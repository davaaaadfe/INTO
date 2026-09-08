import assert from "node:assert/strict";
import test from "node:test";
import { POST as bookInvoiceRoute } from "../app/api/invoices/[invoiceId]/book/route";
import { POST as bookReadyRoute } from "../app/api/invoices/book-ready/route";
import { createUploadedInvoice, getInvoice, saveInvoiceReview } from "../lib/repository/invoice-store";

function createInvoice() {
  return createUploadedInvoice({
    fileName: "booking-command-route.pdf",
    fileType: "application/pdf",
    fileSize: 100,
    storageKey: "storage/tmp-invoices/booking-command-route.pdf",
  });
}

function request(payload: unknown, requestKey?: string) {
  return new Request("http://localhost/api/invoices/book-ready", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(requestKey === undefined ? {} : { "Idempotency-Key": requestKey }),
    },
    body: JSON.stringify(payload),
  });
}

test("booking routes reject non-object JSON without changing invoices", async () => {
  const invoice = createInvoice();
  const before = structuredClone(invoice);
  for (const payload of [null, [], "invoice", 42]) {
    const single = await bookInvoiceRoute(request(payload), { params: { invoiceId: invoice.id } });
    assert.equal(single.status, 422, `single ${JSON.stringify(payload)}`);
    const bulk = await bookReadyRoute(request(payload));
    assert.equal(bulk.status, 422, `bulk ${JSON.stringify(payload)}`);
    assert.deepEqual(getInvoice(invoice.id), before);
  }
});

test("single booking requires a bounded request key before booking work", async () => {
  const invoice = createInvoice();
  const before = structuredClone(invoice);
  for (const requestKey of [undefined, null, "", "   ", 42, "x".repeat(201)]) {
    const response = await bookInvoiceRoute(
      request({ expectedRevision: invoice.revision, requestKey }),
      { params: { invoiceId: invoice.id } }
    );
    assert.equal(response.status, 422, String(requestKey));
    assert.deepEqual(getInvoice(invoice.id), before);
  }
});

test("single booking prefers the header request key and preserves stale conflicts", async () => {
  const invoice = createInvoice();
  const expectedRevision = invoice.revision;
  const current = saveInvoiceReview(invoice.id, invoice.extractedData, [])!;
  const response = await bookInvoiceRoute(
    request({ expectedRevision, requestKey: null }, "header-key"),
    { params: { invoiceId: invoice.id } }
  );
  const payload = await response.json();
  assert.equal(response.status, 409);
  assert.equal(payload.code, "invoice_revision_conflict");
  assert.equal(payload.currentInvoice.revision, current.revision);

  const invalidHeader = await bookInvoiceRoute(
    request({ expectedRevision: current.revision, requestKey: "body-key" }, " "),
    { params: { invoiceId: invoice.id } }
  );
  assert.equal(invalidHeader.status, 422);
});

test("bulk booking rejects malformed, oversized and duplicate item lists before mutation", async () => {
  const invoice = createInvoice();
  const before = structuredClone(invoice);
  const item = { invoiceId: invoice.id, expectedRevision: invoice.revision };
  const invalidLists = [
    undefined,
    [],
    [null],
    ["invoice"],
    [{ ...item, invoiceId: " " }],
    [{ ...item, expectedRevision: "1" }],
    [item, item],
    Array.from({ length: 101 }, (_, index) => ({ ...item, invoiceId: `invoice-${index}` })),
  ];
  for (const items of invalidLists) {
    const response = await bookReadyRoute(request({ items, requestKey: "batch-key" }));
    assert.equal(response.status, 422, JSON.stringify(items));
    assert.deepEqual(getInvoice(invoice.id), before);
  }
});

test("bulk booking requires a bounded batch request key", async () => {
  for (const requestKey of [undefined, null, "", "   ", 42, "x".repeat(201)]) {
    const response = await bookReadyRoute(request({
      items: [{ invoiceId: "missing-invoice", expectedRevision: 1 }],
      requestKey,
    }));
    assert.equal(response.status, 422, String(requestKey));
  }
});

test("bulk booking excludes both terminal learning states before stale revision checks", async () => {
  const purposeOnly = createInvoice();
  purposeOnly.processingPurpose = "learning_only";
  purposeOnly.status = "Ready to Book";
  const statusOnly = createInvoice();
  statusOnly.status = "Learned";
  // Normalize legacy terminal fields before comparing material command mutations.
  const snapshots = [purposeOnly, statusOnly].map((invoice) => structuredClone(getInvoice(invoice.id)));
  const response = await bookReadyRoute(request({
    requestKey: null,
    items: [purposeOnly, statusOnly].map((invoice) => ({ invoiceId: invoice.id, expectedRevision: 999 })),
  }, "header-batch"));
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(payload.results.map((result: { status: string }) => result.status), ["excluded", "excluded"]);
  assert.deepEqual([getInvoice(purposeOnly.id), getInvoice(statusOnly.id)], snapshots);
});
