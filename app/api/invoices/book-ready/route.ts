import {
  addBookingAttempt,
  deleteInvoiceFileAfterBooking,
  getExactMasterData,
  isCachedExactMasterDataStale,
  listInvoices,
  markInvoiceBooked,
  markInvoiceBookingFailed,
  refreshExactConnectionForUser,
  requirePermission,
  syncExactDataNow,
} from "../../../../lib/repository/invoice-store";
import { withPersistentStore } from "../../../../lib/repository/persistent-request";
import { bookInvoiceInExact } from "../../../../lib/services/exact-online-service";
import { assertInvoiceBookingAllowed } from "../../../../lib/domain/invoice";
import { logger } from "../../../../lib/utils/logger";

export async function POST() {
  return withPersistentStore(async () => {
    const results: unknown[] = [];
    let connection;
    let masterData = getExactMasterData();

    try {
      requirePermission("book");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Not allowed.";
      return Response.json({ error: message, invoices: listInvoices(), results }, { status: 403 });
    }

    const readyInvoices = listInvoices().filter(
      (invoice) =>
        invoice.status === "Ready to Book" &&
        invoice.processingPurpose !== "learning_only"
    );
    if (!readyInvoices.length) {
      return Response.json({ invoices: listInvoices(), results });
    }
    try {
      for (const invoice of readyInvoices) {
        assertInvoiceBookingAllowed(invoice);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Booking not allowed.";
      return Response.json(
        { error: message, invoices: listInvoices(), results },
        { status: 409 }
      );
    }

    try {
      connection = await refreshExactConnectionForUser();
      if (isCachedExactMasterDataStale()) {
        masterData = await syncExactDataNow();
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Exact master-data sync failed.";
      return Response.json({ error: message, invoices: listInvoices(), results }, { status: 409 });
    }

    for (const invoice of readyInvoices) {
      try {
        const result = await bookInvoiceInExact(connection, invoice, masterData);
        addBookingAttempt(invoice.id, {
          status: "success",
          exactBookingId: result.exactBookingId,
          requestPayload: {
            extractedData: invoice.extractedData,
            purchaseJournal: invoice.purchaseJournal,
          },
          responsePayload: result,
        });
        markInvoiceBooked(invoice.id, result.exactBookingId);
        results.push(await deleteInvoiceFileAfterBooking(invoice.id));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Booking failed.";
        addBookingAttempt(invoice.id, {
          status: "failed",
          errorMessage: message,
          requestPayload: {
            extractedData: invoice.extractedData,
            purchaseJournal: invoice.purchaseJournal,
          },
        });
        results.push(markInvoiceBookingFailed(invoice.id, message));
        logger.error("invoice.bulk_booking_failed", { invoiceId: invoice.id, message });
      }
    }

    return Response.json({ invoices: listInvoices(), results });
  });
}
