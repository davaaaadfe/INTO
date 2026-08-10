import {
  getInvoice,
  listAuditEvents,
  requirePermission,
} from "../../../../../lib/repository/invoice-store";
import { withPersistentStore } from "../../../../../lib/repository/persistent-request";

type RouteContext = {
  params: { invoiceId: string } | Promise<{ invoiceId: string }>;
};

async function invoiceIdFromContext(context: RouteContext) {
  const params = await context.params;
  return params.invoiceId;
}

export async function GET(request: Request, context: RouteContext) {
  return withPersistentStore(async () => {
    try {
      requirePermission("view");
      const invoiceId = await invoiceIdFromContext(context);
      const invoice = getInvoice(invoiceId);

      if (!invoice) {
        return Response.json({ error: "Invoice not found." }, { status: 404 });
      }

      return Response.json({
        events: listAuditEvents(invoiceId),
        bookingAttempts: invoice.bookingAttempts,
        extractionHistory: invoice.extractionHistory,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Audit trail failed.";
      return Response.json({ error: message }, { status: 403 });
    }
  }, request);
}
