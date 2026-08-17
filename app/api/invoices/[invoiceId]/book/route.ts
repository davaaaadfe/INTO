import {
  addBookingAttempt,
  assertExpectedInvoiceRevision,
  deleteInvoiceFileAfterBooking,
  getExactMasterData,
  getInvoice,
  isCachedExactMasterDataStale,
  markInvoiceBooked,
  markInvoiceBookingFailed,
  InvoiceRevisionConflictError,
  InvoiceRevisionValidationError,
  recomputeInvoiceState,
  refreshExactConnectionForUser,
  requirePermission,
  syncExactDataNow,
} from "../../../../../lib/repository/invoice-store";
import { withPersistentStore } from "../../../../../lib/repository/persistent-request";
import { bookInvoiceInExact } from "../../../../../lib/services/exact-online-service";
import { assertInvoiceBookingAllowed } from "../../../../../lib/domain/invoice";
import { logger } from "../../../../../lib/utils/logger";

type RouteContext = {
  params: { invoiceId: string } | Promise<{ invoiceId: string }>;
};

async function invoiceIdFromContext(context: RouteContext) {
  const params = await context.params;
  return params.invoiceId;
}

export async function POST(request: Request, context: RouteContext) {
  return withPersistentStore(async (principal) => {
    const invoiceId = await invoiceIdFromContext(context);
    const invoice = getInvoice(invoiceId);

    if (!invoice) {
      return Response.json({ error: "Invoice not found." }, { status: 404 });
    }

    try {
      requirePermission("book", principal);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Not allowed.";
      return Response.json({ error: message, invoice }, { status: 403 });
    }

    let expectedRevision: unknown;
    let payload: { expectedRevision?: unknown };
    try {
      payload = (await request.json()) as { expectedRevision?: unknown };
    } catch {
      return Response.json(
        { error: "Request body must be valid JSON.", code: "invalid_request" },
        { status: 422 }
      );
    }
    try {
      expectedRevision = payload.expectedRevision;
      assertExpectedInvoiceRevision(invoice, expectedRevision);
      assertInvoiceBookingAllowed(invoice);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Booking not allowed.";
      if (error instanceof InvoiceRevisionValidationError) {
        return Response.json({ error: message, code: error.code }, { status: 422 });
      }
      if (error instanceof InvoiceRevisionConflictError) {
        return Response.json(
          { error: message, code: error.code, currentInvoice: error.currentInvoice },
          { status: 409 }
        );
      }
      return Response.json({ error: message, invoice }, { status: 409 });
    }

    try {
      const connection = await refreshExactConnectionForUser();
      let masterData = getExactMasterData();
      if (isCachedExactMasterDataStale()) {
        masterData = await syncExactDataNow();
      }

      const invoiceToBook =
        recomputeInvoiceState(invoice.id, { incrementRevision: false }) ?? invoice;
      const result = await bookInvoiceInExact(connection, invoiceToBook, masterData);
      assertExpectedInvoiceRevision(getInvoice(invoice.id) ?? invoice, expectedRevision);

      addBookingAttempt(invoice.id, {
        status: "success",
        exactBookingId: result.exactBookingId,
        requestPayload: {
          extractedData: invoice.extractedData,
          purchaseJournal: invoice.purchaseJournal,
        },
        responsePayload: result,
      });
      markInvoiceBooked(invoice.id, result.exactBookingId, expectedRevision);
      const updatedInvoice = await deleteInvoiceFileAfterBooking(invoice.id);

      logger.info("invoice.booked", {
        invoiceId,
        exactBookingId: result.exactBookingId,
      });

      return Response.json({ invoice: updatedInvoice });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Booking failed.";
      if (error instanceof InvoiceRevisionValidationError) {
        return Response.json({ error: message, code: error.code }, { status: 422 });
      }
      if (error instanceof InvoiceRevisionConflictError) {
        return Response.json(
          { error: message, code: error.code, currentInvoice: error.currentInvoice },
          { status: 409 }
        );
      }
      addBookingAttempt(invoice.id, {
        status: "failed",
        errorMessage: message,
        requestPayload: {
          extractedData: invoice.extractedData,
          purchaseJournal: invoice.purchaseJournal,
        },
      });
      const updatedInvoice = markInvoiceBookingFailed(
        invoice.id,
        message,
        expectedRevision
      );

      logger.error("invoice.booking_failed", { invoiceId, message });
      return Response.json(
        { error: message, invoice: updatedInvoice },
        { status: 409 }
      );
    }
  }, request);
}
