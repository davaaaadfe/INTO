import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const AUTH_SCHEMA_VERSION = 6;

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

export type AuthSessionRecord = {
  id: string;
  userId: string;
  tokenDigest: string;
  correlationIdHash: string;
  tokenVersion: number;
  issuedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastSeenAt: string | null;
};

export type AuthSessionWithUser = AuthSessionRecord & { user: AuthUserRecord };

export type StoredPasswordCredential = Readonly<{
  algorithm: "scrypt";
  version: 1;
  hash: string;
  salt: string;
  n: number;
  r: number;
  p: number;
}>;

export type AuthInvitationRecord = {
  id: string;
  userId: string;
  tokenDigest: string;
  expiresAt: string;
  consumedAt: string | null;
  idempotencyKey: string;
  requestFingerprint: string;
  createdAt: string;
};

export type CreateInvitationInput = {
  id: string;
  userId: string;
  email: string;
  displayName: string;
  tokenDigest: string;
  expiresAt: string;
  inviterActorId: string;
  inviterSessionId: string;
  requestId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  timestamp: string;
};

export type ConsumeInvitationInput = {
  tokenDigest: string;
  displayName: string;
  credential: StoredPasswordCredential;
  session: AuthSessionRecord;
  requestId: string;
  timestamp: string;
};

export type UpdateUserStatusInput = {
  actorId: string;
  targetId: string;
  expectedVersion: number;
  status: "active" | "disabled";
  requestId: string;
  sessionId: string;
  timestamp: string;
};

export class AuthSchemaVersionError extends Error {}
export class AuthEmailNormalizationConflictError extends Error {}
export class AuthEmailValidationError extends Error {}

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

const sqliteV3Schema = `
  CREATE TABLE into_auth_users_next (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (
      email NOT GLOB '*[^!-~]*'
      AND email = lower(email)
      AND instr(email, '@') > 1
      AND instr(email, '@') < length(email)
      AND instr(substr(email, instr(email, '@') + 1), '@') = 0
    ),
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
    id, email, display_name, status, access_level, verified_at, version, created_at, updated_at
  FROM into_auth_users;
  DROP TABLE into_auth_users;
  ALTER TABLE into_auth_users_next RENAME TO into_auth_users;
`;

const sqliteV4Schema = `
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
  ALTER TABLE into_auth_sessions
    ADD COLUMN token_version INTEGER NOT NULL DEFAULT 1 CHECK (token_version = 1);
`;

const sqliteV5Schema = `
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
  ALTER TABLE into_auth_invitations
    ADD COLUMN request_fingerprint TEXT NOT NULL DEFAULT '';
`;

const sqliteV6Schema = `
  CREATE TABLE IF NOT EXISTS into_auth_login_throttles (
    scope_hash TEXT PRIMARY KEY,
    failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
    locked_at TEXT,
    updated_at TEXT NOT NULL
  );
`;

export const SQLITE_AUTH_V1_CHECKSUM = createHash("sha256")
  .update(sqliteV1Schema)
  .digest("hex");
export const SQLITE_AUTH_V2_CHECKSUM = createHash("sha256")
  .update(`2\n${sqliteV2Schema}`)
  .digest("hex");
export const SQLITE_AUTH_V3_CHECKSUM = createHash("sha256")
  .update(`3\n${sqliteV3Schema}`)
  .digest("hex");
export const SQLITE_AUTH_V4_CHECKSUM = createHash("sha256")
  .update(`4\n${sqliteV4Schema}`)
  .digest("hex");
export const SQLITE_AUTH_V5_CHECKSUM = createHash("sha256")
  .update(`5\n${sqliteV5Schema}`)
  .digest("hex");
export const SQLITE_AUTH_V6_CHECKSUM = createHash("sha256")
  .update(`6\n${sqliteV6Schema}`)
  .digest("hex");
