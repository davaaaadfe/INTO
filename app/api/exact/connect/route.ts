import {
  getCompanyConnectionUserId,
  listInvoices,
  publicExactConnection,
  requireSystemOwner,
  setExactConnection,
  syncExactDataNow,
} from "../../../../lib/repository/invoice-store";
import {
  createExactAuthorizationUrl,
  createMockExactConnection,
} from "../../../../lib/services/exact-online-service";
import {
  createRealExactAuthorizationUrl,
  exactIntegrationMode,
  isRealExactMode,
} from "../../../../lib/services/exact-api-client";
import { createId } from "../../../../lib/utils/id";
import { logger } from "../../../../lib/utils/logger";

export async function GET() {
  try {
    requireSystemOwner();
    if (isRealExactMode()) {
      const authorization = await createRealExactAuthorizationUrl(
        getCompanyConnectionUserId()
      );
      return Response.json({
        ...authorization,
        mode: "real",
        requiresRedirect: true,
        masterDataReadOnly: true,
      });
    }

    const state = createId("oauth_state");
    return Response.json({
      authorizationUrl: createExactAuthorizationUrl(state),
      state,
      mode: "mock",
      requiresRedirect: false,
      masterDataReadOnly: true,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Exact Online connection failed.";
    logger.error("exact.connect_metadata_failed", { message });
    return Response.json(
      { error: message },
      { status: message.includes("not allowed") ? 403 : 409 }
    );
  }
}

export async function POST() {
  try {
    requireSystemOwner();
    if (isRealExactMode()) {
      const authorization = await createRealExactAuthorizationUrl(
        getCompanyConnectionUserId()
      );
      logger.info("exact.oauth_started", { mode: exactIntegrationMode() });
      return Response.json({
        ...authorization,
        mode: "real",
        requiresRedirect: true,
        masterDataReadOnly: true,
      });
    }

    const connection = setExactConnection(
      createMockExactConnection(getCompanyConnectionUserId())
    );
    const masterData = await syncExactDataNow();
    logger.info("exact.connected", {
      connectionId: connection.id,
      divisionCode: connection.divisionCode,
    });
    logger.info("exact.master_data_synced", {
      divisionCode: masterData.divisionCode,
      supplierCount: masterData.suppliers.length,
      glAccountCount: masterData.glAccounts.length,
    });
    return Response.json({
      connection: publicExactConnection(connection),
      masterData,
      masterDataReadOnly: true,
      invoices: listInvoices(),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Exact Online connection failed.";
    logger.error("exact.connect_failed", { message });
    return Response.json(
      { error: message },
      { status: message.includes("not allowed") ? 403 : 409 }
    );
  }
}
