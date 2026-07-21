import test from "node:test";
import assert from "node:assert/strict";
import {
  decryptLearningArtifact,
  encryptLearningArtifact,
} from "../lib/services/learning-artifact-crypto";

async function withArtifactKey(
  value: string | undefined,
  run: () => Promise<void>
) {
  const previous = process.env.LEARNING_ARTIFACT_ENCRYPTION_KEY;
  if (value === undefined) {
    delete process.env.LEARNING_ARTIFACT_ENCRYPTION_KEY;
  } else {
    process.env.LEARNING_ARTIFACT_ENCRYPTION_KEY = value;
  }
  try {
    await run();
  } finally {
    if (previous === undefined) {
      delete process.env.LEARNING_ARTIFACT_ENCRYPTION_KEY;
    } else {
      process.env.LEARNING_ARTIFACT_ENCRYPTION_KEY = previous;
    }
  }
}

test("learning artifacts require their own encryption key", async () => {
  await withArtifactKey(undefined, async () => {
    process.env.OAUTH_TOKEN_ENCRYPTION_KEY = "must-not-be-reused";
    try {
      await assert.rejects(
        encryptLearningArtifact("invoice text", "sha256:abc"),
        /LEARNING_ARTIFACT_ENCRYPTION_KEY/
      );
    } finally {
      delete process.env.OAUTH_TOKEN_ENCRYPTION_KEY;
    }
  });
});

test("learning artifacts round-trip without exposing plaintext", async () => {
  await withArtifactKey("artifact-test-key", async () => {
    const plaintext = "Sensitive supplier invoice text";
    const encrypted = await encryptLearningArtifact(plaintext, "sha256:abc");

    assert.match(encrypted, /^v1\./);
    assert.doesNotMatch(encrypted, /Sensitive|supplier|invoice/);
    assert.equal(
      await decryptLearningArtifact(encrypted, "sha256:abc"),
      plaintext
    );
    await assert.rejects(
      decryptLearningArtifact(encrypted, "sha256:different"),
      /could not be decrypted/i
    );
  });
});
