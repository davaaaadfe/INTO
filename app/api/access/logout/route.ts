import { NextResponse } from "next/server";
import { INTO_ACCESS_COOKIE_NAME } from "../../../../lib/services/into-access-auth";
import { configuredAuthRepository } from "../../../../lib/repository/configured-auth-repository";
import {
  revokeVerifiedSession,
  VERIFIED_SESSION_COOKIE_NAME,
  verifiedSessionTokenFromRequest,
} from "../../../../lib/services/verified-session-auth";

export async function POST(request: Request) {
  try {
    await revokeVerifiedSession(
      await configuredAuthRepository(),
      verifiedSessionTokenFromRequest(request)
    );
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
