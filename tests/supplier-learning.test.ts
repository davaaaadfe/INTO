import assert from "node:assert/strict";
import test from "node:test";
import {
  INVOICE_STATUSES,
  SHARED_ACCESS_PERMISSIONS,
  type BookingLearningStore,
} from "../lib/domain/invoice";
import { createInitialLearningStore } from "../lib/services/purchase-journal-intelligence";
import {
  formatFingerprint,
  learnSupplierInvoice,
  resetSupplierLearning,
  supplierConfidence,
} from "../lib/services/supplier-learning";

const learnedAt = "2026-07-21T08:00:00.000Z";

function learn(
  learning: BookingLearningStore,
  supplierAccountId: string,
  contentHash: string,
  fingerprint = "format-a"
) {
  return learnSupplierInvoice(learning, {
    supplierAccountId,
    invoiceId: `invoice-${contentHash}`,
    contentHash,
    formatFingerprint: fingerprint,
    learnedAt,
  });
}

test("new supplier confidence starts at the 35% baseline", () => {
  assert.deepEqual(supplierConfidence(), {
    score: 35,
    band: "Low",
    baseline: 35,
    exampleCount: 0,
    volume: 0,
    quality: 0,
    driftPenalty: 0,
  });
});

test("trusted examples raise supplier confidence gradually", () => {
  let learning = createInitialLearningStore();
  const scores: number[] = [];

  for (let index = 1; index <= 3; index += 1) {
    learning = learn(learning, "supplier-a", `hash-${index}`);
    const profile = learning.supplierProfiles.find(
      (item) => item.supplierAccountId === "supplier-a"
    );
    scores.push(supplierConfidence(profile).score);
  }

  assert.deepEqual(scores, [49, 59, 66]);
  assert.equal(supplierConfidence(
    learning.supplierProfiles.find((item) => item.supplierAccountId === "supplier-a")
  ).band, "Medium");
});

test("supplier confidence uses only weighted metrics for the active supplier generation", () => {
  const profile = {
    supplierAccountId: "supplier-a",
    generation: 2,
    exampleCount: 4,
    formatDrift: "none" as const,
  };
  const confidence = supplierConfidence(profile, [
    {
      supplierAccountId: "supplier-a",
      generation: 2,
      key: "invoice-date",
      successes: 3,
      attempts: 4,
      weight: 2,
    },
    {
      supplierAccountId: "supplier-a",
      generation: 2,
      key: "total",
      successes: 1,
      attempts: 4,
      weight: 1,
    },
    {
      supplierAccountId: "supplier-b",
      generation: 2,
      key: "other-supplier",
      successes: 100,
      attempts: 100,
      weight: 100,
    },
    {
      supplierAccountId: "supplier-a",
      generation: 1,
      key: "old-generation",
      successes: 100,
      attempts: 100,
      weight: 100,
    },
  ]);

  assert.ok(Math.abs(confidence.quality - 5 / 9) < 1e-12);
  assert.equal(confidence.score, 59);
});

test("one content hash contributes only once per supplier generation", () => {
  const once = learn(createInitialLearningStore(), "supplier-a", "same-hash");
  const twice = learn(once, "supplier-a", "same-hash");

  assert.equal(twice.supplierExamples.length, 1);
  assert.equal(twice.supplierProfiles[0].exampleCount, 1);
  assert.equal(twice.supplierProfiles[0].lastLearnedAt, learnedAt);
});

test("learning and reset are isolated to one Exact supplier", () => {
  let learning = learn(createInitialLearningStore(), "supplier-a", "hash-a");
  learning = learn(learning, "supplier-b", "hash-b");
  learning = resetSupplierLearning(
    learning,
    "supplier-a",
    "2026-07-21T09:00:00.000Z"
  );

  const supplierA = learning.supplierProfiles.find(
    (item) => item.supplierAccountId === "supplier-a"
  );
  const supplierB = learning.supplierProfiles.find(
    (item) => item.supplierAccountId === "supplier-b"
  );
  assert.equal(supplierA?.generation, 2);
  assert.equal(supplierA?.exampleCount, 0);
  assert.equal(supplierB?.generation, 1);
  assert.equal(supplierB?.exampleCount, 1);
});

test("reset starts a new generation without deleting trusted history", () => {
  const first = learn(createInitialLearningStore(), "supplier-a", "same-hash");
  const reset = resetSupplierLearning(
    first,
    "supplier-a",
    "2026-07-21T09:00:00.000Z"
  );
  const relearned = learn(reset, "supplier-a", "same-hash");

  assert.deepEqual(
    relearned.supplierExamples.map((example) => example.generation),
    [1, 2]
  );
  assert.equal(relearned.supplierProfiles[0].exampleCount, 1);
});

test("format fingerprints ignore invoice literals and expose format drift", () => {
  const firstDocument = [
    "Invoice number INV-2026-001",
    "Invoice date 2026-07-01",
    "Total EUR 121.00",
  ].join("\n");
  const sameFormat = [
    "Invoice number INV-2026-999",
    "Invoice date 2026-07-20",
    "Total EUR 242.00",
  ].join("\n");
  const changedFormat = [
    "Document reference INV-2026-1000",
    "Amount due EUR 363.00",
    "Issued 2026-07-21",
  ].join("\n");

  assert.equal(formatFingerprint(firstDocument), formatFingerprint(sameFormat));
  assert.notEqual(formatFingerprint(firstDocument), formatFingerprint(changedFormat));

  let learning = learn(
    createInitialLearningStore(),
    "supplier-a",
    "hash-1",
    formatFingerprint(firstDocument)
  );
  learning = learn(
    learning,
    "supplier-a",
    "hash-2",
    formatFingerprint(changedFormat)
  );
  const profile = learning.supplierProfiles[0];

  assert.equal(profile.formatDrift, "possible");
  assert.equal(supplierConfidence(profile).driftPenalty, 10);
});

test("format fingerprints ignore alphabetic field values and line-item descriptions", () => {
  const firstDocument = [
    "Invoice number: INV-2026-001",
    "Description: Ergonomic office chairs",
    "Description | Quantity | Price",
    "Blue mesh chair | 2 | EUR 100.00",
    "Total: EUR 200.00",
  ].join("\n");
  const sameTemplate = [
    "Invoice number: BILL-2026-999",
    "Description: Annual cloud subscriptions",
    "Description | Quantity | Price",
    "Enterprise software license | 12 | EUR 500.00",
    "Total: EUR 6000.00",
  ].join("\n");
  const reorderedTemplate = [
    "Description: Annual cloud subscriptions",
    "Invoice number: BILL-2026-999",
    "Description | Quantity | Price",
    "Enterprise software license | 12 | EUR 500.00",
    "Total: EUR 6000.00",
  ].join("\n");

  assert.equal(formatFingerprint(firstDocument), formatFingerprint(sameTemplate));
  assert.notEqual(
    formatFingerprint(firstDocument),
    formatFingerprint(reorderedTemplate)
  );
});

test("shared learning types expose the approved status, permissions, and revision", () => {
  const learning = createInitialLearningStore();

  assert.ok(INVOICE_STATUSES.includes("Learned"));
  assert.ok(SHARED_ACCESS_PERMISSIONS.includes("train"));
  assert.ok(SHARED_ACCESS_PERMISSIONS.includes("manage_learning"));
  assert.equal(learning.revision, 1);
  assert.deepEqual(learning.supplierProfiles, []);
  assert.deepEqual(learning.supplierExamples, []);
  assert.deepEqual(learning.supplierPatterns, []);
});
