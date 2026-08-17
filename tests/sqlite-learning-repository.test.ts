import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  LearningGenerationConflictError,
  SqliteLearningRepository,
  type LearningArtifactAnalysis,
} from "../lib/repository/learning-repository";

function artifactAnalysis(text: string): LearningArtifactAnalysis {
  const polygon = [
    { x: 0.1, y: 0.1 },
    { x: 0.4, y: 0.1 },
    { x: 0.4, y: 0.2 },
    { x: 0.1, y: 0.2 },
  ];
  return {
    documentTextMode: "plain_text",
    documentAnalysis: {
      pages: [{
        pageNumber: 1,
        width: 1,
        height: 1,
        unit: "normalized",
        text,
        tokens: [{ text, polygon, confidence: 0.99 }],
        language: "en",
        tables: [{
          rowCount: 1,
          columnCount: 1,
          cells: [{
            rowIndex: 0,
            columnIndex: 0,
            rowSpan: 1,
            columnSpan: 1,
            text,
            polygon,
            confidence: 0.98,
          }],
        }],
      }],
      fieldCandidates: [{
        field: "supplierName",
        label: "VendorName",
        value: text,
        page: 1,
        polygon,
        confidence: 0.98,
        source: "test-provider",
      }],
      confidence: 0.99,
      language: "en",
      provider: { name: "test-provider", model: "fixture-v1" },
      sourceMode: "ocr",
    },
  };
}

function testDatabasePath() {
  return resolve(
    "data/tmp-tests",
    `learning-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`
  );
}

async function withRepository(
  run: (repository: SqliteLearningRepository) => Promise<void>
) {
  const databasePath = testDatabasePath();
  const previousKey = process.env.LEARNING_ARTIFACT_ENCRYPTION_KEY;
  process.env.LEARNING_ARTIFACT_ENCRYPTION_KEY = "learning-repository-test-key";
  const repository = new SqliteLearningRepository(databasePath);
  try {
    await repository.migrate();
    await run(repository);
  } finally {
    repository.close();
    if (previousKey === undefined) {
      delete process.env.LEARNING_ARTIFACT_ENCRYPTION_KEY;
    } else {
      process.env.LEARNING_ARTIFACT_ENCRYPTION_KEY = previousKey;
    }
    await rm(databasePath, { force: true });
    await rm(`${databasePath}-shm`, { force: true });
    await rm(`${databasePath}-wal`, { force: true });
  }
}

const scope = {
  companyId: "into-company",
  divisionCode: "123456",
  supplierAccountId: "exact-supplier-a",
};

test("SQLite learning migrations are idempotent and create all normalized tables", async () => {
  await withRepository(async (repository) => {
    await repository.migrate();
    assert.equal(await repository.schemaVersion(), 2);
    assert.deepEqual(await repository.tableNames(), [
      "document_analysis_artifacts",
      "supplier_identity_aliases",
      "supplier_learning_corrections",
      "supplier_learning_data_migrations",
      "supplier_learning_events",
      "supplier_learning_examples",
      "supplier_learning_patterns",
      "supplier_learning_profiles",
      "supplier_learning_schema_migrations",
    ]);
  });
});

test("SQLite upgrades learning schema v1 with correction and evidence-revision storage", async () => {
  const databasePath = testDatabasePath();
  const repository = new SqliteLearningRepository(databasePath);
  try {
    await repository.migrate();
    const database = new DatabaseSync(databasePath);
    try {
      const profileColumns = database
        .prepare("PRAGMA table_info(supplier_learning_profiles)")
        .all() as Array<{ name: string }>;
      const correctionTable = database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='supplier_learning_corrections'"
        )
        .get();
      const activeExampleIndex = database
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='index' AND name='supplier_learning_examples_active_hash_uidx'"
        )
        .get() as { sql: string } | undefined;
      assert.ok(profileColumns.some((column) => column.name === "evidence_revision"));
      assert.ok(profileColumns.some((column) => column.name === "derived_evidence_revision"));
      assert.ok(correctionTable);
      assert.match(activeExampleIndex?.sql ?? "", /UNIQUE INDEX[\s\S]+WHERE active = 1/i);
    } finally {
      database.close();
    }
  } finally {
    repository.close();
    await rm(databasePath, { force: true });
    await rm(`${databasePath}-shm`, { force: true });
    await rm(`${databasePath}-wal`, { force: true });
  }
});

