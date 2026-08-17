import test from "node:test";
import assert from "node:assert/strict";
import {
  loadPostgresTemporaryInvoiceFile,
  loadStoreRevision,
  savePostgresTemporaryInvoiceFile,
  saveStoreSnapshot,
  withPostgresStoreTransaction,
} from "../lib/repository/postgres-store";
import type { IntoStore } from "../lib/repository/invoice-store";

type NeonRequest = {
  connectionString: string;
  query: string;
  params: unknown[];
};

function normalizeSql(query: string) {
  return query.replace(/\s+/g, " ").trim();
}

function fakeNeonFetch(options: {
  revisions: Map<string, number>;
  failRuntimeCreates?: number;
  beforeRuntimeCreate?: (connectionString: string) => Promise<void>;
}) {
  const requests: NeonRequest[] = [];
  const files = new Map<string, unknown[]>();
  let remainingRuntimeCreateFailures = options.failRuntimeCreates ?? 0;

  const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      query: string;
      params: unknown[];
    };
    const connectionString = new Headers(init?.headers).get(
      "Neon-Connection-String"
    );
    assert.ok(connectionString);
    const query = normalizeSql(body.query);
    requests.push({ connectionString, query, params: body.params });

    if (
      query.startsWith("CREATE TABLE IF NOT EXISTS into_runtime_store") &&
      remainingRuntimeCreateFailures > 0
    ) {
      remainingRuntimeCreateFailures -= 1;
      throw new Error("schema unavailable");
    }
    if (query.startsWith("CREATE TABLE IF NOT EXISTS into_runtime_store")) {
      await options.beforeRuntimeCreate?.(connectionString);
    }

    let fields: Array<{ name: string; dataTypeID: number }> = [];
    let rows: unknown[][] = [];

    if (query.startsWith("SELECT revision FROM into_runtime_store")) {
      fields = [{ name: "revision", dataTypeID: 23 }];
      rows = [[String(options.revisions.get(connectionString) ?? 0)]];
    } else if (query.startsWith("INSERT INTO into_temp_invoice_files")) {
      files.set(`${connectionString}:${body.params[0]}`, body.params);
    } else if (
      query.startsWith(
        "SELECT original_file_name, stored_file_name, file_type, file_size, checksum, content_base64 FROM into_temp_invoice_files"
      )
    ) {
      const file = files.get(`${connectionString}:${body.params[0]}`);
      if (file) {
        fields = [
          { name: "original_file_name", dataTypeID: 25 },
          { name: "stored_file_name", dataTypeID: 25 },
          { name: "file_type", dataTypeID: 25 },
          { name: "file_size", dataTypeID: 20 },
          { name: "checksum", dataTypeID: 25 },
          { name: "content_base64", dataTypeID: 25 },
        ];
        rows = [[file[1], file[2], file[3], String(file[4]), file[5], file[6]]];
      }
    }

    return new Response(JSON.stringify({ fields, rows, rowCount: rows.length }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  return { fetch, requests };
}

async function withPostgres(
  databaseUrl: string,
  fetch: typeof globalThis.fetch,
  run: () => Promise<void>
) {
  const previousMode = process.env.DATABASE_MODE;
  const previousUrl = process.env.DATABASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.DATABASE_MODE = "postgres";
  process.env.DATABASE_URL = databaseUrl;
  globalThis.fetch = fetch;

  try {
    await run();
  } finally {
    if (previousMode === undefined) delete process.env.DATABASE_MODE;
    else process.env.DATABASE_MODE = previousMode;
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    globalThis.fetch = previousFetch;
  }
}

function countSql(requests: NeonRequest[], connectionString: string, prefix: string) {
  return requests.filter(
    (request) =>
      request.connectionString === connectionString && request.query.startsWith(prefix)
  ).length;
}

test("initializes only the current PostgreSQL URL once across sequential warm calls", async () => {
  const firstUrl = "postgresql://test:test@first-schema-cache.example/into";
  const secondUrl = "postgresql://test:test@second-schema-cache.example/into";
  const fake = fakeNeonFetch({
    revisions: new Map([
      [firstUrl, 3],
      [secondUrl, 9],
    ]),
  });

  await withPostgres(firstUrl, fake.fetch, async () => {
    assert.equal(await loadStoreRevision(), 3);
    assert.equal(await loadStoreRevision(), 3);
    process.env.DATABASE_URL = secondUrl;
    assert.equal(await loadStoreRevision(), 9);
    assert.equal(await loadStoreRevision(), 9);
    process.env.DATABASE_URL = firstUrl;
    assert.equal(await loadStoreRevision(), 3);
  });

  assert.equal(
    countSql(fake.requests, firstUrl, "CREATE TABLE IF NOT EXISTS into_runtime_store"),
    2
  );
  assert.equal(countSql(fake.requests, firstUrl, "ALTER TABLE into_runtime_store"), 2);
  assert.equal(
    countSql(fake.requests, secondUrl, "CREATE TABLE IF NOT EXISTS into_runtime_store"),
    1
  );
  assert.equal(countSql(fake.requests, secondUrl, "ALTER TABLE into_runtime_store"), 1);
});

test("concurrent first PostgreSQL calls share runtime schema initialization", async () => {
  const url = "postgresql://test:test@concurrent-schema-cache.example/into";
  const fake = fakeNeonFetch({ revisions: new Map([[url, 4]]) });

  await withPostgres(url, fake.fetch, async () => {
    assert.deepEqual(await Promise.all([loadStoreRevision(), loadStoreRevision()]), [4, 4]);
  });

  assert.equal(
    countSql(fake.requests, url, "CREATE TABLE IF NOT EXISTS into_runtime_store"),
    1
  );
  assert.equal(countSql(fake.requests, url, "ALTER TABLE into_runtime_store"), 1);
});

test("initializes the temporary invoice-file schema once across repeated file APIs", async () => {
  const url = "postgresql://test:test@file-schema-cache.example/into";
  const fake = fakeNeonFetch({ revisions: new Map([[url, 1]]) });
  const bytes = new TextEncoder().encode("invoice bytes");

  await withPostgres(url, fake.fetch, async () => {
    await savePostgresTemporaryInvoiceFile({
      storageKey: "invoice-cache-key",
      originalFileName: "invoice.pdf",
      storedFileName: "stored-invoice.pdf",
      fileType: "application/pdf",
      fileSize: bytes.length,
      checksum: "checksum-cache",
      bytes,
    });
    const loaded = await loadPostgresTemporaryInvoiceFile("invoice-cache-key");

    assert.equal(loaded?.originalFileName, "invoice.pdf");
    assert.equal(loaded?.fileSize, bytes.length);
    assert.deepEqual(loaded?.bytes, bytes);
  });

  assert.equal(
    countSql(fake.requests, url, "CREATE TABLE IF NOT EXISTS into_temp_invoice_files"),
    1
  );
});

test("retries a failed runtime schema initialization without recaching it on warm calls", async () => {
  const url = "postgresql://test:test@retry-schema-cache.example/into";
  const fake = fakeNeonFetch({
    revisions: new Map([[url, 8]]),
    failRuntimeCreates: 1,
  });

  await withPostgres(url, fake.fetch, async () => {
    await assert.rejects(loadStoreRevision(), /schema unavailable/);
    assert.equal(await loadStoreRevision(), 8);
    assert.equal(await loadStoreRevision(), 8);
  });

  assert.equal(
    countSql(fake.requests, url, "CREATE TABLE IF NOT EXISTS into_runtime_store"),
    2
  );
  assert.equal(countSql(fake.requests, url, "ALTER TABLE into_runtime_store"), 1);
});

test("a late old-URL failure cannot clear the newer runtime schema readiness", async () => {
  const oldUrl = "postgresql://test:test@late-old-schema-cache.example/into";
  const newUrl = "postgresql://test:test@late-new-schema-cache.example/into";
  let oldStarted!: () => void;
  let rejectOld!: (error: Error) => void;
  const oldCreateStarted = new Promise<void>((resolve) => {
    oldStarted = resolve;
  });
  const oldCreate = new Promise<void>((_resolve, reject) => {
    rejectOld = reject;
  });
  const fake = fakeNeonFetch({
    revisions: new Map([
      [oldUrl, 10],
      [newUrl, 12],
    ]),
    beforeRuntimeCreate: async (connectionString) => {
      if (connectionString === oldUrl) {
        oldStarted();
        await oldCreate;
      }
    },
  });

  await withPostgres(oldUrl, fake.fetch, async () => {
    const oldCall = loadStoreRevision();
    await oldCreateStarted;
    process.env.DATABASE_URL = newUrl;
    assert.equal(await loadStoreRevision(), 12);
    const oldRejected = assert.rejects(oldCall, /old schema unavailable/);
    rejectOld(new Error("old schema unavailable"));
    await oldRejected;
    assert.equal(await loadStoreRevision(), 12);
  });

  assert.equal(
    countSql(fake.requests, newUrl, "CREATE TABLE IF NOT EXISTS into_runtime_store"),
    1
  );
  assert.equal(countSql(fake.requests, newUrl, "ALTER TABLE into_runtime_store"), 1);
});

test("a late old-URL file call cannot replace newer file-schema readiness", async () => {
  const oldUrl = "postgresql://test:test@late-old-file-cache.example/into";
  const newUrl = "postgresql://test:test@late-new-file-cache.example/into";
  let oldStarted!: () => void;
  let releaseOld!: () => void;
  const oldCreateStarted = new Promise<void>((resolve) => {
    oldStarted = resolve;
  });
  const oldCreate = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  const fake = fakeNeonFetch({
    revisions: new Map(),
    beforeRuntimeCreate: async (connectionString) => {
      if (connectionString === oldUrl) {
        oldStarted();
        await oldCreate;
      }
    },
  });
  const bytes = new TextEncoder().encode("file race bytes");

  await withPostgres(oldUrl, fake.fetch, async () => {
    const oldCall = savePostgresTemporaryInvoiceFile({
      storageKey: "old-file-key",
      originalFileName: "old.pdf",
      storedFileName: "stored-old.pdf",
      fileType: "application/pdf",
      fileSize: bytes.length,
      checksum: "old-checksum",
      bytes,
    });
    await oldCreateStarted;

    process.env.DATABASE_URL = newUrl;
    await savePostgresTemporaryInvoiceFile({
      storageKey: "new-file-key",
      originalFileName: "new.pdf",
      storedFileName: "stored-new.pdf",
      fileType: "application/pdf",
      fileSize: bytes.length,
      checksum: "new-checksum",
      bytes,
    });

    releaseOld();
    await oldCall;
    const loaded = await loadPostgresTemporaryInvoiceFile("new-file-key");
    assert.equal(loaded?.originalFileName, "new.pdf");
    assert.deepEqual(loaded?.bytes, bytes);
  });

  assert.equal(
    countSql(fake.requests, newUrl, "CREATE TABLE IF NOT EXISTS into_temp_invoice_files"),
    1
  );
});

test("PostgreSQL store transactions commit all work through one client", async () => {
  const calls: string[] = [];
  let released = false;
  let ended = false;
  const result = await withPostgresStoreTransaction(
    async (query) => {
      await query("INSERT INTO normalized_learning VALUES ($1)", ["example-a"]);
      return "committed";
    },
    async () => ({
      query: async (query: string) => {
        calls.push(query);
        return [];
      },
      release: () => {
        released = true;
      },
      end: async () => {
        ended = true;
      },
    })
  );

  assert.equal(result, "committed");
  assert.deepEqual(calls, [
    "BEGIN",
    "INSERT INTO normalized_learning VALUES ($1)",
    "COMMIT",
  ]);
  assert.equal(released, true);
  assert.equal(ended, true);
});

test("PostgreSQL store transactions roll back every write when projection fails", async () => {
  const calls: string[] = [];
  let released = false;
  let ended = false;

  await assert.rejects(
    withPostgresStoreTransaction(
      async (query) => {
        await query("INSERT INTO normalized_learning VALUES ($1)", ["example-a"]);
        throw new Error("projection failed");
      },
      async () => ({
        query: async (query: string) => {
          calls.push(query);
          return [];
        },
        release: () => {
          released = true;
        },
        end: async () => {
          ended = true;
        },
      })
    ),
    /projection failed/
  );

  assert.deepEqual(calls, [
    "BEGIN",
    "INSERT INTO normalized_learning VALUES ($1)",
    "ROLLBACK",
  ]);
  assert.equal(released, true);
  assert.equal(ended, true);
});

test("PostgreSQL snapshot CAS failure rolls back normalized writes in the same transaction", async () => {
  const url = "postgresql://test:test@atomic-cas.example/into";
  const fake = fakeNeonFetch({ revisions: new Map() });
  const calls: string[] = [];
  const store = {
    schemaVersion: 3,
    revision: 4,
    invoices: [],
  } as unknown as IntoStore;

  await withPostgres(url, fake.fetch, async () => {
    await assert.rejects(
      withPostgresStoreTransaction(
        async (query) => {
          await query("INSERT INTO normalized_learning VALUES ($1)", ["example-a"]);
          await saveStoreSnapshot(store, query);
        },
        async () => ({
          query: async (query: string) => {
            calls.push(query);
            return [];
          },
          release: () => undefined,
          end: async () => undefined,
        })
      ),
      /changed in another request/i
    );
  });

  assert.match(calls[2] ?? "", /UPDATE into_runtime_store/);
  assert.deepEqual(
    calls.filter((query) => /^(BEGIN|COMMIT|ROLLBACK)$/.test(query)),
    ["BEGIN", "ROLLBACK"]
  );
});
