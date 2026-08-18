import {
  getExactMasterData,
  getSupplierOverviewImportStatus,
  listInvoices,
  replaceSupplierOverviewImport,
} from "../../../../../lib/repository/invoice-store";
import { withPersistentStore } from "../../../../../lib/repository/persistent-request";
import { parseSupplierOverviewWorkbook } from "../../../../../lib/services/supplier-overview-import";
import { logger } from "../../../../../lib/utils/logger";

const maximumWorkbookSize = 10 * 1024 * 1024;

export async function POST(request: Request) {
  return withPersistentStore(async () => {
    try {
      const formData = await request.formData();
      const file = formData.get("file");
      if (!(file instanceof File)) {
        return Response.json(
          { error: "Choose an Exact supplier overview Excel file." },
          { status: 400 }
        );
      }
      if (!file.name.toLocaleLowerCase("en-US").endsWith(".xlsx")) {
        return Response.json(
          { error: "Supplier overview import supports .xlsx files only." },
          { status: 400 }
        );
      }
      if (file.size > maximumWorkbookSize) {
        return Response.json(
          { error: "Supplier overview Excel file must be 10 MB or smaller." },
          { status: 413 }
        );
      }

      const suppliers = await parseSupplierOverviewWorkbook(
        Buffer.from(await file.arrayBuffer())
      );
      replaceSupplierOverviewImport({
        sourceFileName: file.name,
        suppliers,
      });
      const status = getSupplierOverviewImportStatus();
      logger.info("exact.supplier_overview_imported", {
        supplierCount: status?.supplierCount ?? suppliers.length,
        importedAt: status?.importedAt,
      });

      return Response.json({
        supplierOverviewImport: status,
        masterData: getExactMasterData(),
        invoices: listInvoices(),
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Supplier overview import failed.";
      logger.error("exact.supplier_overview_import_failed", { message });
      return Response.json(
        { error: message },
        { status: message.includes("not allowed") ? 403 : 400 }
      );
    }
  }, request);
}
