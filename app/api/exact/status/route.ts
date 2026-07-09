import {
  getExactMasterData,
  isCachedExactMasterDataStale,
  publicExactConnection,
} from "../../../../lib/repository/invoice-store";
import { withPersistentStore } from "../../../../lib/repository/persistent-request";

export async function GET() {
  return withPersistentStore(() => {
    return Response.json({
      connection: publicExactConnection(),
      masterData: getExactMasterData(),
      masterDataStale: isCachedExactMasterDataStale(),
      masterDataReadOnly: true,
    });
  });
}
