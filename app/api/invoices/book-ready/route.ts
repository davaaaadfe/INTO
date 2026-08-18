import {
  addBookingAttempt,
  assertExpectedInvoiceRevision,
  deleteInvoiceFileAfterBooking,
  getExactMasterData,
  getInvoice,
  isCachedExactMasterDataStale,
  isExpectedInvoiceRevision,
  listInvoices,
  markInvoiceBooked,
  markInvoiceBookingFailed,
  refreshExactConnectionForUser,
  syncExactDataNow,
  InvoiceRevisionConflictError,
} from "../../../../lib/repository/invoice-store";
import { withPersistentStore } from "../../../../lib/repository/persistent-request";
import { bookInvoiceInExact } from "../../../../lib/services/exact-online-service";
import { assertInvoiceBookingAllowed } from "../../../../lib/domain/invoice";
import { logger } from "../../../../lib/utils/logger";

type BulkBookingItem = { invoiceId?: unknown; expectedRevision?: unknown };

export async function POST(request: Request) {
  return withPersistentStore(async () => {
    const results: Array<Record<string, unknown>> = [];

    let payload: { items?: BulkBookingItem[] };
    try {
      payload = (await request.json()) as { items?: BulkBookingItem[] };
    } catch {
      return Response.json(
        { error: "items must contain invoiceId and expectedRevision." },
        { status: 422 }
      );
    }
    if (!Array.isArray(payload.items)) {
      return Response.json(
        { error: "items must contain invoiceId and expectedRevision." },
        { status: 422 }
      );
    }
    if (
      payload.items.some(
        (item) =>
          typeof item.invoiceId !== "string" ||
          !isExpectedInvoiceRevision(item.expectedRevision)
      )
    ) {
      return Response.json(
        { error: "Each bulk booking item requires a positive integer expectedRevision." },
        { status: 422 }
      );
    }

    const candidates: Array<{ invoiceId: string; expectedRevision: number }> = [];
    for (const item of payload.items) {
      const invoiceId = item.invoiceId as string;
      const expectedRevision = item.expectedRevision as number;
      const invoice = getInvoice(invoiceId);
      if (!invoice) {
        results.push({ invoiceId, status: "failed", error: "Invoice not found." });
        continue;
      }
      if (invoice.processingPurpose === "learning_only") {
        results.push({ invoiceId, status: "excluded", invoice });
        continue;
      }
      try {
        assertExpectedInvoiceRevision(invoice, expectedRevision);
        assertInvoiceBookingAllowed(invoice);
        candidates.push({ invoiceId, expectedRevision });
      } catch (error) {
        if (error instanceof InvoiceRevisionConflictError) {
          results.push({
            invoiceId,
            status: "stale",
            code: error.code,
            currentInvoice: error.currentInvoice,
          });
        } else {
          results.push({
            invoiceId,
            status: "failed",
            error: error instanceof Error ? error.message : "Booking not allowed.",
          });
        }
      }
    }

    if (!candidates.length) {
      return Response.json({ invoices: listInvoices(), results });
    }

    let connection;
    let masterData = getExactMasterData();
    try {
      connection = await refreshExactConnectionForUser();
      if (isCachedExactMasterDataStale()) {
        masterData = await syncExactDataNow();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Exact master-data sync failed.";
      for (const candidate of candidates) {
        results.push({ invoiceId: candidate.invoiceId, status: "failed", error: message });
      }
      return Response.json({ invoices: listInvoices(), results });
    }

    for (const candidate of candidates) {
      const invoice = getInvoice(candidate.invoiceId);
      if (!invoice) {
        results.push({ invoiceId: candidate.invoiceId, status: "failed", error: "Invoice not found." });
        continue;
      }
      try {
        assertExpectedInvoiceRevision(invoice, candidate.expectedRevision);
        const result = await bookInvoiceInExact(connection, invoice, masterData);
        assertExpectedInvoiceRevision(
          getInvoice(candidate.invoiceId) ?? invoice,
          candidate.expectedRevision
        );
        addBookingAttempt(invoice.id, {
          status: "success",
          exactBookingId: result.exactBookingId,
          requestPayload: {
            extractedData: invoice.extractedData,
            purchaseJournal: invoice.purchaseJournal,
          },
          responsePayload: result,
        });
        markInvoiceBooked(invoice.id, result.exactBookingId, candidate.expectedRevision);
        const booked = await deleteInvoiceFileAfterBooking(invoice.id);
        results.push({ invoiceId: invoice.id, status: "booked", invoice: booked });
      } catch (error) {
        if (error instanceof InvoiceRevisionConflictError) {
          results.push({
            invoiceId: candidate.invoiceId,
            status: "stale",
            code: error.code,
            currentInvoice: error.currentInvoice,
          });
          continue;
        }
        const message = error instanceof Error ? error.message : "Booking failed.";
        addBookingAttempt(candidate.invoiceId, {
          status: "failed",
          errorMessage: message,
          requestPayload: {
            extractedData: invoice.extractedData,
            purchaseJournal: invoice.purchaseJournal,
          },
        });
        const failed = markInvoiceBookingFailed(
          candidate.invoiceId,
          message,
          candidate.expectedRevision
        );
        results.push({ invoiceId: candidate.invoiceId, status: "failed", invoice: failed });
        logger.error("invoice.bulk_booking_failed", { invoiceId: candidate.invoiceId, message });
      }
    }

    return Response.json({ invoices: listInvoices(), results });
  }, request);
}
