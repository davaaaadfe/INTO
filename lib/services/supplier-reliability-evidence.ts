import type { LearningExampleRecord } from "../repository/learning-repository";
import type {
  BookingLearningStore,
  SupplierLearningProfile,
} from "../domain/invoice";
import type {
  SupplierReliabilityExample,
  SupplierReliabilityOutcome,
} from "./supplier-reliability";

export type SupplierReliabilityEvidence = {
  examples: SupplierReliabilityExample[];
  outcomes: SupplierReliabilityOutcome[];
};

type UnknownRecord = Record<string, unknown>;
type Comparison = { observed: boolean; success: boolean };

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function extracted(value: unknown) {
  const payload = record(value);
  const nested = record(payload.extractedData);
  return Object.keys(nested).length ? nested : payload;
}

function known(value: unknown) {
  return (
    value !== undefined &&
    value !== null &&
    value !== "" &&
    (!Array.isArray(value) || value.length > 0)
  );
}

function same(left: unknown, right: unknown) {
  return typeof left === "number" && typeof right === "number"
    ? Math.abs(left - right) < 0.005
    : JSON.stringify(left) === JSON.stringify(right);
}

function compareFields(
  prediction: UnknownRecord,
  final: UnknownRecord,
  fields: readonly string[]
): Comparison {
  const pairs = fields
    .map((field) => [prediction[field], final[field]] as const)
    .filter(([left, right]) => known(left) && known(right));
  return {
    observed: pairs.length > 0,
    success: pairs.length > 0 && pairs.every(([left, right]) => same(left, right)),
  };
}

function firstKnown(source: UnknownRecord, fields: readonly string[]) {
  return fields.map((field) => source[field]).find(known);
}

function compareGroups(
  prediction: UnknownRecord,
  final: UnknownRecord,
  fields: readonly (readonly string[])[]
): Comparison {
  const pairs = fields
    .map((group) => [firstKnown(prediction, group), firstKnown(final, group)] as const)
    .filter(([left, right]) => known(left) && known(right));
  return {
    observed: pairs.length > 0,
    success: pairs.length > 0 && pairs.every(([left, right]) => same(left, right)),
  };
}

function combined(...items: Comparison[]): Comparison {
  const observed = items.filter((item) => item.observed);
  return {
    observed: observed.length > 0,
    success: observed.length > 0 && observed.every((item) => item.success),
  };
}

function nested(source: UnknownRecord, field: string) {
  return record(source[field]);
}

function lines(source: unknown, fallback?: unknown) {
  const payload = record(source);
  const candidates = [
    payload.bookingLines,
    nested(payload, "purchaseJournal").lines,
    nested(payload, "booking").lines,
    fallback,
  ];
  const selected = candidates.find(
    (candidate) => Array.isArray(candidate) && candidate.length > 0
  );
  return Array.isArray(selected) ? selected.map(record) : [];
}

function compareLines(
  prediction: UnknownRecord[],
  final: UnknownRecord[],
  fields: readonly (readonly string[])[]
): Comparison {
  if (!prediction.length || !final.length) {
    return { observed: false, success: false };
  }
  const comparisons = prediction
    .slice(0, Math.min(prediction.length, final.length))
    .map((line, index) => compareGroups(line, final[index], fields));
  const observed = comparisons.some((item) => item.observed);
  return {
    observed,
    success:
      observed &&
      prediction.length === final.length &&
      comparisons.filter((item) => item.observed).every((item) => item.success),
  };
}

function evidenceFor(item: LearningExampleRecord) {
  return item.trustState === "legacy" ||
    item.source === "legacy" ||
    item.trigger === "migration"
    ? ("legacy" as const)
    : ("trusted" as const);
}

function recordStrength(item: LearningExampleRecord) {
  const trigger = { migration: 0, learn: 1, review: 2, booking: 3 } as const;
  return (evidenceFor(item) === "trusted" ? 10 : 0) + trigger[item.trigger];
}

