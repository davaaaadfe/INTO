import assert from "node:assert/strict";
import test from "node:test";
import { logger } from "../lib/utils/logger";

test("structured logging drops sensitive metadata recursively", () => {
  const output: string[] = [];
  const original = console.error;
  console.error = (value?: unknown) => output.push(String(value));
  try {
    logger.error("privacy.boundary", {
      invoiceId: "invoice-safe-id",
      message: "supplier NL00BANK0123456789 failed for secret.pdf",
      fileName: "secret.pdf",
      nested: {
        contentHash: "raw-hash",
        outcome: "failed",
      },
    });
  } finally {
    console.error = original;
  }

  assert.equal(output.length, 1);
  const payload = JSON.parse(output[0] ?? "{}") as Record<string, unknown>;
  assert.equal(payload.invoiceId, "invoice-safe-id");
  assert.deepEqual(payload.nested, { outcome: "failed" });
  assert.doesNotMatch(output[0] ?? "", /NL00BANK|secret\.pdf|raw-hash/);
});
