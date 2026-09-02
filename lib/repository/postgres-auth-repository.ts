import { neon } from "@neondatabase/serverless";
import { createHash } from "node:crypto";
import {
  AUTH_SCHEMA_VERSION,
  AuthEmailNormalizationConflictError,
  AuthEmailValidationError,
  AuthSchemaVersionError,
  canonicalAuthEmail,
  inventoryLegacyUsers,
  SQLITE_AUTH_V1_CHECKSUM,
  type AuthSessionRecord,
  type AuthSessionWithUser,
  type AuthRepository,
  type AuthMigrationReport,
  type AuthInvitationRecord,
  type AuthUserRecord,
  type AuthUserStatus,
  type ConsumeInvitationInput,
  type CreateInvitationInput,
  type LegacyAuthUser,
  type UpdateUserStatusInput,
} from "./auth-repository";

export const POSTGRES_AUTH_V1_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS into_auth_schema_migrations (
    version integer PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS into_auth_users (
    id text PRIMARY KEY,
    email text NOT NULL UNIQUE,
    display_name text NOT NULL,
    status text NOT NULL CHECK (status IN ('invited', 'active', 'disabled')),
    access_level text NOT NULL CHECK (access_level = 'verified_user'),
    verified_at timestamptz,
    version integer NOT NULL CHECK (version > 0),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS into_auth_credentials (
    user_id text PRIMARY KEY REFERENCES into_auth_users(id),
    scrypt_hash text NOT NULL,
    scrypt_salt text NOT NULL,
    scrypt_n integer NOT NULL,
    scrypt_r integer NOT NULL,
    scrypt_p integer NOT NULL,
    scrypt_version integer NOT NULL,
    failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
    locked_at timestamptz,
    rotated_at timestamptz,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS into_auth_invitations (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES into_auth_users(id),
    token_digest text NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    inviter_actor_id text,
    inviter_session_id text,
    request_id text,
    idempotency_key text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS into_auth_sessions (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES into_auth_users(id),
    token_digest text NOT NULL UNIQUE,
    correlation_id_hash text NOT NULL,
    issued_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    last_seen_at timestamptz
  )`,
  `CREATE INDEX IF NOT EXISTS into_auth_sessions_user_idx
    ON into_auth_sessions (user_id, expires_at)`,
  `CREATE TABLE IF NOT EXISTS into_auth_events (
    id text PRIMARY KEY,
    type text NOT NULL,
    actor_id text,
    target_user_id text,
    request_id text,
    session_id text,
    event_key text NOT NULL UNIQUE,
    metadata_json jsonb NOT NULL,
    created_at timestamptz NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS into_auth_events_target_idx
    ON into_auth_events (target_user_id, created_at)`,
] as const;

export const POSTGRES_AUTH_V2_MIGRATIONS = [
  `UPDATE into_auth_users SET email = lower(btrim(email))
   WHERE email IS DISTINCT FROM lower(btrim(email))`,
  `ALTER TABLE into_auth_users
   ADD CONSTRAINT into_auth_users_email_canonical_check
   CHECK (email = lower(btrim(email)))`,
] as const;

export const POSTGRES_AUTH_V3_MIGRATIONS = [
  `ALTER TABLE into_auth_users
   ADD CONSTRAINT into_auth_users_email_ascii_check
   CHECK (
     email ~ '^[!-~]+$'
     AND email = lower(email)
     AND email ~ '^[^@]+@[^@]+$'
   )`,
] as const;

export const POSTGRES_AUTH_V4_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS into_auth_sessions (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES into_auth_users(id),
    token_digest text NOT NULL UNIQUE,
    correlation_id_hash text NOT NULL,
    issued_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    last_seen_at timestamptz
  )`,
  `ALTER TABLE into_auth_sessions
   ADD COLUMN token_version integer NOT NULL DEFAULT 1 CHECK (token_version = 1)`,
] as const;

export const POSTGRES_AUTH_V5_MIGRATIONS = [
  `ALTER TABLE into_auth_invitations
   ADD COLUMN IF NOT EXISTS request_fingerprint text NOT NULL DEFAULT ''`,
] as const;

export const POSTGRES_AUTH_V6_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS into_auth_login_throttles (
    scope_hash text PRIMARY KEY,
    failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
    locked_at timestamptz,
    updated_at timestamptz NOT NULL
  )`,
] as const;
export const POSTGRES_AUTH_V7_MIGRATIONS = [
  `DROP TABLE IF EXISTS into_auth_login_throttles`,
] as const;

export const POSTGRES_AUTH_MIGRATIONS = [
  ...POSTGRES_AUTH_V1_MIGRATIONS,
  ...POSTGRES_AUTH_V2_MIGRATIONS,
  ...POSTGRES_AUTH_V3_MIGRATIONS,
  ...POSTGRES_AUTH_V4_MIGRATIONS,
  ...POSTGRES_AUTH_V5_MIGRATIONS,
  ...POSTGRES_AUTH_V6_MIGRATIONS,
  ...POSTGRES_AUTH_V7_MIGRATIONS,
] as const;

export const POSTGRES_AUTH_V1_CHECKSUM = createHash("sha256")
  .update(`1\n${POSTGRES_AUTH_V1_MIGRATIONS.join("\n")}`)
  .digest("hex");
export const POSTGRES_AUTH_V2_CHECKSUM = createHash("sha256")
  .update(`2\n${POSTGRES_AUTH_V2_MIGRATIONS.join("\n")}`)
  .digest("hex");
export const POSTGRES_AUTH_V3_CHECKSUM = createHash("sha256")
  .update(`3\n${POSTGRES_AUTH_V3_MIGRATIONS.join("\n")}`)
  .digest("hex");
export const POSTGRES_AUTH_V4_CHECKSUM = createHash("sha256")
  .update(`4\n${POSTGRES_AUTH_V4_MIGRATIONS.join("\n")}`)
  .digest("hex");
export const POSTGRES_AUTH_V5_CHECKSUM = createHash("sha256")
  .update(`5\n${POSTGRES_AUTH_V5_MIGRATIONS.join("\n")}`)
  .digest("hex");
export const POSTGRES_AUTH_V6_CHECKSUM = createHash("sha256")
  .update(`6\n${POSTGRES_AUTH_V6_MIGRATIONS.join("\n")}`)
  .digest("hex");
export const POSTGRES_AUTH_V7_CHECKSUM = createHash("sha256")
  .update(`7\n${POSTGRES_AUTH_V7_MIGRATIONS.join("\n")}`)
  .digest("hex");
/** @deprecated Use the version-specific checksum. */
export const POSTGRES_AUTH_MIGRATION_CHECKSUM = POSTGRES_AUTH_V2_CHECKSUM;

type PostgresRows = Array<Record<string, unknown>>;
type PostgresQuery = (query: string, parameters?: unknown[]) => Promise<PostgresRows>;
type PostgresStatement = { query: string; parameters?: unknown[] };
type PostgresTransaction = (statements: PostgresStatement[]) => Promise<void>;

function iso(value: unknown) {
  return value instanceof Date ? value.toISOString() : String(value);
}

export class PostgresAuthRepository implements AuthRepository {
  private readonly query: PostgresQuery;
  private readonly transaction: PostgresTransaction;

  constructor(databaseUrl = process.env.DATABASE_URL?.trim() ?? "") {
    if (!databaseUrl) throw new Error("DATABASE_URL is required for PostgreSQL auth.");
    const sql = neon(databaseUrl);
    this.query = (query, parameters = []) => sql.query(query, parameters) as Promise<PostgresRows>;
    this.transaction = async (statements) => {
      await sql.transaction(statements.map(({ query, parameters = [] }) => sql.query(query, parameters)));
    };
  }

  static fromQuery(
    query: PostgresQuery,
    transaction: PostgresTransaction = async (statements) => {
      for (const statement of statements) await query(statement.query, statement.parameters);
    }
  ) {
    const repository = Object.create(PostgresAuthRepository.prototype) as PostgresAuthRepository;
    Object.assign(repository, { query, transaction });
    return repository;
  }

  async migrate() {
    await this.query(POSTGRES_AUTH_V1_MIGRATIONS[0]);
    const rows = await this.query(
      "SELECT version, checksum FROM into_auth_schema_migrations ORDER BY version"
    );
    const current = Number(rows.at(-1)?.version ?? 0);
    if (current > AUTH_SCHEMA_VERSION) {
      throw new AuthSchemaVersionError(
        `Auth database schema ${current} is newer than supported schema ${AUTH_SCHEMA_VERSION}.`
      );
    }
    for (const row of rows) {
      const version = Number(row.version);
      const valid = version === 1
        ? row.checksum === POSTGRES_AUTH_V1_CHECKSUM || row.checksum === SQLITE_AUTH_V1_CHECKSUM
        : version === 2
          ? row.checksum === POSTGRES_AUTH_V2_CHECKSUM
          : version === 3
            ? row.checksum === POSTGRES_AUTH_V3_CHECKSUM
            : version === 4
              ? row.checksum === POSTGRES_AUTH_V4_CHECKSUM
              : version === 5
                ? row.checksum === POSTGRES_AUTH_V5_CHECKSUM
                : version === 6
                  ? row.checksum === POSTGRES_AUTH_V6_CHECKSUM
                  : version === 7 && row.checksum === POSTGRES_AUTH_V7_CHECKSUM;
      if (!valid) {
        throw new AuthSchemaVersionError("Auth database migration checksum does not match this release.");
      }
    }
    if (current < 1) {
      await this.transaction([
        ...POSTGRES_AUTH_V1_MIGRATIONS.slice(1).map((query) => ({ query })),
        {
          query: `INSERT INTO into_auth_schema_migrations (version, checksum, applied_at)
                  VALUES ($1, $2, now()) ON CONFLICT(version) DO NOTHING`,
          parameters: [1, POSTGRES_AUTH_V1_CHECKSUM],
        },
      ]);
    }
    if (current < 2) {
      await this.assertStrictEmailInputs(false);
      await this.migrateCanonicalEmailV2();
    }
    if (current < 3) await this.migrateStrictEmailV3();
    if (current < 4) await this.migrateSessionVersionV4();
    if (current < 5) await this.migrateInvitationFingerprintV5();
    if (current < 6) await this.migrateLoginThrottleV6();
    if (current < 7) await this.removeLoginThrottleV7();
  }

  private async assertStrictEmailInputs(requireLowercase = true) {
    const invalid = await this.query(`
      SELECT id, email FROM into_auth_users
      WHERE email !~ '^[!-~]+$'
        OR (
          ${requireLowercase ? "email <> lower(email) OR" : ""}
          email !~ '^[^@]+@[^@]+$'
        )
      ORDER BY id
    `);
    if (invalid.length) {
      throw new AuthEmailValidationError(
        `Auth emails require visible ASCII and one @: ${invalid.map((row) => String(row.id)).join(", ")}.`
      );
    }
  }

  private async migrateCanonicalEmailV2() {
    const collisions = await this.query(`
      SELECT lower(btrim(email)) AS canonical_email, array_agg(id ORDER BY id) AS user_ids
      FROM into_auth_users
      GROUP BY lower(btrim(email))
      HAVING COUNT(*) > 1
      ORDER BY canonical_email
    `);
    if (collisions.length) {
      throw new AuthEmailNormalizationConflictError(
        `Auth email canonicalization conflicts: ${collisions
          .map((row) => `${String(row.canonical_email)} (${String(row.user_ids)})`)
          .join(", ")}.`
      );
    }
    await this.transaction([
      ...POSTGRES_AUTH_V2_MIGRATIONS.map((query) => ({ query })),
      {
        query: `INSERT INTO into_auth_schema_migrations (version, checksum, applied_at)
                VALUES ($1, $2, now()) ON CONFLICT(version) DO NOTHING`,
        parameters: [2, POSTGRES_AUTH_V2_CHECKSUM],
      },
    ]);
  }

  private async migrateStrictEmailV3() {
    await this.assertStrictEmailInputs();
    await this.transaction([
      ...POSTGRES_AUTH_V3_MIGRATIONS.map((query) => ({ query })),
      {
        query: `INSERT INTO into_auth_schema_migrations (version, checksum, applied_at)
                VALUES ($1, $2, now()) ON CONFLICT(version) DO NOTHING`,
        parameters: [3, POSTGRES_AUTH_V3_CHECKSUM],
      },
    ]);
  }

  private async migrateSessionVersionV4() {
    await this.transaction([
      ...POSTGRES_AUTH_V4_MIGRATIONS.map((query) => ({ query })),
      {
        query: `INSERT INTO into_auth_schema_migrations (version, checksum, applied_at)
                VALUES ($1, $2, now()) ON CONFLICT(version) DO NOTHING`,
        parameters: [4, POSTGRES_AUTH_V4_CHECKSUM],
      },
    ]);
  }

  private async migrateInvitationFingerprintV5() {
    await this.transaction([
      ...POSTGRES_AUTH_V5_MIGRATIONS.map((query) => ({ query })),
      {
        query: `INSERT INTO into_auth_schema_migrations (version, checksum, applied_at)
                VALUES ($1, $2, now()) ON CONFLICT(version) DO NOTHING`,
        parameters: [5, POSTGRES_AUTH_V5_CHECKSUM],
      },
    ]);
  }

  private async migrateLoginThrottleV6() {
    await this.transaction([
      ...POSTGRES_AUTH_V6_MIGRATIONS.map((query) => ({ query })),
      {
        query: `INSERT INTO into_auth_schema_migrations (version, checksum, applied_at)
                VALUES ($1, $2, now()) ON CONFLICT(version) DO NOTHING`,
        parameters: [6, POSTGRES_AUTH_V6_CHECKSUM],
      },
    ]);
  }

  private async removeLoginThrottleV7() {
    await this.transaction([
      ...POSTGRES_AUTH_V7_MIGRATIONS.map((query) => ({ query })),
      {
        query: `INSERT INTO into_auth_schema_migrations (version, checksum, applied_at)
                VALUES ($1, $2, now()) ON CONFLICT(version) DO NOTHING`,
        parameters: [7, POSTGRES_AUTH_V7_CHECKSUM],
      },
    ]);
  }

  async schemaVersion() {
    const rows = await this.query("SELECT MAX(version) AS version FROM into_auth_schema_migrations");
    return Number(rows[0]?.version ?? 0);
  }

  async listUsers() {
    const rows = await this.query("SELECT * FROM into_auth_users ORDER BY id");
    return rows.map((row): AuthUserRecord => ({
      id: String(row.id),
      email: String(row.email),
      displayName: String(row.display_name),
      status: row.status as AuthUserStatus,
      accessLevel: "verified_user",
      verifiedAt: row.verified_at ? iso(row.verified_at) : null,
      version: Number(row.version),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    }));
  }

  async upsertLegacyUsers(users: LegacyAuthUser[], timestamp: string) {
    const canonicalUsers = users.map((user) => ({
      ...user,
      email: canonicalAuthEmail(user.email),
    }));
    for (const user of canonicalUsers) {
      await this.query(`
        INSERT INTO into_auth_users (
          id, email, display_name, status, access_level, verified_at, version, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, 'verified_user', $5, 1, $6, $6)
        ON CONFLICT(id) DO UPDATE SET
          email = EXCLUDED.email,
          display_name = EXCLUDED.display_name,
          status = EXCLUDED.status,
          access_level = EXCLUDED.access_level,
          verified_at = EXCLUDED.verified_at,
          version = into_auth_users.version + 1,
          updated_at = EXCLUDED.updated_at
        WHERE into_auth_users.email IS DISTINCT FROM EXCLUDED.email
          OR into_auth_users.display_name IS DISTINCT FROM EXCLUDED.display_name
          OR into_auth_users.status IS DISTINCT FROM EXCLUDED.status
          OR into_auth_users.access_level IS DISTINCT FROM EXCLUDED.access_level
          OR into_auth_users.verified_at IS DISTINCT FROM EXCLUDED.verified_at
      `, [
        user.id,
        user.email,
        user.displayName,
        user.status,
        user.verifiedAt,
        timestamp,
      ]);
    }
  }

  async migrateLegacyUsers(
    snapshot: unknown,
    requestId: string,
    timestamp: string
  ): Promise<AuthMigrationReport> {
    const report = inventoryLegacyUsers(snapshot);
    await this.upsertLegacyUsers(report.users, timestamp);
    for (const user of report.users) {
      await this.query(`
        INSERT INTO into_auth_events (
          id, type, target_user_id, request_id, event_key, metadata_json, created_at
        ) VALUES ($1, 'legacy_identity_migrated', $2, $3, $4, $5::jsonb, $6)
        ON CONFLICT (event_key) DO NOTHING
      `, [
        `legacy_identity_migrated:${user.id}`,
        user.id,
        requestId,
        `legacy_identity_migrated:${user.id}`,
        JSON.stringify({ source: "raw_snapshot" }),
        timestamp,
      ]);
    }
    return report;
  }

  async createSession(session: AuthSessionRecord) {
    await this.query(`
      INSERT INTO into_auth_sessions (
        id, user_id, token_digest, correlation_id_hash, token_version,
        issued_at, expires_at, revoked_at, last_seen_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [
      session.id, session.userId, session.tokenDigest, session.correlationIdHash,
      session.tokenVersion, session.issuedAt, session.expiresAt, session.revokedAt, session.lastSeenAt,
    ]);
  }

  async findSessionByDigest(tokenDigest: string): Promise<AuthSessionWithUser | null> {
    const rows = await this.query(`
      SELECT s.*, u.email, u.display_name, u.status, u.access_level, u.verified_at,
        u.version, u.created_at, u.updated_at
      FROM into_auth_sessions s JOIN into_auth_users u ON u.id = s.user_id
      WHERE s.token_digest = $1 LIMIT 1
    `, [tokenDigest]);
    const row = rows[0];
    return row ? sessionWithUserFromRow(row) : null;
  }

  async findSessionById(sessionId: string): Promise<AuthSessionWithUser | null> {
    const rows = await this.query(`
      SELECT s.*, u.email, u.display_name, u.status, u.access_level, u.verified_at,
        u.version, u.created_at, u.updated_at
      FROM into_auth_sessions s JOIN into_auth_users u ON u.id = s.user_id
      WHERE s.id = $1 LIMIT 1
    `, [sessionId]);
    return rows[0] ? sessionWithUserFromRow(rows[0]) : null;
  }

  async touchSession(sessionId: string, timestamp: string, before: string) {
    const rows = await this.query(`
      UPDATE into_auth_sessions SET last_seen_at = $1
      WHERE id = $2 AND revoked_at IS NULL
        AND (last_seen_at IS NULL OR last_seen_at < $3)
      RETURNING id
    `, [timestamp, sessionId, before]);
    return rows.length === 1;
  }

  async revokeSessionByDigest(tokenDigest: string, timestamp: string) {
    const rows = await this.query(`
      UPDATE into_auth_sessions SET revoked_at = $1
      WHERE token_digest = $2 AND revoked_at IS NULL
      RETURNING id
    `, [timestamp, tokenDigest]);
    return rows.length === 1;
  }

  async createOrReplayInvitation(input: CreateInvitationInput) {
    const rows = await this.query(`
      WITH existing_invitation AS (
        SELECT * FROM into_auth_invitations WHERE idempotency_key = $8
      ), existing_user AS (
        SELECT id FROM into_auth_users WHERE email = $3
      ), user_insert AS (
        INSERT INTO into_auth_users (
          id, email, display_name, status, access_level, verified_at, version, created_at, updated_at
        ) SELECT $2, $3, $4, 'invited', 'verified_user', NULL, 1, $11, $11
        WHERE NOT EXISTS (SELECT 1 FROM existing_invitation)
        ON CONFLICT (email) DO UPDATE SET updated_at = into_auth_users.updated_at
        RETURNING id
      ), invitation_insert AS (
        INSERT INTO into_auth_invitations (
          id, user_id, token_digest, expires_at, consumed_at, inviter_actor_id,
          inviter_session_id, request_id, idempotency_key, request_fingerprint,
          created_at, updated_at
        ) SELECT $1, (SELECT id FROM user_insert LIMIT 1), $5, $6, NULL, $7,
          $9, $10, $8, $12, $11, $11
        WHERE NOT EXISTS (SELECT 1 FROM existing_invitation)
        ON CONFLICT (idempotency_key) DO UPDATE
          SET idempotency_key = EXCLUDED.idempotency_key
        RETURNING *
      ), invitation_result AS (
        SELECT CASE
          WHEN id = $1 THEN 'created'
          WHEN request_fingerprint = $12 THEN 'replayed'
          ELSE 'conflict' END AS state, invitation_insert.*
        FROM invitation_insert
        UNION ALL
        SELECT CASE WHEN request_fingerprint = $12 THEN 'replayed' ELSE 'conflict' END,
          existing_invitation.* FROM existing_invitation
        WHERE NOT EXISTS (SELECT 1 FROM invitation_insert)
      ), user_cleanup AS (
        DELETE FROM into_auth_users u
        WHERE u.id = $2
          AND NOT EXISTS (SELECT 1 FROM existing_user)
          AND EXISTS (SELECT 1 FROM invitation_result WHERE state = 'conflict')
          AND NOT EXISTS (SELECT 1 FROM into_auth_invitations WHERE user_id = u.id)
        RETURNING u.id
      ), event_insert AS (
        INSERT INTO into_auth_events (
          id, type, actor_id, target_user_id, request_id, session_id,
          event_key, metadata_json, created_at
        ) SELECT 'invitation_created:' || id, 'invitation_created', $7, user_id,
          $10, $9, 'invitation_created:' || id, '{}'::jsonb, $11
        FROM invitation_result WHERE state = 'created'
        ON CONFLICT (event_key) DO NOTHING
      )
      SELECT * FROM invitation_result
      LIMIT 1
    `, [
      input.id, input.userId, canonicalAuthEmail(input.email), input.displayName,
      input.tokenDigest, input.expiresAt, input.inviterActorId, input.idempotencyKey,
      input.inviterSessionId, input.requestId, input.timestamp, input.requestFingerprint,
    ]);
    const row = rows[0];
    if (!row) throw new Error("Invitation command did not return a result.");
    return {
      state: row.state as "created" | "replayed" | "conflict",
      invitation: invitationFromRow(row),
    };
  }

  async consumeInvitation(input: ConsumeInvitationInput) {
    const rows = await this.query(`
      WITH candidate_invitation AS (
        SELECT i.id, i.user_id FROM into_auth_invitations i
        JOIN into_auth_users u ON u.id = i.user_id
        WHERE i.token_digest = $1 AND i.consumed_at IS NULL
          AND i.expires_at > $2 AND u.status = 'invited'
        FOR UPDATE
      ), credential_insert AS (
        INSERT INTO into_auth_credentials (
          user_id, scrypt_hash, scrypt_salt, scrypt_n, scrypt_r, scrypt_p,
          scrypt_version, failed_attempts, locked_at, rotated_at, created_at, updated_at
        ) SELECT user_id, $3, $4, $5, $6, $7, $8, 0, NULL, NULL, $2, $2
        FROM candidate_invitation RETURNING user_id
      ), user_update AS (
        UPDATE into_auth_users u SET display_name = $9, status = 'active',
          verified_at = $2, version = u.version + 1, updated_at = $2
        FROM credential_insert c WHERE u.id = c.user_id RETURNING u.*
      ), invitation_update AS (
        UPDATE into_auth_invitations i SET consumed_at = $2, updated_at = $2
        FROM candidate_invitation c WHERE i.id = c.id RETURNING i.id
      ), session_insert AS (
        INSERT INTO into_auth_sessions (
          id, user_id, token_digest, correlation_id_hash, token_version,
          issued_at, expires_at, revoked_at, last_seen_at
        ) SELECT $10, id, $11, $12, $13, $14, $15, $16, $17 FROM user_update
        RETURNING id, user_id
      ), event_insert AS (
        INSERT INTO into_auth_events (
          id, type, target_user_id, request_id, session_id, event_key, metadata_json, created_at
        ) SELECT 'invitation_consumed:' || i.id, 'invitation_consumed', s.user_id,
          $18, s.id, 'invitation_consumed:' || i.id, '{}'::jsonb, $2
        FROM invitation_update i CROSS JOIN session_insert s
        ON CONFLICT (event_key) DO NOTHING
      )
      SELECT 'consumed' AS state, user_update.* FROM user_update
    `, [
      input.tokenDigest, input.timestamp, input.credential.hash, input.credential.salt,
      input.credential.n, input.credential.r, input.credential.p, input.credential.version,
      input.displayName, input.session.id, input.session.tokenDigest,
      input.session.correlationIdHash, input.session.tokenVersion, input.session.issuedAt,
      input.session.expiresAt, input.session.revokedAt, input.session.lastSeenAt, input.requestId,
    ]);
    return rows[0]
      ? { state: "consumed" as const, user: userFromRow(rows[0]) }
      : { state: "gone" as const, user: null };
  }

  async findUserCredentialByEmail(email: string) {
    const rows = await this.query(`
      SELECT u.*, c.scrypt_hash, c.scrypt_salt, c.scrypt_n, c.scrypt_r,
        c.scrypt_p, c.scrypt_version, c.failed_attempts, c.locked_at
      FROM into_auth_users u JOIN into_auth_credentials c ON c.user_id = u.id
      WHERE u.email = $1 LIMIT 1
    `, [canonicalAuthEmail(email)]);
    const row = rows[0];
    if (!row) return null;
    return {
      user: userFromRow(row),
      credential: {
        algorithm: "scrypt" as const,
        version: Number(row.scrypt_version) as 1,
        hash: String(row.scrypt_hash), salt: String(row.scrypt_salt),
        n: Number(row.scrypt_n), r: Number(row.scrypt_r), p: Number(row.scrypt_p),
      },
      failedAttempts: Number(row.failed_attempts),
      lockedAt: row.locked_at ? iso(row.locked_at) : null,
    };
  }

  async countActiveUsers() {
    const rows = await this.query(
      "SELECT COUNT(*) AS count FROM into_auth_users WHERE status = 'active' AND verified_at IS NOT NULL"
    );
    return Number(rows[0]?.count ?? 0);
  }

  async updateUserStatus(input: UpdateUserStatusInput) {
    const rows = await this.query(`
      WITH locked_active_users AS MATERIALIZED (
        SELECT u.* FROM into_auth_users u
        WHERE u.status = 'active' AND u.verified_at IS NOT NULL
        ORDER BY u.id
        FOR UPDATE OF u
      ), target_user AS (
        SELECT u.* FROM into_auth_users u
        CROSS JOIN (SELECT COUNT(*) AS ignored FROM locked_active_users) active_guard
        WHERE u.id = $1 FOR UPDATE OF u
      ), active_others AS (
        SELECT COUNT(*)::integer AS count FROM locked_active_users WHERE id <> $1
      ), decision AS (
        SELECT CASE
          WHEN t.version <> $2 THEN 'conflict'
          WHEN $3 = 'active' AND t.verified_at IS NULL THEN 'unverified'
          WHEN $3 = 'disabled' AND t.status = 'active' AND a.count = 0 THEN 'final_active'
          ELSE 'updated' END AS state
        FROM target_user t CROSS JOIN active_others a
      ), user_update AS (
        UPDATE into_auth_users u SET status = $3, version = u.version + 1, updated_at = $4
        FROM decision d WHERE u.id = $1 AND d.state = 'updated' AND u.status IS DISTINCT FROM $3
        RETURNING u.*
      ), event_insert AS (
        INSERT INTO into_auth_events (
          id, type, actor_id, target_user_id, request_id, session_id,
          event_key, metadata_json, created_at
        ) SELECT 'user_status:' || $6, 'user_status_changed', $5, $1, $6, $7,
          'user_status:' || $6, jsonb_build_object('status', $3), $4
        FROM user_update ON CONFLICT (event_key) DO NOTHING
      )
      SELECT d.state, COALESCE(u.id, t.id) AS id, COALESCE(u.email, t.email) AS email,
        COALESCE(u.display_name, t.display_name) AS display_name,
        COALESCE(u.status, t.status) AS status, COALESCE(u.verified_at, t.verified_at) AS verified_at,
        COALESCE(u.version, t.version) AS version, COALESCE(u.created_at, t.created_at) AS created_at,
        COALESCE(u.updated_at, t.updated_at) AS updated_at
      FROM decision d CROSS JOIN target_user t LEFT JOIN user_update u ON true
      UNION ALL SELECT 'not_found', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
      WHERE NOT EXISTS (SELECT 1 FROM target_user)
    `, [
      input.targetId, input.expectedVersion, input.status, input.timestamp,
      input.actorId, input.requestId, input.sessionId,
    ]);
    const row = rows[0];
    return {
      state: row?.state as "updated" | "conflict" | "not_found" | "final_active" | "unverified",
      user: row?.id ? userFromRow(row) : null,
    };
  }

  async recordLoginFailure(
    userId: string,
    timestamp: string,
    lockAfter: number,
    lockUntil: string,
    context?: { requestId: string; sourceHash?: string | null }
  ) {
    const rows = await this.query(`
      WITH credential_update AS (
        UPDATE into_auth_credentials SET
          failed_attempts = LEAST(failed_attempts + 1, $3),
          locked_at = CASE WHEN failed_attempts + 1 >= $3 THEN $4::timestamptz ELSE locked_at END,
          updated_at = $2
        WHERE user_id = $1
        RETURNING failed_attempts, locked_at
      ), event_insert AS (
        INSERT INTO into_auth_events (
          id, type, target_user_id, request_id, event_key, metadata_json, created_at
        ) SELECT 'login_failed:' || $1, 'login_failed', $1, $5,
          'login_failed:' || $1,
          CASE WHEN $6::text IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('sourceHash', $6::text) END,
          $2 FROM credential_update WHERE $5 IS NOT NULL
        ON CONFLICT (id) DO UPDATE SET
          request_id = excluded.request_id,
          metadata_json = excluded.metadata_json,
          created_at = excluded.created_at
      ) SELECT * FROM credential_update
    `, [
      userId, timestamp, lockAfter, lockUntil,
      context?.requestId ?? null, context?.sourceHash ?? null,
    ]);
    return {
      failedAttempts: Number(rows[0]?.failed_attempts ?? 0),
      lockedAt: rows[0]?.locked_at ? iso(rows[0].locked_at) : null,
    };
  }

  async resetLoginFailures(userId: string, timestamp: string) {
    await this.query(`
      UPDATE into_auth_credentials SET failed_attempts = 0, locked_at = NULL, updated_at = $2
      WHERE user_id = $1
    `, [userId, timestamp]);
  }
}

function invitationFromRow(row: Record<string, unknown>): AuthInvitationRecord {
  return {
    id: String(row.id), userId: String(row.user_id), tokenDigest: String(row.token_digest),
    expiresAt: iso(row.expires_at), consumedAt: row.consumed_at ? iso(row.consumed_at) : null,
    idempotencyKey: String(row.idempotency_key), requestFingerprint: String(row.request_fingerprint),
    createdAt: iso(row.created_at),
  };
}

function userFromRow(row: Record<string, unknown>): AuthUserRecord {
  return {
    id: String(row.id), email: String(row.email), displayName: String(row.display_name),
    status: row.status as AuthUserStatus, accessLevel: "verified_user",
    verifiedAt: row.verified_at ? iso(row.verified_at) : null,
    version: Number(row.version), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

function sessionWithUserFromRow(row: Record<string, unknown>): AuthSessionWithUser {
  return {
    id: String(row.id), userId: String(row.user_id), tokenDigest: String(row.token_digest),
    correlationIdHash: String(row.correlation_id_hash), tokenVersion: Number(row.token_version),
    issuedAt: iso(row.issued_at), expiresAt: iso(row.expires_at),
    revokedAt: row.revoked_at ? iso(row.revoked_at) : null,
    lastSeenAt: row.last_seen_at ? iso(row.last_seen_at) : null,
    user: {
      id: String(row.user_id), email: String(row.email), displayName: String(row.display_name),
      status: row.status as AuthUserStatus, accessLevel: "verified_user",
      verifiedAt: row.verified_at ? iso(row.verified_at) : null,
      version: Number(row.version), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    },
  };
}
