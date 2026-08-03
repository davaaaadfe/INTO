import test from "node:test";
import assert from "node:assert/strict";
import {
  getStore,
  hydrateStoreFromPersistence,
  type IntoStore,
} from "../lib/repository/invoice-store";
import { closeConfiguredLearningRepository } from "../lib/repository/configured-learning-repository";

function snapshot(invoiceId: string): IntoStore {
  return {
    schemaVersion: 2,
    revision: 1,
    users: [
      {
        id: "shared_user",
        email: "shared_user@internal",
        name: "shared_user",
        status: "active",
        isSystemOwner: true,
        createdAt: "2026-08-03T00:00:00.000Z",
        updatedAt: "2026-08-03T00:00:00.000Z",
      },
    ],
    currentUserId: "shared_user",
    invoices: [
      {
        id: invoiceId,
        status: "Ready to Book",
        storageKey: "",
        extractedData: { lineItems: [] },
        extractionHistory: [],
      } as unknown as IntoStore["invoices"][number],
    ],
    exactConnections: [],
    exactMasterDataCaches: [],
    supplierOverviewImport: null,
    duplicateLogs: [],
    auditEvents: [],
    learning: { revision: 1 } as IntoStore["learning"],
  };
}

type HydrationRuntime = typeof globalThis & {
  __INTO_STORE?: IntoStore;
  __INTO_STORE_HYDRATED_FOR?: string;
  __INTO_STORE_HYDRATING?: unknown;
  __INTO_STORE_PERSISTING?: Promise<void>;
  __INTO_STORE_PERSISTENCE_ERROR?: unknown;
  __INTO_STORE_DIRTY?: boolean;
  __INTO_STORE_DIRTY_REVISION?: number;
  __INTO_STORE_PERSISTED_DIRTY_REVISION?: number;
  __INTO_LEARNING_PERSISTENCE_CONTEXT?: unknown;
  __INTO_POSTGRES_SQL_IDENTITY?: string;
  __INTO_POSTGRES_SQL_CLIENT?: unknown;
  __INTO_POSTGRES_RUNTIME_SCHEMA?: unknown;
  __INTO_POSTGRES_INVOICE_FILE_SCHEMA?: unknown;
  __INTO_LEARNING_REPOSITORY?: unknown;
  __INTO_LEARNING_REPOSITORY_IDENTITY?: string;
  __INTO_LEARNING_REPOSITORY_LOADING?: unknown;
};

const hydrationRuntimeKeys = [
  "__INTO_STORE",
  "__INTO_STORE_HYDRATED_FOR",
  "__INTO_STORE_HYDRATING",
  "__INTO_STORE_PERSISTING",
  "__INTO_STORE_PERSISTENCE_ERROR",
  "__INTO_STORE_DIRTY",
  "__INTO_STORE_DIRTY_REVISION",
  "__INTO_STORE_PERSISTED_DIRTY_REVISION",
  "__INTO_LEARNING_PERSISTENCE_CONTEXT",
  "__INTO_POSTGRES_SQL_IDENTITY",
  "__INTO_POSTGRES_SQL_CLIENT",
  "__INTO_POSTGRES_RUNTIME_SCHEMA",
  "__INTO_POSTGRES_INVOICE_FILE_SCHEMA",
  "__INTO_LEARNING_REPOSITORY",
  "__INTO_LEARNING_REPOSITORY_IDENTITY",
  "__INTO_LEARNING_REPOSITORY_LOADING",
] as const;

type HydrationRuntimeKey = (typeof hydrationRuntimeKeys)[number];

function snapshotHydrationRuntime(runtime: HydrationRuntime) {
  const record = runtime as Record<HydrationRuntimeKey, unknown>;
  return hydrationRuntimeKeys.map((key) => ({
    key,
    existed: Object.prototype.hasOwnProperty.call(runtime, key),
    value: record[key],
  }));
}

function clearHydrationRuntime(runtime: HydrationRuntime, closeLearning = false) {
  if (closeLearning) closeConfiguredLearningRepository();
  const record = runtime as Record<HydrationRuntimeKey, unknown>;
  for (const key of hydrationRuntimeKeys) delete record[key];
}

function restoreHydrationRuntime(
  runtime: HydrationRuntime,
  snapshot: ReturnType<typeof snapshotHydrationRuntime>
) {
  const record = runtime as Record<HydrationRuntimeKey, unknown>;
  for (const { key, existed, value } of snapshot) {
    if (existed) record[key] = value;
    else delete record[key];
  }
}

