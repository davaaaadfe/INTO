import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AuthRepository } from "../repository/auth-repository";
import { configuredAuthRepository } from "../repository/configured-auth-repository";
import {
  INTO_ACCESS_COOKIE_NAME,
  isIntoAccessPasswordConfigured,
  verifyIntoAccessSession,
} from "./into-access-auth";

export const VERIFIED_SESSION_COOKIE_NAME = "into_verified_session";
export const VERIFIED_SESSION_SECONDS = 12 * 60 * 60;
export const SESSION_LAST_SEEN_CADENCE_MS = 15 * 60 * 1_000;

export type AuthMode = "legacy_password" | "dual" | "verified_user";
export type VerifiedPrincipal = Readonly<{
  actorId: string;
  actorName: string;
  accessLevel: "verified_user";
  verificationState: "verified";
  sessionCorrelationId: string;
  requestId: string;
}>;
export type LegacyPrincipal = Readonly<{
  actorId: "shared_user";
  actorName: "Shared access";
  accessLevel: "legacy_shared";
  verificationState: "legacy";
  sessionCorrelationId: string;
  requestId: string;
}>;
export type RequestPrincipal = VerifiedPrincipal | LegacyPrincipal;

export class RequestAuthenticationError extends Error {
  readonly status: 401 | 403 | 503;

  constructor(status: 401 | 403 | 503) {
    super("Request authentication failed.");
    this.status = status;
  }
}

export function parseAuthMode(value = process.env.AUTH_MODE): AuthMode {
  return value === "dual" || value === "verified_user" || value === "legacy_password"
    ? value
    : "legacy_password";
}

export function digestVerifiedSessionToken(token: string) {
  return createHash("sha256").update(`INTO verified session:v1:${token}`).digest("base64url");
}

function correlationIdForToken(token: string) {
  return `verified_session_${createHash("sha256")
    .update(`INTO verified correlation:v1:${token}`)
    .digest("base64url")}`;
}

function correlationHash(correlationId: string) {
  return createHash("sha256").update(correlationId).digest("base64url");
}

function requestIdFor(request: Request) {
  return request.headers.get("idempotency-key")?.trim() || randomUUID();
}

