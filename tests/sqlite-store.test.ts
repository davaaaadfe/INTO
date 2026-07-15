import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  flushStoreToPersistence,
  getExactConnection,
  getExactMasterData,
  getStore,
  hydrateStoreFromPersistence,
  persistStoreSoon,
  setExactConnection,
  syncExactDataNow,
  type IntoStore,
} from "../lib/repository/invoice-store";
import { createMockExactConnection } from "../lib/services/exact-online-service";
import {
  closeSqliteStore,
  databaseMode,
  loadSqliteStoreSnapshot,
  saveSqliteStoreSnapshot,
} from "../lib/repository/sqlite-store";

function testDatabasePath() {
  return resolve(
    "data/tmp-tests",
    `into-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`
  );
}

test("persists the complete INTO runtime snapshot in SQLite", async () => {
  const databasePath = testDatabasePath();
  const snapshot = {
    users: [],
    currentUserId: "shared_user",
    invoices: [{ id: "invoice-persisted" }],
    exactConnections: [{ id: "exact-persisted" }],
    exactMasterDataCaches: [],
    duplicateLogs: [],
    auditEvents: [{ id: "audit-persisted" }],
    learning: { corrections: [] },
  } as unknown as IntoStore;

  try {
    await saveSqliteStoreSnapshot(snapshot, databasePath);
    closeSqliteStore();

    const restored = await loadSqliteStoreSnapshot(databasePath);

    assert.deepEqual(restored, snapshot);
  } finally {
    closeSqliteStore();
    await rm(databasePath, { force: true });
    await rm(`${databasePath}-shm`, { force: true });
    await rm(`${databasePath}-wal`, { force: true });
  }
});

test("the Node test runner uses memory unless a database mode is explicit", () => {
  const environment = process.env as Record<string, string | undefined>;
  const previousNodeEnv = process.env.NODE_ENV;
  const previousMode = process.env.DATABASE_MODE;
  environment.NODE_ENV = "production";
  delete process.env.DATABASE_MODE;

  try {
    assert.equal(databaseMode(), "memory");
  } finally {
    if (previousNodeEnv === undefined) delete environment.NODE_ENV;
    else environment.NODE_ENV = previousNodeEnv;
    if (previousMode === undefined) delete process.env.DATABASE_MODE;
    else process.env.DATABASE_MODE = previousMode;
  }
});

test("the request store survives a local process restart", async () => {
  const databasePath = testDatabasePath();
  const previousMode = process.env.DATABASE_MODE;
  const previousPath = process.env.LOCAL_DATABASE_PATH;
  const runtime = globalThis as typeof globalThis & {
    __INTO_STORE?: IntoStore;
    __INTO_STORE_HYDRATED_FOR?: string;
    __INTO_STORE_HYDRATING?: Promise<void>;
    __INTO_STORE_PERSISTING?: Promise<void>;
  };

  process.env.DATABASE_MODE = "sqlite";
  process.env.LOCAL_DATABASE_PATH = databasePath;

  try {
    await hydrateStoreFromPersistence();
    getStore().auditEvents.unshift({ id: "restart-proof" } as never);
    setExactConnection(createMockExactConnection("company_connection"));
    await syncExactDataNow();
    persistStoreSoon();
    await flushStoreToPersistence();

    delete runtime.__INTO_STORE;
    delete runtime.__INTO_STORE_HYDRATED_FOR;
    delete runtime.__INTO_STORE_HYDRATING;
    delete runtime.__INTO_STORE_PERSISTING;
    closeSqliteStore();

    await hydrateStoreFromPersistence();

    assert.equal(
      getStore().auditEvents.some((event) => event.id === "restart-proof"),
      true
    );
    assert.equal(getExactConnection()?.status, "connected");
    assert.equal(getExactMasterData()?.source, "exact-online");
    assert.ok((getExactMasterData()?.suppliers.length ?? 0) > 0);
  } finally {
    delete runtime.__INTO_STORE;
    delete runtime.__INTO_STORE_HYDRATED_FOR;
    delete runtime.__INTO_STORE_HYDRATING;
    delete runtime.__INTO_STORE_PERSISTING;
    closeSqliteStore();
    if (previousMode === undefined) delete process.env.DATABASE_MODE;
    else process.env.DATABASE_MODE = previousMode;
    if (previousPath === undefined) delete process.env.LOCAL_DATABASE_PATH;
    else process.env.LOCAL_DATABASE_PATH = previousPath;
    await rm(databasePath, { force: true });
    await rm(`${databasePath}-shm`, { force: true });
    await rm(`${databasePath}-wal`, { force: true });
  }
});
