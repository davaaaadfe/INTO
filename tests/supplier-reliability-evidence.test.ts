import assert from "node:assert/strict";
import test from "node:test";
import type { LearningExampleRecord } from "../lib/repository/learning-repository";
import type { BookingLearningStore } from "../lib/domain/invoice";
import * as supplierLearning from "../lib/services/supplier-learning";

const occurredAt = "2026-07-21T09:00:00.000Z";

function record(
  overrides: Partial<LearningExampleRecord> = {}
): LearningExampleRecord {
  return {
    id: "example-1",
    companyId: "into",
    divisionCode: "division-1",
    supplierAccountId: "supplier-a",
    generation: 1,
    invoiceId: "invoice-1",
    contentHash: "hash-1",
    originalFilename: "invoice.pdf",
    originalPrediction: {},
    finalFields: {},
    bookingLines: [],
    fingerprint: "format-1",
    fingerprintVersion: "layout-v1",
    validationResult: {},
    processingPurpose: "booking",
    source: "review",
    trustState: "trusted",
    trigger: "review",
    actorId: "shared_user",
    sessionCorrelationId: "session-1",
    requestId: "request-1",
    createdAt: occurredAt,
    active: true,
    ...overrides,
  };
}

test("turns an unchanged reviewed example into successful reliability evidence", () => {
  const derive = (
    supplierLearning as typeof supplierLearning & {
      supplierReliabilityEvidenceFromExamples?: (
        examples: readonly LearningExampleRecord[]
      ) => unknown;
    }
  ).supplierReliabilityEvidenceFromExamples;

  assert.deepEqual(
    derive?.([
      record({
        originalPrediction: {
          referenceCode: "INV-100",
          invoiceDate: "2026-07-01",
          netAmount: 100,
          vatAmount: 21,
          grossAmount: 121,
        },
        finalFields: {
          extractedData: {
            referenceCode: "INV-100",
            invoiceDate: "2026-07-01",
            netAmount: 100,
            vatAmount: 21,
            grossAmount: 121,
          },
          corrections: [],
        },
        validationResult: { valid: true },
      }),
    ]),
    {
      examples: [
        {
          contentHash: "hash-1",
          trustState: "trusted",
          trigger: "review",
        },
      ],
      outcomes: [
        {
          metric: "your_ref",
          success: true,
          occurredAt,
          evidence: "trusted",
          trigger: "review",
        },
        {
          metric: "invoice_date",
          success: true,
          occurredAt,
          evidence: "trusted",
          trigger: "review",
        },
        {
          metric: "amounts",
          success: true,
          occurredAt,
          evidence: "trusted",
          trigger: "review",
        },
        {
          metric: "vat",
          success: true,
          occurredAt,
          evidence: "trusted",
          trigger: "review",
        },
        {
          metric: "validation",
          success: true,
          occurredAt,
          evidence: "trusted",
          trigger: "review",
        },
        {
          metric: "inverse_correction",
          success: true,
          occurredAt,
          evidence: "trusted",
          trigger: "review",
        },
      ],
    }
  );
});

test("counts corrections as failures while omitting unknown and infrastructure outcomes", () => {
  assert.deepEqual(
    supplierLearning.supplierReliabilityEvidenceFromExamples([
      record({
        trigger: "learn",
        source: "explicit_learn",
        originalPrediction: {
          referenceCode: "INV-WRONG",
          invoiceDate: "2026-07-01",
          netAmount: null,
        },
        finalFields: {
          extractedData: {
            referenceCode: "INV-200",
            invoiceDate: "",
            netAmount: 100,
          },
          corrections: [{ field: "yourRefPattern" }],
        },
        validationResult: { valid: false, status: "infrastructure" },
      }),
    ]),
    {
      examples: [
        {
          contentHash: "hash-1",
          trustState: "trusted",
          trigger: "learn",
        },
      ],
      outcomes: [
        {
          metric: "your_ref",
          success: false,
          occurredAt,
          evidence: "trusted",
          trigger: "learn",
        },
        {
          metric: "inverse_correction",
          success: false,
          occurredAt,
          evidence: "trusted",
          trigger: "learn",
        },
      ],
    }
  );
});

