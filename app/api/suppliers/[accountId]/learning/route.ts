import {
  getSupplierLearningDetail,
  SupplierLearningNotFoundError,
} from "../../../../../lib/repository/invoice-store";
import { withPersistentStore } from "../../../../../lib/repository/persistent-request";
import { learningFeatureFlags } from "../../../../../lib/services/learning-feature-flags";

type RouteContext = {
  params: { accountId: string } | Promise<{ accountId: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  return withPersistentStore(async () => {
    const flags = learningFeatureFlags();
    if (!flags.learningV2Enabled || !flags.learningUiEnabled) {
      return Response.json({ error: "Supplier learning is not enabled." }, { status: 404 });
    }
    try {
      const { accountId } = await context.params;
      return Response.json(getSupplierLearningDetail(accountId));
    } catch (error) {
      const status = error instanceof SupplierLearningNotFoundError ? 404 : 403;
      return Response.json(
        { error: error instanceof Error ? error.message : "Not allowed." },
        { status }
      );
    }
  }, request);
}
