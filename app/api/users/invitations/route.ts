import { configuredAuthRepository } from "../../../../lib/repository/configured-auth-repository";
import {
  createUserInvitation,
  InvitationConflictError,
  parseAuthMode,
  requireSameOrigin,
  withVerifiedPersistentRequest,
} from "../../../../lib/services/verified-session-auth";

export async function POST(request: Request) {
  return withVerifiedPersistentRequest(request, async (principal) => {
    try {
      requireSameOrigin(request);
      const repository = await configuredAuthRepository();
      if (principal.accessLevel === "legacy_shared") {
        if (parseAuthMode() !== "dual" || await repository.countActiveUsers() >= 2) {
          return Response.json({ error: "Access denied." }, { status: 403 });
        }
      }
      const payload = await request.json().catch(() => null) as {
        email?: unknown;
        name?: unknown;
        requestKey?: unknown;
      } | null;
      if (
        typeof payload?.email !== "string" ||
        typeof payload.name !== "string" ||
        typeof payload.requestKey !== "string"
      ) {
        return Response.json({ error: "email, name, and requestKey are required." }, { status: 422 });
      }
      const result = await createUserInvitation(repository, principal, {
        email: payload.email,
        name: payload.name,
        requestKey: payload.requestKey,
      }, new URL(request.url).origin);
      return Response.json(result, { status: result.state === "created" ? 201 : 200 });
    } catch (error) {
      if (error instanceof InvitationConflictError) {
        return Response.json({ error: error.message }, { status: 409 });
      }
      const message = error instanceof Error ? error.message : "Invitation could not be created.";
      const status = /required|characters|visible ASCII|one @/i.test(message) ? 422 : 503;
      return Response.json({ error: status === 503 ? "Authentication service unavailable." : message }, { status });
    }
  });
}
