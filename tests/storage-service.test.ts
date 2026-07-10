import test from "node:test";
import assert from "node:assert/strict";
import { rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  deleteStoredInvoiceFile,
  getStoredInvoiceFile,
  invoiceStorageProvider,
  storeInvoiceFile,
  temporaryInvoiceRetentionDays,
  temporaryInvoiceStoragePath,
  verifyInvoiceStorageWorks,
} from "../lib/services/storage-service";

async function withEnv(
  values: Record<string, string | undefined>,
  run: () => void | Promise<void>
) {
  const keys = [
    "NODE_ENV",
    "VERCEL",
    "VERCEL_ENV",
    "STORAGE_MODE",
    "STORAGE_PROVIDER",
    "TEMP_INVOICE_STORAGE_PATH",
    "TEMP_INVOICE_RETENTION_DAYS",
    "S3_ENDPOINT",
    "S3_BUCKET",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
    "S3_REGION",
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));

  for (const key of keys) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    await run();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function testStoragePath(name: string) {
  return `storage/tmp-tests/${name}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
}

test("uses local temporary invoice storage by default", async () => {
  const storagePath = testStoragePath("default-local");
  await withEnv({ NODE_ENV: "test", TEMP_INVOICE_STORAGE_PATH: storagePath }, async () => {
    const file = new File(["hello"], "invoice.pdf", { type: "application/pdf" });
    const stored = await storeInvoiceFile(file);
    const retrieved = await getStoredInvoiceFile(stored.storageKey);

    assert.equal(invoiceStorageProvider(), "local_temp");
    assert.equal(temporaryInvoiceStoragePath().endsWith(storagePath.replaceAll("/", "\\")) || temporaryInvoiceStoragePath().endsWith(storagePath), true);
    assert.equal(temporaryInvoiceRetentionDays(), 30);
    assert.equal(retrieved?.fileName, "invoice.pdf");
    assert.equal(retrieved?.fileType, "application/pdf");
    assert.equal(retrieved?.checksum, stored.checksum);
    assert.equal(new TextDecoder().decode(retrieved?.bytes), "hello");
    assert.equal(await verifyInvoiceStorageWorks(), true);
    await stat(stored.storageKey);
    assert.equal(await deleteStoredInvoiceFile(stored.storageKey), true);
    assert.equal(await getStoredInvoiceFile(stored.storageKey), null);
  });
  await rm(storagePath, { recursive: true, force: true });
});

test("does not require S3 settings in production when using local temp storage", async () => {
  const storagePath = testStoragePath("production-local");
  await withEnv(
    {
      NODE_ENV: "production",
      STORAGE_MODE: "local_temp",
      TEMP_INVOICE_STORAGE_PATH: storagePath,
      TEMP_INVOICE_RETENTION_DAYS: "14",
    },
    async () => {
      assert.equal(invoiceStorageProvider(), "local_temp");
      assert.equal(temporaryInvoiceRetentionDays(), 14);
      assert.equal(await verifyInvoiceStorageWorks(), true);
    }
  );
  await rm(storagePath, { recursive: true, force: true });
});
test("uses writable tmp storage for relative paths on Vercel", async () => {
  const storagePath = testStoragePath("vercel-local");
  let resolvedStoragePath = "";

  await withEnv(
    {
      NODE_ENV: "production",
      VERCEL: "1",
      VERCEL_ENV: "production",
      TEMP_INVOICE_STORAGE_PATH: storagePath,
    },
    async () => {
      resolvedStoragePath = temporaryInvoiceStoragePath();
      assert.equal(resolvedStoragePath.startsWith(tmpdir()), true);
      assert.equal(resolvedStoragePath.includes("storage"), true);
      assert.equal(await verifyInvoiceStorageWorks(), true);
    }
  );

  await rm(resolvedStoragePath, { recursive: true, force: true });
});