import {
  approveInvoiceIntelligence,
  assertExpectedInvoiceRevision,
  getInvoice,
  InvoiceRevisionConflictError,
  InvoiceRevisionValidationError,
  listInvoices,
  saveInvoiceReview,
  selectInvoiceSupplier,
} from "../../../../../lib/repository/invoice-store";
import type {
  ExtractedInvoiceData,
  PurchaseJournalLine,
} from "../../../../../lib/domain/invoice";
import { withPersistentStore } from "../../../../../lib/repository/persistent-request";
import { logger } from "../../../../../lib/utils/logger";

type RouteContext = {
  params: { invoiceId: string } | Promise<{ invoiceId: string }>;
};

async function invoiceIdFromContext(context: RouteContext) {
  const params = await context.params;
  return params.invoiceId;
}

export async function POST(request: Request, context: RouteContext) {
  return withPersistentStore(async () => {
    try {
      const invoiceId = await invoiceIdFromContext(context);
      const invoice = getInvoice(invoiceId);

      if (!invoice) {
        return Response.json({ error: "Invoice not found." }, { status: 404 });
      }

      const payload = (await request.json()) as {
        action?: "approve" | "selectSupplier";
        accountId?: string;
        expectedRevision?: unknown;
        extractedData?: ExtractedInvoiceData;
        bookingLines?: PurchaseJournalLine[];
      };

      assertExpectedInvoiceRevision(invoice, payload.expectedRevision);
      if (payload.action === "selectSupplier" && payload.extractedData) {
        saveInvoiceReview(
          invoiceId,
          payload.extractedData,
          payload.bookingLines ?? [],
          { incrementRevision: false }
        );
      }

      const updatedInvoice =
        payload.action === "selectSupplier"
          ? selectInvoiceSupplier(invoiceId, payload.accountId ?? "", invoice.revision)
          : approveInvoiceIntelligence(invoiceId, invoice.revision);

      if (!updatedInvoice) {
        return Response.json(
          { error: "Unable to apply purchase journal decision." },
          { status: 400 }
        );
      }

      logger.info("invoice.intelligence_decision_saved", {
        invoiceId,
        action: payload.action ?? "approve",
        status: updatedInvoice.status,
      });

      return Response.json({ invoice: updatedInvoice, invoices: listInvoices() });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unexpected intelligence action error";
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
      if (error instanceof InvoiceRevisionValidationError) {
        return Response.json({ error: message, code: error.code }, { status: 422 });
      }
      logger.error("invoice.intelligence_action_failed", { message });
      return Response.json(
        { error: message },
        { status: message.includes("not allowed") ? 403 : 500 }
      );
    }
  }, request);
}