test("SQLite rejects a future schema before applying current DDL", async () => {
  const databasePath = testDatabasePath();
  const seed = new DatabaseSync(databasePath);
  seed.exec(`
    CREATE TABLE supplier_learning_schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    INSERT INTO supplier_learning_schema_migrations (version, applied_at)
    VALUES (99, '2026-07-21T10:00:00.000Z');
  `);
  seed.close();

  const repository = new SqliteLearningRepository(databasePath);
  try {
    await assert.rejects(repository.migrate(), /newer than supported schema/);
    const verify = new DatabaseSync(databasePath);
    try {
      const profileTable = verify
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='supplier_learning_profiles'"
        )
        .get();
      assert.equal(profileTable, undefined);
    } finally {
      verify.close();
    }
  } finally {
    repository.close();
    await rm(databasePath, { force: true });
    await rm(`${databasePath}-shm`, { force: true });
    await rm(`${databasePath}-wal`, { force: true });
  }
});

test("lists only profiles with learning evidence or reset history", async () => {
  await withRepository(async (repository) => {
    const createdAt = "2026-07-21T10:00:00.000Z";
    const emptyProfile = await repository.ensureProfile({
      ...scope,
      fallbackSupplierCode: "SUP-A",
      createdAt,
    });
    await repository.saveAlias({
      id: "alias-exact-only",
      ...scope,
      generation: emptyProfile.generation,
      kind: "vat",
      normalizedValue: "NL123456789B01",
      source: "exact",
      createdAt,
    });

    const patternScope = {
      ...scope,
      supplierAccountId: "exact-supplier-b",
    };
    const patternProfile = await repository.ensureProfile({
      ...patternScope,
      fallbackSupplierCode: "SUP-B",
      createdAt,
    });
    await repository.savePattern({
      id: "pattern-evidence",
      ...patternScope,
      generation: patternProfile.generation,
      formatCluster: "layout-a",
      field: "referenceCode",
      patternKey: "invoice-number:right",
      supportCount: 1,
      successCount: 1,
      correctionCount: 0,
      driftState: "none",
      modelVersion: "locator-v1",
      createdAt,
    });

    const resetScope = {
      ...scope,
      supplierAccountId: "exact-supplier-c",
    };
    const resetProfile = await repository.ensureProfile({
      ...resetScope,
      fallbackSupplierCode: "SUP-C",
      createdAt,
    });
    await repository.resetSupplier({
      ...resetScope,
      expectedGeneration: resetProfile.generation,
      actorId: "shared_user",
      sessionCorrelationId: "session-reset",
      requestId: "request-reset",
      createdAt: "2026-07-22T10:00:00.000Z",
    });

    assert.deepEqual(
      (
        await repository.listProfiles(scope.companyId, scope.divisionCode)
      ).map((profile) => profile.supplierAccountId),
      ["exact-supplier-b", "exact-supplier-c"]
    );
  });
});

test("artifacts are encrypted, content-hash deduplicated, and bound to their hash", async () => {
  await withRepository(async (repository) => {
    const artifact = await repository.saveArtifact({
      companyId: scope.companyId,
      contentHash: "sha256:invoice-a",
      rawText: "Sensitive invoice body",
      analysis: artifactAnalysis("Sensitive"),
      detectedLanguage: "en",
      provider: "local",
      modelVersion: "embedded-pdf-v1",
      createdAt: "2026-07-21T10:00:00.000Z",
    });
    const duplicate = await repository.saveArtifact({
      companyId: scope.companyId,
      contentHash: "sha256:invoice-a",
      rawText: "Sensitive invoice body",
      analysis: { documentTextMode: "plain_text" },
      provider: "local",
      modelVersion: "embedded-pdf-v1",
      createdAt: "2026-07-21T10:01:00.000Z",
    });

    assert.equal(duplicate.id, artifact.id);
    const stored = await repository.rawArtifact(artifact.id);
    assert.ok(stored);
    assert.doesNotMatch(JSON.stringify(stored), /Sensitive invoice body/);
    assert.match(stored!.rawTextCiphertext, /^v1\./);
    assert.deepEqual(await repository.readArtifact(artifact.id), {
      rawText: "Sensitive invoice body",
      analysis: artifactAnalysis("Sensitive"),
    });
  });
});

