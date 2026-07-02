import {
  disconnectOutlookConnection,
  publicOutlookConnection,
  requirePermission,
} from "../../../../lib/repository/invoice-store";
import { logger } from "../../../../lib/utils/logger";

export async function POST() {
  try {
    requirePermission("connect_outlook");
    const disconnected = disconnectOutlookConnection();

    logger.info("outlook.disconnected", {
      connectionId: disconnected?.id,
    });

    return Response.json({
      connection: publicOutlookConnection(),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Outlook disconnect failed.";
    return Response.json(
      { error: message },
      { status: message.includes("not allowed") ? 403 : 409 }
    );
  }
}
