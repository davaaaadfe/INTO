import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import {
  createIntoAccessSession,
  INTO_ACCESS_COOKIE_NAME,
  INTO_ACCESS_SESSION_SECONDS,
  isIntoAccessPasswordConfigured,
  verifyIntoAccessPassword,
} from "../../../../lib/services/into-access-auth";
import { configuredAuthRepository } from "../../../../lib/repository/configured-auth-repository";
import {
  loginVerifiedUser,
  LoginError,
  parseAuthMode,
  RequestAuthenticationError,
  requireSameOrigin,
  trustedRequestSourceHash,
  VERIFIED_SESSION_COOKIE_NAME,
  VERIFIED_SESSION_SECONDS,
} from "../../../../lib/services/verified-session-auth";

const missingConfigurationMessage =
  "INTO access password is not configured. Add INTO_ACCESS_PASSWORD in Vercel Environment Variables.";

export async function POST(request: Request) {
  const payload = (await request.json().catch(() => null)) as {
    email?: unknown;
    password?: unknown;
  } | null;
  const password = typeof payload?.password === "string" ? payload.password : "";
  const email = typeof payload?.email === "string" ? payload.email : "";
  const mode = parseAuthMode();
  if (mode === "legacy_password" && email) {
    return NextResponse.json({ error: "Access denied." }, { status: 403 });
  }
  const legacyRequest = !email && mode !== "verified_user";

  if (!legacyRequest) {
    try {
      requireSameOrigin(request);
      const repository = await configuredAuthRepository();
      const result = await loginVerifiedUser(repository, email, password, Date.now(), {
        requestId: request.headers.get("idempotency-key")?.trim() || randomUUID(),
        sourceHash: trustedRequestSourceHash(request),
      });
      const response = NextResponse.json({
        ok: true,
        user: {
          id: result.user.id,
          email: result.user.email,
          displayName: result.user.displayName,
          status: result.user.status,
          version: result.user.version,
        },
      });
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
      if (error instanceof LoginError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      if (error instanceof RequestAuthenticationError) {
        return NextResponse.json({ error: "Access denied." }, { status: error.status });
      }
      return NextResponse.json(
        { error: "Authentication service unavailable." },
        { status: 503 }
      );
    }
  }

  if (!isIntoAccessPasswordConfigured()) {
    return NextResponse.json({ error: missingConfigurationMessage }, { status: 503 });
  }

  if (!verifyIntoAccessPassword(password)) {
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
