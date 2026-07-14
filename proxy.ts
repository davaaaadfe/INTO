import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  INTO_ACCESS_COOKIE_NAME,
  isIntoAccessPasswordConfigured,
  verifyIntoAccessSession,
} from "./lib/services/into-access-auth";

const publicApiPaths = new Set([
  "/api/access/login",
  "/api/access/logout",
  "/api/exact/callback",
]);

export function proxy(request: NextRequest) {
  if (publicApiPaths.has(request.nextUrl.pathname)) {
    return NextResponse.next();
  }

  if (!isIntoAccessPasswordConfigured()) {
    return NextResponse.json(
      {
        error:
          "INTO access password is not configured. Add INTO_ACCESS_PASSWORD in Vercel Environment Variables.",
      },
      { status: 503 }
    );
  }

  const session = request.cookies.get(INTO_ACCESS_COOKIE_NAME)?.value;
  if (!verifyIntoAccessSession(session)) {
    return NextResponse.json(
      { error: "INTO is locked. Enter the INTO password to continue." },
      { status: 401 }
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
