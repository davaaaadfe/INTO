import { NextResponse } from "next/server";
import { INTO_ACCESS_COOKIE_NAME } from "../../../../lib/services/into-access-auth";
import { configuredAuthRepository } from "../../../../lib/repository/configured-auth-repository";
import {
  isVerifiedSessionTokenFormat,
  parseAuthMode,
  RequestAuthenticationError,
  requireSameOrigin,
  revokeVerifiedSession,
  VERIFIED_SESSION_COOKIE_NAME,
  verifiedSessionTokenFromRequest,
} from "../../../../lib/services/verified-session-auth";

export async function POST(request: Request) {
  if (parseAuthMode() !== "legacy_password") {
    try {
      requireSameOrigin(request);
    } catch (error) {
      if (error instanceof RequestAuthenticationError) {
        return NextResponse.json({ error: "Access denied." }, { status: 403 });
      }
      throw error;
    }
  }
  try {
    const token = verifiedSessionTokenFromRequest(request);
    if (isVerifiedSessionTokenFormat(token)) {
      await revokeVerifiedSession(await configuredAuthRepository(), token);
    }
  } catch {
    // Logout remains available to clear stale cookies when persistence is unavailable.
  }
  const response = NextResponse.json({ ok: true });
  for (const name of [INTO_ACCESS_COOKIE_NAME, VERIFIED_SESSION_COOKIE_NAME]) {
    response.cookies.set({
      name,
      value: "",
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });
  }
  return response;
}
