import type {
  ExtractedInvoiceData,
  PurchaseJournalLine,
} from "../../../../../lib/domain/invoice";
import {
  getInvoice,
  InvoiceLearningPreconditionError,
  InvoiceRevisionConflictError,
  InvoiceRevisionValidationError,
  learnInvoice,
} from "../../../../../lib/repository/invoice-store";
import { withPersistentStore } from "../../../../../lib/repository/persistent-request";
import {
  learningFeatureFlags,
  supplierLearningMode,
} from "../../../../../lib/services/learning-feature-flags";

type RouteContext = {
  params: { invoiceId: string } | Promise<{ invoiceId: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  return withPersistentStore(async () => {
    const flags = learningFeatureFlags();
    if (
      !flags.learningV2Enabled ||
      !flags.learnWorkflowEnabled ||
      supplierLearningMode() === "off"
    ) {
      return Response.json(
        { error: "Supplier learning is not enabled." },
        { status: 404 }
      );
    }
    const { invoiceId } = await context.params;
    const invoice = getInvoice(invoiceId);
    if (!invoice) {
      return Response.json({ error: "Invoice not found." }, { status: 404 });
    }

    try {
      const payload = (await request.json()) as {
        expectedRevision?: unknown;
        requestKey?: unknown;
        extractedData?: Partial<ExtractedInvoiceData>;
        bookingLines?: PurchaseJournalLine[];
      };
      if (
        typeof payload.expectedRevision !== "number" ||
        !Number.isInteger(payload.expectedRevision) ||
        payload.expectedRevision <= 0
      ) {
        return Response.json(
          { error: "expectedRevision must be a positive integer.", code: "invalid_expected_revision" },
          { status: 422 }
        );
      }
      const correctedData = {
        ...invoice.extractedData,
        ...(payload.extractedData ?? {}),
      };
      const bookingLines = Array.isArray(payload.bookingLines)
        ? payload.bookingLines
        : invoice.bookingLineOverrides ?? invoice.purchaseJournal?.lines ?? [];
      const previousRevision = invoice.revision;
      const previousRequestFingerprint = invoice.learningMetadata?.requestFingerprint;
      const requestKey =
        request.headers.get("idempotency-key")?.trim() ||
        (typeof payload.requestKey === "string" ? payload.requestKey : undefined);
      const learned = learnInvoice(
        invoiceId,
        correctedData,
        bookingLines,
        payload.expectedRevision as number,
        requestKey
      );
      const replayed = Boolean(
        learned?.revision === previousRevision &&
          previousRequestFingerprint &&
          learned.learningMetadata?.requestFingerprint === previousRequestFingerprint
      );
      return Response.json({
        message: "Learning saved for this supplier.",
        invoice: learned,
        learning: learned?.learningMetadata
          ? {
              exampleId: learned.learningMetadata.exampleId,
              generation: learned.learningMetadata.generation,
              savedAt: learned.learningMetadata.learnedAt,
              replayed,
            }
          : undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Learning failed.";
      if (error instanceof InvoiceRevisionConflictError) {
        return Response.json(
          {
            error: message,
            code: error.code,
            currentInvoice: error.currentInvoice,
          },
          { status: 409 }
        );
      }
      if (error instanceof InvoiceRevisionValidationError) {
        return Response.json({ error: message, code: error.code }, { status: 422 });
      }
      if (error instanceof InvoiceLearningPreconditionError) {
        return Response.json({ error: message, code: error.code }, { status: 422 });
      }
      if (error instanceof SyntaxError) {
        return Response.json({ error: "Invalid request data." }, { status: 422 });
      }
      throw error;
    }
  }, request);
}
