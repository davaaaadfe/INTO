export type LearningEvaluationValue = string | number | boolean | null;

export type LearningEvaluationBookingLine = {
  glAccount: string;
  vatCode: string;
  percentage: number;
  amount: number;
};

export type SupplierSelectionOutcome =
  | "manual_selection"
  | "shadow_recommendation"
  | "eligible_automatic_selection"
  | "override";

export const LEARNING_PRODUCTION_EVALUATION_GATE = Object.freeze({
  enabled: false,
  minimumPrecision: 0.995,
  minimumLowerConfidenceBound: 0.99,
  minimumEligibleDecisions: 500,
  minimumSuppliers: 50,
});

export type LearningEvaluationResult = {
  supplierAccountId: string | null;
  fields: Record<string, LearningEvaluationValue>;
  validationPassed: boolean;
  bookingLines: LearningEvaluationBookingLine[];
};

export type LearningEvaluationCase = {
  id: string;
  scenario: string;
  expected: LearningEvaluationResult;
  prediction: LearningEvaluationResult & {
    selectionOutcome: SupplierSelectionOutcome;
    policyViolation?: boolean;
  };
};

export type LearningGoldenCorpusCase = {
  id: string;
  scenario: string;
  sourceText: string;
  fileName?: string;
  processingPurpose?: "booking" | "learning_only";
  supplierSelectionOutcome?: SupplierSelectionOutcome;
  correctedFields?: Record<string, LearningEvaluationValue>;
  learning?: {
    supplierAccountId: string;
    trustedExamples?: number;
    formatFingerprints?: string[];
    reset?: boolean;
    learnedGlAccount?: string;
    descriptionKey?: string;
  };
  expected: LearningEvaluationResult;
};

function ratio(correct: number, attempts: number) {
  return attempts ? correct / attempts : 0;
}

function lowerConfidenceBound(correct: number, attempts: number) {
  if (!attempts) return 0;
  const z = 1.96;
  const proportion = correct / attempts;
  const denominator = 1 + (z * z) / attempts;
  const centre = proportion + (z * z) / (2 * attempts);
  const margin =
    z * Math.sqrt((proportion * (1 - proportion)) / attempts + (z * z) / (4 * attempts * attempts));
  return (centre - margin) / denominator;
}

function sameValue(left: LearningEvaluationValue, right: LearningEvaluationValue) {
  return typeof left === "number" && typeof right === "number"
    ? Math.abs(left - right) < 0.005
    : left === right;
}

function sameBookingLines(
  expected: readonly LearningEvaluationBookingLine[],
  prediction: readonly LearningEvaluationBookingLine[]
) {
  return (
    expected.length === prediction.length &&
    expected.every((line, index) => {
      const candidate = prediction[index];
      return (
        candidate !== undefined &&
        line.glAccount === candidate.glAccount &&
        line.vatCode === candidate.vatCode &&
        sameValue(line.percentage, candidate.percentage) &&
        sameValue(line.amount, candidate.amount)
      );
    })
  );
}

export function evaluateLearningCorpus(
  cases: readonly LearningEvaluationCase[]
) {
  let manualSelections = 0;
  let shadowRecommendations = 0;
  let autoSelections = 0;
  let correctAutoSelections = 0;
  let eligibleDecisions = 0;
  const eligibleSuppliers = new Set<string>();
  let overrides = 0;
  let policyViolations = 0;
  let fieldAttempts = 0;
  let correctFields = 0;
  let validationAttempts = 0;
  let correctValidations = 0;
  let bookingLineAttempts = 0;
  let correctBookingLines = 0;

  for (const item of cases) {
    const outcome = item.prediction.selectionOutcome;
    if (outcome === "manual_selection") manualSelections += 1;
    if (outcome === "shadow_recommendation") shadowRecommendations += 1;
    if (outcome === "override") overrides += 1;
    if (item.prediction.policyViolation) policyViolations += 1;
    if (outcome === "eligible_automatic_selection") {
      eligibleDecisions += 1;
      if (item.expected.supplierAccountId) {
        eligibleSuppliers.add(item.expected.supplierAccountId);
      }
      autoSelections += 1;
      if (
        item.expected.supplierAccountId !== null &&
        item.prediction.supplierAccountId === item.expected.supplierAccountId
      ) {
        correctAutoSelections += 1;
      }
    }

    for (const [field, expected] of Object.entries(item.expected.fields)) {
      fieldAttempts += 1;
      if (sameValue(expected, item.prediction.fields[field] ?? null)) {
        correctFields += 1;
      }
    }

    validationAttempts += 1;
    if (item.prediction.validationPassed === item.expected.validationPassed) {
      correctValidations += 1;
    }

    if (item.expected.bookingLines.length) {
      bookingLineAttempts += 1;
      if (sameBookingLines(item.expected.bookingLines, item.prediction.bookingLines)) {
        correctBookingLines += 1;
      }
    }
  }

  const falseAutoSelections = autoSelections - correctAutoSelections;
  const precision = ratio(correctAutoSelections, autoSelections);
  const rawConfidenceLowerBound = lowerConfidenceBound(
    correctAutoSelections,
    autoSelections
  );
  const confidenceLowerBound =
    Math.round(rawConfidenceLowerBound * 10_000) / 10_000;
  const recommendedGatePassed =
    precision >= LEARNING_PRODUCTION_EVALUATION_GATE.minimumPrecision &&
    rawConfidenceLowerBound >=
      LEARNING_PRODUCTION_EVALUATION_GATE.minimumLowerConfidenceBound &&
    policyViolations === 0 &&
    eligibleDecisions >=
      LEARNING_PRODUCTION_EVALUATION_GATE.minimumEligibleDecisions &&
    eligibleSuppliers.size >= LEARNING_PRODUCTION_EVALUATION_GATE.minimumSuppliers;
  return {
    caseCount: cases.length,
    supplier: {
      manualSelections,
      shadowRecommendations,
      eligibleDecisions,
      eligibleSuppliers: eligibleSuppliers.size,
      autoSelections,
      correctAutoSelections,
      falseAutoSelections,
      overrides,
      policyViolations,
      precision,
      recall: ratio(correctAutoSelections, eligibleDecisions),
      confidenceLowerBound,
      recommendedGatePassed,
      acceptanceGatePassed:
        LEARNING_PRODUCTION_EVALUATION_GATE.enabled && recommendedGatePassed,
    },
    fields: {
      attempts: fieldAttempts,
      correct: correctFields,
      accuracy: ratio(correctFields, fieldAttempts),
    },
    validation: {
      attempts: validationAttempts,
      correct: correctValidations,
      accuracy: ratio(correctValidations, validationAttempts),
    },
    bookingLines: {
      attempts: bookingLineAttempts,
      correct: correctBookingLines,
      accuracy: ratio(correctBookingLines, bookingLineAttempts),
    },
  };
}

