import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  INTO_ACCESS_COOKIE_NAME,
  isIntoAccessPasswordConfigured,
  verifyIntoAccessSession,
} from "./lib/services/into-access-auth";
import { isVerifiedSessionTokenFormat, parseAuthMode, VERIFIED_SESSION_COOKIE_NAME } from "./lib/services/verified-session-auth";

const publicApiPaths = new Set([
  "/api/access/login",
  "/api/access/logout",
  "/api/exact/callback",
  "/api/storage/cleanup",
]);

export function proxy(request: NextRequest) {
  if (publicApiPaths.has(request.nextUrl.pathname)) {
    return NextResponse.next();
  }

  const mode = parseAuthMode();
  if (mode !== "verified_user" && isIntoAccessPasswordConfigured()) {
    const session = request.cookies.get(INTO_ACCESS_COOKIE_NAME)?.value;
    if (verifyIntoAccessSession(session)) return NextResponse.next();
  }

  if (mode !== "legacy_password") {
    const verifiedToken = request.cookies.get(VERIFIED_SESSION_COOKIE_NAME)?.value;
    if (isVerifiedSessionTokenFormat(verifiedToken)) return NextResponse.next();
  }

  if (mode !== "verified_user" && !isIntoAccessPasswordConfigured()) {
    return NextResponse.json(
      {
        error:
          "INTO access password is not configured. Add INTO_ACCESS_PASSWORD in Vercel Environment Variables.",
      },
      { status: 503 }
    );
  }

  return NextResponse.json(
    { error: "INTO is locked. Enter the INTO password to continue." },
    { status: 401 }
  );
}

export const config = {
  matcher: "/api/:path*",
};
