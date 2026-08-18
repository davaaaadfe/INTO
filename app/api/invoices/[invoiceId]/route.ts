import type {
  ExtractedInvoiceData,
  PurchaseJournalLine,
} from "../../../../lib/domain/invoice";
import {
  assertExpectedInvoiceRevision,
  getInvoice,
  InvoiceRevisionConflictError,
  InvoiceRevisionValidationError,
  listInvoices,
  saveInvoiceReview,
} from "../../../../lib/repository/invoice-store";
import { withPersistentStore } from "../../../../lib/repository/persistent-request";
import { logger } from "../../../../lib/utils/logger";

type RouteContext = {
  params: { invoiceId: string } | Promise<{ invoiceId: string }>;
};

async function invoiceIdFromContext(context: RouteContext) {
  const params = await context.params;
  return params.invoiceId;
}

export async function GET(request: Request, context: RouteContext) {
  return withPersistentStore(async () => {
    const invoice = getInvoice(await invoiceIdFromContext(context));

    if (!invoice) {
      return Response.json({ error: "Invoice not found." }, { status: 404 });
    }

    return Response.json({ invoice });
  }, request);
}

export async function PATCH(request: Request, context: RouteContext) {
  return withPersistentStore(async () => {
    try {
      const invoiceId = await invoiceIdFromContext(context);
      const invoice = getInvoice(invoiceId);

      if (!invoice) {
        return Response.json({ error: "Invoice not found." }, { status: 404 });
      }

      const payload = (await request.json()) as
        | Partial<ExtractedInvoiceData>
        | {
            expectedRevision?: unknown;
            extractedData?: Partial<ExtractedInvoiceData>;
            bookingLines?: PurchaseJournalLine[];
          };
      const wrappedPayload =
        "extractedData" in payload || "bookingLines" in payload;
      const envelope = payload as {
        expectedRevision?: unknown;
        extractedData?: Partial<ExtractedInvoiceData>;
        bookingLines?: PurchaseJournalLine[];
      };
      assertExpectedInvoiceRevision(invoice, envelope.expectedRevision);
      const extractedPatch: Partial<ExtractedInvoiceData> = wrappedPayload
        ? envelope.extractedData ?? {}
        : (payload as Partial<ExtractedInvoiceData>);
      const bookingLines = wrappedPayload && Array.isArray(envelope.bookingLines)
        ? envelope.bookingLines
        : undefined;
      const nextData: ExtractedInvoiceData = {
        ...invoice.extractedData,
        ...extractedPatch,
        currency: (
          extractedPatch.currency ?? invoice.extractedData.currency
        ).toUpperCase(),
      };

      const updatedInvoice = saveInvoiceReview(
        invoiceId,
        nextData,
        bookingLines,
        { expectedRevision: envelope.expectedRevision }
      );

      logger.info("invoice.review_saved", {
        invoiceId,
        status: updatedInvoice?.status,
        errorCount: updatedInvoice?.validationErrors.length ?? 0,
      });

      return Response.json({ invoice: updatedInvoice, invoices: listInvoices() });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected review error";
      if (error instanceof InvoiceRevisionValidationError) {
        return Response.json({ error: message, code: error.code }, { status: 422 });
      }
      if (error instanceof InvoiceRevisionConflictError) {
        return Response.json(
          {
            error: message,
            code: error.code,
            currentInvoice: error.currentInvoice,
          },
          { status: 409 }
        );
      }
      logger.error("invoice.review_save_failed", { message });
      return Response.json(
        { error: message },
        { status: message.includes("not allowed") ? 403 : 500 }
      );
    }
  }, request);
}
