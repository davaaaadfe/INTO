import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { IntoStore } from "./invoice-store";

const snapshotId = "company";

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
      updated_at TEXT NOT NULL
    );
  `);
  return database;
}

export async function loadSqliteStoreSnapshot(databasePath = sqliteDatabasePath()) {
  const row = openDatabase(databasePath)
    .prepare("SELECT payload FROM into_runtime_store WHERE id = ? LIMIT 1")
    .get(snapshotId) as { payload?: string } | undefined;

  return row?.payload ? (JSON.parse(row.payload) as IntoStore) : null;
}

export async function saveSqliteStoreSnapshot(
  store: IntoStore,
  databasePath = sqliteDatabasePath()
) {
  openDatabase(databasePath)
    .prepare(`
      INSERT INTO into_runtime_store (id, payload, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        payload = excluded.payload,
        updated_at = excluded.updated_at
    `)
    .run(snapshotId, JSON.stringify(store), new Date().toISOString());
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
  database?.close();
  database = null;
  openDatabasePath = "";
}
