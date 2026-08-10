import {
  listSupplierLearningSummaries,
  requirePermission,
} from "../../../../lib/repository/invoice-store";
import { withPersistentStore } from "../../../../lib/repository/persistent-request";
import { learningFeatureFlags } from "../../../../lib/services/learning-feature-flags";

export async function GET(request?: Request) {
  return withPersistentStore(async () => {
    try {
      requirePermission("view");
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Not allowed." },
        { status: 403 }
      );
    }
    const flags = learningFeatureFlags();
    const enabled = flags.learningV2Enabled && flags.learningUiEnabled;
    return Response.json({
      enabled,
      suppliers: enabled ? listSupplierLearningSummaries() : [],
    });
  }, request);
}
