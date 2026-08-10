import type {
  InvoiceArchiveFilters,
  InvoiceArchiveSortField,
  InvoiceSource,
} from "../../../../lib/domain/invoice";
import {
  requirePermission,
  searchInvoiceArchive,
} from "../../../../lib/repository/invoice-store";
import { withPersistentStore } from "../../../../lib/repository/persistent-request";

function numberParam(params: URLSearchParams, key: string) {
  const value = params.get(key);
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function GET(request: Request) {
  return withPersistentStore((principal) => {
    try {
      requirePermission("search_archive", principal);
      const params = new URL(request.url).searchParams;
      const filters: InvoiceArchiveFilters = {
        keyword: params.get("keyword") ?? undefined,
        invoiceDateFrom: params.get("invoiceDateFrom") ?? undefined,
        invoiceDateTo: params.get("invoiceDateTo") ?? undefined,
        uploadedAtFrom: params.get("uploadedAtFrom") ?? undefined,
        uploadedAtTo: params.get("uploadedAtTo") ?? undefined,
        supplier: params.get("supplier") ?? undefined,
        amountMin: numberParam(params, "amountMin"),
        amountMax: numberParam(params, "amountMax"),
        currency: params.get("currency") ?? undefined,
        invoiceNumber: params.get("invoiceNumber") ?? undefined,
        bookingStatus: params.get("bookingStatus") ?? undefined,
        validationStatus: params.get("validationStatus") ?? undefined,
        source: (params.get("source") as InvoiceSource | "") ?? undefined,
        uploadedByUserId: params.get("uploadedByUserId") ?? undefined,
        exactBookingReference: params.get("exactBookingReference") ?? undefined,
        journal: params.get("journal") ?? undefined,
        glAccount: params.get("glAccount") ?? undefined,
        vatCode: params.get("vatCode") ?? undefined,
        costCenter: params.get("costCenter") ?? undefined,
        costUnit: params.get("costUnit") ?? undefined,
        country: params.get("country") ?? undefined,
        duplicateStatus: params.get("duplicateStatus") ?? undefined,
        sortBy: (params.get("sortBy") as InvoiceArchiveSortField) ?? undefined,
        sortDirection:
          params.get("sortDirection") === "asc" ? "asc" : "desc",
        page: numberParam(params, "page"),
        pageSize: numberParam(params, "pageSize"),
      };

      return Response.json({
        archive: searchInvoiceArchive(filters),
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Archive search failed.";
      return Response.json({ error: message }, { status: 403 });
    }
  }, request);
}
