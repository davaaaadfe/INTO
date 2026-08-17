import {
  listSupplierLearningSummaries,
  requirePermission,
} from "../../../../lib/repository/invoice-store";
import { withPersistentStore } from "../../../../lib/repository/persistent-request";
import { learningFeatureFlags } from "../../../../lib/services/learning-feature-flags";

export async function GET(request: Request) {
  return withPersistentStore(async (principal) => {
    try {
      requirePermission("view", principal);
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Not allowed." },
        { status: 403 }
      );
    }
    const flags = learningFeatureFlags();
    const enabled = flags.learningV2Enabled && flags.learningUiEnabled;
    if (!enabled) return Response.json({ enabled, suppliers: [] });
    const url = new URL(request.url);
    const page = Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1);
    const pageSize = Math.min(
      100,
      Math.max(1, Number.parseInt(url.searchParams.get("pageSize") || "50", 10) || 50)
    );
    const query = (url.searchParams.get("q") || "").trim().toLowerCase();
    const all = listSupplierLearningSummaries().filter((supplier) =>
      !query || `${supplier.supplierCode} ${supplier.supplierName}`.toLowerCase().includes(query)
    );
    const totalPages = Math.max(1, Math.ceil(all.length / pageSize));
    return Response.json({
      enabled,
      suppliers: all.slice((page - 1) * pageSize, page * pageSize),
      pagination: { page, pageSize, total: all.length, totalPages },
    });
  }, request);
}
