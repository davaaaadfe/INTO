import {
  addAuditEvent,
  createUploadedInvoice,
  detectContentDuplicate,
  findDuplicateBeforeProcessing,
  listInvoices,
  markInvoiceReading,
  recomputeInvoiceState,
  requirePermission,
  updateInvoiceExtraction,
} from "../../../lib/repository/invoice-store";
import { extractInvoiceData } from "../../../lib/services/invoice-extraction-service";
import {
  isSupportedInvoiceFile,
  storeInvoiceFile,
} from "../../../lib/services/storage-service";
import { logger } from "../../../lib/utils/logger";
import type {
  DuplicateDetectionResult,
  UploadedInvoice,
} from "../../../lib/domain/invoice";
import { withPersistentStore } from "../../../lib/repository/persistent-request";

export async function GET(request?: Request) {
  return withPersistentStore(() => Response.json({ invoices: listInvoices() }), request);
}

export async function POST(request: Request) {
  return withPersistentStore(async () => {
    try {
      requirePermission("upload");
      const formData = await request.formData();
      const files = formData
        .getAll("files")
        .filter((value): value is File => value instanceof File);
      const checksums = formData
        .getAll("checksums")
        .map((value) => (typeof value === "string" ? value : ""));

      if (files.length === 0) {
        return Response.json(
          { error: "Upload at least one invoice file." },
          { status: 400 }
        );
      }

      const processed: Array<UploadedInvoice | null> = [];
      const rejected: Array<{ fileName: string; checksum?: string; reason: string }> = [];
      const duplicates: Array<{
        fileName: string;
        fileSize: number;
        checksum?: string;
        reason: string;
        duplicateInvoiceId: string;
        exactBookingId?: string;
        detection: DuplicateDetectionResult;
      }> = [];

      for (const [index, file] of files.entries()) {
        const checksum = checksums[index] || undefined;

        if (!isSupportedInvoiceFile(file.name)) {
          rejected.push({
            fileName: file.name,
            checksum,
            reason: "Unsupported file type. Upload PDF, JPG, PNG, XML, or UBL invoices.",
          });
          continue;
        }

        const duplicate = findDuplicateBeforeProcessing({
          fileName: file.name,
          fileSize: file.size,
          checksum,
          source: "manual_upload",
        });

        if (duplicate) {
          duplicates.push({
            fileName: file.name,
            fileSize: file.size,
            checksum,
            reason: duplicate.detection.message,
            duplicateInvoiceId: duplicate.duplicate.id,
            exactBookingId: duplicate.detection.candidates[0]?.exactBookingId,
            detection: duplicate.detection,
          });
          continue;
        }

        const storedFile = await storeInvoiceFile(file);
        const invoice = createUploadedInvoice({
          source: "manual_upload",
          fileName: file.name,
          fileType: storedFile.fileType,
          fileSize: storedFile.fileSize,
          checksum: checksum ?? storedFile.checksum,
          storageKey: storedFile.storageKey,
        });

      logger.info("invoice.uploaded", {
        invoiceId: invoice.id,
        fileName: invoice.fileName,
        fileSize: invoice.fileSize,
      });

      markInvoiceReading(invoice.id);
      const extractedData = await extractInvoiceData(file);
      updateInvoiceExtraction(invoice.id, extractedData);
      addAuditEvent({
        invoiceId: invoice.id,
        type: "invoice_extracted",
        message: "Invoice data was extracted from the original uploaded file.",
        metadata: {
          source: invoice.source,
          confidence: extractedData.confidence,
        },
      });
      const validatedInvoice = recomputeInvoiceState(invoice.id);
      addAuditEvent({
        invoiceId: invoice.id,
        type: "invoice_validated",
        message: `Invoice validation completed with ${validatedInvoice?.validationErrors.length ?? 0} issue(s).`,
        metadata: {
          status: validatedInvoice?.status,
          errorCount: validatedInvoice?.validationErrors.length ?? 0,
        },
      });
      const duplicateDetection = detectContentDuplicate(invoice.id);
      const finalInvoice =
        duplicateDetection?.outcome === "possible_duplicate"
          ? recomputeInvoiceState(invoice.id)
          : validatedInvoice;

      logger.info("invoice.extracted_and_validated", {
        invoiceId: invoice.id,
        status: finalInvoice?.status,
        errorCount: finalInvoice?.validationErrors.length ?? 0,
      });

        processed.push(finalInvoice);
      }

      return Response.json(
        { invoices: listInvoices(), processed, rejected, duplicates },
        { status: 201 }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected upload error";
      logger.error("invoice.upload_failed", { message });
      return Response.json(
        { error: message },
        { status: message.includes("not allowed") ? 403 : 500 }
      );
    }
  }, request);
}
