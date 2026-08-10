import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import test from "node:test";
import { GET as getInvoiceAudit } from "../app/api/invoices/[invoiceId]/audit/route";
import { POST as bookInvoice } from "../app/api/invoices/[invoiceId]/book/route";
import { GET as getInvoiceFile } from "../app/api/invoices/[invoiceId]/file/route";
import { GET as listInvoices, POST as uploadInvoices } from "../app/api/invoices/route";
import {
  emptyExtractedInvoiceData,
  type AuditEvent,
  type ExactConnection,
  type ExactMasterDataCache,
  type UploadedInvoice,
} from "../lib/domain/invoice";
import {
  approveInvoiceIntelligence,
  flushStoreToPersistence,
  getCompanyConnectionUserId,
  getStore,
  hydrateStoreFromPersistence,
  setExactConnection,
  updateInvoiceExtraction,
} from "../lib/repository/invoice-store";
import { closeSqliteStore } from "../lib/repository/sqlite-store";
import { encryptExactSecret } from "../lib/services/exact-token-crypto";

const runtimeKeys = [
  "__INTO_STORE",
  "__INTO_STORE_HYDRATED_FOR",
  "__INTO_STORE_HYDRATING",
  "__INTO_STORE_PERSISTING",
  "__INTO_STORE_PERSISTENCE_BATCH",
  "__INTO_STORE_PERSISTENCE_ERROR",
  "__INTO_STORE_DIRTY",
  "__INTO_STORE_DIRTY_REVISION",
  "__INTO_STORE_PERSISTED_DIRTY_REVISION",
  "__INTO_PERSISTENT_REQUEST_TAIL",
] as const;

function clearRuntimeStore() {
  const runtime = globalThis as typeof globalThis & Record<string, unknown>;
  for (const key of runtimeKeys) delete runtime[key];
}

