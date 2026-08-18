import {
  cleanupTemporaryInvoiceFiles,
  listInvoices,
} from "../../../../lib/repository/invoice-store";
import { withPersistentStore } from "../../../../lib/repository/persistent-request";

export async function POST(request: Request) {
  return withPersistentStore(async () => {
    const cleanup = await cleanupTemporaryInvoiceFiles();
    return Response.json({ cleanup, invoices: listInvoices() });
  }, request);
}
