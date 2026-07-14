import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const INTO_ACCESS_COOKIE_NAME = "into_access_session";
export const INTO_ACCESS_SESSION_SECONDS = 12 * 60 * 60;

function configuredPassword() {
  return process.env.INTO_ACCESS_PASSWORD ?? "";
}

function hash(value: string) {
  return createHash("sha256").update(value).digest();
}

function sessionSignature(expiresAt: string, password: string) {
  return createHmac("sha256", password)
    .update(`INTO access:${expiresAt}`)
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
  return `${expiresAt}.${sessionSignature(expiresAt, password)}`;
}

export function verifyIntoAccessSession(
  session: string | null | undefined,
  now = Date.now()
) {
  const password = configuredPassword();
  if (!password || !session) {
    return false;
  }

  const [expiresAt, signature, extra] = session.split(".");
  const expiresAtSeconds = Number(expiresAt);
  if (
    !expiresAt ||
    !signature ||
    extra !== undefined ||
    !Number.isSafeInteger(expiresAtSeconds) ||
    expiresAtSeconds <= Math.floor(now / 1_000)
  ) {
    return false;
  }

  const expected = Buffer.from(sessionSignature(expiresAt, password));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