test("deduplicates content hashes, skips untrusted records, and preserves legacy weight", () => {
  const evidence = supplierLearning.supplierReliabilityEvidenceFromExamples([
    record({
      id: "legacy-duplicate",
      trustState: "legacy",
      source: "legacy",
      trigger: "migration",
    }),
    record({
      id: "trusted-duplicate",
      source: "booking",
      trigger: "booking",
    }),
    record({
      id: "pending",
      contentHash: "hash-pending",
      trustState: "pending",
    }),
    record({ id: "inactive", contentHash: "hash-inactive", active: false }),
    record({
      id: "legacy-source",
      contentHash: "hash-legacy",
      source: "legacy",
      trigger: "migration",
      trustState: "trusted",
    }),
  ]);

  assert.deepEqual(evidence, {
    examples: [
      {
        contentHash: "hash-1",
        trustState: "trusted",
        trigger: "booking",
      },
      {
        contentHash: "hash-legacy",
        trustState: "legacy",
        trigger: "migration",
      },
    ],
    outcomes: [],
  });
});

test("derives supplier, booking, accounting, and duplicate outcomes from a booked example", () => {
  const line = {
    percentage: 100,
    amount: 100,
    vatAmount: 21,
    vatCode: "4",
    finalSelectedAccount: "4420",
    costCentre: "OPS",
    costUnit: "NL",
    description: "Office supplies",
    from: "2026-07-01",
    to: "2026-07-31",
  };
  const result = supplierLearning.supplierReliabilityEvidenceFromExamples([
    record({
      source: "booking",
      trigger: "booking",
      originalPrediction: {
        supplierResolution: { selectedAccountId: "supplier-a" },
        extractedData: {
          vatAmount: 21,
          dueDate: "2026-07-31",
          paymentTerms: "30 days",
          expenseDescription: "Office supplies",
          serviceStartDate: "2026-07-01",
          serviceEndDate: "2026-07-31",
        },
        bookingLines: [line],
        duplicateDecision: "continue_anyway",
      },
      finalFields: {
        supplierAccountId: "supplier-a",
        extractedData: {
          vatAmount: 21,
          dueDate: "2026-07-31",
          paymentTerms: "30 days",
          expenseDescription: "Office supplies",
          serviceStartDate: "2026-07-01",
          serviceEndDate: "2026-07-31",
        },
        duplicateDecision: "continue_anyway",
        corrections: [],
      },
      bookingLines: [line],
      validationResult: { valid: true },
    }),
  ]);

  assert.deepEqual(
    Object.fromEntries(result.outcomes.map((outcome) => [outcome.metric, outcome.success])),
    {
      supplier_match: true,
      amounts: true,
      vat: true,
      booking_split: true,
      accounting: true,
      validation: true,
      inverse_correction: true,
      duplicate_decision: true,
    }
  );
  assert.ok(result.outcomes.every((outcome) => outcome.trigger === "booking"));
});

test("uses immutable line deltas for corrections when correction metadata is absent", () => {
  const result = supplierLearning.supplierReliabilityEvidenceFromExamples([
    record({
      originalPrediction: {
        bookingLines: [
          {
            percentage: 100,
            amount: 100,
            vatCode: "4",
            finalSelectedAccount: "4420",
          },
        ],
      },
      finalFields: {},
      bookingLines: [
        {
          percentage: 60,
          amount: 60,
          vatCode: "6",
          finalSelectedAccount: "4430",
        },
        {
          percentage: 40,
          amount: 40,
          vatCode: "6",
          finalSelectedAccount: "4440",
        },
      ],
    }),
  ]);

  assert.deepEqual(
    Object.fromEntries(result.outcomes.map((outcome) => [outcome.metric, outcome.success])),
    {
      vat: false,
      booking_split: false,
      accounting: false,
      inverse_correction: false,
    }
  );
});

