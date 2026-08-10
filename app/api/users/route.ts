import { currentUserContext } from "../../../lib/repository/invoice-store";
import { withPersistentStore } from "../../../lib/repository/persistent-request";

export async function GET(request: Request) {
  return withPersistentStore(() => {
    const context = currentUserContext();
    return Response.json({
      permissions: context.permissions,
    });
  }, request);
}
