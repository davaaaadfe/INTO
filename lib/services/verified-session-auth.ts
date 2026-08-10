import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import {
  canonicalAuthEmail,
  type AuthRepository,
} from "../repository/auth-repository";
import { configuredAuthRepository } from "../repository/configured-auth-repository";
import {
  INTO_ACCESS_COOKIE_NAME,
  isIntoAccessPasswordConfigured,
  verifyIntoAccessSession,
} from "./into-access-auth";
import { createBoundedAuthLimiter } from "./bounded-auth-limiter";

export const VERIFIED_SESSION_COOKIE_NAME = "into_verified_session";
export const VERIFIED_SESSION_SECONDS = 12 * 60 * 60;
export const SESSION_LAST_SEEN_CADENCE_MS = 15 * 60 * 1_000;
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;
let testLegacyPrincipalEnabled = false;
let testPasswordVerificationObserver: (() => void) | undefined;

export type PasswordCredential = Readonly<{
  algorithm: "scrypt";
  version: 1;
  hash: string;
  salt: string;
  n: number;
  r: number;
  p: number;
}>;

function validatePassword(password: string) {
  const length = Buffer.byteLength(password, "utf8");
  if (length < 12 || length > 1024) {
    throw new Error("Password must be between 12 and 1024 bytes.");
  }
}

function deriveScrypt(password: string, salt: Buffer, credential: Pick<PasswordCredential, "n" | "r" | "p">) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, SCRYPT_KEY_LENGTH, {
      N: credential.n,
      r: credential.r,
      p: credential.p,
      maxmem: SCRYPT_MAX_MEMORY,
    }, (error, key) => error ? reject(error) : resolve(key));
  });
}

export async function createPasswordCredential(password: string): Promise<PasswordCredential> {
  validatePassword(password);
  const salt = randomBytes(16);
  const parameters = { n: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P };
  const hash = await deriveScrypt(password, salt, parameters);
  return Object.freeze({
    algorithm: "scrypt",
    version: 1,
    hash: hash.toString("base64url"),
    salt: salt.toString("base64url"),
    ...parameters,
  });
}

export async function verifyPasswordCredential(
  password: string,
  credential: PasswordCredential
) {
  testPasswordVerificationObserver?.();
  validatePassword(password);
  if (credential.algorithm !== "scrypt" || credential.version !== 1) {
    throw new Error("Unsupported credential version.");
  }
  const actual = await deriveScrypt(password, Buffer.from(credential.salt, "base64url"), credential);
  const stored = Buffer.from(credential.hash, "base64url");
  const comparable = stored.length === actual.length ? stored : Buffer.alloc(actual.length);
  return timingSafeEqual(actual, comparable) && stored.length === actual.length;
}

/** Test-only work-factor seam; no environment value can enable it. */
export function setPasswordVerificationObserverForTests(observer?: () => void) {
  testPasswordVerificationObserver = observer;
}

/** Test-loader seam; no environment value can enable this. */
export function enableLegacyPrincipalForTests() {
  testLegacyPrincipalEnabled = true;
}

export type AuthMode = "legacy_password" | "dual" | "verified_user";
export type VerifiedPrincipal = Readonly<{
  actorId: string;
  actorName: string;
  accessLevel: "verified_user";
  verificationState: "verified";
  sessionCorrelationId: string;
  requestId: string;
  sessionId?: string;
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

export class InvitationConflictError extends Error {}
export class InvitationGoneError extends Error {}

export class LoginError extends Error {
  readonly status: 401 | 403 | 429 | 503;

  constructor(status: 401 | 403 | 429 | 503, message: string) {
    super(message);
    this.status = status;
  }
}

const INVITATION_SECONDS = 24 * 60 * 60;
const LOGIN_LOCK_ATTEMPTS = 4;
const LOGIN_LOCK_MS = 15 * 60 * 1_000;
const loginLimiter = createBoundedAuthLimiter({
  purpose: "login",
  windowMs: LOGIN_LOCK_MS,
  subjectLimit: LOGIN_LOCK_ATTEMPTS,
  aggregateLimit: 12,
  maxSubjectScopes: 1024,
  maxAggregateScopes: 256,
});
const DUMMY_LOGIN_CREDENTIAL: PasswordCredential = Object.freeze({
  algorithm: "scrypt",
  version: 1,
  hash: "b3qw5l8nUENKHosTC06bne_Lwyk1w7iYd0Uf5Bf4Q74",
  salt: "SU5UTyBsb2dpbiBkdW1teQ",
  n: SCRYPT_N,
  r: SCRYPT_R,
  p: SCRYPT_P,
});

function invitationSecret() {
  const secret = process.env.INTO_INVITATION_SECRET ?? "";
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new LoginError(503, "Authentication service unavailable.");
  }
  return secret;
}