test("derives the same evidence from the active runtime supplier generation", () => {
  const learning: BookingLearningStore = {
    revision: 1,
    supplierProfiles: [
      {
        supplierAccountId: "supplier-a",
        generation: 2,
        exampleCount: 1,
        formatDrift: "none",
      },
    ],
    supplierExamples: [
      {
        id: "runtime-example",
        supplierAccountId: "supplier-a",
        generation: 2,
        invoiceId: "runtime-invoice",
        contentHash: "runtime-hash",
        formatFingerprint: "format-a",
        learnedAt: occurredAt,
        originalExtractedData: { referenceCode: "WRONG" } as never,
        finalExtractedData: { referenceCode: "FINAL" } as never,
        source: "explicit_learn",
        trustState: "trusted",
        trigger: "learn",
        validationResult: { valid: true },
        active: true,
      },
    ],
    supplierPatterns: [],
    supplierSelections: [],
    glAccountSelections: [],
    vatCodeSelections: [],
    costCentreSelections: [],
    costUnitSelections: [],
    corrections: [
      {
        id: "runtime-correction",
        invoiceId: "runtime-invoice",
        field: "yourRefPattern",
        supplierIdentity: "name:supplier-a",
        supplierName: "Supplier A",
        supplierAccountId: "supplier-a",
        matchKey: "reference",
        originalValue: "WRONG",
        correctedValue: "FINAL",
        confidence: 0.8,
        confidenceBefore: 0.5,
        confidenceAfter: 0.8,
        correctedAt: occurredAt,
        correctedByUserId: "shared_user",
        correctedByUserName: "Shared user",
        trustState: "trusted",
      },
    ],
  };

  const evidence = supplierLearning.supplierReliabilityEvidenceFromLearningStore(
    learning,
    learning.supplierProfiles[0]!
  );
  assert.deepEqual(
    evidence.outcomes.map(({ metric, success }) => ({ metric, success })),
    [
      { metric: "your_ref", success: false },
      { metric: "validation", success: true },
      { metric: "inverse_correction", success: false },
    ]
  );
});

test("active normalized candidate outcomes contribute reliability without values", () => {
  const learning: BookingLearningStore = {
    revision: 1,
    supplierProfiles: [{
      supplierAccountId: "supplier-a",
      generation: 2,
      exampleCount: 0,
      formatDrift: "none",
    }],
    supplierExamples: [],
    supplierPatterns: [],
    supplierSelections: [],
    glAccountSelections: [],
    vatCodeSelections: [],
    costCentreSelections: [],
    costUnitSelections: [],
    corrections: [],
    supplierOutcomeEvents: [
      {
        id: "accepted-reference",
        supplierAccountId: "supplier-a",
        generation: 2,
        invoiceId: "invoice-a",
        invoiceRevision: 3,
        type: "acceptance",
        candidateIds: [],
        fields: ["referenceCode"],
        createdAt: occurredAt,
      },
      {
        id: "corrected-date-and-total",
        supplierAccountId: "supplier-a",
        generation: 2,
        invoiceId: "invoice-b",
        invoiceRevision: 4,
        type: "correction",
        candidateIds: [],
        fields: ["invoiceDate", "grossAmount"],
        createdAt: occurredAt,
      },
      {
        id: "validated",
        supplierAccountId: "supplier-a",
        generation: 2,
        invoiceId: "invoice-b",
        invoiceRevision: 4,
        type: "validation",
        candidateIds: [],
        fields: [],
        validation: { passed: false, issueCount: 2 },
        createdAt: occurredAt,
      },
      {
        id: "ignored-application",
        supplierAccountId: "supplier-a",
        generation: 2,
        invoiceId: "invoice-c",
        invoiceRevision: 1,
        type: "application",
        candidateIds: [],
        fields: ["referenceCode"],
        createdAt: occurredAt,
      },
      {
        id: "ignored-old-generation",
        supplierAccountId: "supplier-a",
        generation: 1,
        invoiceId: "invoice-old",
        invoiceRevision: 1,
        type: "rejection",
        candidateIds: [],
        fields: ["referenceCode"],
        createdAt: occurredAt,
      },
    ],
  };

  const evidence = supplierLearning.supplierReliabilityEvidenceFromLearningStore(
    learning,
    learning.supplierProfiles[0]!
  );
  assert.deepEqual(
    evidence.outcomes.map(({ metric, success }) => ({ metric, success })),
    [
      { metric: "your_ref", success: true },
      { metric: "inverse_correction", success: true },
      { metric: "invoice_date", success: false },
      { metric: "amounts", success: false },
      { metric: "inverse_correction", success: false },
      { metric: "validation", success: false },
    ]
  );
});