test("checks referenced artifact existence in one SQLite batch", async () => {
  await withRepository(async (repository) => {
    const first = await repository.saveArtifact({
      companyId: scope.companyId,
      contentHash: "sha256:artifact-exists-a",
      rawText: "Artifact A",
      analysis: artifactAnalysis("Artifact A"),
      provider: "local",
      modelVersion: "embedded-pdf-v1",
      createdAt: "2026-07-21T10:00:00.000Z",
    });
    const second = await repository.saveArtifact({
      companyId: scope.companyId,
      contentHash: "sha256:artifact-exists-b",
      rawText: "Artifact B",
      analysis: artifactAnalysis("Artifact B"),
      provider: "local",
      modelVersion: "embedded-pdf-v1",
      createdAt: "2026-07-21T10:00:00.000Z",
    });

    assert.deepEqual(
      await repository.existingArtifactIds([
        first.id,
        "artifact_missing",
        second.id,
        first.id,
      ]),
      new Set([first.id, second.id])
    );
    assert.deepEqual(await repository.existingArtifactIds([]), new Set());
  });
});

test("concurrent artifact saves converge on one encrypted record", async () => {
  await withRepository(async (repository) => {
    const input = {
      companyId: scope.companyId,
      contentHash: "sha256:concurrent-invoice",
      rawText: "Concurrent sensitive invoice body",
      analysis: artifactAnalysis("Concurrent"),
      provider: "local",
      modelVersion: "embedded-pdf-v1",
      createdAt: "2026-07-21T10:00:00.000Z",
    };

    const [first, second] = await Promise.all([
      repository.saveArtifact(input),
      repository.saveArtifact(input),
    ]);

    assert.equal(first.id, second.id);
    assert.deepEqual(await repository.readArtifact(first.id), {
      rawText: input.rawText,
      analysis: input.analysis,
    });
  });
});

test("artifact retention removes expired encrypted analysis", async () => {
  await withRepository(async (repository) => {
    const artifact = await repository.saveArtifact({
      companyId: scope.companyId,
      contentHash: "sha256:expired-invoice",
      rawText: "Expired sensitive invoice body",
      analysis: artifactAnalysis("Expired"),
      provider: "test-provider",
      modelVersion: "fixture-v1",
      retentionUntil: "2026-07-20T00:00:00.000Z",
      createdAt: "2026-07-19T00:00:00.000Z",
    });

    assert.equal(
      await repository.pruneExpiredArtifacts("2026-07-21T00:00:00.000Z"),
      1
    );
    assert.equal(await repository.readArtifact(artifact.id), null);
  });
});

test("trusted examples are unique per supplier generation and content hash", async () => {
  await withRepository(async (repository) => {
    const profile = await repository.ensureProfile({
      ...scope,
      fallbackSupplierCode: "SUP-A",
      createdAt: "2026-07-21T10:00:00.000Z",
    });
    const input = {
      id: "example-a",
      ...scope,
      generation: profile.generation,
      invoiceId: "invoice-a",
      contentHash: "sha256:invoice-a",
      originalFilename: "past-invoice.pdf",
      originalPrediction: { referenceCode: "wrong" },
      finalFields: { referenceCode: "INV-100" },
      bookingLines: [{ glAccount: "4420", amount: 100 }],
      fingerprint: "layout-a",
      fingerprintVersion: "layout-v1",
      validationResult: { valid: true },
      processingPurpose: "learning_only" as const,
      source: "explicit_learn" as const,
      trustState: "trusted" as const,
      trigger: "learn" as const,
      actorId: "shared_user",
      sessionCorrelationId: "session-hash",
      requestId: "request-a",
      createdAt: "2026-07-21T10:00:00.000Z",
    };

    const [first, duplicate] = await Promise.all([
      repository.saveExample(input),
      repository.saveExample({
        ...input,
        id: "example-duplicate",
        invoiceId: "invoice-duplicate",
        requestId: "request-b",
      }),
    ]);

    assert.equal(first.created, true);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.example.id, first.example.id);
    assert.equal((await repository.listExamples(scope)).length, 1);
    assert.equal((await repository.getProfile(scope))?.learnedCount, 1);
  });
});

