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

async function learningArtifactKey() {
  const secret = process.env.LEARNING_ARTIFACT_ENCRYPTION_KEY?.trim();
  if (!secret) {
    throw new Error(
      "LEARNING_ARTIFACT_ENCRYPTION_KEY is required for persistent supplier learning."
    );
  }
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptLearningArtifact(
  plaintext: string,
  contentHash: string
) {
  const key = await learningArtifactKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: encoder.encode(contentHash),
    },
    key,
    encoder.encode(plaintext)
  );
  return `v1.${base64UrlEncode(iv)}.${base64UrlEncode(
    new Uint8Array(ciphertext)
  )}`;
}

export async function decryptLearningArtifact(
  value: string,
  contentHash: string
) {
  const [version, iv, ciphertext] = value.split(".");
  if (version !== "v1" || !iv || !ciphertext) {
    throw new Error("Learning artifact uses an unsupported encryption format.");
  }
  try {
    const key = await learningArtifactKey();
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64UrlDecode(iv),
        additionalData: encoder.encode(contentHash),
      },
      key,
      base64UrlDecode(ciphertext)
    );
    return decoder.decode(plaintext);
  } catch {
    throw new Error("Learning artifact could not be decrypted.");
  }
}
