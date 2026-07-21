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
      autoSelections: 8,
      correctAutoSelections: 8,
      falseAutoSelections: 0,
      precision: 1,
      recall: 1,
      acceptanceGatePassed: true,
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
  ambiguous.prediction.autoSelected = true;

  const result = evaluateLearningCorpus(unsafe);
  assert.equal(result.supplier.falseAutoSelections, 1);
  assert.equal(result.supplier.precision, 8 / 9);
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
        autoSelected: true,
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
