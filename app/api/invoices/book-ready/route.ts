import { getInvoice, isExpectedInvoiceRevision, listInvoices, InvoiceRevisionConflictError } from "../../../../lib/repository/invoice-store";
import { BookingCommandError, executeInvoiceBooking, isBookingRequestKey } from "../../../../lib/repository/invoice-booking";
import { withPersistentStore } from "../../../../lib/repository/persistent-request";

export async function POST(request: Request) {
  return withPersistentStore(async () => {
    let payload;
    try { payload = await request.json(); } catch {
      return Response.json({ error: "Request body must be valid JSON." }, { status: 422 });
    }
    const invalid = () => Response.json({ error: "Provide a request key and 1–100 unique invoice items with positive integer expectedRevision." }, { status: 422 });
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return invalid();
    const requestKey = request.headers.get("Idempotency-Key") ?? payload.requestKey;
    const items: unknown = payload.items;
    if (!isBookingRequestKey(requestKey) || !Array.isArray(items) || !items.length || items.length > 100) return invalid();
    const ids = new Set<string>();
    const validItems: Array<{ invoiceId: string; expectedRevision: number }> = [];
    for (const item of items) {
      if (!item || typeof item !== "object" || typeof item.invoiceId !== "string" || !item.invoiceId.trim() ||
        !isExpectedInvoiceRevision(item.expectedRevision) || ids.has(item.invoiceId)) return invalid();
      ids.add(item.invoiceId);
      validItems.push(item);
    }
    const results: Array<Record<string, unknown>> = [];
    for (const item of validItems) {
      const invoice = getInvoice(item.invoiceId);
      if (invoice?.processingPurpose === "learning_only" || invoice?.status === "Learned") {
        results.push({ invoiceId: item.invoiceId, status: "excluded", invoice });
        continue;
      }
      try {
        const result = await executeInvoiceBooking({ ...item, requestKey });
        results.push({ invoiceId: item.invoiceId, status: "booked", ...result });
      } catch (error) {
        if (error instanceof InvoiceRevisionConflictError || error instanceof BookingCommandError) {
          results.push({ invoiceId: item.invoiceId, status: error instanceof InvoiceRevisionConflictError ? "stale" : "failed",
            code: error.code, error: error.message, currentInvoice: error.currentInvoice });
        } else throw error;
      }
    }
    return Response.json({ invoices: listInvoices(), results });
  }, request);
}