async function withPostgresHydration(
  databaseUrl: string,
  snapshots: Map<string, IntoStore | Error | null>,
  beforeSelect: (connectionString: string) => Promise<void>,
  run: (selectedUrls: string[]) => Promise<void>,
  beforeQuery?: (connectionString: string, sql: string) => Promise<void>
) {
  const environment = process.env as Record<string, string | undefined>;
  const previous = {
    nodeEnv: environment.NODE_ENV,
    mode: process.env.DATABASE_MODE,
    url: process.env.DATABASE_URL,
    learning: process.env.LEARNING_V2_ENABLED,
    learningMode: process.env.SUPPLIER_LEARNING_MODE,
    encryptionKey: process.env.LEARNING_ARTIFACT_ENCRYPTION_KEY,
    fetch: globalThis.fetch,
  };
  const runtime = globalThis as HydrationRuntime;
  const previousRuntime = snapshotHydrationRuntime(runtime);
  const selectedUrls: string[] = [];

  environment.NODE_ENV = "production";
  process.env.DATABASE_MODE = "postgres";
  process.env.DATABASE_URL = databaseUrl;
  process.env.LEARNING_V2_ENABLED = "false";
  clearHydrationRuntime(runtime);
  globalThis.fetch = async (_input, init) => {
    const connectionString = new Headers(init?.headers).get(
      "Neon-Connection-String"
    );
    assert.ok(connectionString);
    const body = JSON.parse(String(init?.body)) as {
      query?: string;
      queries?: Array<{ query: string }>;
    };
    if (body.queries) {
      const results = [];
      for (const query of body.queries) {
        const sql = query.query.replace(/\s+/g, " ").trim();
        await beforeQuery?.(connectionString, sql);
        results.push({ fields: [], rows: [], rowCount: 0 });
      }
      return new Response(JSON.stringify({ results }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    assert.ok(body.query);
    const sql = body.query.replace(/\s+/g, " ").trim();
    await beforeQuery?.(connectionString, sql);
    let fields: Array<{ name: string; dataTypeID: number }> = [];
    let rows: unknown[][] = [];

    if (sql.startsWith("SELECT payload, revision FROM into_runtime_store")) {
      selectedUrls.push(connectionString);
      await beforeSelect(connectionString);
      const stored = snapshots.get(connectionString);
      if (stored instanceof Error) throw stored;
      if (stored) {
        fields = [
          { name: "payload", dataTypeID: 114 },
          { name: "revision", dataTypeID: 23 },
        ];
        rows = [[JSON.stringify(stored), "1"]];
      }
    }

    return new Response(JSON.stringify({ fields, rows, rowCount: rows.length }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    await run(selectedUrls);
  } finally {
    clearHydrationRuntime(runtime, true);
    if (previous.nodeEnv === undefined) delete environment.NODE_ENV;
    else environment.NODE_ENV = previous.nodeEnv;
    if (previous.mode === undefined) delete process.env.DATABASE_MODE;
    else process.env.DATABASE_MODE = previous.mode;
    if (previous.url === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous.url;
    if (previous.learning === undefined) delete process.env.LEARNING_V2_ENABLED;
    else process.env.LEARNING_V2_ENABLED = previous.learning;
    if (previous.learningMode === undefined) delete process.env.SUPPLIER_LEARNING_MODE;
    else process.env.SUPPLIER_LEARNING_MODE = previous.learningMode;
    if (previous.encryptionKey === undefined) {
      delete process.env.LEARNING_ARTIFACT_ENCRYPTION_KEY;
    } else {
      process.env.LEARNING_ARTIFACT_ENCRYPTION_KEY = previous.encryptionKey;
    }
    globalThis.fetch = previous.fetch;
    restoreHydrationRuntime(runtime, previousRuntime);
  }
}

test("a PostgreSQL identity switch cannot return the previous database snapshot", async () => {
  const firstUrl = "postgresql://test:test@hydration-a.example/into";
  const secondUrl = "postgresql://test:test@hydration-b.example/into";
  const snapshots = new Map([
    [firstUrl, snapshot("invoice-from-a")],
    [secondUrl, snapshot("invoice-from-b")],
  ]);
  let firstSelectStarted!: () => void;
  let releaseFirstSelect!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    firstSelectStarted = resolve;
  });
  const firstRelease = new Promise<void>((resolve) => {
    releaseFirstSelect = resolve;
  });
  await withPostgresHydration(
    firstUrl,
    snapshots,
    async (connectionString) => {
      if (connectionString === firstUrl) {
        firstSelectStarted();
        await firstRelease;
      }
    },
    async () => {
      const firstHydration = hydrateStoreFromPersistence(true);
      await firstStarted;
      process.env.DATABASE_URL = secondUrl;
      const secondHydration = hydrateStoreFromPersistence(true);
      releaseFirstSelect();

      await secondHydration;
      assert.equal(getStore().invoices[0]?.id, "invoice-from-b");
      await firstHydration;
    }
  );
});

test("concurrent hydrations for one PostgreSQL identity share one snapshot load", async () => {
  const url = "postgresql://test:test@hydration-shared.example/into";
  let selectStarted!: () => void;
  let releaseSelect!: () => void;
  const started = new Promise<void>((resolve) => {
    selectStarted = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseSelect = resolve;
  });

  await withPostgresHydration(
    url,
    new Map([[url, snapshot("invoice-shared")]]),
    async () => {
      selectStarted();
      await release;
    },
    async (selectedUrls) => {
      const first = hydrateStoreFromPersistence(true);
      await started;
      const second = hydrateStoreFromPersistence(true);
      releaseSelect();
      await Promise.all([first, second]);

      assert.deepEqual(selectedUrls, [url]);
      assert.equal(getStore().invoices[0]?.id, "invoice-shared");
    }
  );
});

test("a failed old PostgreSQL hydration cannot poison the new identity", async () => {
  const firstUrl = "postgresql://test:test@hydration-failed-a.example/into";
  const secondUrl = "postgresql://test:test@hydration-recovered-b.example/into";
  let firstSelectStarted!: () => void;
  let rejectFirstSelect!: (error: Error) => void;
  const firstStarted = new Promise<void>((resolve) => {
    firstSelectStarted = resolve;
  });
  const firstFailure = new Promise<void>((_resolve, reject) => {
    rejectFirstSelect = reject;
  });

  await withPostgresHydration(
    firstUrl,
    new Map<string, IntoStore | Error>([
      [firstUrl, new Error("old hydration failed")],
      [secondUrl, snapshot("invoice-recovered-from-b")],
    ]),
    async (connectionString) => {
      if (connectionString === firstUrl) {
        firstSelectStarted();
        await firstFailure;
      }
    },
    async (selectedUrls) => {
      const firstHydration = hydrateStoreFromPersistence(true);
      await firstStarted;
      process.env.DATABASE_URL = secondUrl;
      const secondHydration = hydrateStoreFromPersistence(true);
      rejectFirstSelect(new Error("old hydration failed"));

      await Promise.all([firstHydration, secondHydration]);
      assert.deepEqual(selectedUrls, [firstUrl, secondUrl]);
      assert.equal(getStore().invoices[0]?.id, "invoice-recovered-from-b");
    }
  );
});

test("an empty old database cannot initialize or poison the new PostgreSQL identity", async () => {
  const firstUrl = "postgresql://test:test@hydration-empty-a.example/into";
  const secondUrl = "postgresql://test:test@hydration-existing-b.example/into";
  let saveBoundaryReached!: () => void;
  let releaseSaveBoundary!: () => void;
  const boundaryReached = new Promise<void>((resolve) => {
    saveBoundaryReached = resolve;
  });
  const boundaryRelease = new Promise<void>((resolve) => {
    releaseSaveBoundary = resolve;
  });
  const writeTargets: string[] = [];
  let boundaryCaptured = false;

  await withPostgresHydration(
    firstUrl,
    new Map<string, IntoStore | Error | null>([
      [firstUrl, null],
      [secondUrl, snapshot("invoice-existing-in-b")],
    ]),
    async () => {},
    async () => {
      process.env.LEARNING_V2_ENABLED = "true";
      process.env.SUPPLIER_LEARNING_MODE = "apply";
      process.env.LEARNING_ARTIFACT_ENCRYPTION_KEY = "hydration-race-test-key";
      const firstHydration = hydrateStoreFromPersistence(true);
      await boundaryReached;
      process.env.DATABASE_URL = secondUrl;
      process.env.LEARNING_V2_ENABLED = "false";
      const secondHydration = hydrateStoreFromPersistence(true);
      releaseSaveBoundary();

      await Promise.all([firstHydration, secondHydration]);
      assert.deepEqual(writeTargets, []);
      assert.equal(getStore().invoices[0]?.id, "invoice-existing-in-b");
    },
    async (connectionString, sql) => {
      const learningMigration = sql.startsWith(
        "CREATE TABLE IF NOT EXISTS supplier_learning_schema_migrations"
      );
      const initialSnapshotWrite = sql.startsWith(
        "INSERT INTO into_runtime_store"
      );
      if (!boundaryCaptured && (learningMigration || initialSnapshotWrite)) {
        boundaryCaptured = true;
        saveBoundaryReached();
        await boundaryRelease;
      }
      if (initialSnapshotWrite) {
        writeTargets.push(connectionString);
        throw new Error("stale initial save failed");
      }
    }
  );
});

test("a current empty-database save failure does not poison a later identity", async () => {
  const firstUrl = "postgresql://test:test@hydration-current-failure-a.example/into";
  const secondUrl = "postgresql://test:test@hydration-after-failure-b.example/into";

  await withPostgresHydration(
    firstUrl,
    new Map<string, IntoStore | Error | null>([
      [firstUrl, null],
      [secondUrl, snapshot("invoice-after-a-failure")],
    ]),
    async () => {},
    async () => {
      const firstError = await hydrateStoreFromPersistence(true).then(
        () => null,
        (error: unknown) => error
      );
      process.env.DATABASE_URL = secondUrl;
      const secondError = await hydrateStoreFromPersistence(true).then(
        () => null,
        (error: unknown) => error
      );

      assert.match(String(firstError), /current initial save failed/);
      assert.equal(secondError, null);
      assert.equal(getStore().invoices[0]?.id, "invoice-after-a-failure");
    },
    async (connectionString, sql) => {
      if (
        connectionString === firstUrl &&
        sql.startsWith("INSERT INTO into_runtime_store")
      ) {
        throw new Error("current initial save failed");
      }
    }
  );
});
