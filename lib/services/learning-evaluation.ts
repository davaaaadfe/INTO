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
    automaticSelectionEligible?: boolean;
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

export type LearningEvaluationHoldout = {
  supplierAccountId: string;
  formatId: string;
};

export function learningEvaluationHoldoutReport(
  training: readonly LearningEvaluationHoldout[],
  evaluation: readonly LearningEvaluationHoldout[]
) {
  const trainedSuppliers = new Set(training.map((item) => item.supplierAccountId));
  const trainedFormats = new Set(training.map((item) => item.formatId));
  const supplierLeakage = [...new Set(
    evaluation
      .map((item) => item.supplierAccountId)
      .filter((supplier) => trainedSuppliers.has(supplier))
  )].sort();
  const formatLeakage = [...new Set(
    evaluation
      .map((item) => item.formatId)
      .filter((format) => trainedFormats.has(format))
  )].sort();
  return {
    valid: supplierLeakage.length === 0 && formatLeakage.length === 0,
    supplierLeakage,
    formatLeakage,
  };
}

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
    const eligible = item.prediction.automaticSelectionEligible ??
      outcome === "eligible_automatic_selection";
    if (eligible) {
      eligibleDecisions += 1;
      if (item.expected.supplierAccountId) {
        eligibleSuppliers.add(item.expected.supplierAccountId);
      }
    }
    if (outcome === "eligible_automatic_selection") {
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
      coverage: ratio(autoSelections, eligibleDecisions),
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
    { structuralFormat },
    { supplierIdentityKeys },
  ] = await Promise.all([
    import("./invoice-extraction-service"),
    import("./invoice-validation"),
    import("./purchase-journal-intelligence"),
    import("./supplier-learning"),
    import("./supplier-format-clustering"),
    import("./supplier-identity"),
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
  const currentFormat = structuralFormat(corrected.rawText ?? "");
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
          learningInput.formatFingerprints?.[index] ?? currentFormat.fingerprint,
        formatSignature: learningInput.formatFingerprints?.[index]
          ? undefined
          : currentFormat.signature,
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
    if (
      item.supplierSelectionOutcome === "eligible_automatic_selection" &&
      !learningInput.reset
    ) {
      learning.supplierSelections.unshift({
        supplierIdentity:
          supplierIdentityKeys(corrected)[0] ?? `account:${learningInput.supplierAccountId}`,
        accountId: learningInput.supplierAccountId,
        decidedAt: "2026-07-20T00:00:00.000Z",
        invoiceId: `${item.id}-confirmed-format`,
        formatFingerprint: currentFormat.fingerprint,
        trustState: "trusted",
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
  const initialBooking = generatePurchaseJournalBooking(
    invoice,
    [invoice],
    learning,
    exactMasterData
  );
  const manualExpected =
    item.supplierSelectionOutcome === "manual_selection" &&
    item.expected.supplierAccountId !== null;
  if (manualExpected) {
    learning.supplierSelections.unshift({
      supplierIdentity:
        supplierIdentityKeys(corrected)[0] ?? `account:${item.expected.supplierAccountId}`,
      accountId: item.expected.supplierAccountId!,
      decidedAt: timestamp,
      invoiceId: invoice.id,
      formatFingerprint: currentFormat.fingerprint,
      trustState: "trusted",
    });
  }
  const booking = manualExpected
    ? generatePurchaseJournalBooking(invoice, [invoice], learning, exactMasterData)
    : initialBooking;
  const validationErrors = [
    ...validateInvoiceData(invoice.id, corrected, []),
    ...purchaseJournalValidationErrors(booking, corrected),
  ];
  const prediction: LearningEvaluationCase["prediction"] = {
    supplierAccountId:
      booking.supplierResolution.selectedAccountId ?? null,
    selectionOutcome:
      item.supplierSelectionOutcome === "eligible_automatic_selection"
        ? booking.supplierResolution.selectionOrigin === "automatic"
          ? "eligible_automatic_selection"
          : "manual_selection"
        : item.supplierSelectionOutcome ??
          (booking.supplierResolution.selectionOrigin === "automatic"
            ? "eligible_automatic_selection"
            : "manual_selection"),
    policyViolation:
      item.supplierSelectionOutcome === "manual_selection" &&
      initialBooking.supplierResolution.selectionOrigin === "automatic",
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
