import test from "node:test";
import assert from "node:assert/strict";
import {
  POSTGRES_LEARNING_MIGRATIONS,
  PostgresLearningRepository,
} from "../lib/repository/postgres-learning-repository";

test("PostgreSQL learning migrations define the normalized production schema", () => {
  const sql = POSTGRES_LEARNING_MIGRATIONS.join("\n");
  for (const table of [
    "supplier_learning_profiles",
    "supplier_identity_aliases",
    "document_analysis_artifacts",
    "supplier_learning_examples",
    "supplier_learning_patterns",
    "supplier_learning_events",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(
    sql,
    /UNIQUE \(\s*company_id, division_code, supplier_account_id, generation, content_hash\s*\)/
  );
  assert.match(sql, /UNIQUE \(company_id, idempotency_key\)/);
  const aliasTable = POSTGRES_LEARNING_MIGRATIONS.find((statement) =>
    statement.includes("CREATE TABLE IF NOT EXISTS supplier_identity_aliases")
  );
  assert.ok(aliasTable);
  assert.doesNotMatch(
    aliasTable,
    /UNIQUE/i,
    "supplier identity values must not be globally unique"
  );
});

test("PostgreSQL migrations are replayable and record one schema version", async () => {
  const calls: Array<{ query: string; parameters?: unknown[] }> = [];
  const repository = PostgresLearningRepository.fromQuery(
    async (query, parameters) => {
      calls.push({ query, parameters });
      return query.startsWith("SELECT MAX(version)") ? [{ version: 0 }] : [];
    }
  );

  await repository.migrate();

  assert.equal(
    calls.filter((call) => call.query.includes("CREATE TABLE IF NOT EXISTS"))
      .length >= 7,
    true
  );
  assert.equal(
    calls.filter((call) =>
      call.query.includes("INSERT INTO supplier_learning_schema_migrations")
    ).length,
    1
  );
});

test("PostgreSQL migration rejects a database from a newer release", async () => {
  const calls: string[] = [];
  const repository = PostgresLearningRepository.fromQuery(async (query) => {
    calls.push(query);
    return query.startsWith("SELECT MAX(version)") ? [{ version: 99 }] : [];
  });

  await assert.rejects(repository.migrate(), /newer than supported schema/);
  assert.deepEqual(
    calls.filter((query) => query.includes("CREATE TABLE IF NOT EXISTS")),
    [
      POSTGRES_LEARNING_MIGRATIONS.find((query) =>
        query.includes("supplier_learning_schema_migrations")
      ),
    ]
  );
});

test("PostgreSQL repository exposes authoritative read paths", async () => {
  const calls: Array<{ query: string; parameters?: unknown[] }> = [];
  const repository = PostgresLearningRepository.fromQuery(
    async (query, parameters) => {
      calls.push({ query, parameters });
      return [];
    }
  );
  const scope = {
    companyId: "into-company",
    divisionCode: "123456",
    supplierAccountId: "supplier-a",
  };

  assert.deepEqual(await repository.listExamples(scope), []);
  assert.deepEqual(await repository.listPatterns(scope), []);
  assert.deepEqual(
    await repository.findAliases(
      scope.companyId,
      scope.divisionCode,
      "vat",
      "NL123456789B01"
    ),
    []
  );
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.match(call.query, /supplier_learning_profiles/);
    assert.match(call.query, /generation/);
  }
});

test("PostgreSQL generation writes lock the active profile row", async () => {
  const calls: string[] = [];
  const repository = PostgresLearningRepository.fromQuery(async (query) => {
    calls.push(query);
    if (query.includes("RETURNING id") && !query.includes("supplier_learning_examples")) {
      return [{ id: "saved" }];
    }
    return [];
  });
  const scope = {
    companyId: "into-company",
    divisionCode: "123456",
    supplierAccountId: "supplier-a",
    generation: 2,
  };

  await repository.saveAlias({
    ...scope,
    id: "alias-a",
    kind: "vat",
    normalizedValue: "NL123456789B01",
    source: "learned",
    createdAt: "2026-07-21T10:00:00.000Z",
  });
  await repository.savePattern({
    ...scope,
    id: "pattern-a",
    formatCluster: "layout-a",
    field: "referenceCode",
    patternKey: "invoice-number:right",
    supportCount: 1,
    successCount: 1,
    correctionCount: 0,
    driftState: "none",
    modelVersion: "locator-v1",
    createdAt: "2026-07-21T10:00:00.000Z",
  });
  await assert.rejects(
    repository.saveExample({
      ...scope,
      id: "example-a",
      invoiceId: "invoice-a",
      contentHash: "sha256:a",
      originalFilename: "invoice.pdf",
      originalPrediction: {},
      finalFields: {},
      bookingLines: [],
      fingerprint: "layout-a",
      fingerprintVersion: "layout-v1",
      validationResult: { valid: true },
      processingPurpose: "learning_only",
      source: "explicit_learn",
      trustState: "trusted",
      trigger: "learn",
      actorId: "shared_user",
      sessionCorrelationId: "session-a",
      requestId: "request-a",
      createdAt: "2026-07-21T10:00:00.000Z",
    }),
    /generation changed/i
  );

  const generationWrites = calls.filter(
    (query) =>
      query.includes("INSERT INTO supplier_identity_aliases") ||
      query.includes("INSERT INTO supplier_learning_patterns") ||
      query.includes("INSERT INTO supplier_learning_examples")
  );
  assert.equal(generationWrites.length, 3);
  for (const query of generationWrites) {
    assert.match(query, /SELECT 1 FROM supplier_learning_profiles/i);
    assert.match(query, /WHERE company_id=[\s\S]*generation=/i);
    assert.match(query, /FOR UPDATE/i);
  }
  assert.match(
    generationWrites.find((query) =>
      query.includes("INSERT INTO supplier_identity_aliases")
    ) ?? "",
    /source\s*=\s*'exact'[\s\S]*EXCLUDED\.source\s*=\s*'exact'/i
  );
});

test("PostgreSQL retention unlinks examples before deleting expired artifacts", async () => {
  let retentionQuery = "";
  const repository = PostgresLearningRepository.fromQuery(async (query) => {
    retentionQuery = query;
    return [{ count: 2 }];
  });

  assert.equal(
    await repository.pruneExpiredArtifacts("2026-07-21T00:00:00.000Z"),
    2
  );
  assert.match(retentionQuery, /UPDATE supplier_learning_examples SET artifact_id = NULL/i);
  assert.match(retentionQuery, /DELETE FROM document_analysis_artifacts/i);
});

test("PostgreSQL checks referenced artifact existence with one array query", async () => {
  const calls: Array<{ query: string; parameters?: unknown[] }> = [];
  const repository = PostgresLearningRepository.fromQuery(
    async (query, parameters) => {
      calls.push({ query, parameters });
      return [{ id: "artifact-a" }, { id: "artifact-c" }];
    }
  );

  assert.deepEqual(
    await repository.existingArtifactIds([
      "artifact-a",
      "artifact-missing",
      "artifact-c",
    ]),
    new Set(["artifact-a", "artifact-c"])
  );
  assert.equal(calls.length, 1);
  assert.match(
    calls[0]!.query,
    /SELECT id FROM document_analysis_artifacts WHERE id = ANY\(\$1::text\[\]\)/i
  );
  assert.deepEqual(calls[0]!.parameters, [
    ["artifact-a", "artifact-missing", "artifact-c"],
  ]);

  calls.length = 0;
  assert.deepEqual(await repository.existingArtifactIds([]), new Set());
  assert.equal(calls.length, 0);
});
