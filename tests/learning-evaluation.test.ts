import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  evaluateLearningCorpus,
  runLearningCorpusCase,
  type LearningEvaluationCase,
  type LearningGoldenCorpusCase,
} from "../lib/services/learning-evaluation";
import { createMockExactMasterData } from "../lib/services/exact-master-data-service";

const corpus = JSON.parse(
  readFileSync(resolve("tests/fixtures/ml-golden-corpus.json"), "utf8")
) as {
  schemaVersion: number;
  sanitized: boolean;
  workflowScenarios: string[];
  cases: LearningGoldenCorpusCase[];
};

async function executableCases() {
  const previous = {
    resolution: process.env.SUPPLIER_RESOLUTION_V2_ENABLED,
    shadow: process.env.LEARNING_SHADOW_MODE,
    mode: process.env.SUPPLIER_LEARNING_MODE,
  };
  process.env.SUPPLIER_RESOLUTION_V2_ENABLED = "true";
  process.env.LEARNING_SHADOW_MODE = "false";
  process.env.SUPPLIER_LEARNING_MODE = "apply";
  try {
    const masterData = createMockExactMasterData();
    return await Promise.all(
      corpus.cases.map(async (item) => ({
        id: item.id,
        scenario: item.scenario,
        expected: item.expected,
        prediction: await runLearningCorpusCase(item, masterData),
      }))
    );
  } finally {
    if (previous.resolution === undefined) {
      delete process.env.SUPPLIER_RESOLUTION_V2_ENABLED;
    } else {
      process.env.SUPPLIER_RESOLUTION_V2_ENABLED = previous.resolution;
    }
    if (previous.shadow === undefined) {
      delete process.env.LEARNING_SHADOW_MODE;
    } else {
      process.env.LEARNING_SHADOW_MODE = previous.shadow;
    }
    if (previous.mode === undefined) {
      delete process.env.SUPPLIER_LEARNING_MODE;
    } else {
      process.env.SUPPLIER_LEARNING_MODE = previous.mode;
    }
  }
}

test("the sanitized golden corpus executes every required production workflow", async () => {
  assert.equal(corpus.schemaVersion, 2);
  assert.equal(corpus.sanitized, true);
  assert.deepEqual(corpus.workflowScenarios, [
    "supplier_no_training",
    "one_training_invoice",
    "multiple_consistent_invoices",
    "supplier_format_changed",
    "duplicate_supplier_candidates",
    "manually_corrected_fields",
    "learn_only_invoice",
    "reset_learning",
    "future_invoice_after_training",
  ]);
  assert.deepEqual(
    corpus.cases.map((item) => item.scenario),
    corpus.workflowScenarios
  );
  assert.equal(
    corpus.cases.some((item) => "prediction" in item),
    false,
    "fixtures contain source truth, never hand-authored predictions"
  );

  const cases = await executableCases();
  assert.deepEqual(evaluateLearningCorpus(cases), {
    caseCount: 9,
    supplier: {
      manualSelections: 7,
      shadowRecommendations: 0,
      eligibleDecisions: 2,
      eligibleSuppliers: 1,
      autoSelections: 2,
      correctAutoSelections: 2,
      falseAutoSelections: 0,
      overrides: 0,
      policyViolations: 0,
      precision: 1,
      recall: 1,
      confidenceLowerBound: 0.3424,
      recommendedGatePassed: false,
      acceptanceGatePassed: false,
    },
    fields: { attempts: 27, correct: 27, accuracy: 1 },
    validation: { attempts: 9, correct: 9, accuracy: 1 },
    bookingLines: { attempts: 9, correct: 9, accuracy: 1 },
  });
});

test("one false supplier auto-selection fails the 99% precision gate", async () => {
  const unsafe = structuredClone(await executableCases());
  const ambiguous = unsafe.find(
    (item) => item.scenario === "duplicate_supplier_candidates"
  )!;
  ambiguous.prediction.supplierAccountId = "wrong-supplier";
  ambiguous.prediction.selectionOutcome = "eligible_automatic_selection";

  const result = evaluateLearningCorpus(unsafe);
  assert.equal(result.supplier.falseAutoSelections, 1);
  assert.equal(result.supplier.precision, 2 / 3);
  assert.equal(result.supplier.acceptanceGatePassed, false);
});

