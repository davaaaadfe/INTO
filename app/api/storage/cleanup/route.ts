import {
  cleanupTemporaryInvoiceFiles,
  listInvoices,
  requireSystemOwner,
} from "../../../../lib/repository/invoice-store";
import { withPersistentStore } from "../../../../lib/repository/persistent-request";

export async function POST(request: Request) {
  return withPersistentStore(async (principal) => {
    try {
      requireSystemOwner(principal);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Not allowed.";
      return Response.json({ error: message }, { status: 403 });
    }

    const cleanup = await cleanupTemporaryInvoiceFiles();
    return Response.json({ cleanup, invoices: listInvoices() });
  }, request);
}
