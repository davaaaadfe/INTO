import test from "node:test";
import assert from "node:assert/strict";
import {
  POSTGRES_AUTH_MIGRATIONS,
  POSTGRES_AUTH_V1_CHECKSUM,
  POSTGRES_AUTH_V2_CHECKSUM,
  POSTGRES_AUTH_V3_CHECKSUM,
  PostgresAuthRepository,
} from "../lib/repository/postgres-auth-repository";
import {
  AuthEmailNormalizationConflictError,
  AuthEmailValidationError,
} from "../lib/repository/auth-repository";

test("PostgreSQL auth migrations define secret-safe normalized auth tables", () => {
  const sql = POSTGRES_AUTH_MIGRATIONS.join("\n");
  for (const table of [
    "into_auth_users",
    "into_auth_credentials",
    "into_auth_invitations",
    "into_auth_sessions",
    "into_auth_events",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(sql, /timestamptz/i);
  assert.match(sql, /jsonb/i);
  assert.match(sql, /token_digest text NOT NULL UNIQUE/i);
  assert.match(sql, /CHECK \(email = lower\(btrim\(email\)\)\)/i);
  assert.doesNotMatch(sql, /raw_token|password(?:\s|,|\))/i);
});

test("PostgreSQL auth migration is checksummed and fails closed for newer schemas", async () => {
  const calls: Array<{ query: string; parameters?: unknown[] }> = [];
  const repository = PostgresAuthRepository.fromQuery(async (query, parameters) => {
    calls.push({ query, parameters });
    return [];
  });
  await repository.migrate();
  assert.equal(calls.some((call) => call.query.includes("into_auth_users")), true);
  assert.deepEqual(
    calls.find((call) => call.query.includes("INSERT INTO into_auth_schema_migrations"))?.parameters,
    [1, POSTGRES_AUTH_V1_CHECKSUM]
  );

  const futureCalls: string[] = [];
  const future = PostgresAuthRepository.fromQuery(async (query) => {
    futureCalls.push(query);
    return query.startsWith("SELECT version, checksum") ? [{ version: 99, checksum: "future" }] : [];
  });
  await assert.rejects(future.migrate(), /newer than supported schema/);
  assert.equal(futureCalls.some((query) => query.includes("into_auth_users")), false);
});

test("PostgreSQL rejects a current schema with a stale PostgreSQL migration checksum", async () => {
  const repository = PostgresAuthRepository.fromQuery(async (query) =>
    query.startsWith("SELECT version, checksum")
      ? [{ version: 3, checksum: "sqlite-derived-checksum" }]
      : []
  );
  await assert.rejects(repository.migrate(), /checksum does not match/);
});

test("PostgreSQL upgrades compatible v1 ledger entries through a collision check and v2 DDL", async () => {
  const transactions: Array<Array<{ query: string; parameters?: unknown[] }>> = [];
  const repository = PostgresAuthRepository.fromQuery(
    async (query) => query.startsWith("SELECT version, checksum")
      ? [{ version: 1, checksum: POSTGRES_AUTH_V1_CHECKSUM }]
      : query.includes("GROUP BY lower(btrim(email))") ? [] : [],
    async (statements) => { transactions.push(statements); }
  );
  await repository.migrate();
  assert.equal(transactions.length, 2);
  assert.match(transactions[0]?.[0]?.query ?? "", /UPDATE into_auth_users SET email = lower\(btrim\(email\)\)/i);
  assert.match(transactions[0]?.[1]?.query ?? "", /ADD CONSTRAINT into_auth_users_email_canonical_check/i);
  assert.deepEqual(transactions[0]?.[2]?.parameters, [2, POSTGRES_AUTH_V2_CHECKSUM]);
  assert.deepEqual(transactions[1]?.[1]?.parameters, [3, POSTGRES_AUTH_V3_CHECKSUM]);
});

test("PostgreSQL v1 unsupported email input fails before v2 or v3 changes", async () => {
  let transactions = 0;
  const repository = PostgresAuthRepository.fromQuery(
    async (query) => query.startsWith("SELECT version, checksum")
      ? [{ version: 1, checksum: POSTGRES_AUTH_V1_CHECKSUM }]
      : query.includes("email !~ '^[!-~]+$'")
        ? [{ id: "bad", email: "case@example.test\t" }]
        : [],
    async () => { transactions += 1; }
  );
  await assert.rejects(repository.migrate(), AuthEmailValidationError);
  assert.equal(transactions, 0);
});

test("PostgreSQL v1 canonical email collisions fail closed before v2 changes", async () => {
  let transactions = 0;
  const repository = PostgresAuthRepository.fromQuery(
    async (query) => query.startsWith("SELECT version, checksum")
      ? [{ version: 1, checksum: POSTGRES_AUTH_V1_CHECKSUM }]
      : query.includes("GROUP BY lower(btrim(email))")
        ? [{ canonical_email: "case@example.test", user_ids: ["first", "second"] }]
        : [],
    async () => { transactions += 1; }
  );
  await assert.rejects(repository.migrate(), AuthEmailNormalizationConflictError);
  assert.equal(transactions, 0);
});

test("PostgreSQL legacy migration upserts canonical users and append-only events", async () => {
  const calls: Array<{ query: string; parameters?: unknown[] }> = [];
  const repository = PostgresAuthRepository.fromQuery(async (query, parameters) => {
    calls.push({ query, parameters });
    return [];
  });
  const report = await repository.migrateLegacyUsers({ users: [
    { id: "pg-user", email: "PG@Example.test", role: "Reviewer" },
    { id: "shared_user", email: "shared@internal", role: "Admin" },
    { id: "unknown", email: "unknown@example.test", role: "Owner" },
  ] }, "request-pg", "2026-08-10T00:00:00.000Z");

  assert.deepEqual(report.unknown, ["unknown"]);
  assert.deepEqual(report.excludedHistorical, ["shared_user"]);
  const userWrite = calls.find((call) => call.query.includes("INSERT INTO into_auth_users"));
  assert.deepEqual(userWrite?.parameters?.slice(0, 2), ["pg-user", "pg@example.test"]);
  const eventWrite = calls.find((call) => call.query.includes("INSERT INTO into_auth_events"));
  assert.match(eventWrite?.query ?? "", /ON CONFLICT \(event_key\) DO NOTHING/i);
  assert.deepEqual(eventWrite?.parameters, [
    "legacy_identity_migrated:pg-user",
    "pg-user",
    "request-pg",
    "legacy_identity_migrated:pg-user",
    JSON.stringify({ source: "raw_snapshot" }),
    "2026-08-10T00:00:00.000Z",
  ]);
});
