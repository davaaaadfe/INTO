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
    "supplier_learning_corrections",
    "supplier_learning_patterns",
    "supplier_learning_events",
    "supplier_learning_data_migrations",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(
    sql,
    /UNIQUE \(\s*company_id, division_code, supplier_account_id, generation, content_hash\s*\)/
  );
  assert.match(sql, /UNIQUE \(company_id, idempotency_key\)/);
  assert.match(sql, /evidence_revision integer NOT NULL DEFAULT 0/);
  assert.match(sql, /format_signature text NOT NULL DEFAULT ''/);
  assert.match(sql, /format_cluster text NOT NULL DEFAULT ''/);
  assert.match(
    sql,
    /CREATE UNIQUE INDEX IF NOT EXISTS supplier_learning_examples_active_hash_uidx[\s\S]+WHERE active = true/
  );
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
    3
  );
  assert.deepEqual(
    calls
      .filter((call) =>
        call.query.includes("INSERT INTO supplier_learning_schema_migrations")
      )
      .map((call) => call.parameters?.[0]),
    [1, 2, 3]
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
      formatSignature: "invoice number:<value>\ntotal:<value>",
      formatCluster: "cluster-layout-a",
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

test("PostgreSQL pattern projection replaces absolute counters instead of adding replay deltas", async () => {
  const calls: string[] = [];
  const repository = PostgresLearningRepository.fromQuery(async (query) => {
    calls.push(query);
    return [{ id: "pattern-a" }];
  });

  await repository.savePattern({
    id: "pattern-a",
    companyId: "into-company",
    divisionCode: "123456",
    supplierAccountId: "supplier-a",
    generation: 1,
    formatCluster: "layout-a",
    field: "referenceCode",
    patternKey: "invoice-number",
    supportCount: 3,
    successCount: 2,
    correctionCount: 1,
    driftState: "none",
    modelVersion: "pattern-v2",
    createdAt: "2026-08-17T10:00:00.000Z",
  });

  const sql = calls.join("\n");
  assert.match(sql, /support_count = EXCLUDED\.support_count/);
  assert.doesNotMatch(sql, /support_count \+ EXCLUDED\.support_count/);
});

test("PostgreSQL derived pattern rebuild replaces the active model set atomically", async () => {
  const calls: Array<{ query: string; parameters?: unknown[] }> = [];
  const repository = PostgresLearningRepository.fromQuery(async (query, parameters) => {
    calls.push({ query, parameters });
    return [{ derived_evidence_revision: 4 }];
  });
  await repository.replaceDerivedPatterns({
    companyId: "into-company",
    divisionCode: "123456",
    supplierAccountId: "supplier-a",
    generation: 2,
    modelVersion: "cluster-pattern-v1",
    updatedAt: "2026-08-17T10:00:00.000Z",
    patterns: [{
      id: "derived-a",
      companyId: "into-company",
      divisionCode: "123456",
      supplierAccountId: "supplier-a",
      generation: 2,
      formatCluster: "cluster-a",
      field: "referenceCode",
      patternKey: "field:referenceCode",
      supportCount: 2,
      successCount: 1,
      correctionCount: 1,
      driftState: "none",
      modelVersion: "cluster-pattern-v1",
      createdAt: "2026-08-17T10:00:00.000Z",
    }],
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0]!.query, /deactivated AS[\s\S]*active=false/i);
  assert.match(calls[0]!.query, /jsonb_to_recordset/i);
  assert.match(calls[0]!.query, /support_count = EXCLUDED\.support_count/i);
  assert.match(calls[0]!.query, /derived_evidence_revision = profile_ok\.evidence_revision/i);
});

test("PostgreSQL example writes supersede changed truth without increasing distinct volume", async () => {
  const calls: Array<{ query: string; parameters: readonly unknown[] }> = [];
  const repository = PostgresLearningRepository.fromQuery(
    async (query, parameters = []) => {
      calls.push({ query, parameters });
      return [];
    }
  );
  await assert.rejects(
    repository.saveExample({
      id: "example-successor",
      companyId: "into-company",
      divisionCode: "123456",
      supplierAccountId: "supplier-a",
      generation: 2,
      invoiceId: "invoice-a",
      contentHash: "sha256:a",
      originalFilename: "*.pdf",
      originalPrediction: {},
      finalFields: { referenceCode: "CORRECTED" },
      bookingLines: [],
      observationState: { referenceCode: "observed", dueDate: "unknown" },
      fingerprint: "layout-a",
      fingerprintVersion: "layout-v1",
      formatSignature: "invoice number:<value>\ntotal:<value>",
      formatCluster: "cluster-layout-a",
      validationResult: { valid: true },
      processingPurpose: "learning_only",
      source: "explicit_learn",
      trustState: "trusted",
      trigger: "learn",
      actorId: "verified-user",
      sessionCorrelationId: "session-a",
      requestId: "request-a",
      createdAt: "2026-07-21T10:00:00.000Z",
    }),
    /generation changed/i
  );
  assert.match(
    calls.find(({ query }) => query.includes("INSERT INTO supplier_learning_examples"))?.query ?? "",
    /ON CONFLICT\s*\([\s\S]*content_hash\s*\)\s*WHERE active = true\s*DO NOTHING/i
  );

  const write = calls[0]!;
  assert.match(write.query, /existing AS[\s\S]*FOR UPDATE/i);
  assert.match(write.query, /deactivated AS[\s\S]*superseded_by_id/i);
  assert.match(write.query, /learned_count = learned_count \+ CASE/i);
  assert.match(write.query, /observation_state_json/i);
  assert.match(write.query, /format_signature/i);
  assert.match(write.query, /format_cluster/i);
  assert.equal(write.parameters.at(-3), JSON.stringify({
    referenceCode: "observed",
    dueDate: "unknown",
  }));
  assert.equal(write.parameters.at(-2), "invoice number:<value>\ntotal:<value>");
  assert.equal(write.parameters.at(-1), "cluster-layout-a");
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

test("PostgreSQL migration ledger is checksum-idempotent and fails closed on mismatches", async () => {
  const calls: Array<{ query: string; parameters?: unknown[] }> = [];
  const repository = PostgresLearningRepository.fromQuery(
    async (query, parameters) => {
      calls.push({ query, parameters });
      return [{
        migration_name: "legacy-learning:into-company:123456",
        version: 1,
        source_snapshot_revision: 8,
        source_snapshot_hash: "snapshot-hash-a",
        status: "completed",
        row_counts_json: { examples: 2 },
        checksum: "migration-checksum-a",
        error_code: null,
        started_at: "2026-08-17T10:00:00.000Z",
        completed_at: "2026-08-17T10:00:01.000Z",
        inserted: true,
      }];
    }
  );

  const result = await repository.recordDataMigration({
    migrationName: "legacy-learning:into-company:123456",
    version: 1,
    sourceSnapshotRevision: 8,
    sourceSnapshotHash: "snapshot-hash-a",
    rowCounts: { examples: 2 },
    checksum: "migration-checksum-a",
    startedAt: "2026-08-17T10:00:00.000Z",
    completedAt: "2026-08-17T10:00:01.000Z",
  });

  assert.equal(result.created, true);
  assert.match(calls[0]!.query, /ON CONFLICT[\s\S]+checksum[\s\S]+RETURNING/i);
});

test("PostgreSQL legacy cutover deactivates generation zero without a reset event", async () => {
  const calls: string[] = [];
  const repository = PostgresLearningRepository.fromQuery(async (query) => {
    calls.push(query);
    return [{
      company_id: "into-company",
      division_code: "123456",
      supplier_account_id: "supplier-a",
      fallback_supplier_code: "SUP-A",
      generation: 1,
      state: "active",
      confidence_score: 35,
      confidence_breakdown_version: 1,
      drift_state: "none",
      learned_count: 0,
      last_learned_at: null,
      last_reset_at: null,
      version: 2,
      created_at: "2026-08-17T10:00:00.000Z",
      updated_at: "2026-08-17T10:00:01.000Z",
    }];
  });

  await repository.completeLegacyMigration({
    companyId: "into-company",
    divisionCode: "123456",
    supplierAccountId: "supplier-a",
    activeGeneration: 1,
    updatedAt: "2026-08-17T10:00:01.000Z",
  });

  assert.match(calls[0]!, /generation=0[\s\S]+supplier_learning_examples/i);
  assert.match(calls[0]!, /supplier_learning_patterns[\s\S]+active=false/i);
  assert.match(calls[0]!, /supplier_identity_aliases[\s\S]+source <> 'exact'/i);
  assert.doesNotMatch(calls[0]!, /supplier_learning_events/i);
});
