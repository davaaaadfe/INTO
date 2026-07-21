import test from "node:test";
import assert from "node:assert/strict";
import {
  learningFeatureFlags,
  supplierLearningMode,
} from "../lib/services/learning-feature-flags";

test("learning feature flags are independently disabled by default in production", () => {
  const flags = learningFeatureFlags({ NODE_ENV: "production" });

  assert.deepEqual(flags, {
    learningV2Enabled: false,
    documentIntelligenceEnabled: false,
    learningUiEnabled: false,
    supplierResolutionV2Enabled: false,
    learningShadowMode: true,
  });
  assert.equal(supplierLearningMode({ NODE_ENV: "production" }), "off");
});

test("learning feature flags parse explicit true and false values", () => {
  const flags = learningFeatureFlags({
    NODE_ENV: "production",
    LEARNING_V2_ENABLED: "true",
    DOCUMENT_INTELLIGENCE_ENABLED: "1",
    LEARNING_UI_ENABLED: "yes",
    SUPPLIER_RESOLUTION_V2_ENABLED: "on",
    LEARNING_SHADOW_MODE: "false",
  });

  assert.equal(flags.learningV2Enabled, true);
  assert.equal(flags.documentIntelligenceEnabled, true);
  assert.equal(flags.learningUiEnabled, true);
  assert.equal(flags.supplierResolutionV2Enabled, true);
  assert.equal(flags.learningShadowMode, false);
});

test("supplier learning mode provides off, observe, and apply kill switches", () => {
  assert.equal(supplierLearningMode({ SUPPLIER_LEARNING_MODE: "observe" }), "observe");
  assert.equal(supplierLearningMode({ SUPPLIER_LEARNING_MODE: "apply" }), "apply");
  assert.equal(supplierLearningMode({ SUPPLIER_LEARNING_MODE: "invalid" }), "off");
});
