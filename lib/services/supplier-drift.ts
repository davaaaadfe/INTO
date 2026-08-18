import type {
  SupplierLearningFormatDrift,
  SupplierLearningOutcomeEvent,
} from "../domain/invoice";

export const SUPPLIER_DRIFT_POLICY = {
  version: "supplier-drift-v1",
  possible: { minimumEvaluated: 3, minimumAdverse: 2, adverseRate: 0.4 },
  confirmed: { minimumEvaluated: 5, minimumAdverse: 3, adverseRate: 0.6 },
} as const;

export type SupplierDriftResult = {
  state: SupplierLearningFormatDrift;
  policyVersion: typeof SUPPLIER_DRIFT_POLICY.version;
  evaluatedCount: number;
  adverseCount: number;
  adverseRate: number;
};

export function deriveSupplierDrift({
  events,
  supplierAccountId,
  generation,
}: {
  events: readonly SupplierLearningOutcomeEvent[];
  supplierAccountId: string;
  generation: number;
}): SupplierDriftResult {
  const evaluated = [...new Map(
    events
      .filter(
        (event) =>
          event.supplierAccountId === supplierAccountId &&
          event.generation === generation &&
          ["acceptance", "correction", "rejection"].includes(event.type)
      )
      .map((event) => [event.id, event] as const)
  ).values()];
  const adverseCount = evaluated.filter(
    (event) => event.type === "correction" || event.type === "rejection"
  ).length;
  const adverseRate = evaluated.length ? adverseCount / evaluated.length : 0;
  const qualifies = (threshold: {
    minimumEvaluated: number;
    minimumAdverse: number;
    adverseRate: number;
  }) =>
    evaluated.length >= threshold.minimumEvaluated &&
    adverseCount >= threshold.minimumAdverse &&
    adverseRate >= threshold.adverseRate;
  const state = qualifies(SUPPLIER_DRIFT_POLICY.confirmed)
    ? "confirmed"
    : qualifies(SUPPLIER_DRIFT_POLICY.possible)
      ? "possible"
      : "none";
  return {
    state,
    policyVersion: SUPPLIER_DRIFT_POLICY.version,
    evaluatedCount: evaluated.length,
    adverseCount,
    adverseRate,
  };
}