test("aliases may legitimately match more than one supplier", async () => {
  await withRepository(async (repository) => {
    await repository.ensureProfile({
      ...scope,
      fallbackSupplierCode: "SUP-A",
      createdAt: "2026-07-21T10:00:00.000Z",
    });
    await repository.ensureProfile({
      ...scope,
      supplierAccountId: "exact-supplier-b",
      fallbackSupplierCode: "SUP-B",
      createdAt: "2026-07-21T10:00:00.000Z",
    });
    await repository.saveAlias({
      id: "alias-a",
      ...scope,
      generation: 0,
      kind: "vat",
      normalizedValue: "NL123456789B01",
      source: "exact",
      createdAt: "2026-07-21T10:00:00.000Z",
    });
    await repository.saveAlias({
      id: "alias-b",
      ...scope,
      supplierAccountId: "exact-supplier-b",
      generation: 0,
      kind: "vat",
      normalizedValue: "NL123456789B01",
      source: "exact",
      createdAt: "2026-07-21T10:00:00.000Z",
    });

    assert.equal(
      (await repository.findAliases(scope.companyId, scope.divisionCode, "vat", "NL123456789B01")).length,
      2
    );
  });
});

test("patterns aggregate by stable supplier, generation, cluster, field, and key", async () => {
  await withRepository(async (repository) => {
    const profile = await repository.ensureProfile({
      ...scope,
      fallbackSupplierCode: "SUP-A",
      createdAt: "2026-07-21T10:00:00.000Z",
    });
    const pattern = {
      id: "pattern-a",
      ...scope,
      generation: profile.generation,
      formatCluster: "layout-a",
      field: "referenceCode",
      patternKey: "label:invoice-number:right",
      label: "Invoice number",
      anchor: { direction: "right" },
      normalizedRegion: { x: 0.7, y: 0.1, width: 0.2, height: 0.05 },
      dataType: "reference",
      supportCount: 1,
      successCount: 1,
      correctionCount: 0,
      driftState: "none" as const,
      modelVersion: "locator-v1",
      createdAt: "2026-07-21T10:00:00.000Z",
    };
    await repository.savePattern(pattern);
    await repository.savePattern({
      ...pattern,
      id: "pattern-duplicate-observation",
      createdAt: "2026-07-21T11:00:00.000Z",
    });

    const rows = await repository.listPatterns(scope);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.support_count, 2);
    assert.equal(rows[0]?.success_count, 2);
  });
});

test("undesirable: replaying one pattern projection from independent writers increments its counters twice", async () => {
  const databasePath = testDatabasePath();
  const previousKey = process.env.LEARNING_ARTIFACT_ENCRYPTION_KEY;
  process.env.LEARNING_ARTIFACT_ENCRYPTION_KEY = "independent-pattern-writer-key";
  const firstWriter = new SqliteLearningRepository(databasePath);
  const secondWriter = new SqliteLearningRepository(databasePath);
  try {
    await firstWriter.migrate();
    const profile = await firstWriter.ensureProfile({
      ...scope,
      fallbackSupplierCode: "SUP-A",
      createdAt: "2026-08-10T10:00:00.000Z",
    });
    const projection = {
      id: "independent-pattern-projection",
      ...scope,
      generation: profile.generation,
      formatCluster: "layout-a",
      field: "referenceCode",
      patternKey: "label:invoice-number:right",
      supportCount: 1,
      successCount: 1,
      correctionCount: 0,
      driftState: "none" as const,
      modelVersion: "locator-v1",
      createdAt: "2026-08-10T10:00:00.000Z",
    };

    await firstWriter.savePattern(projection);
    await secondWriter.savePattern({ ...projection, id: "replayed-pattern-projection" });

    const stored = await firstWriter.listPatterns(scope);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.support_count, 2);
    assert.equal(stored[0]?.success_count, 2);
  } finally {
    firstWriter.close();
    secondWriter.close();
    if (previousKey === undefined) delete process.env.LEARNING_ARTIFACT_ENCRYPTION_KEY;
    else process.env.LEARNING_ARTIFACT_ENCRYPTION_KEY = previousKey;
    await rm(databasePath, { force: true });
    await rm(`${databasePath}-shm`, { force: true });
    await rm(`${databasePath}-wal`, { force: true });
  }
});

