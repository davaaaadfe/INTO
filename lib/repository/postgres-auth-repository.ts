import { neon } from "@neondatabase/serverless";
import { createHash } from "node:crypto";
import {
  AUTH_SCHEMA_VERSION,
  AuthSchemaVersionError,
  canonicalAuthEmail,
  inventoryLegacyUsers,
  type AuthRepository,
  type AuthMigrationReport,
  type AuthUserRecord,
  type AuthUserStatus,
  type LegacyAuthUser,
} from "./auth-repository";

export const POSTGRES_AUTH_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS into_auth_schema_migrations (
    version integer PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS into_auth_users (
    id text PRIMARY KEY,
    email text NOT NULL UNIQUE CHECK (email = lower(btrim(email))),
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

export const POSTGRES_AUTH_MIGRATION_CHECKSUM = createHash("sha256")
  .update(`${AUTH_SCHEMA_VERSION}\n${POSTGRES_AUTH_MIGRATIONS.join("\n")}`)
  .digest("hex");

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
    await this.query(POSTGRES_AUTH_MIGRATIONS[0]);
    const rows = await this.query(
      "SELECT version, checksum FROM into_auth_schema_migrations ORDER BY version DESC LIMIT 1"
    );
    const current = Number(rows[0]?.version ?? 0);
    if (current > AUTH_SCHEMA_VERSION) {
      throw new AuthSchemaVersionError(
        `Auth database schema ${current} is newer than supported schema ${AUTH_SCHEMA_VERSION}.`
      );
    }
    if (
      current === AUTH_SCHEMA_VERSION &&
      rows[0]?.checksum !== POSTGRES_AUTH_MIGRATION_CHECKSUM
    ) {
      throw new AuthSchemaVersionError("Auth database migration checksum does not match this release.");
    }
    if (current < AUTH_SCHEMA_VERSION) {
      await this.transaction([
        ...POSTGRES_AUTH_MIGRATIONS.slice(1).map((query) => ({ query })),
        {
          query: `INSERT INTO into_auth_schema_migrations (version, checksum, applied_at)
                  VALUES ($1, $2, now()) ON CONFLICT(version) DO NOTHING`,
          parameters: [AUTH_SCHEMA_VERSION, POSTGRES_AUTH_MIGRATION_CHECKSUM],
        },
      ]);
    }
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
    for (const user of users) {
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
        canonicalAuthEmail(user.email),
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
}