export function supplierReliabilityEvidenceFromExamples(
  records: readonly LearningExampleRecord[]
): SupplierReliabilityEvidence {
  const examples: SupplierReliabilityExample[] = [];
  const outcomes: SupplierReliabilityOutcome[] = [];
  const distinct = new Map<string, LearningExampleRecord>();

  for (const item of records) {
    if (!item.active || item.trustState === "pending" || !item.contentHash) continue;
    const current = distinct.get(item.contentHash);
    if (!current || recordStrength(item) > recordStrength(current)) {
      distinct.set(item.contentHash, item);
    }
  }

  for (const item of distinct.values()) {
    const evidence = evidenceFor(item);
    const context = {
      occurredAt: item.createdAt,
      evidence,
      trigger: item.trigger,
    } as const;
    const predictionPayload = record(item.originalPrediction);
    const finalPayload = record(item.finalFields);
    const prediction = extracted(predictionPayload);
    const final = extracted(finalPayload);
    const predictionLines = lines(predictionPayload);
    const finalLines = lines(finalPayload, item.bookingLines);
    const supplier = compareGroups(
      {
        accountId:
          nested(predictionPayload, "supplierResolution").selectedAccountId ??
          nested(predictionPayload, "supplier").accountId ??
          predictionPayload.supplierAccountId,
      },
      {
        accountId:
          nested(finalPayload, "supplierResolution").selectedAccountId ??
          nested(finalPayload, "supplier").accountId ??
          finalPayload.supplierAccountId ??
          item.supplierAccountId,
      },
      [["accountId"]]
    );
    const vat = combined(
      compareFields(prediction, final, ["vatAmount"]),
      compareLines(predictionLines, finalLines, [["vatCode"]])
    );
    const bookingSplit = compareLines(predictionLines, finalLines, [
      ["percentage"],
      ["amount"],
    ]);
    const accounting = combined(
      compareGroups(prediction, final, [
        ["dueDate"],
        ["paymentConditionCode", "paymentTerms"],
        ["expenseDescription", "description"],
        ["serviceStartDate", "accrualFrom"],
        ["serviceEndDate", "accrualTo"],
      ]),
      compareLines(predictionLines, finalLines, [
        ["finalSelectedAccount", "glAccount", "suggestedGlAccount"],
        ["costCentre", "costCenter"],
        ["costUnit"],
        ["description"],
        ["from", "benefitStartDate", "accrualFrom"],
        ["to", "benefitEndDate", "accrualTo"],
      ])
    );
    const duplicateDecision = compareGroups(predictionPayload, finalPayload, [
      ["duplicateDecision", "duplicateResolutionDecision"],
    ]);
    const comparisons = [
      ["supplier_match", supplier],
      ["your_ref", compareFields(prediction, final, ["referenceCode"])],
      ["invoice_date", compareFields(prediction, final, ["invoiceDate"])],
      [
        "amounts",
        compareFields(prediction, final, ["netAmount", "vatAmount", "grossAmount"]),
      ],
      ["vat", vat],
      ["booking_split", bookingSplit],
      ["accounting", accounting],
    ] as const;

    examples.push({
      contentHash: item.contentHash,
      trustState: evidence,
      trigger: item.trigger,
    });
    for (const [metric, comparison] of comparisons) {
      if (comparison.observed) {
        outcomes.push({ metric, success: comparison.success, ...context });
      }
    }
    const validationResult = record(item.validationResult);
    const validation = validationResult.valid;
    if (
      typeof validation === "boolean" &&
      validationResult.status !== "infrastructure"
    ) {
      outcomes.push({ metric: "validation", success: validation, ...context });
    }
    const corrections = record(item.finalFields).corrections;
    if (Array.isArray(corrections)) {
      outcomes.push({
        metric: "inverse_correction",
        success: corrections.length === 0,
        ...context,
      });
    } else {
      const observedComparisons = [
        ...comparisons.map(([, comparison]) => comparison),
        duplicateDecision,
      ].filter((comparison) => comparison.observed);
      if (observedComparisons.length) {
        outcomes.push({
          metric: "inverse_correction",
          success: observedComparisons.every((comparison) => comparison.success),
          ...context,
        });
      }
    }
    if (duplicateDecision.observed) {
      outcomes.push({
        metric: "duplicate_decision",
        success: duplicateDecision.success,
        ...context,
      });
    }
  }

  return { examples, outcomes };
}

export function supplierReliabilityEvidenceFromLearningStore(
  learning: BookingLearningStore,
  profile: SupplierLearningProfile
) {
  const records: LearningExampleRecord[] = learning.supplierExamples
    .filter(
      (example) =>
        example.supplierAccountId === profile.supplierAccountId &&
        example.generation === profile.generation
    )
    .map((example) => {
      const trustState =
        example.trustState ?? (example.source ? "trusted" : "legacy");
      const source =
        example.source ?? (trustState === "legacy" ? "legacy" : "explicit_learn");
      const trigger =
        example.trigger ?? (trustState === "legacy" ? "migration" : "learn");
      return {
        id: example.id ?? `runtime:${example.invoiceId}:${example.contentHash}`,
        companyId: "runtime",
        divisionCode: "runtime",
        supplierAccountId: example.supplierAccountId,
        generation: example.generation,
        invoiceId: example.invoiceId,
        contentHash: example.contentHash,
        originalFilename: "runtime",
        originalPrediction: {
          extractedData: example.originalExtractedData ?? {},
          bookingLines: example.originalBookingLines ?? [],
          supplierResolution: example.originalSupplierAccountId
            ? { selectedAccountId: example.originalSupplierAccountId }
            : undefined,
        },
        finalFields: {
          extractedData: example.finalExtractedData ?? {},
          supplierAccountId: example.supplierAccountId,
          corrections: learning.corrections.filter(
            (correction) =>
              correction.invoiceId === example.invoiceId &&
              correction.trustState !== "pending"
          ),
        },
        bookingLines: example.bookingLines ?? [],
        fingerprint: example.formatFingerprint,
        fingerprintVersion: "layout-v1",
        validationResult: example.validationResult ?? {},
        processingPurpose: example.processingPurpose ?? "learning_only",
        source,
        trustState,
        trigger,
        actorId: example.learnedByUserId ?? "shared_user",
        sessionCorrelationId: "runtime",
        requestId: example.id ?? example.contentHash,
        createdAt: example.learnedAt,
        active: example.active ?? true,
      };
    });
  return supplierReliabilityEvidenceFromExamples(records);
}
