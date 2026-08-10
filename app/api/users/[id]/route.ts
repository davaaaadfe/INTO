import { configuredAuthRepository } from "../../../../lib/repository/configured-auth-repository";
import {
  requireSameOrigin,
  safeAuthUser,
  withVerifiedPersistentRequest,
} from "../../../../lib/services/verified-session-auth";

type RouteContext = { params: { id: string } | Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  return withVerifiedPersistentRequest(request, async (principal) => {
    if (principal.accessLevel !== "verified_user") {
      return Response.json({ error: "Access denied." }, { status: 403 });
    }
    try {
      requireSameOrigin(request);
      const payload = await request.json().catch(() => null) as {
        expectedVersion?: unknown;
        status?: unknown;
      } | null;
      if (
        !Number.isInteger(payload?.expectedVersion) ||
        (payload?.status !== "active" && payload?.status !== "disabled")
      ) {
        return Response.json({ error: "expectedVersion and a valid status are required." }, { status: 422 });
      }
      const { id } = await context.params;
      const result = await (await configuredAuthRepository()).updateUserStatus({
        actorId: principal.actorId,
        targetId: id,
        expectedVersion: payload.expectedVersion as number,
        status: payload.status,
        requestId: principal.requestId,
        sessionId: principal.sessionCorrelationId,
        timestamp: new Date().toISOString(),
      });
      if (result.state === "not_found") return Response.json({ error: "User not found." }, { status: 404 });
      if (result.state === "conflict") {
        return Response.json({ error: "User changed. Refresh and try again.", user: result.user && safeAuthUser(result.user) }, { status: 409 });
      }
      if (result.state === "final_active" || result.state === "unverified") {
        return Response.json({ error: result.state === "final_active"
          ? "The final active verified user cannot be disabled."
          : "An unverified user cannot be activated." }, { status: 422 });
      }
      return Response.json({ user: safeAuthUser(result.user!) });
    } catch {
      return Response.json({ error: "Authentication service unavailable." }, { status: 503 });
    }
  });
}