/** @deprecated Use the version-specific checksum. */
export const AUTH_MIGRATION_CHECKSUM = SQLITE_AUTH_V2_CHECKSUM;

export function canonicalAuthEmail(email: string) {
  if (!/^[!-~]+$/.test(email) || !/^[^@]+@[^@]+$/.test(email)) {
    throw new AuthEmailValidationError("Auth email must use visible ASCII characters and one @.");
  }
  return email.replace(/[A-Z]/g, (character) =>
    String.fromCharCode(character.charCodeAt(0) + 32)
  );
}

const authTables = [
  "into_auth_credentials",
  "into_auth_events",
  "into_auth_invitations",
  "into_auth_login_throttles",
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

function legacyRawValue(record: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
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
    const rawEmail = legacyRawValue(row, "email");
    let email: string | null = null;
    try {
      email = rawEmail ? canonicalAuthEmail(rawEmail) : null;
    } catch {
      unknown.push(id);
      continue;
    }
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
  createSession(session: AuthSessionRecord): Promise<void>;
  findSessionByDigest(tokenDigest: string): Promise<AuthSessionWithUser | null>;
  touchSession(sessionId: string, timestamp: string, before: string): Promise<boolean>;
  revokeSessionByDigest(tokenDigest: string, timestamp: string): Promise<boolean>;
  createOrReplayInvitation(input: CreateInvitationInput): Promise<{
    state: "created" | "replayed" | "conflict";
    invitation: AuthInvitationRecord;
  }>;
  consumeInvitation(input: ConsumeInvitationInput): Promise<{
    state: "consumed" | "gone";
    user: AuthUserRecord | null;
  }>;
  findUserCredentialByEmail(email: string): Promise<{
    user: AuthUserRecord;
    credential: StoredPasswordCredential;
    failedAttempts: number;
    lockedAt: string | null;
  } | null>;
  countActiveUsers(): Promise<number>;
  updateUserStatus(input: UpdateUserStatusInput): Promise<{
    state: "updated" | "conflict" | "not_found" | "final_active" | "unverified";
    user: AuthUserRecord | null;
  }>;
  recordLoginFailure(
    scopeHash: string,
    timestamp: string,
    lockAfter: number,
    context?: { requestId: string; targetUserId?: string; sourceHash?: string | null }
  ): Promise<{
    failedAttempts: number;
    lockedAt: string | null;
  }>;
  findLoginThrottle(scopeHash: string): Promise<{
    failedAttempts: number;
    lockedAt: string | null;
  } | null>;
  resetLoginFailures(scopeHash: string, timestamp: string): Promise<void>;
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
      [3, SQLITE_AUTH_V3_CHECKSUM],
      [4, SQLITE_AUTH_V4_CHECKSUM],
      [5, SQLITE_AUTH_V5_CHECKSUM],
      [6, SQLITE_AUTH_V6_CHECKSUM],
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
    if (current < 2) {
      this.assertStrictEmailInputs(false);
      this.migrateCanonicalEmailV2();
    }
    if (current < 3) this.migrateStrictEmailV3();
    if (current < 4) this.migrateSessionVersionV4();
    if (current < 5) this.migrateInvitationFingerprintV5();
    if (current < 6) this.migrateLoginThrottleV6();
  }

  private assertStrictEmailInputs(requireLowercase = true) {
    const invalid = this.database.prepare(`
      SELECT id, email FROM into_auth_users
      WHERE email GLOB '*[^!-~]*'
        OR (
          ${requireLowercase ? "email <> lower(email) OR" : ""}
          instr(email, '@') <= 1
        OR instr(email, '@') >= length(email)
        OR instr(substr(email, instr(email, '@') + 1), '@') <> 0)
      ORDER BY id
    `).all() as Array<{ id: string; email: string }>;
    if (invalid.length) {
      throw new AuthEmailValidationError(
        `Auth emails require visible ASCII and one @: ${invalid.map((row) => row.id).join(", ")}.`
      );
    }
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

  private migrateStrictEmailV3() {
    this.assertStrictEmailInputs();
    this.database.exec("PRAGMA foreign_keys = OFF");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.exec(sqliteV3Schema);
      this.database.prepare(
        "INSERT INTO into_auth_schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)"
      ).run(3, SQLITE_AUTH_V3_CHECKSUM, new Date().toISOString());
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    } finally {
      this.database.exec("PRAGMA foreign_keys = ON");
    }
  }

  private migrateSessionVersionV4() {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.exec(sqliteV4Schema);
      this.database.prepare(
        "INSERT INTO into_auth_schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)"
      ).run(4, SQLITE_AUTH_V4_CHECKSUM, new Date().toISOString());
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private migrateInvitationFingerprintV5() {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.exec(sqliteV5Schema);
      this.database.prepare(
        "INSERT INTO into_auth_schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)"
      ).run(5, SQLITE_AUTH_V5_CHECKSUM, new Date().toISOString());
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private migrateLoginThrottleV6() {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.exec(sqliteV6Schema);
      this.database.prepare(
        "INSERT INTO into_auth_schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)"
      ).run(6, SQLITE_AUTH_V6_CHECKSUM, new Date().toISOString());
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
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
    const canonicalUsers = users.map((user) => ({
      ...user,
      email: canonicalAuthEmail(user.email),
    }));
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
    for (const user of canonicalUsers) {
      statement.run(
        user.id,
        user.email,
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

  async createSession(session: AuthSessionRecord) {
    this.database.prepare(`
      INSERT INTO into_auth_sessions (
        id, user_id, token_digest, correlation_id_hash, token_version,
        issued_at, expires_at, revoked_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.id, session.userId, session.tokenDigest, session.correlationIdHash,
      session.tokenVersion, session.issuedAt, session.expiresAt, session.revokedAt, session.lastSeenAt
    );
  }

  async findSessionByDigest(tokenDigest: string): Promise<AuthSessionWithUser | null> {
    const row = this.database.prepare(`
      SELECT s.*, u.email, u.display_name, u.status, u.access_level, u.verified_at,
        u.version, u.created_at, u.updated_at
      FROM into_auth_sessions s JOIN into_auth_users u ON u.id = s.user_id
      WHERE s.token_digest = ? LIMIT 1
    `).get(tokenDigest) as Record<string, unknown> | undefined;
    return row ? sessionWithUserFromRow(row) : null;
  }

  async touchSession(sessionId: string, timestamp: string, before: string) {
    const result = this.database.prepare(`
      UPDATE into_auth_sessions SET last_seen_at = ?
      WHERE id = ? AND revoked_at IS NULL
        AND (last_seen_at IS NULL OR last_seen_at < ?)
    `).run(timestamp, sessionId, before);
    return result.changes === 1;
  }

  async revokeSessionByDigest(tokenDigest: string, timestamp: string) {
    const result = this.database.prepare(`
      UPDATE into_auth_sessions SET revoked_at = ?
      WHERE token_digest = ? AND revoked_at IS NULL
    `).run(timestamp, tokenDigest);
    return result.changes === 1;
  }

  async createOrReplayInvitation(input: CreateInvitationInput) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database.prepare(`
        SELECT * FROM into_auth_invitations WHERE idempotency_key = ? LIMIT 1
      `).get(input.idempotencyKey) as Record<string, unknown> | undefined;
      if (existing) {
        this.database.exec("COMMIT");
        return {
          state: existing.request_fingerprint === input.requestFingerprint ? "replayed" as const : "conflict" as const,
          invitation: invitationFromRow(existing),
        };
      }

      const email = canonicalAuthEmail(input.email);
      const existingUser = this.database.prepare(
        "SELECT id, status FROM into_auth_users WHERE email = ? LIMIT 1"
      ).get(email) as { id: string; status: AuthUserStatus } | undefined;
      const userId = existingUser?.id ?? input.userId;
      if (!existingUser) {
        this.database.prepare(`
          INSERT INTO into_auth_users (
            id, email, display_name, status, access_level, verified_at, version, created_at, updated_at
          ) VALUES (?, ?, ?, 'invited', 'verified_user', NULL, 1, ?, ?)
        `).run(userId, email, input.displayName, input.timestamp, input.timestamp);
      }
      this.database.prepare(`
        INSERT INTO into_auth_invitations (
          id, user_id, token_digest, expires_at, consumed_at, inviter_actor_id,
          inviter_session_id, request_id, idempotency_key, request_fingerprint,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id, userId, input.tokenDigest, input.expiresAt, input.inviterActorId,
        input.inviterSessionId, input.requestId, input.idempotencyKey,
        input.requestFingerprint, input.timestamp, input.timestamp
      );
      this.database.prepare(`
        INSERT INTO into_auth_events (
          id, type, actor_id, target_user_id, request_id, session_id,
          event_key, metadata_json, created_at
        ) VALUES (?, 'invitation_created', ?, ?, ?, ?, ?, '{}', ?)
      `).run(
        `invitation_created:${input.id}`, input.inviterActorId, userId,
        input.requestId, input.inviterSessionId, `invitation_created:${input.id}`, input.timestamp
      );
      const created = this.database.prepare(
        "SELECT * FROM into_auth_invitations WHERE id = ?"
      ).get(input.id) as Record<string, unknown>;
      this.database.exec("COMMIT");
      return { state: "created" as const, invitation: invitationFromRow(created) };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async consumeInvitation(input: ConsumeInvitationInput) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const invitation = this.database.prepare(`
        SELECT i.*, u.email, u.display_name, u.status, u.access_level, u.verified_at,
          u.version, u.created_at AS user_created_at, u.updated_at AS user_updated_at
        FROM into_auth_invitations i
        JOIN into_auth_users u ON u.id = i.user_id
        WHERE i.token_digest = ? AND i.consumed_at IS NULL
          AND i.expires_at > ? AND u.status = 'invited'
        LIMIT 1
      `).get(input.tokenDigest, input.timestamp) as Record<string, unknown> | undefined;
      if (!invitation) {
        this.database.exec("COMMIT");
        return { state: "gone" as const, user: null };
      }
      const userId = String(invitation.user_id);
      this.database.prepare(`
        INSERT INTO into_auth_credentials (
          user_id, scrypt_hash, scrypt_salt, scrypt_n, scrypt_r, scrypt_p,
          scrypt_version, failed_attempts, locked_at, rotated_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?)
      `).run(
        userId, input.credential.hash, input.credential.salt, input.credential.n,
        input.credential.r, input.credential.p, input.credential.version,
        input.timestamp, input.timestamp
      );
      this.database.prepare(`
        UPDATE into_auth_users SET display_name = ?, status = 'active', verified_at = ?,
          version = version + 1, updated_at = ? WHERE id = ?
      `).run(input.displayName, input.timestamp, input.timestamp, userId);
      this.database.prepare(`
        UPDATE into_auth_invitations SET consumed_at = ?, updated_at = ? WHERE id = ?
      `).run(input.timestamp, input.timestamp, String(invitation.id));
      this.database.prepare(`
        INSERT INTO into_auth_sessions (
          id, user_id, token_digest, correlation_id_hash, token_version,
          issued_at, expires_at, revoked_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.session.id, userId, input.session.tokenDigest, input.session.correlationIdHash,
        input.session.tokenVersion, input.session.issuedAt, input.session.expiresAt,
        input.session.revokedAt, input.session.lastSeenAt
      );
      this.database.prepare(`
        INSERT INTO into_auth_events (
          id, type, target_user_id, request_id, session_id, event_key, metadata_json, created_at
        ) VALUES (?, 'invitation_consumed', ?, ?, ?, ?, '{}', ?)
      `).run(
        `invitation_consumed:${invitation.id}`, userId, input.requestId, input.session.id,
        `invitation_consumed:${invitation.id}`, input.timestamp
      );
      const userRow = this.database.prepare(
        "SELECT * FROM into_auth_users WHERE id = ?"
      ).get(userId) as Record<string, unknown>;
      this.database.exec("COMMIT");
      return { state: "consumed" as const, user: userFromRow(userRow) };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async findUserCredentialByEmail(email: string) {
    const row = this.database.prepare(`
      SELECT u.*, c.scrypt_hash, c.scrypt_salt, c.scrypt_n, c.scrypt_r,
        c.scrypt_p, c.scrypt_version, c.failed_attempts, c.locked_at
      FROM into_auth_users u JOIN into_auth_credentials c ON c.user_id = u.id
      WHERE u.email = ? LIMIT 1
    `).get(canonicalAuthEmail(email)) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      user: userFromRow(row),
      credential: {
        algorithm: "scrypt" as const,
        version: Number(row.scrypt_version) as 1,
        hash: String(row.scrypt_hash),
        salt: String(row.scrypt_salt),
        n: Number(row.scrypt_n),
        r: Number(row.scrypt_r),
        p: Number(row.scrypt_p),
      },
      failedAttempts: Number(row.failed_attempts),
      lockedAt: row.locked_at ? String(row.locked_at) : null,
    };
  }

  async countActiveUsers() {
    const row = this.database.prepare(
      "SELECT COUNT(*) AS count FROM into_auth_users WHERE status = 'active' AND verified_at IS NOT NULL"
    ).get() as { count: number };
    return Number(row.count);
  }

  async updateUserStatus(input: UpdateUserStatusInput) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare(
        "SELECT * FROM into_auth_users WHERE id = ? LIMIT 1"
      ).get(input.targetId) as Record<string, unknown> | undefined;
      if (!row) {
        this.database.exec("COMMIT");
        return { state: "not_found" as const, user: null };
      }
      const current = userFromRow(row);
      if (current.version !== input.expectedVersion) {
        this.database.exec("COMMIT");
        return { state: "conflict" as const, user: current };
      }
      if (input.status === "active" && !current.verifiedAt) {
        this.database.exec("COMMIT");
        return { state: "unverified" as const, user: current };
      }
      if (input.status === "disabled" && current.status === "active") {
        const active = this.database.prepare(`
          SELECT COUNT(*) AS count FROM into_auth_users
          WHERE status = 'active' AND verified_at IS NOT NULL AND id <> ?
        `).get(input.targetId) as { count: number };
        if (Number(active.count) === 0) {
          this.database.exec("COMMIT");
          return { state: "final_active" as const, user: current };
        }
      }
      if (current.status === input.status) {
        this.database.exec("COMMIT");
        return { state: "updated" as const, user: current };
      }
      this.database.prepare(`
        UPDATE into_auth_users SET status = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(input.status, input.timestamp, input.targetId, input.expectedVersion);
      this.database.prepare(`
        INSERT INTO into_auth_events (
          id, type, actor_id, target_user_id, request_id, session_id,
          event_key, metadata_json, created_at
        ) VALUES (?, 'user_status_changed', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `user_status:${input.requestId}`, input.actorId, input.targetId,
        input.requestId, input.sessionId, `user_status:${input.requestId}`,
        JSON.stringify({ status: input.status }), input.timestamp
      );
      const updated = this.database.prepare(
        "SELECT * FROM into_auth_users WHERE id = ?"
      ).get(input.targetId) as Record<string, unknown>;
      this.database.exec("COMMIT");
      return { state: "updated" as const, user: userFromRow(updated) };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async recordLoginFailure(
    scopeHash: string,
    timestamp: string,
    lockAfter: number,
    context?: { requestId: string; targetUserId?: string; sourceHash?: string | null }
  ) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT OR IGNORE INTO into_auth_login_throttles (
          scope_hash, failed_attempts, locked_at, updated_at
        ) VALUES (?, 0, NULL, ?)
      `).run(scopeHash, timestamp);
      this.database.prepare(`
        UPDATE into_auth_login_throttles SET
          failed_attempts = failed_attempts + 1,
          locked_at = CASE WHEN failed_attempts + 1 >= ? THEN ? ELSE locked_at END,
          updated_at = ?
        WHERE scope_hash = ?
      `).run(lockAfter, timestamp, timestamp, scopeHash);
      const row = this.database.prepare(
        "SELECT failed_attempts, locked_at FROM into_auth_login_throttles WHERE scope_hash = ?"
      ).get(scopeHash) as { failed_attempts: number; locked_at: string | null };
      if (context) {
        this.database.prepare(`
          INSERT OR IGNORE INTO into_auth_events (
            id, type, target_user_id, request_id, event_key, metadata_json, created_at
          ) VALUES (?, 'login_failed', ?, ?, ?, ?, ?)
        `).run(
          `login_failed:${context.requestId}`, context.targetUserId ?? null, context.requestId,
          `login_failed:${context.requestId}`,
          JSON.stringify(context.sourceHash ? { sourceHash: context.sourceHash } : {}), timestamp
        );
      }
      this.database.exec("COMMIT");
      return {
        failedAttempts: Number(row.failed_attempts),
        lockedAt: row.locked_at ? String(row.locked_at) : null,
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async findLoginThrottle(scopeHash: string) {
    const row = this.database.prepare(`
      SELECT failed_attempts, locked_at FROM into_auth_login_throttles WHERE scope_hash = ?
    `).get(scopeHash) as { failed_attempts: number; locked_at: string | null } | undefined;
    return row ? {
      failedAttempts: Number(row.failed_attempts),
      lockedAt: row.locked_at ? String(row.locked_at) : null,
    } : null;
  }

  async resetLoginFailures(scopeHash: string, timestamp: string) {
    this.database.prepare(`
      UPDATE into_auth_login_throttles
      SET failed_attempts = 0, locked_at = NULL, updated_at = ?
      WHERE scope_hash = ?
    `).run(timestamp, scopeHash);
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

function invitationFromRow(row: Record<string, unknown>): AuthInvitationRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    tokenDigest: String(row.token_digest),
    expiresAt: String(row.expires_at),
    consumedAt: row.consumed_at ? String(row.consumed_at) : null,
    idempotencyKey: String(row.idempotency_key),
    requestFingerprint: String(row.request_fingerprint),
    createdAt: String(row.created_at),
  };
}

function userFromRow(row: Record<string, unknown>): AuthUserRecord {
  return {
    id: String(row.id),
    email: String(row.email),
    displayName: String(row.display_name),
    status: row.status as AuthUserStatus,
    accessLevel: "verified_user",
    verifiedAt: row.verified_at ? String(row.verified_at) : null,
    version: Number(row.version),
    createdAt: String(row.created_at ?? row.user_created_at),
    updatedAt: String(row.updated_at ?? row.user_updated_at),
  };
}

function sessionWithUserFromRow(row: Record<string, unknown>): AuthSessionWithUser {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    tokenDigest: String(row.token_digest),
    correlationIdHash: String(row.correlation_id_hash),
    tokenVersion: Number(row.token_version),
    issuedAt: String(row.issued_at),
    expiresAt: String(row.expires_at),
    revokedAt: row.revoked_at ? String(row.revoked_at) : null,
    lastSeenAt: row.last_seen_at ? String(row.last_seen_at) : null,
    user: {
      id: String(row.user_id), email: String(row.email), displayName: String(row.display_name),
      status: row.status as AuthUserStatus, accessLevel: "verified_user",
      verifiedAt: row.verified_at ? String(row.verified_at) : null,
      version: Number(row.version), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    },
  };
}
