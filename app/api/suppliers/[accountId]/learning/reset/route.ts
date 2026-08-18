import {
  getSupplierLearningDetail,
  listSupplierLearningSummaries,
  resetLearningForSupplierCommand,
  SupplierLearningGenerationConflictError,
  SupplierLearningNotFoundError,
} from "../../../../../../lib/repository/invoice-store";
import { withPersistentStore } from "../../../../../../lib/repository/persistent-request";
import {
  learningFeatureFlags,
  supplierLearningMode,
} from "../../../../../../lib/services/learning-feature-flags";

type RouteContext = {
  params: { accountId: string } | Promise<{ accountId: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  return withPersistentStore(async () => {
    if (
      !learningFeatureFlags().learningV2Enabled ||
      supplierLearningMode() === "off"
    ) {
      return Response.json(
        { error: "Supplier learning is not enabled." },
        { status: 404 }
      );
    }
    const { accountId } = await context.params;
    try {
      const payload = (await request.json()) as { expectedGeneration?: unknown };
      if (!Number.isInteger(payload.expectedGeneration)) {
        return Response.json(
          { error: "expectedGeneration must be an integer." },
          { status: 400 }
        );
      }
      if (accountId.startsWith("supplier-overview:")) {
        return Response.json(
          { error: "A canonical Exact supplier account is required." },
          { status: 422 }
        );
      }
      getSupplierLearningDetail(accountId);
      const requestKey =
        request.headers.get("idempotency-key")?.trim() ||
        (typeof (payload as { requestKey?: unknown }).requestKey === "string"
          ? (payload as { requestKey: string }).requestKey.trim()
          : "");
      if (!requestKey) {
        return Response.json(
          { error: "Idempotency-Key is required." },
          { status: 422 }
        );
      }
      const result = resetLearningForSupplierCommand(
        accountId,
        payload.expectedGeneration as number,
        requestKey
      );
      const summary = listSupplierLearningSummaries().find(
        (item) => item.supplierAccountId === accountId
      );
      return Response.json({ ...result, summary });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Reset failed.";
      const status =
        error instanceof SupplierLearningNotFoundError
          ? 404
          : error instanceof SupplierLearningGenerationConflictError
            ? 409
            : error instanceof TypeError
              ? 422
              : 500;
      return Response.json({ error: message }, { status });
    }
  }, request);
}
