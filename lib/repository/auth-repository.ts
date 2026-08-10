import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const AUTH_SCHEMA_VERSION = 2;

export type AuthUserStatus = "invited" | "active" | "disabled";
export type AuthUserRecord = {
  id: string;
  email: string;
  displayName: string;
  status: AuthUserStatus;
  accessLevel: "verified_user";
  verifiedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type LegacyAuthUser = Omit<AuthUserRecord, "version" | "createdAt" | "updatedAt">;
export type LegacyUserInventory = {
  users: LegacyAuthUser[];
  unknown: string[];
  excludedHistorical: string[];
};

export type AuthMigrationReport = LegacyUserInventory;

export class AuthSchemaVersionError extends Error {}
export class AuthEmailNormalizationConflictError extends Error {}

const migrationTable = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS into_auth_schema_migrations (
    version INTEGER PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  );
`;

const sqliteV1Schema = `
  CREATE TABLE IF NOT EXISTS into_auth_users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    display_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('invited', 'active', 'disabled')),
    access_level TEXT NOT NULL CHECK (access_level = 'verified_user'),
    verified_at TEXT,
    version INTEGER NOT NULL CHECK (version > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS into_auth_credentials (
    user_id TEXT PRIMARY KEY REFERENCES into_auth_users(id),
    scrypt_hash TEXT NOT NULL,
    scrypt_salt TEXT NOT NULL,
    scrypt_n INTEGER NOT NULL,
    scrypt_r INTEGER NOT NULL,
    scrypt_p INTEGER NOT NULL,
    scrypt_version INTEGER NOT NULL,
    failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
    locked_at TEXT,
    rotated_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS into_auth_invitations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES into_auth_users(id),
    token_digest TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    inviter_actor_id TEXT,
    inviter_session_id TEXT,
    request_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS into_auth_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES into_auth_users(id),
    token_digest TEXT NOT NULL UNIQUE,
    correlation_id_hash TEXT NOT NULL,
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    last_seen_at TEXT
  );
  CREATE INDEX IF NOT EXISTS into_auth_sessions_user_idx
    ON into_auth_sessions (user_id, expires_at);
  CREATE TABLE IF NOT EXISTS into_auth_events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    actor_id TEXT,
    target_user_id TEXT,
    request_id TEXT,
    session_id TEXT,
    event_key TEXT NOT NULL UNIQUE,
    metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS into_auth_events_target_idx
    ON into_auth_events (target_user_id, created_at);
`;

const sqliteV2Schema = `
  CREATE TABLE into_auth_users_next (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (email = lower(trim(email))),
    display_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('invited', 'active', 'disabled')),
    access_level TEXT NOT NULL CHECK (access_level = 'verified_user'),
    verified_at TEXT,
    version INTEGER NOT NULL CHECK (version > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  INSERT INTO into_auth_users_next (
    id, email, display_name, status, access_level, verified_at, version, created_at, updated_at
  ) SELECT
    id, lower(trim(email)), display_name, status, access_level, verified_at, version, created_at, updated_at
  FROM into_auth_users;
  DROP TABLE into_auth_users;
  ALTER TABLE into_auth_users_next RENAME TO into_auth_users;
`;

export const SQLITE_AUTH_V1_CHECKSUM = createHash("sha256")
  .update(sqliteV1Schema)
  .digest("hex");
export const SQLITE_AUTH_V2_CHECKSUM = createHash("sha256")
  .update(`2\n${sqliteV2Schema}`)
  .digest("hex");
/** @deprecated Use the version-specific checksum. */
export const AUTH_MIGRATION_CHECKSUM = SQLITE_AUTH_V2_CHECKSUM;

export function canonicalAuthEmail(email: string) {
  return email.trim().toLowerCase();
}

const authTables = [
  "into_auth_credentials",
  "into_auth_events",
  "into_auth_invitations",
  "into_auth_schema_migrations",
  "into_auth_sessions",
  "into_auth_users",
] as const;

function legacyValue(record: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function legacyRows(snapshot: unknown) {
  if (!snapshot || typeof snapshot !== "object") return [];
  const users = (snapshot as { users?: unknown }).users;
  return Array.isArray(users)
    ? users.filter((user): user is Record<string, unknown> => Boolean(user) && typeof user === "object")
    : [];
}

export function mapLegacyRole(role: unknown) {
  const normalized = typeof role === "string" ? role.trim().toLowerCase() : "";
  return ["admin", "accountant", "reviewer", "viewer"].includes(normalized)
    ? "verified_user"
    : null;
}

export function inventoryLegacyUsers(snapshot: unknown): LegacyUserInventory {
  const raw = typeof snapshot === "string" ? JSON.parse(snapshot) : snapshot;
  const users: LegacyAuthUser[] = [];
  const unknown: string[] = [];
  const excludedHistorical: string[] = [];

  for (const [index, row] of legacyRows(raw).entries()) {
    const id = legacyValue(row, "id") ?? `row:${index}`;
    if (id === "shared_user") {
      excludedHistorical.push(id);
      continue;
    }
    if (!mapLegacyRole(row.role)) {
      unknown.push(id);
      continue;
    }
    const rawEmail = legacyValue(row, "email");
    const email = rawEmail ? canonicalAuthEmail(rawEmail) : null;
    if (!email) {
      unknown.push(id);
      continue;
    }
    const verifiedAt = legacyValue(row, "verifiedAt", "verified_at", "verificationTimestamp");
    const disabled = legacyValue(row, "status")?.toLowerCase() === "disabled";
    users.push({
      id,
      email,
      displayName: legacyValue(row, "displayName", "name") ?? email,
      status: disabled ? "disabled" : verifiedAt ? "active" : "invited",
      accessLevel: "verified_user",
      verifiedAt: verifiedAt ?? null,
    });
  }

  const usersById = new Map(users.map((user) => [user.id, user]));
  return {
    users: [...usersById.values()].sort((left, right) => left.id.localeCompare(right.id)),
    unknown: [...new Set(unknown)].sort(),
    excludedHistorical: [...new Set(excludedHistorical)].sort(),
  };
}

export function inventoryRawSqliteSnapshot(databasePath: string) {
  const database = new DatabaseSync(databasePath);
  try {
    const runtimeTable = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("into_runtime_store");
    const snapshot = runtimeTable
      ? database
          .prepare("SELECT payload FROM into_runtime_store WHERE id = ? LIMIT 1")
          .get("company") as { payload?: string } | undefined
      : undefined;
    const rawUsers = snapshot?.payload ? legacyRows(JSON.parse(snapshot.payload)) : [];
    const usersTable = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("users");
    if (usersTable) {
      const columns = database.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
      const names = new Set(columns.map((column) => column.name));
      if (names.has("id") && names.has("email") && names.has("role")) {
        const optional = (name: string) => names.has(name) ? `, ${name}` : "";
        const normalized = database.prepare(
          `SELECT id, email, role${optional("name")}${optional("display_name")}\n           ${optional("status")}${optional("verified_at")} FROM users`
        ).all() as Array<Record<string, unknown>>;
        rawUsers.push(...normalized.map((row) => ({
          id: row.id,
          email: row.email,
          role: row.role,
          name: row.name ?? row.display_name,
          status: row.status,
          verifiedAt: row.verified_at,
        })));
      }
    }
    return inventoryLegacyUsers({ users: rawUsers });
  } finally {
    database.close();
  }
}

export interface AuthRepository {
  migrate(): Promise<void>;
  schemaVersion(): Promise<number>;
  listUsers(): Promise<AuthUserRecord[]>;
  upsertLegacyUsers(users: LegacyAuthUser[], timestamp: string): Promise<void>;
  migrateLegacyUsers(
    snapshot: unknown,
    requestId: string,
    timestamp: string
  ): Promise<AuthMigrationReport>;
}

export class SqliteAuthRepository implements AuthRepository {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    const path = resolve(databasePath);
    mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
  }

  async migrate() {
    this.database.exec(migrationTable);
    const rows = this.database.prepare(
      "SELECT version, checksum FROM into_auth_schema_migrations ORDER BY version"
    ).all() as Array<{ version: number; checksum: string }>;
    const current = Number(rows.at(-1)?.version ?? 0);
    if (current > AUTH_SCHEMA_VERSION) {
      throw new AuthSchemaVersionError(
        `Auth database schema ${current} is newer than supported schema ${AUTH_SCHEMA_VERSION}.`
      );
    }
    const checksums = new Map([
      [1, SQLITE_AUTH_V1_CHECKSUM],
      [2, SQLITE_AUTH_V2_CHECKSUM],
    ]);
    for (const row of rows) {
      if (checksums.get(Number(row.version)) !== row.checksum) {
        throw new AuthSchemaVersionError("Auth database migration checksum does not match this release.");
      }
    }
    if (current < 1) {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(sqliteV1Schema);
        this.database.prepare(
          "INSERT INTO into_auth_schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)"
        ).run(1, SQLITE_AUTH_V1_CHECKSUM, new Date().toISOString());
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    if (current < 2) this.migrateCanonicalEmailV2();
  }

  private migrateCanonicalEmailV2() {
    const collisions = this.database.prepare(`
      SELECT lower(trim(email)) AS canonical_email, group_concat(id, ',') AS user_ids
      FROM into_auth_users
      GROUP BY lower(trim(email))
      HAVING COUNT(*) > 1
      ORDER BY canonical_email
    `).all() as Array<{ canonical_email: string; user_ids: string }>;
    if (collisions.length) {
      throw new AuthEmailNormalizationConflictError(
        `Auth email canonicalization conflicts: ${collisions
          .map((row) => `${row.canonical_email} (${row.user_ids})`)
          .join(", ")}.`
      );
    }
    this.database.exec("PRAGMA foreign_keys = OFF");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.exec(sqliteV2Schema);
      this.database.prepare(
        "INSERT INTO into_auth_schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)"
      ).run(2, SQLITE_AUTH_V2_CHECKSUM, new Date().toISOString());
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    } finally {
      this.database.exec("PRAGMA foreign_keys = ON");
    }
  }

  async schemaVersion() {
    const migration = this.database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'into_auth_schema_migrations'"
    ).get();
    if (!migration) return 0;
    const row = this.database.prepare(
      "SELECT MAX(version) AS version FROM into_auth_schema_migrations"
    ).get() as { version?: number } | undefined;
    return Number(row?.version ?? 0);
  }

  async tableNames() {
    return (this.database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'into_auth_%' ORDER BY name"
    ).all() as Array<{ name: string }>).map((row) => row.name);
  }

  async schemaSql() {
    return (this.database.prepare(
      "SELECT sql FROM sqlite_master WHERE name LIKE 'into_auth_%' ORDER BY name"
    ).all() as Array<{ sql: string | null }>).map((row) => row.sql ?? "").join("\n");
  }

  async listUsers() {
    const rows = this.database.prepare(
      "SELECT * FROM into_auth_users ORDER BY id"
    ).all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      email: String(row.email),
      displayName: String(row.display_name),
      status: row.status as AuthUserStatus,
      accessLevel: "verified_user" as const,
      verifiedAt: row.verified_at ? String(row.verified_at) : null,
      version: Number(row.version),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
  }

  async upsertLegacyUsers(users: LegacyAuthUser[], timestamp: string) {
    const statement = this.database.prepare(`
      INSERT INTO into_auth_users (
        id, email, display_name, status, access_level, verified_at, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'verified_user', ?, 1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        email = excluded.email,
        display_name = excluded.display_name,
        status = excluded.status,
        access_level = excluded.access_level,
        verified_at = excluded.verified_at,
        version = into_auth_users.version + 1,
        updated_at = excluded.updated_at
      WHERE into_auth_users.email IS NOT excluded.email
        OR into_auth_users.display_name IS NOT excluded.display_name
        OR into_auth_users.status IS NOT excluded.status
        OR into_auth_users.access_level IS NOT excluded.access_level
        OR into_auth_users.verified_at IS NOT excluded.verified_at
    `);
    for (const user of users) {
      statement.run(
        user.id,
        canonicalAuthEmail(user.email),
        user.displayName,
        user.status,
        user.verifiedAt,
        timestamp,
        timestamp
      );
    }
  }

  async migrateLegacyUsers(snapshot: unknown, requestId: string, timestamp: string) {
    const report = inventoryLegacyUsers(snapshot);
    await this.upsertLegacyUsers(report.users, timestamp);
    const event = this.database.prepare(`
      INSERT OR IGNORE INTO into_auth_events (
        id, type, target_user_id, request_id, event_key, metadata_json, created_at
      ) VALUES (?, 'legacy_identity_migrated', ?, ?, ?, ?, ?)
    `);
    for (const user of report.users) {
      event.run(
        `legacy_identity_migrated:${user.id}`,
        user.id,
        requestId,
        `legacy_identity_migrated:${user.id}`,
        JSON.stringify({ source: "raw_snapshot" }),
        timestamp
      );
    }
    return report;
  }

  async migrateLegacySnapshot(snapshot: unknown, requestId: string, timestamp: string) {
    return this.migrateLegacyUsers(snapshot, requestId, timestamp);
  }

  async countRows(table: (typeof authTables)[number]) {
    if (!authTables.includes(table)) throw new Error("Unsupported auth table.");
    const row = this.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    return Number(row.count);
  }

  close() {
    this.database.close();
  }
}
