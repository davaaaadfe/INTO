import test from "node:test";
import assert from "node:assert/strict";
import {
  AUTH_MIGRATION_CHECKSUM,
  POSTGRES_AUTH_MIGRATIONS,
  PostgresAuthRepository,
} from "../lib/repository/postgres-auth-repository";

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
  assert.doesNotMatch(sql, /raw_token|password(?:\s|,|\))/i);
});

test("PostgreSQL auth migration is checksummed and fails closed for newer schemas", async () => {
  const calls: Array<{ query: string; parameters?: unknown[] }> = [];
  const repository = PostgresAuthRepository.fromQuery(async (query, parameters) => {
    calls.push({ query, parameters });
    if (query.startsWith("SELECT version, checksum")) return [{ version: 0, checksum: null }];
    return [];
  });
  await repository.migrate();
  assert.equal(calls.some((call) => call.query.includes("into_auth_users")), true);
  assert.deepEqual(
    calls.find((call) => call.query.includes("INSERT INTO into_auth_schema_migrations"))?.parameters,
    [1, AUTH_MIGRATION_CHECKSUM]
  );

  const futureCalls: string[] = [];
  const future = PostgresAuthRepository.fromQuery(async (query) => {
    futureCalls.push(query);
    return query.startsWith("SELECT version, checksum") ? [{ version: 99, checksum: "future" }] : [];
  });
  await assert.rejects(future.migrate(), /newer than supported schema/);
  assert.equal(futureCalls.some((query) => query.includes("into_auth_users")), false);
});
