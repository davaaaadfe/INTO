import {
  getCompanyConnectionUserId,
  setExactConnection,
  syncExactDataNow,
} from "../../../../lib/repository/invoice-store";
import { withPublicPersistentStore } from "../../../../lib/repository/persistent-request";
import { createMockExactConnection } from "../../../../lib/services/exact-online-service";
import {
  exchangeExactAuthorizationCode,
  isRealExactMode,
  verifyExactOAuthState,
} from "../../../../lib/services/exact-api-client";
import { logger } from "../../../../lib/utils/logger";

export async function GET(request: Request) {
  return withPublicPersistentStore(async () => {
    const url = new URL(request.url);
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    if (error) {
      logger.error("exact.oauth_callback_error", {
        error,
        description: url.searchParams.get("error_description"),
      });
      return Response.redirect(new URL("/?exact=error", request.url));
    }

    if (isRealExactMode()) {
      try {
        if (!code || !state) {
          throw new Error("Exact OAuth callback is missing code or state.");
        }

        const verifiedState = await verifyExactOAuthState(state);
        const connection = setExactConnection(
          await exchangeExactAuthorizationCode(verifiedState.userId, code)
        );
        const masterData = await syncExactDataNow(verifiedState.userId);

        logger.info("exact.oauth_callback", {
          connectionId: connection.id,
          divisionCode: connection.divisionCode,
          supplierCount: masterData.suppliers.length,
        });

        return Response.redirect(new URL("/?exact=connected", request.url));
      } catch (callbackError) {
        const message =
          callbackError instanceof Error
            ? callbackError.message
            : "Exact OAuth callback failed.";
        logger.error("exact.oauth_callback_failed", { message });
        return Response.redirect(new URL("/?exact=error", request.url));
      }
    }

    const hasCode = Boolean(code);
    const connection = setExactConnection(
      createMockExactConnection(getCompanyConnectionUserId())
    );

    logger.info("exact.oauth_callback", {
      connectionId: connection.id,
      hasCode,
    });

    return Response.redirect(new URL("/", request.url));
  }, request);
}