test("reset uses generation CAS and only deactivates the selected supplier", async () => {
  await withRepository(async (repository) => {
    const profileA = await repository.ensureProfile({
      ...scope,
      fallbackSupplierCode: "SUP-A",
      createdAt: "2026-07-21T10:00:00.000Z",
    });
    const profileB = await repository.ensureProfile({
      ...scope,
      supplierAccountId: "exact-supplier-b",
      fallbackSupplierCode: "SUP-B",
      createdAt: "2026-07-21T10:00:00.000Z",
    });
    for (const [profile, suffix] of [
      [profileA, "a"],
      [profileB, "b"],
    ] as const) {
      await repository.saveExample({
        id: `example-${suffix}`,
        companyId: profile.companyId,
        divisionCode: profile.divisionCode,
        supplierAccountId: profile.supplierAccountId,
        generation: profile.generation,
        invoiceId: `invoice-${suffix}`,
        contentHash: `sha256:${suffix}`,
        originalFilename: `${suffix}.pdf`,
        originalPrediction: {},
        finalFields: {},
        bookingLines: [],
        fingerprint: `layout-${suffix}`,
        fingerprintVersion: "layout-v1",
        validationResult: { valid: true },
        processingPurpose: "learning_only",
        source: "explicit_learn",
        trustState: "trusted",
        trigger: "learn",
        actorId: "shared_user",
        sessionCorrelationId: "session-hash",
        requestId: `request-${suffix}`,
        createdAt: "2026-07-21T10:00:00.000Z",
      });
    }

    await assert.rejects(
      repository.resetSupplier({
        ...scope,
        expectedGeneration: profileA.generation + 1,
        actorId: "shared_user",
        sessionCorrelationId: "session-hash",
        requestId: "reset-stale",
        createdAt: "2026-07-21T11:00:00.000Z",
      }),
      LearningGenerationConflictError
    );
    const reset = await repository.resetSupplier({
      ...scope,
      expectedGeneration: profileA.generation,
      actorId: "shared_user",
      sessionCorrelationId: "session-hash",
      requestId: "reset-a",
      createdAt: "2026-07-21T11:00:00.000Z",
    });

    assert.equal(reset.generation, profileA.generation + 1);
    assert.equal(reset.learnedCount, 0);
    assert.equal((await repository.listExamples(scope)).length, 0);
    assert.equal(
      (
        await repository.listExamples({
          ...scope,
          supplierAccountId: "exact-supplier-b",
        })
      ).length,
      1
    );
    assert.equal((await repository.listEvents(scope)).at(-1)?.type, "reset");

    await assert.rejects(
      repository.saveAlias({
        id: "stale-alias",
        ...scope,
        generation: profileA.generation,
        kind: "name",
        normalizedValue: "stale supplier",
        source: "learned",
        createdAt: "2026-07-21T12:00:00.000Z",
      }),
      LearningGenerationConflictError
    );
    await assert.rejects(
      repository.savePattern({
        id: "stale-pattern",
        ...scope,
        generation: profileA.generation,
        formatCluster: "old-layout",
        field: "referenceCode",
        patternKey: "old-pattern",
        supportCount: 1,
        successCount: 1,
        correctionCount: 0,
        driftState: "none",
        modelVersion: "locator-v1",
        createdAt: "2026-07-21T12:00:00.000Z",
      }),
      LearningGenerationConflictError
    );
    assert.equal(
      (
        await repository.findAliases(
          scope.companyId,
          scope.divisionCode,
          "name",
          "stale supplier"
        )
      ).length,
      0
    );
  });
});
