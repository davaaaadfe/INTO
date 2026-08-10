import assert from "node:assert/strict";
import test from "node:test";
import { POST as learnInvoiceRoute } from "../app/api/invoices/[invoiceId]/learn/route";
import { POST as bookInvoiceRoute } from "../app/api/invoices/[invoiceId]/book/route";
import { POST as bookReadyRoute } from "../app/api/invoices/book-ready/route";
import { POST as intelligenceRoute } from "../app/api/invoices/[invoiceId]/intelligence/route";
import { GET as listSupplierLearningRoute } from "../app/api/suppliers/learning/route";
import { POST as resetSupplierLearningRoute } from "../app/api/suppliers/[accountId]/learning/reset/route";
import {
  emptyExtractedInvoiceData,
  LEARNING_ONLY_BOOKING_MESSAGE,
} from "../lib/domain/invoice";
import {
  createUploadedInvoice,
  getCompanyConnectionUserId,
  getStore,
  recomputeInvoiceState,
  resetLearningForSupplier,
  updateInvoiceExtraction,
} from "../lib/repository/invoice-store";
import { createMockExactMasterData } from "../lib/services/exact-master-data-service";

let routeLearningInvoiceSequence = 0;

function routeLearningInvoice() {
  routeLearningInvoiceSequence += 1;
  const sequence = routeLearningInvoiceSequence;
  getStore().exactMasterDataCaches = [
    {
      userId: getCompanyConnectionUserId(),
      cache: createMockExactMasterData(),
    },
  ];
  const invoice = createUploadedInvoice({
    fileName: `route-learning-${sequence}.pdf`,
    fileType: "application/pdf",
    fileSize: 1_024,
    checksum: `route-learning-hash-${sequence}`,
    storageKey: `storage/tmp-invoices/route-learning-${sequence}.pdf`,
  });
  const extractedData = {
    ...emptyExtractedInvoiceData(),
    supplierName: "Noordzee Office Supplies",
    supplierVatNumber: "NL812345678B01",
    supplierCountry: "NL",
    invoiceNumber: "ROUTE-LEARN-1",
    referenceCode: "ROUTE-LEARN-1",
    invoiceDate: "2026-07-21",
    paymentTerms: "7 days",
    currency: "EUR",
    netAmount: 100,
    vatAmount: 21,
    grossAmount: 121,
    expenseDescription: "Office Supplies",
    companyVatNumber: "NL857017263B01",
    rawText: "Invoice number ROUTE-LEARN-1\nOffice Supplies",
    documentTextMode: "plain_text" as const,
  };
  updateInvoiceExtraction(invoice.id, extractedData, { applyLearning: false });
  return recomputeInvoiceState(invoice.id)!;
}

test("supplier selection atomically saves the live corrected draft", async () => {
  const invoice = routeLearningInvoice();
  const correctedData = {
    ...invoice.extractedData,
    expenseDescription: "Corrected before supplier selection",
  };
  const response = await intelligenceRoute(
    new Request(`http://localhost/api/invoices/${invoice.id}/intelligence`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "selectSupplier",
        accountId: "supplier_delta_it",
        expectedRevision: invoice.revision,
        extractedData: correctedData,
        bookingLines: invoice.purchaseJournal?.lines ?? [],
      }),
    }),
    { params: { invoiceId: invoice.id } }
  );
  const payload = (await response.json()) as {
    invoice?: ReturnType<typeof routeLearningInvoice>;
  };

  assert.equal(response.status, 200);
  assert.equal(
    payload.invoice?.extractedData.expenseDescription,
    "Corrected before supplier selection"
  );
  assert.equal(
    payload.invoice?.purchaseJournal?.supplierResolution.selectedAccountId,
    "supplier_delta_it"
  );
});

test("supplier learning routes return stable not-found and list responses", async () => {
  const learnResponse = await learnInvoiceRoute(
    new Request("http://localhost/api/invoices/missing/learn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ extractedData: {}, bookingLines: [] }),
    }),
    { params: { invoiceId: "missing" } }
  );
  assert.equal(learnResponse.status, 404);

  const resetResponse = await resetSupplierLearningRoute(
    new Request("http://localhost/api/suppliers/missing/learning/reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedGeneration: 1 }),
    }),
    { params: { accountId: "missing" } }
  );
  assert.equal(resetResponse.status, 404);

  const listResponse = await listSupplierLearningRoute(new Request("http://localhost/api/suppliers/learning"));
  assert.equal(listResponse.status, 200);
  const payload = (await listResponse.json()) as { suppliers?: unknown[] };
  assert.ok(Array.isArray(payload.suppliers));
});

