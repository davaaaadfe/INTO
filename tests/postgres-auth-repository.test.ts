import test from "node:test";
import assert from "node:assert/strict";
import {
  POSTGRES_AUTH_MIGRATIONS,
  POSTGRES_AUTH_V1_CHECKSUM,
  POSTGRES_AUTH_V2_CHECKSUM,
  POSTGRES_AUTH_V3_CHECKSUM,
  POSTGRES_AUTH_V4_CHECKSUM,
  POSTGRES_AUTH_V5_CHECKSUM,
  POSTGRES_AUTH_V6_CHECKSUM,
  POSTGRES_AUTH_V7_CHECKSUM,
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
  assert.match(sql, /DROP TABLE IF EXISTS into_auth_login_throttles/i);
  assert.match(sql, /CHECK \(email = lower\(btrim\(email\)\)\)/i);
  assert.doesNotMatch(sql, /raw_token|password(?:\s|,|\))/i);
});

test("PostgreSQL auth commands use atomic CTE chains for invitations, verification, and status CAS", async () => {
  const calls: Array<{ query: string; parameters?: unknown[] }> = [];
  const repository = PostgresAuthRepository.fromQuery(async (query, parameters) => {
    calls.push({ query, parameters });
    if (query.includes("existing_invitation")) return [{
      state: "created", id: "invitation-1", user_id: "user-1", token_digest: "digest",
      expires_at: "2026-08-11T00:00:00.000Z", consumed_at: null,
      idempotency_key: "key", request_fingerprint: "fingerprint",
      created_at: "2026-08-10T00:00:00.000Z",
    }];
    if (query.includes("candidate_invitation")) return [{
      state: "consumed", id: "user-1", email: "user@example.test", display_name: "User",
      status: "active", verified_at: "2026-08-10T00:05:00.000Z", version: 2,
      created_at: "2026-08-10T00:00:00.000Z", updated_at: "2026-08-10T00:05:00.000Z",
    }];
    if (query.includes("target_user")) return [{
      state: "updated", id: "user-1", email: "user@example.test", display_name: "User",
      status: "disabled", verified_at: "2026-08-10T00:05:00.000Z", version: 3,
      created_at: "2026-08-10T00:00:00.000Z", updated_at: "2026-08-10T00:10:00.000Z",
    }];
    return [];
  });
  assert.equal(typeof repository.createOrReplayInvitation, "function");
  await repository.createOrReplayInvitation({
    id: "invitation-1", userId: "user-1", email: "user@example.test", displayName: "User",
    tokenDigest: "digest", expiresAt: "2026-08-11T00:00:00.000Z", inviterActorId: "actor",
    inviterSessionId: "session", requestId: "request", idempotencyKey: "key",
    requestFingerprint: "fingerprint", timestamp: "2026-08-10T00:00:00.000Z",
  });
  await repository.consumeInvitation({
    tokenDigest: "digest", displayName: "User", requestId: "verify-request",
    timestamp: "2026-08-10T00:05:00.000Z",
    credential: { algorithm: "scrypt", version: 1, hash: "hash", salt: "salt", n: 16384, r: 8, p: 1 },
    session: {
      id: "session-1", userId: "user-1", tokenDigest: "session-digest",
      correlationIdHash: "correlation-hash", tokenVersion: 1,
      issuedAt: "2026-08-10T00:05:00.000Z", expiresAt: "2026-08-10T12:05:00.000Z",
      revokedAt: null, lastSeenAt: "2026-08-10T00:05:00.000Z",
    },
  });
  await repository.updateUserStatus({
    actorId: "actor", targetId: "user-1", expectedVersion: 2, status: "disabled",
    requestId: "status-request", sessionId: "session-1", timestamp: "2026-08-10T00:10:00.000Z",
  });
  const sql = calls.map((call) => call.query).join("\n");
  assert.match(sql, /WITH existing_invitation AS/i);
  assert.match(sql, /ON CONFLICT \(idempotency_key\) DO (?:NOTHING|UPDATE)/i);
  assert.match(sql, /invitation_result AS[\s\S]*request_fingerprint/i);
  assert.match(sql, /candidate_invitation AS[\s\S]*FOR UPDATE/i);
  assert.match(sql, /credential_insert AS[\s\S]*session_insert AS[\s\S]*event_insert AS/i);
  assert.match(sql, /locked_active_users AS MATERIALIZED[\s\S]*status = 'active'[\s\S]*ORDER BY u\.id[\s\S]*FOR UPDATE OF u/i);
  assert.match(sql, /target_user AS[\s\S]*active_others AS[\s\S]*FROM locked_active_users[\s\S]*user_update AS/i);
  assert.equal(sql.includes("raw_token"), false);
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
  assert.equal(transactions.length, 6);
  assert.match(transactions[0]?.[0]?.query ?? "", /UPDATE into_auth_users SET email = lower\(btrim\(email\)\)/i);
  assert.match(transactions[0]?.[1]?.query ?? "", /ADD CONSTRAINT into_auth_users_email_canonical_check/i);
  assert.deepEqual(transactions[0]?.[2]?.parameters, [2, POSTGRES_AUTH_V2_CHECKSUM]);
  assert.deepEqual(transactions[1]?.[1]?.parameters, [3, POSTGRES_AUTH_V3_CHECKSUM]);
  assert.match(transactions[2]?.[1]?.query ?? "", /ADD COLUMN token_version/i);
  assert.deepEqual(transactions[2]?.[2]?.parameters, [4, POSTGRES_AUTH_V4_CHECKSUM]);
  assert.match(transactions[3]?.[0]?.query ?? "", /request_fingerprint/i);
  assert.deepEqual(transactions[3]?.[1]?.parameters, [5, POSTGRES_AUTH_V5_CHECKSUM]);
  assert.match(transactions[4]?.[0]?.query ?? "", /into_auth_login_throttles/i);
  assert.deepEqual(transactions[4]?.[1]?.parameters, [6, POSTGRES_AUTH_V6_CHECKSUM]);
  assert.match(transactions[5]?.[0]?.query ?? "", /DROP TABLE IF EXISTS into_auth_login_throttles/i);
  assert.deepEqual(transactions[5]?.[1]?.parameters, [7, POSTGRES_AUTH_V7_CHECKSUM]);
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

test("PostgreSQL session lifecycle uses digest-only lookup, bounded touch, and idempotent revoke SQL", async () => {
  const calls: Array<{ query: string; parameters?: unknown[] }> = [];
  const repository = PostgresAuthRepository.fromQuery(async (query, parameters) => {
    calls.push({ query, parameters });
    return query.includes("RETURNING id") ? [{ id: "session-1" }] : [];
  });
  const session = {
    id: "session-1", userId: "user-1", tokenDigest: "digest-only", correlationIdHash: "correlation-hash",
    tokenVersion: 1, issuedAt: "2026-08-10T00:00:00.000Z", expiresAt: "2026-08-11T00:00:00.000Z",
    revokedAt: null, lastSeenAt: null,
  };
  await repository.createSession(session);
  await repository.findSessionByDigest("digest-only");
  await repository.findSessionById("session-1");
  await repository.touchSession("session-1", "2026-08-10T00:20:00.000Z", "2026-08-10T00:05:00.000Z");
  await repository.revokeSessionByDigest("digest-only", "2026-08-10T00:21:00.000Z");

  const sql = calls.map((call) => call.query).join("\n");
  assert.match(sql, /INSERT INTO into_auth_sessions/i);
  assert.match(sql, /WHERE s\.token_digest = \$1/i);
  assert.match(sql, /WHERE s\.id = \$1/i);
  assert.match(sql, /last_seen_at IS NULL OR last_seen_at < \$3/i);
  assert.match(sql, /WHERE token_digest = \$2 AND revoked_at IS NULL/i);
  assert.deepEqual(calls[0]?.parameters?.slice(0, 5), ["session-1", "user-1", "digest-only", "correlation-hash", 1]);
  assert.equal(sql.includes("raw_token"), false);
});

test("PostgreSQL login failure storage records a future lock expiry separately from the attempt time", async () => {
  const calls: Array<{ query: string; parameters?: unknown[] }> = [];
  const repository = PostgresAuthRepository.fromQuery(async (query, parameters) => {
    calls.push({ query, parameters });
    return [{ failed_attempts: 4, locked_at: "2026-08-10T01:19:00.000Z" }];
  });

  const result = await repository.recordLoginFailure(
    "user-1",
    "2026-08-10T01:04:00.000Z",
    4,
    "2026-08-10T01:19:00.000Z",
    { requestId: "login-4", sourceHash: "source-hash" }
  );

  assert.deepEqual(result, {
    failedAttempts: 4,
    lockedAt: "2026-08-10T01:19:00.000Z",
  });
  assert.match(calls[0]?.query ?? "", /locked_at = CASE[\s\S]*THEN \$4::timestamptz/i);
  assert.deepEqual(calls[0]?.parameters, [
    "user-1",
    "2026-08-10T01:04:00.000Z",
    4,
    "2026-08-10T01:19:00.000Z",
    "login-4",
    "source-hash",
  ]);
});