async function withLocalFirstEnvironment(
  run: (paths: { storagePath: string }) => Promise<void>
) {
  const root = await mkdtemp(join(tmpdir(), "into-local-first-restart-"));
  const storagePath = join(root, "storage");
  const environment = process.env as Record<string, string | undefined>;
  const values = {
    NODE_ENV: "test",
    DATABASE_MODE: "sqlite",
    LOCAL_DATABASE_PATH: join(root, "data", "into.sqlite"),
    STORAGE_MODE: "local",
    LOCAL_INVOICE_STORAGE_PATH: storagePath,
    TEMP_INVOICE_STORAGE_PATH: undefined,
    LEARNING_V2_ENABLED: "false",
    SUPPLIER_LEARNING_MODE: "off",
    EXACT_ONLINE_BASE_URL: "https://exact.restart.test",
    EXACT_ONLINE_CLIENT_ID: "restart-client-id",
    EXACT_ONLINE_CLIENT_SECRET: "restart-client-secret",
    EXACT_ONLINE_REDIRECT_URI: "http://localhost/api/exact/callback",
    EXACT_ONLINE_ENABLE_REAL_BOOKING: "true",
    EXACT_ONLINE_DOCUMENT_TYPE: "55",
    OAUTH_TOKEN_ENCRYPTION_KEY: "local-first-restart-token-key",
  };
  const previous = new Map(
    Object.keys(values).map((key) => [key, process.env[key]])
  );

  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete environment[key];
    else environment[key] = value;
  }
  clearRuntimeStore();
  closeSqliteStore();

  try {
    await run({ storagePath });
  } finally {
    clearRuntimeStore();
    closeSqliteStore();
    for (const [key, value] of previous) {
      if (value === undefined) delete environment[key];
      else environment[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactMasterData(): ExactMasterDataCache {
  const now = Date.now();
  return {
    source: "exact-online",
    divisionCode: "123456",
    lastSyncedAt: new Date(now).toISOString(),
    staleAfter: new Date(now + 30 * 60_000).toISOString(),
    suppliers: [
      {
        id: "supplier-restart",
        code: "70001",
        name: "Restart Supplies BV",
        vatNumber: "NL812345678B01",
        iban: "NL91ABNA0417164300",
        chamberOfCommerceNumber: "34123456",
        address: "Restartstraat 1, Amsterdam",
        country: "NL",
        paymentConditionCode: "30",
        paymentConditionLabel: "30 days",
        defaultGlAccount: "4400",
        defaultGlAccountName: "Office supplies",
        isInBodyEntity: false,
      },
    ],
    paymentConditions: [
      { code: "30", label: "30 days", days: 30, isActive: true },
    ],
    journals: [
      { code: "60", description: "Purchases", type: "purchase", isActive: true },
      {
        code: "61",
        description: "Intercompany purchases",
        type: "purchase",
        isActive: true,
      },
    ],
    glAccounts: [
      {
        id: "gl-account-restart",
        code: "4400",
        name: "Office supplies",
        isActive: true,
      },
    ],
    costCenters: [],
    costUnits: [],
    vatCodes: [
      {
        code: "4",
        description: "Domestic high",
        percentage: 21,
        type: "purchase",
        isActive: true,
      },
    ],
    historicalPurchaseBookings: [],
  };
}

async function exactConnection(): Promise<ExactConnection> {
  const timestamp = new Date().toISOString();
  return {
    id: "exact-restart-connection",
    userId: getCompanyConnectionUserId(),
    divisionCode: "123456",
    status: "connected",
    accessTokenCiphertext: await encryptExactSecret("restart-access-token"),
    refreshTokenCiphertext: await encryptExactSecret("restart-refresh-token"),
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    scopes: ["financial", "purchase", "transaction"],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

test("uploaded invoice files and audit state survive a local restart", async () => {
  await withLocalFirstEnvironment(async ({ storagePath }) => {
    const pdfBytes = new TextEncoder().encode(
      "%PDF-1.7\nInvoice number: RESTART-PDF-001\nTotal: EUR 121.00"
    );
    const pngBytes = new Uint8Array(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64"
      )
    );
    const fixtures = [
      {
        fileName: "restart-invoice.pdf",
        fileType: "application/pdf",
        bytes: pdfBytes,
      },
      {
        fileName: "restart-invoice.png",
        fileType: "image/png",
        bytes: pngBytes,
      },
    ];

    await hydrateStoreFromPersistence();
    const formData = new FormData();
    for (const fixture of fixtures) {
      formData.append(
        "files",
        new File([fixture.bytes], fixture.fileName, { type: fixture.fileType })
      );
    }

    const uploadResponse = await uploadInvoices(
      new Request("http://localhost/api/invoices", {
        method: "POST",
        body: formData,
      })
    );
    assert.equal(uploadResponse.status, 201);
    const uploaded = (await uploadResponse.json()) as {
      processed: UploadedInvoice[];
    };
    assert.equal(uploaded.processed.length, 2);

    await flushStoreToPersistence();
    closeSqliteStore();
    clearRuntimeStore();
    await hydrateStoreFromPersistence();

    const listResponse = await listInvoices(new Request("http://localhost/api/invoices"));
    assert.equal(listResponse.status, 200);
    const listed = (await listResponse.json()) as { invoices: UploadedInvoice[] };

    for (const fixture of fixtures) {
      const invoice = listed.invoices.find(
        (candidate) => candidate.fileName === fixture.fileName
      );
      assert.ok(invoice);
      assert.equal(invoice.fileType, fixture.fileType);
      assert.equal(invoice.fileSize, fixture.bytes.byteLength);
      assert.equal(invoice.checksum, sha256(fixture.bytes));
      assert.equal(invoice.localFileStatus, "available");
      assert.ok(invoice.storageKey);
      const storageRelativePath = relative(
        resolve(storagePath),
        resolve(invoice.storageKey)
      );
      assert.equal(
        storageRelativePath.startsWith("..") || isAbsolute(storageRelativePath),
        false
      );

      const auditResponse = await getInvoiceAudit(
        new Request(`http://localhost/api/invoices/${invoice.id}/audit`),
        { params: { invoiceId: invoice.id } }
      );
      assert.equal(auditResponse.status, 200);
      const audit = (await auditResponse.json()) as { events: AuditEvent[] };
      const auditTypes = new Set(audit.events.map((event) => event.type));
      for (const type of [
        "invoice_uploaded",
        "invoice_extracted",
        "invoice_validated",
      ] as const) {
        assert.equal(auditTypes.has(type), true);
      }
      const uploadEvent = audit.events.find(
        (event) => event.type === "invoice_uploaded"
      );
      assert.equal(uploadEvent?.metadata?.fileName, fixture.fileName);
      assert.equal(uploadEvent?.metadata?.checksum, sha256(fixture.bytes));

      const fileUrl = `http://localhost/api/invoices/${invoice.id}/file`;
      const previewResponse = await getInvoiceFile(new Request(fileUrl), {
        params: { invoiceId: invoice.id },
      });
      assert.equal(previewResponse.status, 200);
      assert.equal(previewResponse.headers.get("content-type"), fixture.fileType);
      assert.deepEqual(
        new Uint8Array(await previewResponse.arrayBuffer()),
        fixture.bytes
      );

      if (fixture.fileType === "application/pdf") {
        const downloadResponse = await getInvoiceFile(
          new Request(`${fileUrl}?download=1`),
          { params: { invoiceId: invoice.id } }
        );
        assert.equal(downloadResponse.status, 200);
        assert.equal(
          downloadResponse.headers.get("content-disposition"),
          `attachment; filename="${fixture.fileName}"`
        );
        assert.deepEqual(
          new Uint8Array(await downloadResponse.arrayBuffer()),
          fixture.bytes
        );
      }
    }
  });
});

test("a failed Exact booking remains retryable with its original file after restart", async () => {
  await withLocalFirstEnvironment(async () => {
    const originalFetch = globalThis.fetch;
    const bytes = new TextEncoder().encode(
      "%PDF-1.7\nInvoice number: RETRY-2026-001\nTotal: EUR 121.00"
    );

    globalThis.fetch = (async (input, init) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL
          ? input.toString()
          : input.url
      );
      const method = init?.method ?? "GET";

      if (method === "GET" && /\/purchaseentry\/PurchaseEntr(?:y|ies)/i.test(url.pathname)) {
        return Response.json({ d: { results: [] } });
      }
      if (method === "GET" && /\/documents\/DocumentTypes$/i.test(url.pathname)) {
        return Response.json({
          d: { results: [{ ID: 55, DocumentIsCreatable: true }] },
        });
      }
      if (method === "POST" && /\/documents\/Documents$/i.test(url.pathname)) {
        return Response.json({ d: { ID: "restart-document-id" } }, { status: 201 });
      }
      if (
        method === "POST" &&
        /\/documents\/DocumentAttachments$/i.test(url.pathname)
      ) {
        return Response.json(
          { error: { message: { value: "Attachment rejected by Exact" } } },
          { status: 409 }
        );
      }
      return new Response("Unexpected Exact request", { status: 500 });
    }) as typeof fetch;

    try {
      await hydrateStoreFromPersistence();
      const formData = new FormData();
      formData.append(
        "files",
        new File([bytes], "retry-after-restart.pdf", {
          type: "application/pdf",
        })
      );
      const uploadResponse = await uploadInvoices(
        new Request("http://localhost/api/invoices", {
          method: "POST",
          body: formData,
        })
      );
      assert.equal(uploadResponse.status, 201);
      const uploaded = (await uploadResponse.json()) as {
        processed: UploadedInvoice[];
      };
      const uploadedInvoice = uploaded.processed[0];
      assert.ok(uploadedInvoice);

      getStore().exactMasterDataCaches = [
        { userId: getCompanyConnectionUserId(), cache: exactMasterData() },
      ];
      setExactConnection(await exactConnection());
      const reviewed = updateInvoiceExtraction(uploadedInvoice.id, {
        ...emptyExtractedInvoiceData(),
        supplierName: "Restart Supplies BV",
        supplierVatNumber: "NL812345678B01",
        supplierCountry: "NL",
        invoiceNumber: "RETRY-2026-001",
        referenceCode: "RETRY-2026-001",
        invoiceDate: "2026-08-01",
        dueDate: "2026-08-31",
        paymentTerms: "30 days",
        currency: "EUR",
        netAmount: 100,
        vatAmount: 21,
        grossAmount: 121,
        expenseDescription: "Restart supplies",
        companyVatNumber: "NL857017263B01",
      });
      assert.ok(reviewed);
      const invoice = approveInvoiceIntelligence(uploadedInvoice.id);
      assert.ok(invoice);
      assert.equal(invoice.status, "Ready to Book");
      await flushStoreToPersistence();

      const firstBookingResponse = await bookInvoice(
        new Request(`http://localhost/api/invoices/${invoice.id}/book`, {
          method: "POST",
        }),
        { params: { invoiceId: invoice.id } }
      );
      assert.equal(firstBookingResponse.status, 409);
      const firstFailure = (await firstBookingResponse.json()) as {
        error: string;
        invoice: UploadedInvoice;
      };
      assert.match(firstFailure.error, /Attachment rejected by Exact/);
      assert.equal(firstFailure.invoice.status, "Booking Failed");
      assert.equal(firstFailure.invoice.localFileStatus, "available");
      assert.equal(firstFailure.invoice.bookingAttempts.length, 1);

      closeSqliteStore();
      clearRuntimeStore();
      await hydrateStoreFromPersistence();

      const listResponse = await listInvoices(new Request("http://localhost/api/invoices"));
      const listed = (await listResponse.json()) as { invoices: UploadedInvoice[] };
      const retained = listed.invoices.find(
        (candidate) => candidate.id === invoice.id
      );
      assert.ok(retained);
      assert.equal(retained.status, "Booking Failed");
      assert.equal(retained.exactBookingStatus, "failed");
      assert.equal(retained.localFileStatus, "available");
      assert.equal(retained.bookingAttempts.length, 1);
      assert.match(retained.bookingAttempts[0]?.errorMessage ?? "", /Attachment rejected/);

      const auditResponse = await getInvoiceAudit(
        new Request(`http://localhost/api/invoices/${retained.id}/audit`),
        { params: { invoiceId: retained.id } }
      );
      const audit = (await auditResponse.json()) as { events: AuditEvent[] };
      assert.equal(
        audit.events.some((event) => event.type === "invoice_booking_failed"),
        true
      );

      const fileUrl = `http://localhost/api/invoices/${retained.id}/file`;
      const retainedFileResponse = await getInvoiceFile(new Request(fileUrl), {
        params: { invoiceId: retained.id },
      });
      assert.equal(retainedFileResponse.status, 200);
      assert.deepEqual(
        new Uint8Array(await retainedFileResponse.arrayBuffer()),
        bytes
      );

      const retryResponse = await bookInvoice(
        new Request(`http://localhost/api/invoices/${retained.id}/book`, {
          method: "POST",
        }),
        { params: { invoiceId: retained.id } }
      );
      assert.equal(retryResponse.status, 409);
      const retried = (await retryResponse.json()) as {
        error: string;
        invoice: UploadedInvoice;
      };
      assert.match(retried.error, /Attachment rejected by Exact/);
      assert.equal(retried.invoice.status, "Booking Failed");
      assert.equal(retried.invoice.localFileStatus, "available");
      assert.equal(retried.invoice.bookingAttempts.length, 2);

      const retryFileResponse = await getInvoiceFile(new Request(fileUrl), {
        params: { invoiceId: retained.id },
      });
      assert.equal(retryFileResponse.status, 200);
      assert.deepEqual(
        new Uint8Array(await retryFileResponse.arrayBuffer()),
        bytes
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