export async function runLearningCorpusCase(
  item: LearningGoldenCorpusCase,
  exactMasterData: import("../domain/invoice").ExactMasterDataCache
) {
  const [
    { extractInvoiceData },
    { validateInvoiceData },
    {
      createInitialLearningStore,
      generatePurchaseJournalBooking,
      purchaseJournalValidationErrors,
    },
    { learnSupplierInvoice, resetSupplierLearning },
  ] = await Promise.all([
    import("./invoice-extraction-service"),
    import("./invoice-validation"),
    import("./purchase-journal-intelligence"),
    import("./supplier-learning"),
  ]);
  const extracted = await extractInvoiceData({
    name: item.fileName ?? `${item.id}.txt`,
    type: "text/plain",
    size: item.sourceText.length,
    text: async () => item.sourceText,
  });
  const corrected = {
    ...extracted,
    ...(item.correctedFields ?? {}),
  };
  let learning = createInitialLearningStore();
  const learningInput = item.learning;
  if (learningInput) {
    const count = learningInput.trustedExamples ?? 0;
    for (let index = 0; index < count; index += 1) {
      learning = learnSupplierInvoice(learning, {
        id: `${item.id}-example-${index + 1}`,
        supplierAccountId: learningInput.supplierAccountId,
        invoiceId: `${item.id}-training-${index + 1}`,
        contentHash: `${item.id}-hash-${index + 1}`,
        formatFingerprint:
          learningInput.formatFingerprints?.[index] ?? "stable-layout",
        learnedAt: `2026-07-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
        originalExtractedData: structuredClone(corrected),
        finalExtractedData: structuredClone(corrected),
        originalSupplierAccountId: learningInput.supplierAccountId,
        originalBookingLines: [],
        bookingLines: [],
        source: "explicit_learn",
        trustState: "trusted",
        trigger: "learn",
        processingPurpose: "learning_only",
        validationResult: { valid: true },
        active: true,
      });
    }
    if (learningInput.reset) {
      learning = resetSupplierLearning(
        learning,
        learningInput.supplierAccountId,
        "2026-07-20T00:00:00.000Z"
      );
    }
    if (learningInput.learnedGlAccount) {
      learning.glAccountSelections.push({
        supplierAccountId: learningInput.supplierAccountId,
        descriptionKey: learningInput.descriptionKey ?? "",
        glAccount: learningInput.learnedGlAccount,
        decidedAt: "2026-07-20T00:00:00.000Z",
      });
    }
  }

  const timestamp = "2026-07-21T00:00:00.000Z";
  const learningOnly = item.processingPurpose === "learning_only";
  const invoice: import("../domain/invoice").UploadedInvoice = {
    id: `golden-${item.id}`,
    userId: "shared_user",
    uploadedByUserId: "shared_user",
    uploadedByName: "Golden corpus",
    source: "manual_upload",
    fileName: item.fileName ?? `${item.id}.txt`,
    fileType: "text/plain",
    fileSize: item.sourceText.length,
    checksum: `golden-${item.id}`,
    storageKey: `fixtures/${item.id}.txt`,
    localFileStatus: "available",
    status: learningOnly ? "Learned" : "Uploaded",
    processingPurpose: learningOnly ? "learning_only" : "booking",
    learningState: learningOnly ? "saved" : "not_saved",
    revision: 1,
    exactBookingStatus: "not_booked",
    extractedData: corrected,
    extractionHistory: [],
    purchaseJournal: null,
    validationErrors: [],
    bookingAttempts: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const booking = generatePurchaseJournalBooking(
    invoice,
    [invoice],
    learning,
    exactMasterData
  );
  const validationErrors = [
    ...validateInvoiceData(invoice.id, corrected, []),
    ...purchaseJournalValidationErrors(booking, corrected),
  ];
  const prediction: LearningEvaluationCase["prediction"] = {
    supplierAccountId:
      booking.supplierResolution.selectedAccountId ?? null,
    selectionOutcome:
      item.supplierSelectionOutcome ??
      (booking.supplierResolution.selectedAccountId &&
      !booking.supplierResolution.reviewRequired
        ? "eligible_automatic_selection"
        : "manual_selection"),
    fields: {
      referenceCode: corrected.referenceCode,
      invoiceDate: corrected.invoiceDate,
      grossAmount: corrected.grossAmount,
    },
    validationPassed: !validationErrors.some(
      (error) => error.severity === "error"
    ),
    bookingLines: booking.lines.map((line) => ({
      glAccount: line.finalSelectedAccount || line.glAccount,
      vatCode: line.vatCode,
      percentage: line.percentage,
      amount: line.amount,
    })),
  };
  return prediction;
}
