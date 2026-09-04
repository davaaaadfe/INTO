import { createHash } from "node:crypto";
import type { SupplierResolution } from "../domain/invoice";
import { SUPPLIER_RESOLUTION_V2_POLICY } from "./purchase-journal-intelligence";

export function supplierResolutionShadowTelemetry(
  resolution: SupplierResolution
) {
  const shadow = resolution.shadowEvaluation;
  if (!shadow) return null;

  return {
    policyVersion: SUPPLIER_RESOLUTION_V2_POLICY.version,
    candidateRef: shadow.selectedAccountId
      ? createHash("sha256")
          .update(`supplier-shadow:${shadow.selectedAccountId}`)
          .digest("hex")
          .slice(0, 16)
      : null,
    eligible: !shadow.reviewRequired,
    matchConfidence: shadow.matchConfidence,
    manualReason: shadow.manualReason ?? null,
  };
}

export function supplierResolutionOutcomeTelemetry(
  shadow: SupplierResolution["shadowEvaluation"],
  confirmedAccountId: string
) {
  if (!shadow) return null;
  return {
    policyVersion: SUPPLIER_RESOLUTION_V2_POLICY.version,
    eligible: !shadow.reviewRequired,
    outcome: !shadow.selectedAccountId
      ? "abstained"
      : shadow.selectedAccountId === confirmedAccountId
        ? "confirmed"
        : "overridden",
    matchConfidence: shadow.matchConfidence,
    manualReason: shadow.manualReason ?? null,
  };
}
