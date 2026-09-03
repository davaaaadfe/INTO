import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { databasePersistenceIdentity } from "../lib/repository/sqlite-store";
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
  loadSqliteStoreRevision,
  loadSqliteStoreSnapshot,
  SnapshotRevisionConflictError,
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
    supplierOverviewImport: {
      sourceFileName: "suppliers.xlsx",
      importedAt: "2026-07-15T10:00:00.000Z",
      supplierCount: 1,
      suppliers: [{ code: "1000001", name: "Persisted supplier" }],
    },
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

test("SQLite snapshot writes use compare-and-swap revisions", async () => {
  const databasePath = testDatabasePath();
  const base = {
    users: [],
    currentUserId: "shared_user",
    invoices: [],
    exactConnections: [],
    exactMasterDataCaches: [],
    supplierOverviewImport: null,
    duplicateLogs: [],
    auditEvents: [],
    learning: { corrections: [] },
    schemaVersion: 1,
    revision: 0,
  } as unknown as IntoStore;
  const firstWriter = structuredClone(base);
  const staleWriter = structuredClone(base);

  try {
    await saveSqliteStoreSnapshot(firstWriter, databasePath);
    assert.equal((firstWriter as IntoStore & { revision: number }).revision, 1);
    await assert.rejects(
      saveSqliteStoreSnapshot(staleWriter, databasePath),
      SnapshotRevisionConflictError
    );
    const restored = await loadSqliteStoreSnapshot(databasePath);
    assert.equal((restored as IntoStore & { revision: number }).revision, 1);
  } finally {
    closeSqliteStore();
    await rm(databasePath, { force: true });
    await rm(`${databasePath}-shm`, { force: true });
    await rm(`${databasePath}-wal`, { force: true });
  }
});

test("reads only the scalar SQLite snapshot revision", async () => {
  const databasePath = testDatabasePath();
  const snapshot = {
    users: [],
    currentUserId: "shared_user",
    invoices: [],
    exactConnections: [],
    exactMasterDataCaches: [],
    supplierOverviewImport: null,
    duplicateLogs: [],
    auditEvents: [],
    learning: { corrections: [] },
    schemaVersion: 1,
    revision: 0,
  } as unknown as IntoStore;

  try {
    assert.equal(await loadSqliteStoreRevision(databasePath), null);
    await saveSqliteStoreSnapshot(snapshot, databasePath);
    assert.equal(await loadSqliteStoreRevision(databasePath), 1);
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

test("PostgreSQL persistence identities isolate database URLs without exposing them", () => {
  const previousMode = process.env.DATABASE_MODE;
  const previousUrl = process.env.DATABASE_URL;
  try {
    process.env.DATABASE_MODE = "postgres";
    process.env.DATABASE_URL = "postgresql://first.example/into";
    const firstIdentity = databasePersistenceIdentity();
    process.env.DATABASE_URL = "postgresql://second.example/into";
    const secondIdentity = databasePersistenceIdentity();
    delete process.env.DATABASE_URL;
    const unconfiguredIdentity = databasePersistenceIdentity();

    assert.match(firstIdentity, /^postgres:[a-f0-9]{64}$/);
    assert.notEqual(secondIdentity, firstIdentity);
    assert.doesNotMatch(firstIdentity, /first\.example/);
    assert.equal(unconfiguredIdentity, "postgres:unconfigured");
  } finally {
    if (previousMode === undefined) delete process.env.DATABASE_MODE;
    else process.env.DATABASE_MODE = previousMode;
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  }
});

test("the request store survives a local process restart", async () => {
  const databasePath = testDatabasePath();
  const previousMode = process.env.DATABASE_MODE;
  const previousPath = process.env.LOCAL_DATABASE_PATH;
  const previousLearningEnabled = process.env.LEARNING_V2_ENABLED;
  const runtime = globalThis as typeof globalThis & {
    __INTO_STORE?: IntoStore;
    __INTO_STORE_HYDRATED_FOR?: string;
    __INTO_STORE_HYDRATING?: Promise<void>;
    __INTO_STORE_PERSISTING?: Promise<void>;
  };

  process.env.DATABASE_MODE = "sqlite";
  process.env.LOCAL_DATABASE_PATH = databasePath;
  process.env.LEARNING_V2_ENABLED = "false";

  try {
    await hydrateStoreFromPersistence();
    getStore().invoices[0]!.extractedData.rawText =
      "sensitive evidence must not enter the runtime snapshot";
    getStore().invoices[0]!.extractedData.documentAnalysis = {
      pages: [],
      fieldCandidates: [],
      confidence: 1,
      provider: { name: "test", model: "test-v1" },
      sourceMode: "plain_text",
    };
    getStore().auditEvents.unshift({ id: "restart-proof" } as never);
    setExactConnection(createMockExactConnection("company_connection"));
    await syncExactDataNow();
    persistStoreSoon();
    await flushStoreToPersistence();

    const durableSnapshot = await loadSqliteStoreSnapshot(databasePath);
    assert.equal(durableSnapshot?.invoices[0]?.extractedData.rawText, undefined);
    assert.equal(
      durableSnapshot?.invoices[0]?.extractedData.documentAnalysis,
      undefined
    );

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
    if (previousLearningEnabled === undefined) delete process.env.LEARNING_V2_ENABLED;
    else process.env.LEARNING_V2_ENABLED = previousLearningEnabled;
    await rm(databasePath, { force: true });
    await rm(`${databasePath}-shm`, { force: true });
    await rm(`${databasePath}-wal`, { force: true });
  }
});
