import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import type {
  ExactConnection,
  ExactMasterDataCache,
  UploadedInvoice,
} from "../lib/domain/invoice";
import { createRealExactPurchaseBooking } from "../lib/services/exact-api-client";
import { encryptExactSecret } from "../lib/services/exact-token-crypto";
import {
  deleteStoredInvoiceFile,
  getStoredInvoiceFile,
  storeInvoiceFile,
} from "../lib/services/storage-service";

const storagePath = `storage/tmp-tests/exact-real-${Date.now()}-${Math.random()
  .toString(16)
  .slice(2)}`;

const exactEnvKeys = [
  "EXACT_ONLINE_BASE_URL",
  "EXACT_ONLINE_CLIENT_ID",
  "EXACT_ONLINE_CLIENT_SECRET",
  "EXACT_ONLINE_REDIRECT_URI",
  "EXACT_ONLINE_ENABLE_REAL_BOOKING",
  "EXACT_ONLINE_DOCUMENT_TYPE",
  "OAUTH_TOKEN_ENCRYPTION_KEY",
  "TEMP_INVOICE_STORAGE_PATH",
];

async function withExactBookingEnv(run: () => Promise<void>) {
  const previous = new Map(exactEnvKeys.map((key) => [key, process.env[key]]));
  process.env.EXACT_ONLINE_BASE_URL = "https://exact.test";
  process.env.EXACT_ONLINE_CLIENT_ID = "exact-client-id";
  process.env.EXACT_ONLINE_CLIENT_SECRET = "exact-client-secret";
  process.env.EXACT_ONLINE_REDIRECT_URI =
    "https://into.example.com/api/exact/callback";
  process.env.EXACT_ONLINE_ENABLE_REAL_BOOKING = "true";
  process.env.EXACT_ONLINE_DOCUMENT_TYPE = "55";
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = "exact-test-encryption-key";
  process.env.TEMP_INVOICE_STORAGE_PATH = storagePath;

  try {
    await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(storagePath, { recursive: true, force: true });
  }
}

function masterData(): ExactMasterDataCache {
  return {
    source: "exact-online",
    divisionCode: "123456",
    lastSyncedAt: new Date().toISOString(),
    staleAfter: new Date(Date.now() + 60_000).toISOString(),
    suppliers: [
      {
        id: "supplier-guid",
        code: "SUP-1",
        name: "Test Supplier",
        vatNumber: "NL123",
        iban: "",
        chamberOfCommerceNumber: "",
        address: "",
        country: "NL",
        paymentConditionCode: "30",
        paymentConditionLabel: "30 days",
        defaultGlAccount: "4420",
        defaultGlAccountName: "Software",
        isInBodyEntity: false,
      },
    ],
    paymentConditions: [{ code: "30", label: "30 days", days: 30, isActive: true }],
    journals: [{ code: "60", description: "Purchases", type: "purchase", isActive: true }],
    glAccounts: [
      { id: "gl-account-guid", code: "4420", name: "Software", isActive: true },
    ],
    costCenters: [],
    costUnits: [],
    vatCodes: [
      { code: "4", description: "Domestic high", percentage: 21, type: "purchase", isActive: true },
    ],
    historicalPurchaseBookings: [],
  };
}

function invoice(storageKey: string): UploadedInvoice {
  return {
    id: "invoice-live-test",
    fileName: "original-invoice.pdf",
    fileType: "application/pdf",
    storageKey,
    extractedData: {
      supplierName: "Test Supplier",
      invoiceNumber: "INV-2026-001",
      referenceCode: "INV-2026-001",
      invoiceDate: "2026-07-01",
      dueDate: "2026-07-31",
      currency: "EUR",
      grossAmount: 121,
    },
    purchaseJournal: {
      attachmentStorageKey: storageKey,
      description: "2026.07 Software",
      paymentConditionCode: "30",
      yourRef: "INV-2026-001",
      currency: "EUR",
      journal: "60",
      financialYear: 2026,
      period: 7,
      supplierResolution: { selectedAccountId: "supplier-guid" },
      lines: [
        {
          finalSelectedAccount: "4420",
          description: "2026.07 Software",
          from: "",
          to: "",
          costCentre: "",
          costUnit: "",
          vatCode: "4",
          amount: 100,
          vatAmount: 21,
        },
      ],
      totals: { lineAmount: 100, vatAmount: 21, grossAmount: 121, difference: 0 },
    },
  } as unknown as UploadedInvoice;
}

