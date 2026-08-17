import assert from "node:assert/strict";
import test from "node:test";
import type { SupplierLearningExample } from "../lib/domain/invoice";
import {
  assignFormatCluster,
  structuralFormat,
} from "../lib/services/supplier-format-clustering";
import { rebuildSupplierPatterns } from "../lib/services/supplier-pattern-derivation";

test("structural clustering groups value changes and keeps legitimate layouts separate", () => {
  const first = structuralFormat([
    "Invoice number: INV-100",
    "Invoice date: 2026-08-01",
    "Description | Quantity | Price",
    "Chair | 2 | EUR 100.00",
    "Total: EUR 200.00",
  ].join("\n"));
  const sameLayout = structuralFormat([
    "Invoice number: INV-999",
    "Invoice date: 2026-08-17",
    "Description | Quantity | Price",
    "Cloud subscription | 12 | EUR 50.00",
    "Total: EUR 600.00",
  ].join("\n"));
  const secondLayout = structuralFormat([
    "Document reference: BILL-9",
    "Amount due: EUR 600.00",
    "Issued: 2026-08-17",
  ].join("\n"));

  const firstAssignment = assignFormatCluster(first.signature, []);
  const sameAssignment = assignFormatCluster(sameLayout.signature, [
    { id: firstAssignment.clusterId, signature: first.signature },
  ]);
  const secondAssignment = assignFormatCluster(secondLayout.signature, [
    { id: firstAssignment.clusterId, signature: first.signature },
  ]);

  assert.equal(first.fingerprint, sameLayout.fingerprint);
  assert.equal(sameAssignment.clusterId, firstAssignment.clusterId);
  assert.equal(sameAssignment.recognized, true);
  assert.notEqual(secondAssignment.clusterId, firstAssignment.clusterId);
  assert.equal(secondAssignment.recognized, false);
});

test("structural signatures bound OCR input before distance comparison", () => {
  const format = structuralFormat(
    Array.from({ length: 1_000 }, (_, index) => `Unlabelled OCR line ${index}`).join("\n")
  );

  assert.ok(format.signature.split("\n").length <= 256);
});

test("pattern rebuild is absolute, cluster-scoped, and ignores prior generations", () => {
  const example = (
    id: string,
    generation: number,
    cluster: string,
    referenceCode: string
  ): SupplierLearningExample => ({
    id,
    supplierAccountId: "supplier-a",
    generation,
    invoiceId: `invoice-${id}`,
    contentHash: `hash-${id}`,
    formatFingerprint: cluster,
    formatCluster: cluster,
    learnedAt: "2026-08-17T10:00:00.000Z",
    trustState: "trusted",
    active: true,
    originalExtractedData: { referenceCode: `${referenceCode}-original` } as never,
    finalExtractedData: { referenceCode } as never,
  });
  const examples = [
    example("old", 1, "cluster-old", "OLD"),
    example("a1", 2, "cluster-a", "A-1"),
    example("a2", 2, "cluster-a", "A-2"),
    example("b1", 2, "cluster-b", "B-1"),
  ];

  const first = rebuildSupplierPatterns("supplier-a", 2, examples);
  const replay = rebuildSupplierPatterns("supplier-a", 2, [...examples].reverse());

  assert.deepEqual(replay, first);
  assert.deepEqual(
    first.map((pattern) => [pattern.formatCluster, pattern.field, pattern.attempts]),
    [
      ["cluster-a", "referenceCode", 2],
      ["cluster-b", "referenceCode", 1],
    ]
  );
  assert.equal(first.some((pattern) => pattern.formatCluster === "cluster-old"), false);
});
