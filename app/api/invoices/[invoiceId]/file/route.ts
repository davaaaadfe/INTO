import { getInvoice } from "../../../../../lib/repository/invoice-store";
import { withPersistentStore } from "../../../../../lib/repository/persistent-request";
import { getStoredInvoiceFile } from "../../../../../lib/services/storage-service";

type RouteContext = {
  params: { invoiceId: string } | Promise<{ invoiceId: string }>;
};

async function invoiceIdFromContext(context: RouteContext) {
  const params = await context.params;
  return params.invoiceId;
}

function contentDisposition(fileName: string, download: boolean) {
  const safeFileName = fileName.replace(/["\r\n]/g, "");
  return `${download ? "attachment" : "inline"}; filename="${safeFileName}"`;
}

export async function GET(request: Request, context: RouteContext) {
  return withPersistentStore(async () => {
    const invoiceId = await invoiceIdFromContext(context);
    const invoice = getInvoice(invoiceId);

    if (!invoice) {
      return Response.json({ error: "Invoice not found." }, { status: 404 });
    }

    const storedFile = await getStoredInvoiceFile(invoice.storageKey, {
      fileName: invoice.fileName,
      fileType: invoice.fileType,
    });
    if (!storedFile) {
      return Response.json(
        { error: "Original invoice source document is not available." },
        { status: 404 }
      );
    }

    const url = new URL(request.url);
    const download = url.searchParams.get("download") === "1";
    const body = storedFile.bytes.buffer.slice(
      storedFile.bytes.byteOffset,
      storedFile.bytes.byteOffset + storedFile.bytes.byteLength
    ) as ArrayBuffer;

    return new Response(body, {
      headers: {
        "Content-Type": storedFile.fileType,
        "Content-Length": String(storedFile.fileSize),
        "Content-Disposition": contentDisposition(invoice.fileName, download),
        "Cache-Control": "private, max-age=300",
      },
    });
  });
}
