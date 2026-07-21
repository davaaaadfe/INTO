import {
  listSupplierLearningSummaries,
  requirePermission,
} from "../../../../lib/repository/invoice-store";
import { withPersistentStore } from "../../../../lib/repository/persistent-request";

export async function GET() {
  return withPersistentStore(async () => {
    try {
      requirePermission("view");
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Not allowed." },
        { status: 403 }
      );
    }
    return Response.json({ suppliers: listSupplierLearningSummaries() });
  });
}