test("a tiny perfect sample cannot enable supplier auto-selection", () => {
  const tiny: LearningEvaluationCase[] = [
    {
      id: "tiny-1",
      scenario: "unique",
      expected: {
        supplierAccountId: "supplier-a",
        fields: {},
        validationPassed: true,
        bookingLines: [],
      },
      prediction: {
        supplierAccountId: "supplier-a",
        selectionOutcome: "eligible_automatic_selection",
        fields: {},
        validationPassed: true,
        bookingLines: [],
      },
    },
  ];

  assert.equal(
    evaluateLearningCorpus(tiny).supplier.acceptanceGatePassed,
    false
  );
});

test("supplier evaluation counts only eligible automatic selections and keeps the production gate disabled", () => {
  const cases = [
    {
      id: "first-unfamiliar-supplier",
      scenario: "first_supplier",
      expected: {
        supplierAccountId: "supplier-a",
        fields: {},
        validationPassed: true,
        bookingLines: [],
      },
      prediction: {
        supplierAccountId: "supplier-a",
        selectionOutcome: "manual_selection",
        fields: {},
        validationPassed: true,
        bookingLines: [],
      },
    },
    {
      id: "shadow-recommendation",
      scenario: "shadow",
      expected: {
        supplierAccountId: "supplier-a",
        fields: {},
        validationPassed: true,
        bookingLines: [],
      },
      prediction: {
        supplierAccountId: "supplier-a",
        selectionOutcome: "shadow_recommendation",
        fields: {},
        validationPassed: true,
        bookingLines: [],
      },
    },
    {
      id: "eligible-automatic-selection",
      scenario: "eligible_auto",
      expected: {
        supplierAccountId: "supplier-b",
        fields: {},
        validationPassed: true,
        bookingLines: [],
      },
      prediction: {
        supplierAccountId: "supplier-b",
        selectionOutcome: "eligible_automatic_selection",
        fields: {},
        validationPassed: true,
        bookingLines: [],
      },
    },
    {
      id: "override",
      scenario: "override",
      expected: {
        supplierAccountId: "supplier-b",
        fields: {},
        validationPassed: true,
        bookingLines: [],
      },
      prediction: {
        supplierAccountId: "supplier-b",
        selectionOutcome: "override",
        fields: {},
        validationPassed: true,
        bookingLines: [],
      },
    },
  ] satisfies LearningEvaluationCase[];

  assert.deepEqual(evaluateLearningCorpus(cases), {
    caseCount: 4,
    supplier: {
      manualSelections: 1,
      shadowRecommendations: 1,
      eligibleDecisions: 1,
      eligibleSuppliers: 1,
      autoSelections: 1,
      correctAutoSelections: 1,
      falseAutoSelections: 0,
      overrides: 1,
      policyViolations: 0,
      precision: 1,
      recall: 1,
      confidenceLowerBound: 0.2065,
      recommendedGatePassed: false,
      acceptanceGatePassed: false,
    },
    fields: { attempts: 0, correct: 0, accuracy: 0 },
    validation: { attempts: 4, correct: 4, accuracy: 1 },
    bookingLines: { attempts: 0, correct: 0, accuracy: 0 },
  });
});

test("does not round a 95% lower confidence bound up to the production threshold", () => {
  const cases = Array.from({ length: 560 }, (_, index) => ({
    id: `near-boundary-${index}`,
    scenario: "eligible_auto",
    expected: {
      supplierAccountId: `supplier-${index % 50}`,
      fields: {},
      validationPassed: true,
      bookingLines: [],
    },
    prediction: {
      supplierAccountId: index === 559 ? "wrong-supplier" : `supplier-${index % 50}`,
      selectionOutcome: "eligible_automatic_selection" as const,
      fields: {},
      validationPassed: true,
      bookingLines: [],
    },
  })) satisfies LearningEvaluationCase[];

  const result = evaluateLearningCorpus(cases);

  assert.equal(result.supplier.precision, 559 / 560);
  assert.equal(result.supplier.confidenceLowerBound, 0.99);
  assert.equal(result.supplier.recommendedGatePassed, false);
});