function invitationToken(invitationId: string) {
  return `v1.${createHmac("sha256", invitationSecret())
    .update(`INTO invitation:v1:${invitationId}`)
    .digest("base64url")}`;
}

function digestInvitationToken(token: string) {
  return createHash("sha256").update(`INTO invitation digest:v1:${token}`).digest("base64url");
}

function requireDisplayName(value: string) {
  const name = value.trim();
  if (!name || name.length > 120) throw new Error("Display name must be between 1 and 120 characters.");
  return name;
}

function createVerifiedSessionRecord(userId: string, now: number) {
  const token = `v1.${randomBytes(32).toString("base64url")}`;
  const correlationId = correlationIdForToken(token);
  const issuedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + VERIFIED_SESSION_SECONDS * 1_000).toISOString();
  const sessionId = randomUUID();
  return {
    token,
    sessionId,
    correlationId,
    expiresAt,
    record: {
      id: sessionId,
      userId,
      tokenDigest: digestVerifiedSessionToken(token),
      correlationIdHash: correlationHash(correlationId),
      tokenVersion: 1,
      issuedAt,
      expiresAt,
      revokedAt: null,
      lastSeenAt: issuedAt,
    },
  } as const;
}

export async function createUserInvitation(
  repository: AuthRepository,
  principal: RequestPrincipal,
  input: { email: string; name: string; requestKey: string },
  origin: string,
  now = Date.now()
) {
  const email = canonicalAuthEmail(input.email);
  const displayName = requireDisplayName(input.name);
  const requestKey = input.requestKey.trim();
  if (!requestKey || requestKey.length > 200) throw new Error("requestKey is required.");
  const id = randomUUID();
  const token = invitationToken(id);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ email, displayName }))
    .digest("base64url");
  const result = await repository.createOrReplayInvitation({
    id,
    userId: randomUUID(),
    email,
    displayName,
    tokenDigest: digestInvitationToken(token),
    expiresAt: new Date(now + INVITATION_SECONDS * 1_000).toISOString(),
    inviterActorId: principal.actorId,
    inviterSessionId: principal.sessionCorrelationId,
    requestId: principal.requestId,
    idempotencyKey: requestKey,
    requestFingerprint: fingerprint,
    timestamp: new Date(now).toISOString(),
  });
  if (result.state === "conflict") throw new InvitationConflictError("requestKey was already used for different invitation details.");
  const replayToken = invitationToken(result.invitation.id);
  const verificationUrl = new URL("/verify", origin);
  verificationUrl.searchParams.set("token", replayToken);
  return { state: result.state, verificationUrl: verificationUrl.toString() };
}

export async function verifyUserInvitation(
  repository: AuthRepository,
  input: { token: string; displayName: string; password: string; requestId: string },
  now = Date.now()
) {
  if (!/^v1\.[A-Za-z0-9_-]{32,}$/.test(input.token)) {
    throw new InvitationGoneError("Invitation is expired or already used.");
  }
  const credential = await createPasswordCredential(input.password);
  const session = createVerifiedSessionRecord("pending-invitation-user", now);
  const result = await repository.consumeInvitation({
    tokenDigest: digestInvitationToken(input.token),
    displayName: requireDisplayName(input.displayName),
    credential,
    session: session.record,
    requestId: input.requestId,
    timestamp: new Date(now).toISOString(),
  });
  if (result.state !== "consumed" || !result.user) {
    throw new InvitationGoneError("Invitation is expired or already used.");
  }
  return {
    user: result.user,
    session: {
      token: session.token,
      sessionId: session.sessionId,
      correlationId: session.correlationId,
      expiresAt: session.expiresAt,
    },
  };
}

