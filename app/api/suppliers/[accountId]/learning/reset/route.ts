import {
  resetLearningForSupplier,
  requirePermission,
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
    try {
      requirePermission("manage_learning");
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Not allowed." },
        { status: 403 }
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
      const profile = resetLearningForSupplier(
        accountId,
        payload.expectedGeneration as number
      );
      return Response.json({ profile });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Reset failed.";
      const status =
        error instanceof SupplierLearningNotFoundError
          ? 404
          : error instanceof SupplierLearningGenerationConflictError
            ? 409
            : 500;
      return Response.json({ error: message }, { status });
    }
  }, request);
}
