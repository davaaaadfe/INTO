import { configuredAuthRepository } from "../../../../lib/repository/configured-auth-repository";
import {
  parseAuthMode,
  RequestAuthenticationError,
  resolveRequestPrincipal,
  safeAuthUser,
  verifiedSessionTokenFromRequest,
  digestVerifiedSessionToken,
} from "../../../../lib/services/verified-session-auth";

export async function GET(request: Request) {
  try {
    const repository = await configuredAuthRepository();
    const principal = await resolveRequestPrincipal(request, { repository });
    if (principal.accessLevel === "legacy_shared") {
      return Response.json({ mode: parseAuthMode(), legacy: true, user: null });
    }
    const token = verifiedSessionTokenFromRequest(request)!;
    const session = await repository.findSessionByDigest(digestVerifiedSessionToken(token));
    if (!session) throw new RequestAuthenticationError(401);
    return Response.json({ mode: parseAuthMode(), legacy: false, user: safeAuthUser(session.user) });
  } catch (error) {
    const status = error instanceof RequestAuthenticationError ? error.status : 503;
    return Response.json({ error: status === 503 ? "Authentication service unavailable." : "Authentication required." }, { status });
  }
}
