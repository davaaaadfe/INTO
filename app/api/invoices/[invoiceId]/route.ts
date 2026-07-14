import type {
  ExtractedInvoiceData,
  PurchaseJournalLine,
} from "../../../../lib/domain/invoice";
import {
  getInvoice,
  listInvoices,
  requirePermission,
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

export async function GET(_request: Request, context: RouteContext) {
  return withPersistentStore(async () => {
    try {
      requirePermission("view");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Not allowed.";
      return Response.json({ error: message }, { status: 403 });
    }

    const invoice = getInvoice(await invoiceIdFromContext(context));

    if (!invoice) {
      return Response.json({ error: "Invoice not found." }, { status: 404 });
    }

    return Response.json({ invoice });
  });
}

export async function PATCH(request: Request, context: RouteContext) {
  return withPersistentStore(async () => {
    try {
      requirePermission("edit");
      const invoiceId = await invoiceIdFromContext(context);
      const invoice = getInvoice(invoiceId);

      if (!invoice) {
        return Response.json({ error: "Invoice not found." }, { status: 404 });
      }

      const payload = (await request.json()) as
        | Partial<ExtractedInvoiceData>
        | {
            extractedData?: Partial<ExtractedInvoiceData>;
            bookingLines?: PurchaseJournalLine[];
          };
      const wrappedPayload =
        "extractedData" in payload || "bookingLines" in payload;
      const extractedPatch = wrappedPayload
        ? payload.extractedData ?? {}
        : payload;
      const bookingLines = wrappedPayload && Array.isArray(payload.bookingLines)
        ? payload.bookingLines
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
        bookingLines
      );

      logger.info("invoice.review_saved", {
        invoiceId,
        status: updatedInvoice?.status,
        errorCount: updatedInvoice?.validationErrors.length ?? 0,
      });

      return Response.json({ invoice: updatedInvoice, invoices: listInvoices() });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected review error";
      logger.error("invoice.review_save_failed", { message });
      return Response.json(
        { error: message },
        { status: message.includes("not allowed") ? 403 : 500 }
      );
    }
  });
}
