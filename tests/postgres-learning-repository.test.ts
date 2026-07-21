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
