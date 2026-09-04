import test from "node:test";
import assert from "node:assert/strict";
import {
  learningFeatureFlags,
  supplierLearnedAutoSelectionEnabledFor,
  supplierLearningMode,
} from "../lib/services/learning-feature-flags";

test("learning feature flags are independently disabled by default in production", () => {
  const flags = learningFeatureFlags({ NODE_ENV: "production" });

  assert.deepEqual(flags, {
    learningV2Enabled: false,
    learnWorkflowEnabled: false,
    documentIntelligenceEnabled: false,
    learningUiEnabled: false,
    supplierReliabilityEnabled: false,
    supplierDriftEnabled: false,
    supplierResolutionV2Enabled: false,
    supplierLearnedAutoSelectionEnabled: false,
    supplierLearnedAutoSelectionEvaluationApproved: false,
    supplierLearnedAutoSelectionAllowlist: [],
    supplierLearnedAutoSelectionPercentage: 0,
    learningShadowMode: true,
  });
  assert.equal(supplierLearningMode({ NODE_ENV: "production" }), "off");
});

test("learning feature flags parse explicit true and false values", () => {
  const flags = learningFeatureFlags({
    NODE_ENV: "production",
    LEARNING_V2_ENABLED: "true",
    LEARN_WORKFLOW_ENABLED: "true",
    DOCUMENT_INTELLIGENCE_ENABLED: "1",
    LEARNING_UI_ENABLED: "yes",
    SUPPLIER_RELIABILITY_ENABLED: "true",
    SUPPLIER_DRIFT_ENABLED: "1",
    SUPPLIER_RESOLUTION_V2_ENABLED: "on",
    SUPPLIER_LEARNED_AUTO_SELECTION_ENABLED: "true",
    SUPPLIER_LEARNED_AUTO_SELECTION_EVALUATION_APPROVED: "true",
    SUPPLIER_LEARNED_AUTO_SELECTION_ALLOWLIST: " supplier-a, supplier-b, supplier-a ",
    SUPPLIER_LEARNED_AUTO_SELECTION_PERCENTAGE: "25",
    LEARNING_SHADOW_MODE: "false",
  });

  assert.equal(flags.learningV2Enabled, true);
  assert.equal(flags.learnWorkflowEnabled, true);
  assert.equal(flags.documentIntelligenceEnabled, true);
  assert.equal(flags.learningUiEnabled, true);
  assert.equal(flags.supplierReliabilityEnabled, true);
  assert.equal(flags.supplierDriftEnabled, true);
  assert.equal(flags.supplierResolutionV2Enabled, true);
  assert.equal(flags.supplierLearnedAutoSelectionEnabled, true);
  assert.equal(flags.supplierLearnedAutoSelectionEvaluationApproved, true);
  assert.deepEqual(flags.supplierLearnedAutoSelectionAllowlist, [
    "supplier-a",
    "supplier-b",
  ]);
  assert.equal(flags.supplierLearnedAutoSelectionPercentage, 25);
  assert.equal(flags.learningShadowMode, false);
});

test("learned auto-selection rollout is supplier-scoped and deterministic", () => {
  assert.equal(
    supplierLearnedAutoSelectionEnabledFor("supplier-a", {
      NODE_ENV: "production",
      SUPPLIER_LEARNED_AUTO_SELECTION_ENABLED: "true",
      SUPPLIER_LEARNED_AUTO_SELECTION_EVALUATION_APPROVED: "true",
      SUPPLIER_LEARNED_AUTO_SELECTION_ALLOWLIST: "supplier-a",
      SUPPLIER_LEARNED_AUTO_SELECTION_PERCENTAGE: "0",
    }),
    true
  );
  assert.equal(
    supplierLearnedAutoSelectionEnabledFor("supplier-b", {
      NODE_ENV: "production",
      SUPPLIER_LEARNED_AUTO_SELECTION_ENABLED: "true",
      SUPPLIER_LEARNED_AUTO_SELECTION_EVALUATION_APPROVED: "true",
      SUPPLIER_LEARNED_AUTO_SELECTION_ALLOWLIST: "supplier-a",
      SUPPLIER_LEARNED_AUTO_SELECTION_PERCENTAGE: "0",
    }),
    false
  );
  assert.equal(
    supplierLearnedAutoSelectionEnabledFor("supplier-b", {
      NODE_ENV: "production",
      SUPPLIER_LEARNED_AUTO_SELECTION_ENABLED: "true",
      SUPPLIER_LEARNED_AUTO_SELECTION_EVALUATION_APPROVED: "true",
      SUPPLIER_LEARNED_AUTO_SELECTION_PERCENTAGE: "100",
    }),
    true
  );
  assert.equal(
    supplierLearnedAutoSelectionEnabledFor("supplier-a", {
      SUPPLIER_LEARNED_AUTO_SELECTION_ENABLED: "false",
      SUPPLIER_LEARNED_AUTO_SELECTION_EVALUATION_APPROVED: "true",
      SUPPLIER_LEARNED_AUTO_SELECTION_ALLOWLIST: "supplier-a",
      SUPPLIER_LEARNED_AUTO_SELECTION_PERCENTAGE: "100",
    }),
    false
  );
});

test("learned auto-selection stays disabled until evaluation approval is explicit", () => {
  assert.equal(
    supplierLearnedAutoSelectionEnabledFor("supplier-a", {
      NODE_ENV: "production",
      SUPPLIER_LEARNED_AUTO_SELECTION_ENABLED: "true",
      SUPPLIER_LEARNED_AUTO_SELECTION_ALLOWLIST: "supplier-a",
      SUPPLIER_LEARNED_AUTO_SELECTION_PERCENTAGE: "100",
    }),
    false
  );
});

test("supplier learning mode provides off, observe, and apply kill switches", () => {
  assert.equal(supplierLearningMode({ SUPPLIER_LEARNING_MODE: "observe" }), "observe");
  assert.equal(supplierLearningMode({ SUPPLIER_LEARNING_MODE: "apply" }), "apply");
  assert.equal(supplierLearningMode({ SUPPLIER_LEARNING_MODE: "invalid" }), "off");
});
