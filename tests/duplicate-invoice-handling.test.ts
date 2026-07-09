import test from "node:test";
import assert from "node:assert/strict";
import { emptyExtractedInvoiceData } from "../lib/domain/invoice";
import {
  createUploadedInvoice,
  detectContentDuplicate,
  findDuplicateBeforeProcessing,
  getInvoice,
  markInvoiceBooked,
  updateInvoiceExtraction,
} from "../lib/repository/invoice-store";

function invoiceData(overrides: Partial<ReturnType<typeof emptyExtractedInvoiceData>>) {
  return {
    ...emptyExtractedInvoiceData(),
    supplierName: "Duplicate Test Supplier",
    invoiceNumber: "DUP-001",
    referenceCode: "",
    invoiceDate: "2026-06-01",
    dueDate: "2026-06-30",
    currency: "EUR",
    netAmount: 100,
    vatAmount: 21,
    grossAmount: 121,
    ...overrides,
  };
}

test("blocks a duplicate file that has already been booked in Exact Online", () => {
  const invoice = createUploadedInvoice({
    source: "manual_upload",
    fileName: "booked-duplicate.pdf",
    fileType: "application/pdf",
    fileSize: 12_345,
    checksum: "checksum-booked-duplicate",
    storageKey: "tests/booked-duplicate.pdf",
  });
  updateInvoiceExtraction(invoice.id, invoiceData({ invoiceNumber: "DUP-BOOKED" }));
  markInvoiceBooked(invoice.id, "EXACT-DUP-BOOKED");

  const duplicate = findDuplicateBeforeProcessing({
    source: "manual_upload",
    fileName: "booked-duplicate.pdf",
    fileSize: 12_345,
    checksum: "checksum-booked-duplicate",
  });

  assert.equal(duplicate?.detection.outcome, "already_booked");
  assert.equal(
    duplicate?.detection.message,
    "This invoice has already been booked in Exact Online."
  );
  assert.equal(
    duplicate?.detection.candidates[0]?.exactBookingId,
    "EXACT-DUP-BOOKED"
  );
});

test("asks for a decision when a duplicate file was processed but not booked", () => {
  const invoice = createUploadedInvoice({
    source: "manual_upload",
    fileName: "processed-duplicate.pdf",
    fileType: "application/pdf",
    fileSize: 22_222,
    checksum: "checksum-processed-duplicate",
    storageKey: "tests/processed-duplicate.pdf",
  });
  updateInvoiceExtraction(
    invoice.id,
    invoiceData({ invoiceNumber: "DUP-PROCESSED" })
  );

  const duplicate = findDuplicateBeforeProcessing({
    source: "manual_upload",
    fileName: "processed-duplicate.pdf",
    fileSize: 22_222,
    checksum: "checksum-processed-duplicate",
  });

  assert.equal(duplicate?.detection.outcome, "processed_unbooked");
  assert.match(
    duplicate?.detection.message ?? "",
    /already processed but has not been booked/
  );
  assert.equal(duplicate?.detection.candidates[0]?.exactBookingId, undefined);
});

test("marks matching invoice contents as a possible duplicate", () => {
  const existing = createUploadedInvoice({
    source: "manual_upload",
    fileName: "content-duplicate-existing.pdf",
    fileType: "application/pdf",
    fileSize: 33_333,
    checksum: "checksum-content-existing",
    storageKey: "tests/content-duplicate-existing.pdf",
  });
  updateInvoiceExtraction(
    existing.id,
    invoiceData({ invoiceNumber: "DUP-CONTENT", grossAmount: 242 })
  );

  const uploaded = createUploadedInvoice({
    source: "manual_upload",
    fileName: "content-duplicate-new.pdf",
    fileType: "application/pdf",
    fileSize: 44_444,
    checksum: "checksum-content-new",
    storageKey: "tests/content-duplicate-new.pdf",
  });
  updateInvoiceExtraction(
    uploaded.id,
    invoiceData({ invoiceNumber: "DUP-CONTENT", grossAmount: 242 })
  );

  const detection = detectContentDuplicate(uploaded.id);
  const updatedInvoice = getInvoice(uploaded.id);

  assert.equal(detection?.outcome, "possible_duplicate");
  assert.equal(updatedInvoice?.status, "Possible Duplicate");
  assert.equal(detection?.candidates[0]?.invoiceId, existing.id);
});
