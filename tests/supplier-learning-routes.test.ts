import assert from "node:assert/strict";
import test from "node:test";
import { POST as learnInvoiceRoute } from "../app/api/invoices/[invoiceId]/learn/route";
import { POST as bookInvoiceRoute } from "../app/api/invoices/[invoiceId]/book/route";
import { POST as bookReadyRoute } from "../app/api/invoices/book-ready/route";
import { GET as listSupplierLearningRoute } from "../app/api/suppliers/learning/route";
import { POST as resetSupplierLearningRoute } from "../app/api/suppliers/[accountId]/learning/reset/route";
import { LEARNING_ONLY_BOOKING_MESSAGE } from "../lib/domain/invoice";
import {
  createUploadedInvoice,
  getStore,
} from "../lib/repository/invoice-store";

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
