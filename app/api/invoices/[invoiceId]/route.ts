import type { ExtractedInvoiceData } from "../../../../lib/domain/invoice";
import {
  auditInvoiceFieldChanges,
  getInvoice,
  listInvoices,
  recomputeInvoiceState,
  requirePermission,
  updateInvoiceExtraction,
} from "../../../../lib/repository/invoice-store";
import { logger } from "../../../../lib/utils/logger";

type RouteContext = {
  params: { invoiceId: string } | Promise<{ invoiceId: string }>;
};

async function invoiceIdFromContext(context: RouteContext) {
  const params = await context.params;
  return params.invoiceId;
}

export async function GET(_request: Request, context: RouteContext) {
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
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    requirePermission("edit");
    const invoiceId = await invoiceIdFromContext(context);
    const invoice = getInvoice(invoiceId);

    if (!invoice) {
      return Response.json({ error: "Invoice not found." }, { status: 404 });
    }

    const payload = (await request.json()) as Partial<ExtractedInvoiceData>;
    const nextData: ExtractedInvoiceData = {
      ...invoice.extractedData,
      ...payload,
      currency: (payload.currency ?? invoice.extractedData.currency).toUpperCase(),
    };

    auditInvoiceFieldChanges(invoiceId, invoice.extractedData, nextData);
    updateInvoiceExtraction(invoiceId, nextData);
    const updatedInvoice = recomputeInvoiceState(invoiceId);

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
}
