import { InvoiceRevisionConflictError, InvoiceRevisionValidationError } from "../../../../../lib/repository/invoice-store";
import { BookingCommandError, executeInvoiceBooking } from "../../../../../lib/repository/invoice-booking";
import { withPersistentStore } from "../../../../../lib/repository/persistent-request";

type RouteContext = { params: { invoiceId: string } | Promise<{ invoiceId: string }> };

export async function POST(request: Request, context: RouteContext) {
  return withPersistentStore(async () => {
    let payload;
    try { payload = await request.json(); } catch {
      return Response.json({ error: "Request body must be valid JSON." }, { status: 422 });
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return Response.json({ error: "Request body must be a JSON object." }, { status: 422 });
    }
    try {
      const result = await executeInvoiceBooking({
        invoiceId: (await context.params).invoiceId,
        expectedRevision: payload.expectedRevision,
        requestKey: request.headers.get("Idempotency-Key") ?? payload.requestKey,
      });
      return Response.json(result);
    } catch (error) {
      if (error instanceof BookingCommandError || error instanceof InvoiceRevisionConflictError) {
        return Response.json({ error: error.message, code: error.code, currentInvoice: error.currentInvoice },
          { status: error instanceof BookingCommandError ? error.status : 409 });
      }
      if (error instanceof InvoiceRevisionValidationError) {
        return Response.json({ error: error.message, code: error.code }, { status: 422 });
      }
      throw error;
    }
  }, request);
}
