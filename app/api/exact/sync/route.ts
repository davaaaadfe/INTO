import {
  addAuditEvent,
  listInvoices,
  requireSystemOwner,
  syncExactDataNow,
} from "../../../../lib/repository/invoice-store";
import { logger } from "../../../../lib/utils/logger";

export async function POST() {
  try {
    requireSystemOwner();
    const masterData = await syncExactDataNow();
    logger.info("exact.master_data_synced", {
      divisionCode: masterData.divisionCode,
      supplierCount: masterData.suppliers.length,
      glAccountCount: masterData.glAccounts.length,
      vatCodeCount: masterData.vatCodes.length,
    });

    return Response.json({
      masterData,
      masterDataReadOnly: true,
      invoices: listInvoices(),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Exact master-data sync failed.";
    addAuditEvent({
      type: "sync_operation",
      message: `Exact Online master data sync failed: ${message}`,
      metadata: {
        provider: "exact-online",
        status: "failed",
      },
    });
    logger.error("exact.master_data_sync_failed", { message });
    return Response.json(
      { error: message },
      { status: message.includes("not allowed") ? 403 : 409 }
    );
  }
}
