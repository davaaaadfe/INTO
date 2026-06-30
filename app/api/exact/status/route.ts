import {
  getExactMasterData,
  isCachedExactMasterDataStale,
  publicExactConnection,
} from "../../../../lib/repository/invoice-store";

export async function GET() {
  return Response.json({
    connection: publicExactConnection(),
    masterData: getExactMasterData(),
    masterDataStale: isCachedExactMasterDataStale(),
    masterDataReadOnly: true,
  });
}
