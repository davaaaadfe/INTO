import { getInvoice } from "../../../../../lib/repository/invoice-store";
import { withPersistentStore } from "../../../../../lib/repository/persistent-request";
import { getStoredInvoiceFile } from "../../../../../lib/services/storage-service";
import { logger } from "../../../../../lib/utils/logger";

type RouteContext = {
  params: { invoiceId: string } | Promise<{ invoiceId: string }>;
};

const missingInvoiceFileMessage =
  "Original invoice file could not be found. Please re-upload or re-read this invoice.";

async function invoiceIdFromContext(context: RouteContext) {
  const params = await context.params;
  return params.invoiceId;
}

function contentDisposition(fileName: string, download: boolean) {
  const safeFileName = fileName.replace(/["\r\n]/g, "");
  return `${download ? "attachment" : "inline"}; filename="${safeFileName}"`;
}

function missingInvoiceFileResponse() {
  return new Response(missingInvoiceFileMessage, {
    status: 404,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function invoiceFileResponse(
  request: Request,
  context: RouteContext,
  headOnly: boolean
) {
  return withPersistentStore(async () => {
    const invoiceId = await invoiceIdFromContext(context);
    const invoice = getInvoice(invoiceId);

    if (!invoice) {
      logger.warn("invoice.file_invoice_not_found", { invoiceId });
      return missingInvoiceFileResponse();
    }

    const storedFile = await getStoredInvoiceFile(invoice.storageKey, {
      fileName: invoice.fileName,
      fileType: invoice.fileType,
    });
    if (!storedFile) {
      logger.error("invoice.file_missing", {
        invoiceId,
        localFileStatus: invoice.localFileStatus,
      });
      return missingInvoiceFileResponse();
    }

    const url = new URL(request.url);
    const download = url.searchParams.get("download") === "1";
    const headers = {
      "Content-Type": storedFile.fileType,
      "Content-Length": String(storedFile.fileSize),
      "Content-Disposition": contentDisposition(invoice.fileName, download),
      "Cache-Control": "private, max-age=300",
    };

    if (headOnly) {
      return new Response(null, { headers });
    }

    const body = storedFile.bytes.buffer.slice(
      storedFile.bytes.byteOffset,
      storedFile.bytes.byteOffset + storedFile.bytes.byteLength
    ) as ArrayBuffer;

    return new Response(body, { headers });
  }, request);
}

export async function HEAD(request: Request, context: RouteContext) {
  return invoiceFileResponse(request, context, true);
}

export async function GET(request: Request, context: RouteContext) {
  return invoiceFileResponse(request, context, false);
}
