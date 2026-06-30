import {
  getCompanyConnectionUserId,
  publicOutlookConnection,
  requireSystemOwner,
  setOutlookConnection,
} from "../../../../lib/repository/invoice-store";
import {
  createMockOutlookConnection,
  createOutlookAuthorizationUrl,
  createRealOutlookAuthorizationUrl,
  isRealOutlookMode,
  outlookIntegrationMode,
} from "../../../../lib/services/outlook-service";
import { createId } from "../../../../lib/utils/id";
import { logger } from "../../../../lib/utils/logger";

export async function GET() {
  try {
    requireSystemOwner();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Not allowed.";
    return Response.json({ error: message }, { status: 403 });
  }

  if (isRealOutlookMode()) {
    const authorization = await createRealOutlookAuthorizationUrl(
      getCompanyConnectionUserId()
    );
    return Response.json({
      ...authorization,
      mode: "real",
      requiresRedirect: true,
    });
  }

  const state = createId("outlook_state");
  return Response.json({
    authorizationUrl: createOutlookAuthorizationUrl(state),
    state,
    mode: "mock",
    requiresRedirect: false,
  });
}

export async function POST() {
  try {
    requireSystemOwner();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Not allowed.";
    return Response.json({ error: message }, { status: 403 });
  }

  if (isRealOutlookMode()) {
    const authorization = await createRealOutlookAuthorizationUrl(
      getCompanyConnectionUserId()
    );
    logger.info("outlook.oauth_started", { mode: outlookIntegrationMode() });
    return Response.json({
      ...authorization,
      mode: "real",
      requiresRedirect: true,
    });
  }

  const connection = setOutlookConnection(
    createMockOutlookConnection(getCompanyConnectionUserId())
  );
  logger.info("outlook.connected", {
    connectionId: connection.id,
    mailboxAddress: connection.mailboxAddress,
  });
  return Response.json({
    connection: publicOutlookConnection(connection),
    mode: "mock",
    requiresRedirect: false,
  });
}
