import { setOutlookConnection } from "../../../../lib/repository/invoice-store";
import {
  exchangeOutlookAuthorizationCode,
  verifyMicrosoftOAuthState,
} from "../../../../lib/services/outlook-service";
import { logger } from "../../../../lib/utils/logger";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (error) {
    logger.error("outlook.oauth_callback_error", {
      error,
      description: url.searchParams.get("error_description"),
    });
    return Response.redirect(new URL("/?outlook=error", request.url));
  }

  try {
    if (!code || !state) {
      throw new Error("Outlook OAuth callback is missing code or state.");
    }

    const verifiedState = await verifyMicrosoftOAuthState(state);
    const connection = setOutlookConnection(
      await exchangeOutlookAuthorizationCode(verifiedState.userId, code)
    );

    logger.info("outlook.oauth_callback", {
      connectionId: connection.id,
      mailboxAddress: connection.mailboxAddress,
    });

    return Response.redirect(new URL("/?outlook=connected", request.url));
  } catch (callbackError) {
    const message =
      callbackError instanceof Error
        ? callbackError.message
        : "Outlook OAuth callback failed.";
    logger.error("outlook.oauth_callback_failed", { message });
    return Response.redirect(new URL("/?outlook=error", request.url));
  }
}