async function exactConnection(): Promise<ExactConnection> {
  return {
    id: "exact-connection",
    userId: "company_connection",
    divisionCode: "123456",
    status: "connected",
    accessTokenCiphertext: await encryptExactSecret("access-token"),
    refreshTokenCiphertext: await encryptExactSecret("refresh-token"),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    scopes: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

test("creates and attaches the original document before posting the Exact purchase entry", async () => {
  await withExactBookingEnv(async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ method: string; pathname: string; body?: Record<string, unknown> }> = [];
    const stored = await storeInvoiceFile(
      new File(["%PDF-1.7 original bytes"], "original-invoice.pdf", {
        type: "application/pdf",
      })
    );
    const connection = await exactConnection();

    globalThis.fetch = (async (input, init) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input.toString() : input.url
      );
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, pathname: url.pathname, body });

      if (/\/documents\/DocumentTypes$/i.test(url.pathname)) {
        return Response.json({ d: { results: [{ ID: 55, DocumentIsCreatable: true }] } });
      }
      if (/\/documents\/Documents$/i.test(url.pathname)) {
        return Response.json({ d: { ID: "document-guid" } }, { status: 201 });
      }
      if (/\/documents\/DocumentAttachments$/i.test(url.pathname)) {
        return Response.json({ d: { ID: "attachment-guid" } }, { status: 201 });
      }
      if (/\/purchaseentry\/PurchaseEntries$/i.test(url.pathname)) {
        return Response.json(
          { d: { EntryID: "purchase-entry-guid", EntryNumber: 2600001 } },
          { status: 201 }
        );
      }

      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    try {
      const result = await createRealExactPurchaseBooking(
        connection,
        invoice(stored.storageKey),
        masterData()
      );

      assert.deepEqual(
        calls.map((call) => `${call.method} ${call.pathname}`),
        [
          "GET /api/v1/123456/documents/DocumentTypes",
          "POST /api/v1/123456/documents/Documents",
          "POST /api/v1/123456/documents/DocumentAttachments",
          "POST /api/v1/123456/purchaseentry/PurchaseEntries",
        ]
      );
      assert.equal(calls[2]?.body?.Document, "document-guid");
      assert.equal(
        calls[2]?.body?.Attachment,
        Buffer.from("%PDF-1.7 original bytes").toString("base64")
      );
      const entryLines = calls[3]?.body?.PurchaseEntryLines as Array<Record<string, unknown>>;
      assert.equal(entryLines[0]?.GLAccount, "gl-account-guid");
      assert.equal(entryLines[0]?.VATCode, "4");
      assert.equal(calls[3]?.body?.Document, "document-guid");
      assert.equal(result.exactBookingId, "purchase-entry-guid");
      assert.equal(result.exactDocumentId, "document-guid");
      assert.equal(result.exactAttachmentId, "attachment-guid");
      assert.notEqual(await getStoredInvoiceFile(stored.storageKey), null);
    } finally {
      globalThis.fetch = originalFetch;
      await deleteStoredInvoiceFile(stored.storageKey);
    }
  });
});

test("does not post a purchase entry when Exact attachment upload fails", async () => {
  await withExactBookingEnv(async () => {
    const originalFetch = globalThis.fetch;
    const paths: string[] = [];
    const stored = await storeInvoiceFile(
      new File(["%PDF attachment failure"], "attachment-failure.pdf", {
        type: "application/pdf",
      })
    );

    globalThis.fetch = (async (input, init) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input.toString() : input.url
      );
      paths.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (/\/DocumentTypes$/i.test(url.pathname)) {
        return Response.json({ d: { results: [{ ID: 55, DocumentIsCreatable: true }] } });
      }
      if (/\/Documents$/i.test(url.pathname)) {
        return Response.json({ d: { ID: "document-guid" } }, { status: 201 });
      }
      if (/\/DocumentAttachments$/i.test(url.pathname)) {
        return Response.json(
          { error: { message: { value: "Attachment rejected" } } },
          { status: 409 }
        );
      }
      return new Response("Unexpected request", { status: 500 });
    }) as typeof fetch;

    try {
      await assert.rejects(
        createRealExactPurchaseBooking(
          await exactConnection(),
          invoice(stored.storageKey),
          masterData()
        ),
        /Attachment rejected/
      );
      assert.equal(paths.some((path) => /PurchaseEntries/.test(path)), false);
      assert.notEqual(await getStoredInvoiceFile(stored.storageKey), null);
    } finally {
      globalThis.fetch = originalFetch;
      await deleteStoredInvoiceFile(stored.storageKey);
    }
  });
});

test("keeps real Exact posting disabled unless the explicit safety flag is true", async () => {
  await withExactBookingEnv(async () => {
    process.env.EXACT_ONLINE_ENABLE_REAL_BOOKING = "false";
    await assert.rejects(
      createRealExactPurchaseBooking(
        await exactConnection(),
        invoice("missing-file-is-not-read-while-disabled"),
        masterData()
      ),
      /Real Exact Online booking is disabled/
    );
  });
});
