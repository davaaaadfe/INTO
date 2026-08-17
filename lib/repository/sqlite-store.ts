import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { IntoStore } from "./invoice-store";
import {
  CURRENT_STORE_SCHEMA_VERSION,
  migrateStoreSnapshot,
} from "./store-migrations";

const snapshotId = "company";
export const CURRENT_SNAPSHOT_SCHEMA_VERSION = CURRENT_STORE_SCHEMA_VERSION;

export class SnapshotRevisionConflictError extends Error {}

type VersionedStore = IntoStore & {
  schemaVersion?: number;
  revision?: number;
};

let database: DatabaseSync | null = null;
let openDatabasePath = "";

export type DatabaseMode = "memory" | "postgres" | "sqlite";

export function databaseMode(): DatabaseMode {
  const configured = process.env.DATABASE_MODE?.trim().toLowerCase();
  if (configured === "memory" || configured === "postgres" || configured === "sqlite") {
    return configured;
  }

  if (process.env.NODE_ENV === "test" || process.env.NODE_TEST_CONTEXT) {
    return "memory";
  }

  if (process.env.VERCEL || process.env.VERCEL_ENV) {
    return process.env.DATABASE_URL?.trim() ? "postgres" : "memory";
  }

  return "sqlite";
}

export function sqliteDatabasePath() {
  const configured = process.env.LOCAL_DATABASE_PATH?.trim() || "data/into.sqlite";
  return isAbsolute(configured)
    ? configured
    : resolve(/* turbopackIgnore: true */ process.cwd(), configured);
}

export function databasePersistenceIdentity() {
  const mode = databaseMode();
  if (mode === "sqlite") return `${mode}:${sqliteDatabasePath()}`;
  if (mode === "postgres") {
    const databaseUrl = process.env.DATABASE_URL?.trim() ?? "";
    return databaseUrl
      ? `${mode}:${createHash("sha256").update(databaseUrl).digest("hex")}`
      : `${mode}:unconfigured`;
  }
  return mode;
}

export function isSqlitePersistenceEnabled() {
  return databaseMode() === "sqlite";
}

function openDatabase(databasePath = sqliteDatabasePath()) {
  const resolvedPath = resolve(databasePath);
  if (database && openDatabasePath === resolvedPath) {
    return database;
  }

  closeSqliteStore();
  mkdirSync(dirname(resolvedPath), { recursive: true });
  database = new DatabaseSync(resolvedPath);
  openDatabasePath = resolvedPath;
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS into_runtime_store (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
  `);
  const columns = database
    .prepare("PRAGMA table_info(into_runtime_store)")
    .all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "revision")) {
    database.exec(
      "ALTER TABLE into_runtime_store ADD COLUMN revision INTEGER NOT NULL DEFAULT 0"
    );
  }
  return database;
}

export async function loadSqliteStoreSnapshot(databasePath = sqliteDatabasePath()) {
  const row = openDatabase(databasePath)
    .prepare("SELECT payload, revision FROM into_runtime_store WHERE id = ? LIMIT 1")
    .get(snapshotId) as { payload?: string; revision?: number } | undefined;

  if (!row?.payload) {
    return null;
  }
  const store = JSON.parse(row.payload) as VersionedStore;
  store.schemaVersion ??= 1;
  store.revision = row.revision ?? store.revision ?? 0;
  return migrateStoreSnapshot(store);
}

export async function loadSqliteStoreRevision(
  databasePath = sqliteDatabasePath()
) {
  const row = openDatabase(databasePath)
    .prepare("SELECT revision FROM into_runtime_store WHERE id = ? LIMIT 1")
    .get(snapshotId) as { revision: number } | undefined;
  return row?.revision ?? null;
}

export async function saveSqliteStoreSnapshot(
  store: IntoStore,
  databasePath = sqliteDatabasePath()
) {
  Object.assign(store, migrateStoreSnapshot(store));
  const versioned = store as VersionedStore;
  const expectedRevision = versioned.revision ?? 0;
  const nextRevision = expectedRevision + 1;
  const nextStore = {
    ...versioned,
    schemaVersion: CURRENT_SNAPSHOT_SCHEMA_VERSION,
    revision: nextRevision,
  };
  const db = openDatabase(databasePath);
  const existing = db
    .prepare("SELECT revision FROM into_runtime_store WHERE id = ?")
    .get(snapshotId) as { revision: number } | undefined;
  if (!existing) {
    if (expectedRevision !== 0) {
      throw new SnapshotRevisionConflictError(
        "INTO data changed in another request. Reload and try again."
      );
    }
    const result = db.prepare(
      `INSERT OR IGNORE INTO into_runtime_store (id, payload, revision, updated_at)
       VALUES (?, ?, ?, ?)`
    ).run(
      snapshotId,
      JSON.stringify(nextStore),
      nextRevision,
      new Date().toISOString()
    );
    if (result.changes !== 1) {
      throw new SnapshotRevisionConflictError(
        "INTO data changed in another request. Reload and try again."
      );
    }
  } else {
    const result = db
      .prepare(
        `UPDATE into_runtime_store
         SET payload = ?, revision = ?, updated_at = ?
         WHERE id = ? AND revision = ?`
      )
      .run(
        JSON.stringify(nextStore),
        nextRevision,
        new Date().toISOString(),
        snapshotId,
        expectedRevision
      );
    if (result.changes !== 1) {
      throw new SnapshotRevisionConflictError(
        "INTO data changed in another request. Reload and try again."
      );
    }
  }
  versioned.schemaVersion = CURRENT_SNAPSHOT_SCHEMA_VERSION;
  versioned.revision = nextRevision;
}

export async function withSqliteStoreTransaction<T>(
  operation: (database: DatabaseSync) => Promise<T>,
  databasePath = sqliteDatabasePath()
) {
  const db = openDatabase(databasePath);
  const ownsTransaction = !db.isTransaction;
  if (ownsTransaction) db.exec("BEGIN IMMEDIATE;");
  try {
    const result = await operation(db);
    if (ownsTransaction) db.exec("COMMIT;");
    return result;
  } catch (error) {
    if (ownsTransaction && db.isTransaction) db.exec("ROLLBACK;");
    throw error;
  }
}

export async function verifySqliteStoreWorks() {
  try {
    openDatabase().prepare("SELECT 1 AS ok").get();
    return true;
  } catch {
    return false;
  }
}

export function closeSqliteStore() {
  const runtime = globalThis as typeof globalThis & {
    __INTO_CLOSE_LEARNING_REPOSITORY?: () => void;
  };
  runtime.__INTO_CLOSE_LEARNING_REPOSITORY?.();
  database?.close();
  database = null;
  openDatabasePath = "";
}