test("supplier learning read state stays off until both rollout flags are enabled", async () => {
  const original = {
    NODE_ENV: process.env.NODE_ENV,
    LEARNING_V2_ENABLED: process.env.LEARNING_V2_ENABLED,
    LEARNING_UI_ENABLED: process.env.LEARNING_UI_ENABLED,
  };

  try {
    Reflect.set(process.env, "NODE_ENV", "production");
    delete process.env.LEARNING_V2_ENABLED;
    delete process.env.LEARNING_UI_ENABLED;

    const productionDefault = await listSupplierLearningRoute(new Request("http://localhost/api/suppliers/learning"));
    assert.deepEqual(await productionDefault.json(), {
      enabled: false,
      suppliers: [],
    });

    process.env.LEARNING_V2_ENABLED = "true";
    process.env.LEARNING_UI_ENABLED = "false";
    const hiddenUi = await listSupplierLearningRoute(new Request("http://localhost/api/suppliers/learning"));
    assert.deepEqual(await hiddenUi.json(), {
      enabled: false,
      suppliers: [],
    });

    process.env.LEARNING_V2_ENABLED = "false";
    process.env.LEARNING_UI_ENABLED = "true";
    const disabledLearning = await listSupplierLearningRoute(new Request("http://localhost/api/suppliers/learning"));
    assert.deepEqual(await disabledLearning.json(), {
      enabled: false,
      suppliers: [],
    });

    process.env.LEARNING_V2_ENABLED = "true";
    const enabled = await listSupplierLearningRoute(new Request("http://localhost/api/suppliers/learning"));
    const payload = (await enabled.json()) as {
      enabled?: boolean;
      suppliers?: unknown[];
    };
    assert.equal(payload.enabled, true);
    assert.ok(Array.isArray(payload.suppliers));
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("supplier learning write routes stay unavailable behind the main kill switch", async () => {
  const previousEnabled = process.env.LEARNING_V2_ENABLED;
  const previousMode = process.env.SUPPLIER_LEARNING_MODE;
  process.env.LEARNING_V2_ENABLED = "false";
  process.env.SUPPLIER_LEARNING_MODE = "apply";
  try {
    const invoice = routeLearningInvoice();
    const before = structuredClone(invoice);
    const learnResponse = await learnInvoiceRoute(
      new Request(`http://localhost/api/invoices/${invoice.id}/learn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: invoice.revision,
          extractedData: invoice.extractedData,
          bookingLines: invoice.purchaseJournal?.lines ?? [],
        }),
      }),
      { params: { invoiceId: invoice.id } }
    );
    assert.equal(learnResponse.status, 404);
    assert.deepEqual(invoice, before);

    const resetResponse = await resetSupplierLearningRoute(
      new Request("http://localhost/api/suppliers/disabled/learning/reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedGeneration: 1 }),
      }),
      { params: { accountId: "disabled" } }
    );
    assert.equal(resetResponse.status, 404);
  } finally {
    if (previousEnabled === undefined) delete process.env.LEARNING_V2_ENABLED;
    else process.env.LEARNING_V2_ENABLED = previousEnabled;
    if (previousMode === undefined) delete process.env.SUPPLIER_LEARNING_MODE;
    else process.env.SUPPLIER_LEARNING_MODE = previousMode;
  }
});

test("Learn route requires an integer revision and rejects stale drafts without mutation", async () => {
  const invoice = routeLearningInvoice();
  const invoiceBefore = structuredClone(invoice);
  const learningBefore = structuredClone(getStore().learning);
  const auditsBefore = structuredClone(getStore().auditEvents);

  const missingResponse = await learnInvoiceRoute(
    new Request(`http://localhost/api/invoices/${invoice.id}/learn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ extractedData: {}, bookingLines: [] }),
    }),
    { params: { invoiceId: invoice.id } }
  );
  assert.equal(missingResponse.status, 400);

  const staleResponse = await learnInvoiceRoute(
    new Request(`http://localhost/api/invoices/${invoice.id}/learn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: invoice.revision! - 1,
        extractedData: { expenseDescription: "Stale route edit" },
        bookingLines: invoice.purchaseJournal!.lines,
      }),
    }),
    { params: { invoiceId: invoice.id } }
  );
  assert.equal(staleResponse.status, 409);

  assert.deepEqual(invoice, invoiceBefore);
  assert.deepEqual(getStore().learning, learningBefore);
  assert.deepEqual(getStore().auditEvents, auditsBefore);
});

test("Learn route saves a reset Learned invoice into the active generation", async () => {
  const invoice = routeLearningInvoice();
  const firstResponse = await learnInvoiceRoute(
    new Request(`http://localhost/api/invoices/${invoice.id}/learn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: invoice.revision,
        extractedData: invoice.extractedData,
        bookingLines: invoice.purchaseJournal!.lines,
      }),
    }),
    { params: { invoiceId: invoice.id } }
  );
  assert.equal(firstResponse.status, 200);
  const first = (await firstResponse.json()) as { invoice: typeof invoice };
  const firstGeneration = first.invoice.learningMetadata!.generation;

  resetLearningForSupplier(
    first.invoice.learningMetadata!.supplierAccountId,
    firstGeneration
  );
  const secondResponse = await learnInvoiceRoute(
    new Request(`http://localhost/api/invoices/${invoice.id}/learn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: first.invoice.revision,
        extractedData: first.invoice.extractedData,
        bookingLines:
          first.invoice.bookingLineOverrides ?? first.invoice.purchaseJournal!.lines,
      }),
    }),
    { params: { invoiceId: invoice.id } }
  );
  assert.equal(secondResponse.status, 200);
  const second = (await secondResponse.json()) as { invoice: typeof invoice };
  assert.equal(second.invoice.learningMetadata!.generation, firstGeneration + 1);
  assert.equal(second.invoice.revision, first.invoice.revision! + 1);
});

test("Learn route accepts the exact original retry and rejects a changed stale retry", async () => {
  const invoice = routeLearningInvoice();
  const requestPayload = {
    expectedRevision: invoice.revision!,
    extractedData: invoice.extractedData,
    bookingLines: invoice.purchaseJournal!.lines,
  };
  const post = (payload: typeof requestPayload) =>
    learnInvoiceRoute(
      new Request(`http://localhost/api/invoices/${invoice.id}/learn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      { params: { invoiceId: invoice.id } }
    );

  const firstResponse = await post(requestPayload);
  assert.equal(firstResponse.status, 200);
  const first = (await firstResponse.json()) as { invoice: typeof invoice };

  const retryResponse = await post(requestPayload);
  assert.equal(retryResponse.status, 200);
  const retry = (await retryResponse.json()) as { invoice: typeof invoice };
  assert.equal(retry.invoice.revision, first.invoice.revision);
  assert.equal(
    retry.invoice.learningMetadata!.exampleId,
    first.invoice.learningMetadata!.exampleId
  );

  const changedResponse = await post({
    ...requestPayload,
    extractedData: {
      ...requestPayload.extractedData,
      expenseDescription: "Different stale route payload",
    },
  });
  assert.equal(changedResponse.status, 409);
});

test("Learn route keeps retries isolated when invoices share a content hash", async () => {
  const firstInvoice = routeLearningInvoice();
  const secondInvoice = routeLearningInvoice();
  firstInvoice.checksum = "route-shared-content-hash";
  secondInvoice.checksum = "route-shared-content-hash";
  const payloadFor = (invoice: typeof firstInvoice, description: string) => ({
    expectedRevision: invoice.revision!,
    requestKey: `request-${invoice.id}`,
    extractedData: { ...invoice.extractedData, expenseDescription: description },
    bookingLines: invoice.purchaseJournal!.lines,
  });
  const firstPayload = payloadFor(firstInvoice, "First route correction");
  const secondPayload = payloadFor(secondInvoice, "Second route correction");
  const post = (invoice: typeof firstInvoice, payload: typeof firstPayload) =>
    learnInvoiceRoute(
      new Request(`http://localhost/api/invoices/${invoice.id}/learn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      { params: { invoiceId: invoice.id } }
    );

  assert.equal((await post(firstInvoice, firstPayload)).status, 200);
  assert.equal((await post(secondInvoice, secondPayload)).status, 200);
  assert.equal((await post(firstInvoice, firstPayload)).status, 200);
  assert.equal((await post(secondInvoice, secondPayload)).status, 200);
  assert.equal(
    (await post(secondInvoice, { ...secondPayload, requestKey: "wrong-key" })).status,
    409
  );
  assert.equal(
    (
      await post(secondInvoice, {
        ...secondPayload,
        extractedData: firstPayload.extractedData,
      })
    ).status,
    409
  );
});

test("single booking rejects learning-only invoices before attempts or connection work", async () => {
  const invoice = createUploadedInvoice({
    fileName: "single-learning-only.pdf",
    fileType: "application/pdf",
    fileSize: 100,
    storageKey: "storage/tmp-invoices/single-learning-only.pdf",
  });
  invoice.status = "Ready to Book";
  invoice.processingPurpose = "learning_only";
  const auditCount = getStore().auditEvents.length;

  const response = await bookInvoiceRoute(
    new Request(`http://localhost/api/invoices/${invoice.id}/book`, {
      method: "POST",
    }),
    { params: { invoiceId: invoice.id } }
  );
  const payload = (await response.json()) as { error?: string };

  assert.equal(response.status, 409);
  assert.equal(payload.error, LEARNING_ONLY_BOOKING_MESSAGE);
  assert.deepEqual(invoice.bookingAttempts, []);
  assert.equal(invoice.status, "Ready to Book");
  assert.equal(getStore().auditEvents.length, auditCount);
});

test("bulk booking excludes learning-only ready invoices before attempts or connection work", async () => {
  const invoice = createUploadedInvoice({
    fileName: "bulk-learning-only.pdf",
    fileType: "application/pdf",
    fileSize: 100,
    storageKey: "storage/tmp-invoices/bulk-learning-only.pdf",
  });
  invoice.status = "Ready to Book";
  invoice.processingPurpose = "learning_only";
  const auditCount = getStore().auditEvents.length;

  const response = await bookReadyRoute(new Request("http://localhost/api/invoices/book-ready", { method: "POST" }));
  const payload = (await response.json()) as { results?: unknown[] };

  assert.equal(response.status, 200);
  assert.deepEqual(payload.results, []);
  assert.deepEqual(invoice.bookingAttempts, []);
  assert.equal(invoice.status, "Ready to Book");
  assert.equal(getStore().auditEvents.length, auditCount);
});
