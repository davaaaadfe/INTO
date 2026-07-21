import assert from "node:assert/strict";
import test from "node:test";
import { POST as learnInvoiceRoute } from "../app/api/invoices/[invoiceId]/learn/route";
import { POST as bookInvoiceRoute } from "../app/api/invoices/[invoiceId]/book/route";
import { POST as bookReadyRoute } from "../app/api/invoices/book-ready/route";
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

function routeLearningInvoice() {
  getStore().exactMasterDataCaches = [
    {
      userId: getCompanyConnectionUserId(),
      cache: createMockExactMasterData(),
    },
  ];
  const invoice = createUploadedInvoice({
    fileName: "route-learning.pdf",
    fileType: "application/pdf",
    fileSize: 1_024,
    checksum: "route-learning-hash",
    storageKey: "storage/tmp-invoices/route-learning.pdf",
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
  };
  updateInvoiceExtraction(invoice.id, extractedData, { applyLearning: false });
  return recomputeInvoiceState(invoice.id)!;
}

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

  const listResponse = await listSupplierLearningRoute();
  assert.equal(listResponse.status, 200);
  const payload = (await listResponse.json()) as { suppliers?: unknown[] };
  assert.ok(Array.isArray(payload.suppliers));
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

test("bulk booking rejects learning-only ready invoices before attempts or connection work", async () => {
  const invoice = createUploadedInvoice({
    fileName: "bulk-learning-only.pdf",
    fileType: "application/pdf",
    fileSize: 100,
    storageKey: "storage/tmp-invoices/bulk-learning-only.pdf",
  });
  invoice.status = "Ready to Book";
  invoice.processingPurpose = "learning_only";
  const auditCount = getStore().auditEvents.length;

  const response = await bookReadyRoute();
  const payload = (await response.json()) as { error?: string };

  assert.equal(response.status, 409);
  assert.equal(payload.error, LEARNING_ONLY_BOOKING_MESSAGE);
  assert.deepEqual(invoice.bookingAttempts, []);
  assert.equal(invoice.status, "Ready to Book");
  assert.equal(getStore().auditEvents.length, auditCount);
});
