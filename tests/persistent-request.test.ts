import test from "node:test";
import assert from "node:assert/strict";
import { withPersistentStore } from "../lib/repository/persistent-request";

test("unhandled API failures return a JSON response", async () => {
  const previousMode = process.env.DATABASE_MODE;
  process.env.DATABASE_MODE = "memory";

  try {
    const outcome = await withPersistentStore(() => {
      throw new Error("internal implementation detail");
    }).then(
      (response) => ({ response }),
      (error: unknown) => ({ error })
    );

    assert.equal("error" in outcome, false);
    const response = "response" in outcome ? outcome.response : undefined;
    assert.ok(response instanceof Response);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: "INTO could not complete the request. Please try again.",
    });
  } finally {
    if (previousMode === undefined) delete process.env.DATABASE_MODE;
    else process.env.DATABASE_MODE = previousMode;
  }
});

test("missing learning encryption configuration returns an actionable error", async () => {
  const previousMode = process.env.DATABASE_MODE;
  process.env.DATABASE_MODE = "memory";

  try {
    const response = await withPersistentStore(() => {
      throw new Error(
        "LEARNING_ARTIFACT_ENCRYPTION_KEY is required for persistent supplier learning."
      );
    });

    assert.ok(response instanceof Response);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error:
        "Supplier learning storage is not configured. Add LEARNING_ARTIFACT_ENCRYPTION_KEY and redeploy.",
    });
  } finally {
    if (previousMode === undefined) delete process.env.DATABASE_MODE;
    else process.env.DATABASE_MODE = previousMode;
  }
});
