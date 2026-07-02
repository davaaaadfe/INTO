import {
  getInvoice,
  listInvoices,
  markInvoiceNeedsReview,
  requirePermission,
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
    requirePermission("review");
    const invoiceId = await invoiceIdFromContext(context);
    const invoice = getInvoice(invoiceId);

    if (!invoice) {
      return Response.json({ error: "Invoice not found." }, { status: 404 });
    }

    if (invoice.status === "Booked") {
      return Response.json(
        { error: "Booked invoices cannot be marked as needing review." },
        { status: 409 }
      );
    }

    const payload = (await request.json()) as {
      action?: "needs_review";
      reason?: string;
    };

    if (payload.action !== "needs_review") {
      return Response.json({ error: "Unsupported review action." }, { status: 400 });
    }

    const updatedInvoice = markInvoiceNeedsReview(
      invoiceId,
      payload.reason || "Marked as needs review by user."
    );

    logger.info("invoice.review_action_saved", {
      invoiceId,
      action: payload.action,
      status: updatedInvoice?.status,
    });

    return Response.json({ invoice: updatedInvoice, invoices: listInvoices() });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected review action error";
    logger.error("invoice.review_action_failed", { message });
    return Response.json(
      { error: message },
      { status: message.includes("not allowed") ? 403 : 500 }
    );
  }
}
