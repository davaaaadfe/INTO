import assert from "node:assert/strict";
import test from "node:test";
import type { SupplierLearningOutcomeEvent } from "../lib/domain/invoice";
import {
  SUPPLIER_DRIFT_POLICY,
  deriveSupplierDrift,
} from "../lib/services/supplier-drift";

function event(
  id: string,
  type: SupplierLearningOutcomeEvent["type"],
  generation = 2
): SupplierLearningOutcomeEvent {
  return {
    id,
    supplierAccountId: "supplier-a",
    generation,
    invoiceId: `invoice-${id}`,
    invoiceRevision: 1,
    type,
    candidateIds: [],
    fields: ["referenceCode"],
    createdAt: "2026-08-17T10:00:00.000Z",
  };
}

test("drift requires repeated adverse outcomes and ignores novelty alone", () => {
  assert.deepEqual(SUPPLIER_DRIFT_POLICY, {
    version: "supplier-drift-v1",
    possible: { minimumEvaluated: 3, minimumAdverse: 2, adverseRate: 0.4 },
    confirmed: { minimumEvaluated: 5, minimumAdverse: 3, adverseRate: 0.6 },
  });
  assert.equal(deriveSupplierDrift({
    events: [event("application", "application")],
    supplierAccountId: "supplier-a",
    generation: 2,
  }).state, "none");
  assert.equal(deriveSupplierDrift({
    events: [
      event("correction-1", "correction"),
      event("acceptance-1", "acceptance"),
    ],
    supplierAccountId: "supplier-a",
    generation: 2,
  }).state, "none");
});

test("outcome drift transitions conservatively and stays generation scoped", () => {
  const possible = deriveSupplierDrift({
    events: [
      event("correction-1", "correction"),
      event("correction-2", "correction"),
      event("acceptance-1", "acceptance"),
      event("old-correction", "correction", 1),
    ],
    supplierAccountId: "supplier-a",
    generation: 2,
  });
  assert.deepEqual(possible, {
    state: "possible",
    policyVersion: "supplier-drift-v1",
    evaluatedCount: 3,
    adverseCount: 2,
    adverseRate: 2 / 3,
  });

  const confirmed = deriveSupplierDrift({
    events: [
      event("correction-1", "correction"),
      event("correction-2", "correction"),
      event("rejection-1", "rejection"),
      event("acceptance-1", "acceptance"),
      event("acceptance-2", "acceptance"),
    ],
    supplierAccountId: "supplier-a",
    generation: 2,
  });
  assert.equal(confirmed.state, "confirmed");
  assert.equal(confirmed.adverseRate, 0.6);
});
