import { createHash, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { configuredAuthRepository } from "../../../../lib/repository/configured-auth-repository";
import {
  InvitationGoneError,
  parseAuthMode,
  RequestAuthenticationError,
  requireSameOrigin,
  safeAuthUser,
  trustedRequestSourceHash,
  VERIFIED_SESSION_COOKIE_NAME,
  VERIFIED_SESSION_SECONDS,
  verifyUserInvitation,
} from "../../../../lib/services/verified-session-auth";

// ponytail: process-local limiter; replace with shared storage before multi-instance enforcement is required.
const verificationAttempts = new Map<string, { count: number; windowStartedAt: number }>();
const verificationWindowMs = 60_000;
const verificationLimit = 10;

function verificationAllowed(request: Request, token: unknown, now = Date.now()) {
  const tokenFingerprint = createHash("sha256")
    .update(`INTO verification token:v1:${typeof token === "string" ? token : "malformed"}`)
    .digest("base64url");
  const key = createHash("sha256")
    .update(`INTO verification limit:v1:${tokenFingerprint}:${trustedRequestSourceHash(request) ?? "unattributed"}`)
    .digest("base64url");
  const current = verificationAttempts.get(key);
  if (!current || now - current.windowStartedAt >= verificationWindowMs) {
    verificationAttempts.set(key, { count: 1, windowStartedAt: now });
    return true;
  }
  if (current.count >= verificationLimit) return false;
  current.count += 1;
  return true;
}

export async function POST(request: Request) {
  try {
    if (parseAuthMode() === "legacy_password") {
      return NextResponse.json({ error: "Access denied." }, { status: 403 });
    }
    requireSameOrigin(request);
    const payload = await request.json().catch(() => null) as {
      token?: unknown;
      displayName?: unknown;
      password?: unknown;
    } | null;
    if (!verificationAllowed(request, payload?.token)) {
      return NextResponse.json({ error: "Too many verification attempts. Try again later." }, { status: 429 });
    }
    if (
      typeof payload?.token !== "string" ||
      typeof payload.displayName !== "string" ||
      typeof payload.password !== "string"
    ) {
      return NextResponse.json({ error: "token, displayName, and password are required." }, { status: 422 });
    }
    const result = await verifyUserInvitation(await configuredAuthRepository(), {
      token: payload.token,
      displayName: payload.displayName,
      password: payload.password,
      requestId: request.headers.get("idempotency-key")?.trim() || randomUUID(),
    });
    const response = NextResponse.json({ ok: true, user: safeAuthUser(result.user) });
    response.cookies.set({
      name: VERIFIED_SESSION_COOKIE_NAME,
      value: result.session.token,
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: VERIFIED_SESSION_SECONDS,
    });
    return response;
  } catch (error) {
    if (error instanceof InvitationGoneError) {
      return NextResponse.json({ error: error.message }, { status: 410 });
    }
    if (error instanceof RequestAuthenticationError) {
      return NextResponse.json({ error: "Access denied." }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : "Verification failed.";
    const status = /between|required|characters/i.test(message) ? 422 : 503;
    return NextResponse.json({ error: status === 503 ? "Authentication service unavailable." : message }, { status });
  }
}
