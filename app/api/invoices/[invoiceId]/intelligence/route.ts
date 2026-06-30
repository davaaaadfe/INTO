import {
  approveInvoiceIntelligence,
  getInvoice,
  listInvoices,
  requirePermission,
  selectInvoiceSupplier,
} from "../../../../../lib/repository/invoice-store";
import { logger } from "../../../../../lib/utils/logger";

type RouteContext = {
  params: { invoiceId: string } | Promise<{ invoiceId: string }>;
};

async function invoiceIdFromContext(context: RouteContext) {
  const params = await context.params;
  return params.invoiceId;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    requirePermission("approve");
    const invoiceId = await invoiceIdFromContext(context);
    const invoice = getInvoice(invoiceId);

    if (!invoice) {
      return Response.json({ error: "Invoice not found." }, { status: 404 });
    }

    const payload = (await request.json()) as {
      action?: "approve" | "selectSupplier";
      accountId?: string;
    };

    const updatedInvoice =
      payload.action === "selectSupplier"
        ? selectInvoiceSupplier(invoiceId, payload.accountId ?? "")
        : approveInvoiceIntelligence(invoiceId);

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
    logger.error("invoice.intelligence_action_failed", { message });
    return Response.json(
      { error: message },
      { status: message.includes("not allowed") ? 403 : 500 }
    );
  }
}
