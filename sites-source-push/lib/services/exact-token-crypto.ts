const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64UrlEncode(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(value: string) {
  const padded = value.padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
  const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function exactCryptoKey() {
  const secret =
    process.env.OAUTH_TOKEN_ENCRYPTION_KEY || process.env.EXACT_TOKEN_ENCRYPTION_KEY;
  if (!secret) {
    throw new Error(
      "OAUTH_TOKEN_ENCRYPTION_KEY or EXACT_TOKEN_ENCRYPTION_KEY is required for real OAuth token storage."
    );
  }

  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptExactSecret(value: string) {
  const key = await exactCryptoKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(value)
  );

  return `v1.${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(encrypted))}`;
}

export const encryptOAuthSecret = encryptExactSecret;

export async function decryptExactSecret(value: string) {
  if (value.startsWith("mock-")) {
    return value;
  }

  const [version, iv, encrypted] = value.split(".");
  if (version !== "v1" || !iv || !encrypted) {
    throw new Error("Stored Exact Online token is not in a supported format.");
  }

  const key = await exactCryptoKey();
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlDecode(iv) },
    key,
    base64UrlDecode(encrypted)
  );

  return decoder.decode(decrypted);
}

export const decryptOAuthSecret = decryptExactSecret;

export async function signExactState(payload: string) {
  const secret =
    process.env.OAUTH_STATE_SECRET ||
    process.env.EXACT_OAUTH_STATE_SECRET ||
    process.env.OAUTH_TOKEN_ENCRYPTION_KEY ||
    process.env.EXACT_TOKEN_ENCRYPTION_KEY;
  if (!secret) {
    throw new Error(
      "OAUTH_STATE_SECRET, EXACT_OAUTH_STATE_SECRET, OAUTH_TOKEN_ENCRYPTION_KEY, or EXACT_TOKEN_ENCRYPTION_KEY is required for real OAuth."
    );
  }

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return base64UrlEncode(new Uint8Array(signature));
}

export function encodeExactStatePayload(payload: unknown) {
  return base64UrlEncode(encoder.encode(JSON.stringify(payload)));
}

export function decodeExactStatePayload<T>(value: string): T {
  return JSON.parse(decoder.decode(base64UrlDecode(value))) as T;
}
