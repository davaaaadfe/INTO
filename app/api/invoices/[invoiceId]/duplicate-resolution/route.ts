import type {
  DuplicateDetectionOutcome,
  DuplicateResolutionDecision,
} from "../../../../../lib/domain/invoice";
import {
  getInvoice,
  listInvoices,
  replaceInvoiceExtractionFromReread,
  requirePermission,
  resolveDuplicateDecision,
} from "../../../../../lib/repository/invoice-store";
import { withPersistentStore } from "../../../../../lib/repository/persistent-request";
import { extractInvoiceData } from "../../../../../lib/services/invoice-extraction-service";
import { getStoredInvoiceFile } from "../../../../../lib/services/storage-service";
import { logger } from "../../../../../lib/utils/logger";

type RouteContext = {
  params: { invoiceId: string } | Promise<{ invoiceId: string }>;
};

async function invoiceIdFromContext(context: RouteContext) {
  const params = await context.params;
  return params.invoiceId;
}

export async function POST(request: Request, context: RouteContext) {
  return withPersistentStore(async (principal) => {
    const invoiceId = await invoiceIdFromContext(context);
    const invoice = getInvoice(invoiceId);

    if (!invoice) {
      return Response.json({ error: "Invoice not found." }, { status: 404 });
    }

    try {
      requirePermission("edit", principal);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Not allowed.";
      return Response.json({ error: message }, { status: 403 });
    }

    try {
      const payload = (await request.json()) as {
        decision: DuplicateResolutionDecision;
        message?: string;
        detectionOutcome?: DuplicateDetectionOutcome;
      };
      const decision = payload.decision;
      const detectionOutcome =
        payload.detectionOutcome ?? invoice.duplicateDetection?.outcome ?? "processed_unbooked";
      const message =
        payload.message ??
        invoice.duplicateDetection?.message ??
        "Duplicate invoice decision recorded.";

      if (decision === "re_read") {
        const storedFile = await getStoredInvoiceFile(invoice.storageKey, {
          fileName: invoice.fileName,
          fileType: invoice.fileType,
        });
        if (!storedFile) {
          return Response.json(
            { error: "Original invoice file is not available for re-reading." },
            { status: 409 }
          );
        }

        const extractedData = await extractInvoiceData({
          name: storedFile.fileName,
          type: storedFile.fileType,
          size: storedFile.fileSize,
          arrayBuffer: async () => storedFile.bytes.slice().buffer,
          text: async () => new TextDecoder().decode(storedFile.bytes),
        });
        const updatedInvoice = replaceInvoiceExtractionFromReread(
          invoice.id,
          extractedData,
          "re_read"
        );
        await resolveDuplicateDecision({
          invoiceId: invoice.id,
          source: invoice.source,
          fileName: invoice.fileName,
          checksum: invoice.checksum,
          detectionOutcome,
          decision,
          message,
          exactBookingId: invoice.exactBookingId,
        });

        logger.info("invoice.duplicate_reread", {
          invoiceId: invoice.id,
          versionCount: updatedInvoice?.extractionHistory.length ?? 0,
        });

        return Response.json({ invoice: updatedInvoice, invoices: listInvoices() });
      }

      const result = await resolveDuplicateDecision({
        invoiceId: invoice.id,
        source: invoice.source,
        fileName: invoice.fileName,
        checksum: invoice.checksum,
        detectionOutcome,
        decision,
        message,
        exactBookingId: invoice.exactBookingId,
      });

      logger.info("invoice.duplicate_decision", {
        invoiceId: invoice.id,
        decision,
        detectionOutcome,
      });

      return Response.json({
        invoice: result.invoice,
        invoices: listInvoices(),
        decisionLog: result.log,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Duplicate decision failed.";
      logger.error("invoice.duplicate_decision_failed", { invoiceId, message });
      return Response.json({ error: message }, { status: 500 });
    }
  }, request);
}
