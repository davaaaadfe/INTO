import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export const INTO_ACCESS_COOKIE_NAME = "into_access_session";
export const INTO_ACCESS_SESSION_SECONDS = 12 * 60 * 60;

function configuredPassword() {
  return process.env.INTO_ACCESS_PASSWORD ?? "";
}

function hash(value: string) {
  return createHash("sha256").update(value).digest();
}

function sessionSignature(
  expiresAt: string,
  sessionId: string,
  password: string
) {
  return createHmac("sha256", password)
    .update(`INTO access:${expiresAt}:${sessionId}`)
    .digest("base64url");
}

export function isIntoAccessPasswordConfigured() {
  return configuredPassword().length > 0;
}

export function verifyIntoAccessPassword(candidate: string) {
  const password = configuredPassword();
  if (!password) {
    return false;
  }

  return timingSafeEqual(hash(candidate), hash(password));
}

export function createIntoAccessSession(now = Date.now()) {
  const password = configuredPassword();
  if (!password) {
    throw new Error("INTO access password is not configured.");
  }

  const expiresAt = String(
    Math.floor(now / 1_000) + INTO_ACCESS_SESSION_SECONDS
  );
  const sessionId = randomBytes(24).toString("base64url");
  return `${expiresAt}.${sessionId}.${sessionSignature(
    expiresAt,
    sessionId,
    password
  )}`;
}

export function verifyIntoAccessSession(
  session: string | null | undefined,
  now = Date.now()
) {
  const password = configuredPassword();
  if (!password || !session) {
    return false;
  }

  const [expiresAt, sessionId, signature, extra] = session.split(".");
  const expiresAtSeconds = Number(expiresAt);
  if (
    !expiresAt ||
    !sessionId ||
    !signature ||
    extra !== undefined ||
    !Number.isSafeInteger(expiresAtSeconds) ||
    expiresAtSeconds <= Math.floor(now / 1_000)
  ) {
    return false;
  }

  const expected = Buffer.from(
    sessionSignature(expiresAt, sessionId, password)
  );
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function accessSessionCorrelationId(
  session: string | null | undefined,
  now = Date.now()
) {
  if (!verifyIntoAccessSession(session, now) || !session) {
    return "";
  }
  const sessionId = session.split(".")[1] ?? "";
  return `session_${createHash("sha256")
    .update(`INTO correlation:${sessionId}`)
    .digest("base64url")}`;
}

export function sessionCorrelationIdFromRequest(
  request: Request,
  now = Date.now()
) {
  const cookies = request.headers.get("cookie")?.split(";") ?? [];
  const raw = cookies
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(`${INTO_ACCESS_COOKIE_NAME}=`))
    ?.slice(INTO_ACCESS_COOKIE_NAME.length + 1);
  if (!raw) {
    return "";
  }
  try {
    return accessSessionCorrelationId(decodeURIComponent(raw), now);
  } catch {
    return "";
  }
}
