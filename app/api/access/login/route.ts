import { NextResponse } from "next/server";
import {
  createIntoAccessSession,
  INTO_ACCESS_COOKIE_NAME,
  INTO_ACCESS_SESSION_SECONDS,
  isIntoAccessPasswordConfigured,
  verifyIntoAccessPassword,
} from "../../../../lib/services/into-access-auth";
import { createBoundedAuthLimiter } from "../../../../lib/services/bounded-auth-limiter";
import {
  RequestAuthenticationError,
  requireSameOrigin,
  trustedRequestSourceHash,
} from "../../../../lib/services/verified-session-auth";

// ponytail: per-instance protection; use trusted ingress limits for cross-instance protection.
const loginLimiter = createBoundedAuthLimiter({
  purpose: "shared-password-login",
  windowMs: 15 * 60 * 1_000,
  subjectLimit: 20,
  aggregateLimit: 20,
  maxSubjectScopes: 1024,
  maxAggregateScopes: 1024,
});

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
  } catch (error) {
    if (error instanceof RequestAuthenticationError) {
      return NextResponse.json({ error: "Access denied." }, { status: error.status });
    }
    throw error;
  }
  if (!isIntoAccessPasswordConfigured()) {
    return NextResponse.json({ error: "INTO access password is not configured." }, { status: 503 });
  }
  const payload = await request.json().catch(() => null);
  if (!payload || Array.isArray(payload) || typeof payload.password !== "string" ||
      Buffer.byteLength(payload.password, "utf8") < 1 || Buffer.byteLength(payload.password, "utf8") > 1024) {
    return NextResponse.json({ error: "Enter a valid password." }, { status: 422 });
  }
  if (!loginLimiter.allow("shared-password", trustedRequestSourceHash(request))) {
    return NextResponse.json(
      { error: "Too many login attempts. Try again later." },
      { status: 429, headers: { "Retry-After": "900" } }
    );
  }
  if (!verifyIntoAccessPassword(payload.password)) {
    return NextResponse.json(
      { error: "The password is incorrect. Please try again." },
      { status: 401 }
    );
  }
  const response = NextResponse.json({ ok: true });
  response.cookies.set({
    name: INTO_ACCESS_COOKIE_NAME,
    value: createIntoAccessSession(),
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: INTO_ACCESS_SESSION_SECONDS,
  });
  return response;
}
