import {
  addBookingAttempt,
  getExactMasterData,
  getInvoice,
  isCachedExactMasterDataStale,
  markInvoiceBooked,
  markInvoiceBookingFailed,
  recomputeInvoiceState,
  refreshExactConnectionForUser,
  requirePermission,
  syncExactDataNow,
} from "../../../../../lib/repository/invoice-store";
import { bookInvoiceInExact } from "../../../../../lib/services/exact-online-service";
import { logger } from "../../../../../lib/utils/logger";

type RouteContext = {
  params: { invoiceId: string } | Promise<{ invoiceId: string }>;
};

async function invoiceIdFromContext(context: RouteContext) {
  const params = await context.params;
  return params.invoiceId;
}

export async function POST(_request: Request, context: RouteContext) {
  const invoiceId = await invoiceIdFromContext(context);
  const invoice = getInvoice(invoiceId);

  if (!invoice) {
    return Response.json({ error: "Invoice not found." }, { status: 404 });
  }

  try {
    requirePermission("book");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Not allowed.";
    return Response.json({ error: message, invoice }, { status: 403 });
  }

  try {
    const connection = await refreshExactConnectionForUser();
    let masterData = getExactMasterData();
    if (isCachedExactMasterDataStale()) {
      masterData = await syncExactDataNow();
    }

    const invoiceToBook = recomputeInvoiceState(invoice.id) ?? invoice;
    const result = await bookInvoiceInExact(connection, invoiceToBook, masterData);

    addBookingAttempt(invoice.id, {
      status: "success",
      exactBookingId: result.exactBookingId,
      requestPayload: {
        extractedData: invoice.extractedData,
        purchaseJournal: invoice.purchaseJournal,
      },
      responsePayload: result,
    });
    const updatedInvoice = markInvoiceBooked(invoice.id, result.exactBookingId);

    logger.info("invoice.booked", {
      invoiceId,
      exactBookingId: result.exactBookingId,
    });

    return Response.json({ invoice: updatedInvoice });
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
    const updatedInvoice = markInvoiceBookingFailed(invoice.id, message);

    logger.error("invoice.booking_failed", { invoiceId, message });
    return Response.json(
      { error: message, invoice: updatedInvoice },
      { status: 409 }
    );
  }
}
