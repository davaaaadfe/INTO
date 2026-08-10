import { configuredAuthRepository } from "../../../lib/repository/configured-auth-repository";
import { safeAuthUser, withVerifiedPersistentRequest } from "../../../lib/services/verified-session-auth";

export async function GET(request: Request) {
  return withVerifiedPersistentRequest(request, async (principal) => {
    if (principal.accessLevel !== "verified_user") {
      return Response.json({ error: "Access denied." }, { status: 403 });
    }
    try {
      const users = await (await configuredAuthRepository()).listUsers();
      return Response.json({ users: users.map(safeAuthUser) });
    } catch {
      return Response.json({ error: "Authentication service unavailable." }, { status: 503 });
    }
  });
}