function cookieFromRequest(request: Request, name: string) {
  const raw = request.headers.get("cookie")?.split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`))
    ?.slice(name.length + 1);
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

export function isVerifiedSessionTokenFormat(token: string | null | undefined) {
  return Boolean(token && /^v1\.[A-Za-z0-9_-]{32,}$/.test(token));
}

export async function issueVerifiedSession(
  repository: AuthRepository,
  userId: string,
  now = Date.now()
) {
  const token = `v1.${randomBytes(32).toString("base64url")}`;
  const correlationId = correlationIdForToken(token);
  const issuedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + VERIFIED_SESSION_SECONDS * 1_000).toISOString();
  const sessionId = randomUUID();
  await repository.createSession({
    id: sessionId,
    userId,
    tokenDigest: digestVerifiedSessionToken(token),
    correlationIdHash: correlationHash(correlationId),
    tokenVersion: 1,
    issuedAt,
    expiresAt,
    revokedAt: null,
    lastSeenAt: issuedAt,
  });
  return { token, sessionId, correlationId, expiresAt };
}

export async function revokeVerifiedSession(
  repository: AuthRepository,
  token: string | null | undefined,
  now = Date.now()
) {
  if (!isVerifiedSessionTokenFormat(token ?? null)) return false;
  return repository.revokeSessionByDigest(
    digestVerifiedSessionToken(token!), new Date(now).toISOString()
  );
}

export async function resolveVerifiedPrincipal(
  request: Request,
  options: { repository?: AuthRepository; now?: number } = {}
): Promise<VerifiedPrincipal> {
  const token = cookieFromRequest(request, VERIFIED_SESSION_COOKIE_NAME);
  if (!isVerifiedSessionTokenFormat(token)) throw new RequestAuthenticationError(401);
  const now = options.now ?? Date.now();
  let session;
  try {
    session = await (options.repository ?? await configuredAuthRepository())
      .findSessionByDigest(digestVerifiedSessionToken(token!));
  } catch {
    throw new RequestAuthenticationError(503);
  }
  if (!session || session.tokenVersion !== 1 || session.revokedAt || Date.parse(session.expiresAt) <= now) {
    throw new RequestAuthenticationError(401);
  }
  if (session.user.status === "disabled" || session.user.status === "invited" || !session.user.verifiedAt) {
    throw new RequestAuthenticationError(403);
  }
  const lastSeen = Date.parse(session.lastSeenAt ?? session.issuedAt);
  if (now - lastSeen >= SESSION_LAST_SEEN_CADENCE_MS) {
    try {
      await (options.repository ?? await configuredAuthRepository()).touchSession(
        session.id,
        new Date(now).toISOString(),
        new Date(now - SESSION_LAST_SEEN_CADENCE_MS).toISOString()
      );
    } catch {
      throw new RequestAuthenticationError(503);
    }
  }
  return Object.freeze({
    actorId: session.user.id,
    actorName: session.user.displayName,
    accessLevel: "verified_user",
    verificationState: "verified",
    sessionCorrelationId: correlationIdForToken(token!),
    requestId: requestIdFor(request),
  });
}

function legacyPrincipal(request: Request): LegacyPrincipal {
  const token = cookieFromRequest(request, INTO_ACCESS_COOKIE_NAME);
  if (!isIntoAccessPasswordConfigured()) {
    if (process.env.NODE_TEST_CONTEXT) {
      return Object.freeze({
        actorId: "shared_user",
        actorName: "Shared access",
        accessLevel: "legacy_shared",
        verificationState: "legacy",
        sessionCorrelationId: "legacy_test_session",
        requestId: requestIdFor(request),
      });
    }
    throw new RequestAuthenticationError(503);
  }
  if (!verifyIntoAccessSession(token)) throw new RequestAuthenticationError(401);
  return Object.freeze({
    actorId: "shared_user",
    actorName: "Shared access",
    accessLevel: "legacy_shared",
    verificationState: "legacy",
    sessionCorrelationId: "legacy_session",
    requestId: requestIdFor(request),
  });
}

export async function resolveRequestPrincipal(
  request: Request,
  options: { mode?: AuthMode; repository?: AuthRepository; now?: number } = {}
): Promise<RequestPrincipal> {
  const mode = options.mode ?? parseAuthMode();
  if (mode === "legacy_password") return legacyPrincipal(request);
  const verifiedToken = cookieFromRequest(request, VERIFIED_SESSION_COOKIE_NAME);
  if (verifiedToken) return resolveVerifiedPrincipal(request, options);
  if (mode === "dual") return legacyPrincipal(request);
  return resolveVerifiedPrincipal(request, options);
}

function trustedOrigins(request: Request) {
  const configured = process.env.INTO_TRUSTED_ORIGINS?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean) ?? [];
  const source = configured.length
    ? configured
    : [forwardedOrigin(request) ?? new URL(request.url).origin];
  return new Set(source.flatMap((origin) => {
    try {
      return [new URL(origin).origin];
    } catch {
      return [];
    }
  }));
}

function forwardedOrigin(request: Request) {
  const host = request.headers.get("x-forwarded-host");
  const protocol = request.headers.get("x-forwarded-proto");
  if (!host || !protocol || host.includes(",") || protocol.includes(",")) return null;
  return `${protocol.toLowerCase()}://${host.toLowerCase()}`;
}

function requireSameOrigin(request: Request) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  const origin = request.headers.get("origin");
  if (!origin || !trustedOrigins(request).has(origin)) throw new RequestAuthenticationError(403);
}

export async function withVerifiedPersistentRequest<T>(
  request: Request,
  handler: (principal: RequestPrincipal) => Promise<T> | T
): Promise<T | Response> {
  try {
    const principal = await resolveRequestPrincipal(request);
    if (parseAuthMode() !== "legacy_password") requireSameOrigin(request);
    return await handler(principal);
  } catch (error) {
    if (error instanceof RequestAuthenticationError) {
      const errorMessage = error.status === 401
        ? "Authentication required."
        : error.status === 403
          ? "Access denied."
          : "Authentication service unavailable.";
      return Response.json({ error: errorMessage }, { status: error.status });
    }
    throw error;
  }
}
