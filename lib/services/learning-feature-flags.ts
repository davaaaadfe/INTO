export type SupplierLearningMode = "off" | "observe" | "apply";

type Environment = Record<string, string | undefined>;

function booleanSetting(
  environment: Environment,
  key: string,
  defaultValue: boolean
) {
  const value = environment[key]?.trim().toLowerCase();
  if (!value) {
    return defaultValue;
  }
  if (["true", "1", "yes", "on"].includes(value)) {
    return true;
  }
  if (["false", "0", "no", "off"].includes(value)) {
    return false;
  }
  return defaultValue;
}

function percentageSetting(
  environment: Environment,
  key: string,
  defaultValue: number
) {
  const value = Number(environment[key]);
  return Number.isFinite(value)
    ? Math.min(100, Math.max(0, value))
    : defaultValue;
}

function supplierAllowlist(environment: Environment) {
  return [...new Set(
    (environment.SUPPLIER_LEARNED_AUTO_SELECTION_ALLOWLIST ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0 && value.length <= 128)
  )].slice(0, 1_000);
}

export function learningFeatureFlags(
  environment: Environment = process.env
) {
  const production = environment.NODE_ENV === "production";
  return {
    learningV2Enabled: booleanSetting(
      environment,
      "LEARNING_V2_ENABLED",
      !production
    ),
    learnWorkflowEnabled: booleanSetting(
      environment,
      "LEARN_WORKFLOW_ENABLED",
      !production
    ),
    documentIntelligenceEnabled: booleanSetting(
      environment,
      "DOCUMENT_INTELLIGENCE_ENABLED",
      false
    ),
    learningUiEnabled: booleanSetting(
      environment,
      "LEARNING_UI_ENABLED",
      !production
    ),
    supplierReliabilityEnabled: booleanSetting(
      environment,
      "SUPPLIER_RELIABILITY_ENABLED",
      !production
    ),
    supplierDriftEnabled: booleanSetting(
      environment,
      "SUPPLIER_DRIFT_ENABLED",
      !production
    ),
    supplierResolutionV2Enabled: booleanSetting(
      environment,
      "SUPPLIER_RESOLUTION_V2_ENABLED",
      !production
    ),
    supplierLearnedAutoSelectionEnabled: booleanSetting(
      environment,
      "SUPPLIER_LEARNED_AUTO_SELECTION_ENABLED",
      !production
    ),
    supplierLearnedAutoSelectionEvaluationApproved: booleanSetting(
      environment,
      "SUPPLIER_LEARNED_AUTO_SELECTION_EVALUATION_APPROVED",
      false
    ),
    supplierLearnedAutoSelectionAllowlist: supplierAllowlist(environment),
    supplierLearnedAutoSelectionPercentage: percentageSetting(
      environment,
      "SUPPLIER_LEARNED_AUTO_SELECTION_PERCENTAGE",
      production ? 0 : 100
    ),
    learningShadowMode: booleanSetting(
      environment,
      "LEARNING_SHADOW_MODE",
      production
    ),
  };
}

function supplierRolloutBucket(accountId: string) {
  let hash = 2_166_136_261;
  for (const character of accountId) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % 100;
}

export function supplierLearnedAutoSelectionEnabledFor(
  accountId: string,
  environment: Environment = process.env
) {
  const flags = learningFeatureFlags(environment);
  if (!flags.supplierLearnedAutoSelectionEnabled) return false;
  if (!flags.supplierLearnedAutoSelectionEvaluationApproved) return false;
  if (flags.supplierLearnedAutoSelectionAllowlist.includes(accountId)) return true;
  return supplierRolloutBucket(accountId) <
    flags.supplierLearnedAutoSelectionPercentage;
}

export function supplierLearningMode(
  environment: Environment = process.env
): SupplierLearningMode {
  const value = environment.SUPPLIER_LEARNING_MODE?.trim().toLowerCase();
  if (value === "observe" || value === "apply" || value === "off") {
    return value;
  }
  if (value) {
    return "off";
  }
  return environment.NODE_ENV === "production" ? "off" : "apply";
}
