import { getSetupStatus } from "../../../../lib/services/app-config-service";

export async function GET() {
  return Response.json(getSetupStatus());
}
