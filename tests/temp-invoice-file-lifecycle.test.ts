import test from "node:test";
import assert from "node:assert/strict";
import { rm, stat } from "node:fs/promises";
import {
  createUploadedInvoice,
  deleteInvoiceFileAfterBooking,
  getInvoice,
  listAuditEvents,
  markInvoiceBooked,
  markInvoiceBookingFailed,
} from "../lib/repository/invoice-store";
import {
  getStoredInvoiceFile,
  storeMockInvoiceFile,
} from "../lib/services/storage-service";

async function withTempStorage(run: () => Promise<void>) {
  const previousLocalPath = process.env.LOCAL_INVOICE_STORAGE_PATH;
  const previousPath = process.env.TEMP_INVOICE_STORAGE_PATH;
  const storagePath = `storage/tmp-tests/lifecycle-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
  delete process.env.LOCAL_INVOICE_STORAGE_PATH;
  process.env.TEMP_INVOICE_STORAGE_PATH = storagePath;

  try {
    await run();
  } finally {
    if (previousLocalPath === undefined) {
      delete process.env.LOCAL_INVOICE_STORAGE_PATH;
    } else {
      process.env.LOCAL_INVOICE_STORAGE_PATH = previousLocalPath;
    }
    if (previousPath === undefined) {
      delete process.env.TEMP_INVOICE_STORAGE_PATH;
    } else {
      process.env.TEMP_INVOICE_STORAGE_PATH = previousPath;
    }
    await rm(storagePath, { recursive: true, force: true });
  }
}

test("deletes the temporary invoice file only after a successful Exact booking", async () => {
  await withTempStorage(async () => {
    const stored = storeMockInvoiceFile({
      fileName: "booked-temp.pdf",
      fileType: "application/pdf",
      content: "temporary invoice content",
    });
    const invoice = createUploadedInvoice({
      source: "manual_upload",
      fileName: "booked-temp.pdf",
      fileType: stored.fileType,
      fileSize: stored.fileSize,
      checksum: stored.checksum,
      storageKey: stored.storageKey,
    });

    markInvoiceBookingFailed(invoice.id, "Exact timeout");
    assert.notEqual(await getStoredInvoiceFile(stored.storageKey), null);
    assert.equal(getInvoice(invoice.id)?.localFileStatus, "available");

    markInvoiceBooked(invoice.id, "EXACT-TEMP-BOOKED");
    const updatedInvoice = await deleteInvoiceFileAfterBooking(invoice.id);

    await assert.rejects(stat(stored.storageKey));
    assert.equal(updatedInvoice?.localFileStatus, "deleted_after_booking");
    assert.equal(updatedInvoice?.exactBookingId, "EXACT-TEMP-BOOKED");
    assert.equal(
      listAuditEvents(invoice.id).some((event) => event.type === "invoice_file_deleted"),
      true
    );
  });
});
