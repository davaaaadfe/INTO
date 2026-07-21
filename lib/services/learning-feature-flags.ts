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
    supplierResolutionV2Enabled: booleanSetting(
      environment,
      "SUPPLIER_RESOLUTION_V2_ENABLED",
      !production
    ),
    learningShadowMode: booleanSetting(
      environment,
      "LEARNING_SHADOW_MODE",
      true
    ),
  };
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
