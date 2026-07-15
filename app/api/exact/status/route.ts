import {
  getExactMasterData,
  getSupplierOverviewImportStatus,
  isCachedExactMasterDataStale,
  publicExactConnection,
} from "../../../../lib/repository/invoice-store";
import { withPersistentStore } from "../../../../lib/repository/persistent-request";
import { exactOAuthConfigurationStatus } from "../../../../lib/services/app-config-service";
import { exactIntegrationMode } from "../../../../lib/services/exact-api-client";

export async function GET() {
  return withPersistentStore(() => {
    return Response.json({
      connection: publicExactConnection(),
      masterData: getExactMasterData(),
      masterDataStale: isCachedExactMasterDataStale(),
      masterDataReadOnly: true,
      supplierOverviewImport: getSupplierOverviewImportStatus(),
      configuration: {
        ...exactOAuthConfigurationStatus(),
        mode: exactIntegrationMode(),
      },
    });
  });
}
