import assert from "node:assert/strict";
import test from "node:test";
import { supplierResolutionShadowTelemetry } from "../lib/services/supplier-resolution-telemetry";

test("shadow resolver telemetry hashes candidate identity and exposes only gate outcomes", () => {
  const detail = supplierResolutionShadowTelemetry({
    selectedAccountId: undefined,
    matchConfidence: 0.99,
    threshold: 0.9,
    method: "No match",
    reviewRequired: true,
    candidates: [],
    reasoning: [],
    shadowEvaluation: {
      selectedAccountId: "supplier-sensitive-id",
      matchConfidence: 0.97,
      reviewRequired: false,
    },
  });

  assert.deepEqual(detail, {
    policyVersion: "supplier-resolution-v2.1",
    candidateRef: "0a5a44d42930e134",
    eligible: true,
    matchConfidence: 0.97,
    manualReason: null,
  });
  assert.doesNotMatch(JSON.stringify(detail), /supplier-sensitive-id/);
});

test("shadow resolver telemetry is absent when shadow mode did not run", () => {
  assert.equal(
    supplierResolutionShadowTelemetry({
      selectedAccountId: undefined,
      matchConfidence: 0,
      threshold: 0.9,
      method: "No match",
      reviewRequired: true,
      candidates: [],
      reasoning: [],
    }),
    null
  );
});
