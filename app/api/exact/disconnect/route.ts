import {
  disconnectExactConnection,
  listInvoices,
  publicExactConnection,
} from "../../../../lib/repository/invoice-store";
import { withPersistentStore } from "../../../../lib/repository/persistent-request";
import { logger } from "../../../../lib/utils/logger";

export async function POST(request: Request) {
  return withPersistentStore(() => {
    try {
      const disconnected = disconnectExactConnection();

      logger.info("exact.disconnected", {
        connectionId: disconnected?.id,
      });

      return Response.json({
        connection: publicExactConnection(),
        masterData: null,
        masterDataStale: true,
        masterDataReadOnly: true,
        invoices: listInvoices(),
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Exact disconnect failed.";
      return Response.json(
        { error: message },
        { status: message.includes("not allowed") ? 403 : 409 }
      );
    }
  }, request);
}
