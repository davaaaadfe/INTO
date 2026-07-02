import { getSetupStatus } from "../../../../lib/services/setup-status-service";

export async function GET() {
  return Response.json(await getSetupStatus());
}
