import { getSetupStatus } from "../../../../lib/services/setup-status-service";
import { withPersistentStore } from "../../../../lib/repository/persistent-request";

export async function GET() {
  return withPersistentStore(async () => Response.json(await getSetupStatus()));
}
