import assert from "node:assert/strict";
import test from "node:test";
import {
  INVOICE_STATUSES,
  type BookingLearningStore,
} from "../lib/domain/invoice";
import { createInitialLearningStore } from "../lib/services/purchase-journal-intelligence";
import {
  formatFingerprint,
  learnSupplierInvoice,
  resetSupplierLearning,
  structuralFormat,
  supplierReliability,
} from "../lib/services/supplier-learning";
import * as supplierLearning from "../lib/services/supplier-learning";

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

test("supplier learning exposes only the authoritative reliability formula", () => {
  assert.equal("supplierConfidence" in supplierLearning, false);
  assert.equal(supplierReliability().score, 35);
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

test("format fingerprints ignore invoice literals without treating a new layout as drift", () => {
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

  assert.equal(profile.formatDrift, "none");
  assert.equal(supplierReliability({ drift: profile.formatDrift }).driftPenalty, 0);
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
    "Office 365 subscription | 12 | EUR 500.00",
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

test("format fingerprints ignore the number of line items", () => {
  const twoItems = [
    "Invoice number: INV-2026-001",
    "Description | Quantity | Price",
    "Cloud subscription | 2 | EUR 100.00",
    "Support package | 1 | EUR 50.00",
    "Total: EUR 250.00",
  ].join("\n");
  const oneItem = [
    "Invoice number: INV-2026-002",
    "Description | Quantity | Price",
    "Software license | 3 | EUR 200.00",
    "Total: EUR 600.00",
  ].join("\n");
  const reorderedHeader = [
    "Invoice number: INV-2026-002",
    "Quantity | Description | Price",
    "3 | Software license | EUR 200.00",
    "Total: EUR 600.00",
  ].join("\n");

  assert.equal(formatFingerprint(twoItems), formatFingerprint(oneItem));
  assert.notEqual(formatFingerprint(twoItems), formatFingerprint(reorderedHeader));
});

test("learning assigns multiple format clusters and rebuilds active patterns absolutely", () => {
  const layoutA = structuralFormat("Invoice number: A-1\nTotal: EUR 10.00");
  const layoutB = structuralFormat("Document reference: B-1\nAmount due: EUR 20.00");
  const add = (
    learning: BookingLearningStore,
    id: string,
    layout: ReturnType<typeof structuralFormat>
  ) => learnSupplierInvoice(learning, {
    supplierAccountId: "supplier-clusters",
    invoiceId: `invoice-${id}`,
    contentHash: `hash-${id}`,
    formatFingerprint: layout.fingerprint,
    formatSignature: layout.signature,
    learnedAt,
    trustState: "trusted",
    originalExtractedData: { referenceCode: `${id}-old` } as never,
    finalExtractedData: { referenceCode: id } as never,
  });

  let learning = add(createInitialLearningStore(), "a1", layoutA);
  learning = add(learning, "a2", layoutA);
  learning = add(learning, "b1", layoutB);

  assert.equal(new Set(learning.supplierExamples.map((item) => item.formatCluster)).size, 2);
  assert.deepEqual(
    Object.fromEntries(
      learning.supplierPatterns.map((pattern) => [
        pattern.formatCluster,
        [pattern.field, pattern.attempts],
      ])
    ),
    {
      [learning.supplierExamples[0].formatCluster!]: ["referenceCode", 2],
      [learning.supplierExamples[2].formatCluster!]: ["referenceCode", 1],
    }
  );

  const reset = resetSupplierLearning(
    learning,
    "supplier-clusters",
    "2026-08-17T11:00:00.000Z"
  );
  const relearned = add(reset, "a3", layoutA);
  const activeGeneration = relearned.supplierProfiles[0].generation;
  assert.deepEqual(
    relearned.supplierPatterns.filter((pattern) => pattern.generation === activeGeneration),
    [
      {
        ...relearned.supplierPatterns.at(-1),
        generation: activeGeneration,
      },
    ]
  );
});

test("shared learning types expose the approved status and revision", () => {
  const learning = createInitialLearningStore();

  assert.ok(INVOICE_STATUSES.includes("Learned"));
  assert.equal(learning.revision, 1);
  assert.deepEqual(learning.supplierProfiles, []);
  assert.deepEqual(learning.supplierExamples, []);
  assert.deepEqual(learning.supplierPatterns, []);
});