export async function loginVerifiedUser(
  repository: AuthRepository,
  emailInput: string,
  password: string,
  now = Date.now(),
  context?: { requestId: string; sourceHash: string | null }
) {
  const boundedEmailInput = emailInput.slice(0, 320);
  let normalizedEmail: string | null = null;
  try {
    if (emailInput.length <= 320) normalizedEmail = canonicalAuthEmail(boundedEmailInput);
  } catch {
    // Invalid identifiers follow the same bounded password-work path as unknown users.
  }
  const limiterIdentity = normalizedEmail ?? `malformed:${boundedEmailInput}`;
  if (!loginLimiter.allow(limiterIdentity, context?.sourceHash ?? null, now)) {
    throw new LoginError(429, "Too many login attempts. Try again later.");
  }
  const stored = normalizedEmail
    ? await repository.findUserCredentialByEmail(normalizedEmail)
    : null;
  const validLength = Buffer.byteLength(password, "utf8") >= 12 && Buffer.byteLength(password, "utf8") <= 1024;
  const candidate = validLength ? password : "invalid password input";
  const credential = stored?.credential ?? DUMMY_LOGIN_CREDENTIAL;
  const valid = await verifyPasswordCredential(candidate, credential);
  if (!stored || !validLength || !valid) {
    if (stored) await repository.recordLoginFailure(
      stored.user.id,
      new Date(now).toISOString(),
      LOGIN_LOCK_ATTEMPTS,
      new Date(now + LOGIN_LOCK_MS).toISOString(),
      context ? { requestId: context.requestId, sourceHash: context.sourceHash } : undefined
    );
    throw new LoginError(401, "Invalid email or password.");
  }
  if (stored.lockedAt && Date.parse(stored.lockedAt) > now) {
    throw new LoginError(429, "Too many login attempts. Try again later.");
  }
  if (stored.user.status !== "active" || !stored.user.verifiedAt) {
    throw new LoginError(403, "Account is not active.");
  }
  await repository.resetLoginFailures(stored.user.id, new Date(now).toISOString());
  const session = await issueVerifiedSession(repository, stored.user.id, now);
  return { user: stored.user, session };
}

/** Test-only isolation seam; no environment value can invoke it. */
export function resetLoginLimiterForTests() {
  loginLimiter.reset();
}

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

export function verifiedSessionTokenFromRequest(request: Request) {
  return cookieFromRequest(request, VERIFIED_SESSION_COOKIE_NAME);
}

export function safeAuthUser(user: {
  id: string;
  email: string;
  displayName: string;
  status: string;
  version: number;
}) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    status: user.status,
    version: user.version,
  };
}

export function trustedRequestSourceHash(request: Request) {
  const header = process.env.INTO_TRUSTED_SOURCE_HEADER?.trim().toLowerCase() ?? "";
  if (!/^[a-z0-9-]+$/.test(header)) return null;
  const source = request.headers.get(header)?.trim();
  if (!source) return null;
  return createHash("sha256")
    .update(`INTO trusted request source:v1:${source.slice(0, 512)}`)
    .digest("base64url");
}

export function isVerifiedSessionTokenFormat(token: string | null | undefined) {
  return Boolean(token && /^v1\.[A-Za-z0-9_-]{32,}$/.test(token));
}

export async function issueVerifiedSession(
  repository: AuthRepository,
  userId: string,
  now = Date.now()
) {
  const session = createVerifiedSessionRecord(userId, now);
  await repository.createSession(session.record);
  return {
    token: session.token,
    sessionId: session.sessionId,
    correlationId: session.correlationId,
    expiresAt: session.expiresAt,
  };
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
  let repository: AuthRepository;
  try {
    repository = options.repository ?? await configuredAuthRepository();
    session = await repository.findSessionByDigest(digestVerifiedSessionToken(token!));
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
      await repository.touchSession(
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
    sessionId: session.id,
  });
}

function legacyPrincipal(request: Request): LegacyPrincipal {
  const token = cookieFromRequest(request, INTO_ACCESS_COOKIE_NAME);
  if (!isIntoAccessPasswordConfigured()) {
    if (testLegacyPrincipalEnabled) {
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
  const platform = [
    process.env.APP_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
    process.env.VERCEL_BRANCH_URL,
    process.env.VERCEL_URL,
  ].map((origin) => origin?.trim())
    .filter((origin): origin is string => Boolean(origin))
    .map((origin) => /^https?:\/\//i.test(origin) ? origin : `https://${origin}`);
  const url = new URL(request.url);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  const trusted = [...configured, ...platform];
  const source = trusted.length ? trusted : local || testLegacyPrincipalEnabled ? [url.origin] : [];
  return new Set(source.flatMap((origin) => {
    try {
      return [new URL(origin).origin];
    } catch {
      return [];
    }
  }));
}

export function requireSameOrigin(request: Request) {
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
