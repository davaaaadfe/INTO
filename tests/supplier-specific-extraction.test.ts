import assert from "node:assert/strict";
import test from "node:test";
import { emptyExtractedInvoiceData, type BookingLearningStore } from "../lib/domain/invoice";
import { structuralFormat } from "../lib/services/supplier-format-clustering";
import {
  applySupplierCandidateEvidence,
  recordSupplierCandidateApplication,
  recordSupplierCandidateOutcome,
  recordSupplierValidationOutcome,
  supplierExtractionContext,
} from "../lib/services/supplier-specific-extraction";
import { createInitialLearningStore } from "../lib/services/purchase-journal-intelligence";

test("supplier extraction selects only the closest active-generation cluster", () => {
  const layout = structuralFormat("Invoice number: A-1\nTotal: EUR 10.00");
  const learning: BookingLearningStore = {
    ...createInitialLearningStore(),
    supplierProfiles: [{
      supplierAccountId: "supplier-a",
      generation: 2,
      exampleCount: 1,
      formatDrift: "none",
    }],
    supplierExamples: [{
      supplierAccountId: "supplier-a",
      generation: 2,
      invoiceId: "invoice-a",
      contentHash: "hash-a",
      formatFingerprint: layout.fingerprint,
      formatSignature: layout.signature,
      formatCluster: "cluster-a",
      learnedAt: "2026-08-17T10:00:00.000Z",
      trustState: "trusted",
    }],
    supplierPatterns: [
      {
        supplierAccountId: "supplier-a",
        generation: 1,
        formatCluster: "cluster-a",
        field: "referenceCode",
        key: "old",
        successes: 10,
        attempts: 10,
        weight: 10,
      },
      {
        supplierAccountId: "supplier-a",
        generation: 2,
        formatCluster: "cluster-a",
        field: "referenceCode",
        key: "active",
        successes: 1,
        attempts: 1,
        weight: 1,
        active: true,
      },
    ],
  };

  const context = supplierExtractionContext(
    learning,
    "supplier-a",
    "Invoice number: A-9\nTotal: EUR 99.00"
  );
  const unfamiliar = supplierExtractionContext(
    learning,
    "supplier-a",
    "Document reference: B-1\nAmount due: EUR 10.00\nIssued: 2026-08-17"
  );

  assert.equal(context?.clusterId, "cluster-a");
  assert.deepEqual(context?.patterns.map((pattern) => pattern.key), ["active"]);
  assert.equal(unfamiliar, null);
  learning.supplierProfiles[0]!.formatDrift = "confirmed";
  assert.equal(
    supplierExtractionContext(
      learning,
      "supplier-a",
      "Invoice number: A-9\nTotal: EUR 99.00"
    ),
    null
  );
});

test("supplier candidates retain provenance and only prefill in apply mode", () => {
  const data = {
    ...emptyExtractedInvoiceData(),
    referenceCode: "GENERIC-1",
    invoiceNumber: "GENERIC-1",
    documentAnalysis: {
      pages: [],
      fieldCandidates: [],
      confidence: 0.7,
      provider: { name: "local" },
      providerOutcome: { status: "succeeded" as const, adapter: "local" },
      sourceMode: "plain_text" as const,
    },
  };
  const candidate = {
    id: "learned-reference-a",
    field: "referenceCode",
    value: "LEARNED-9",
    normalizedValue: "LEARNED-9",
    rawValue: "LEARNED-9",
    label: "Invoice number",
    page: 1,
    polygon: [],
    confidence: 0.94,
    source: "supplier_learning",
    rule: "correction-a",
    model: "cluster-pattern-v1",
    supportingText: "Invoice number",
    clusterContext: { supplierAccountId: "supplier-a", generation: 2, clusterId: "cluster-a" },
  } as const;

  const observed = applySupplierCandidateEvidence(data, [candidate], "observe");
  const applied = applySupplierCandidateEvidence(data, [candidate], "apply");

  assert.equal(observed.data.referenceCode, "GENERIC-1");
  assert.equal(observed.appliedFields.length, 0);
  assert.equal(observed.data.documentAnalysis?.fieldCandidates.at(-1)?.source, "supplier_learning");
  assert.equal(applied.data.referenceCode, "LEARNED-9");
  assert.equal(applied.data.invoiceNumber, "LEARNED-9");
  assert.deepEqual(applied.appliedFields, ["referenceCode"]);
  assert.deepEqual(
    applied.data.documentAnalysis?.fieldCandidates.at(-1)?.clusterContext,
    candidate.clusterContext
  );
});

test("supplier candidate outcomes retain classifications without learned values", () => {
  const learning = createInitialLearningStore();
  const invoice = {
    id: "invoice-a",
    revision: 7,
  } as Parameters<typeof recordSupplierCandidateApplication>[1];
  const candidates = [
    {
      id: "learned-reference-a",
      field: "referenceCode",
      value: "SECRET-REFERENCE",
      polygon: [],
      confidence: 0.94,
      source: "supplier_learning",
      clusterContext: {
        supplierAccountId: "supplier-a",
        generation: 2,
        clusterId: "cluster-a",
      },
    },
    {
      id: "learned-total-a",
      field: "grossAmount",
      value: 1234.56,
      polygon: [],
      confidence: 0.93,
      source: "supplier_learning",
      clusterContext: {
        supplierAccountId: "supplier-a",
        generation: 2,
        clusterId: "cluster-a",
      },
    },
  ];

  recordSupplierCandidateApplication(
    learning,
    invoice,
    candidates,
    "2026-08-17T10:00:00.000Z"
  );
  recordSupplierCandidateApplication(
    learning,
    invoice,
    candidates,
    "2026-08-17T10:00:30.000Z"
  );
  recordSupplierValidationOutcome(
    learning,
    invoice,
    false,
    2,
    "2026-08-17T10:01:00.000Z"
  );
  recordSupplierCandidateOutcome(
    learning,
    invoice,
    ["grossAmount"],
    "2026-08-17T10:01:00.000Z"
  );

  assert.deepEqual(
    learning.supplierOutcomeEvents?.map((event) => event.type),
    ["application", "validation", "correction", "acceptance"]
  );
  assert.equal(invoice.supplierLearningApplication, undefined);
  assert.deepEqual(learning.supplierOutcomeEvents?.[2]?.fields, ["grossAmount"]);
  assert.deepEqual(learning.supplierOutcomeEvents?.[3]?.fields, ["referenceCode"]);
  assert.deepEqual(learning.supplierOutcomeEvents?.[1]?.validation, {
    passed: false,
    issueCount: 2,
  });
  assert.doesNotMatch(JSON.stringify(learning.supplierOutcomeEvents), /SECRET|1234/);
});

test("needs-review classifies every pending supplier candidate as rejected", () => {
  const learning = createInitialLearningStore();
  const invoice = {
    id: "invoice-b",
    revision: 3,
  } as Parameters<typeof recordSupplierCandidateApplication>[1];
  recordSupplierCandidateApplication(
    learning,
    invoice,
    [{
      id: "learned-date-b",
      field: "invoiceDate",
      clusterContext: {
        supplierAccountId: "supplier-b",
        generation: 4,
        clusterId: "cluster-b",
      },
    }],
    "2026-08-17T10:00:00.000Z"
  );

  recordSupplierCandidateOutcome(
    learning,
    invoice,
    "rejection",
    "2026-08-17T10:02:00.000Z"
  );

  assert.equal(learning.supplierOutcomeEvents?.at(-1)?.type, "rejection");
  assert.deepEqual(learning.supplierOutcomeEvents?.at(-1)?.fields, ["invoiceDate"]);
});
