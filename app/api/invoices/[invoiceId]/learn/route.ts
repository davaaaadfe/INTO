import type {
  ExtractedInvoiceData,
  PurchaseJournalLine,
} from "../../../../../lib/domain/invoice";
import {
  getInvoice,
  learnInvoice,
  requirePermission,
} from "../../../../../lib/repository/invoice-store";
import { withPersistentStore } from "../../../../../lib/repository/persistent-request";

type RouteContext = {
  params: { invoiceId: string } | Promise<{ invoiceId: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  return withPersistentStore(async () => {
    try {
      requirePermission("train");
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Not allowed." },
        { status: 403 }
      );
    }

    const { invoiceId } = await context.params;
    const invoice = getInvoice(invoiceId);
    if (!invoice) {
      return Response.json({ error: "Invoice not found." }, { status: 404 });
    }

    try {
      const payload = (await request.json()) as {
        extractedData?: Partial<ExtractedInvoiceData>;
        bookingLines?: PurchaseJournalLine[];
      };
      const correctedData = {
        ...invoice.extractedData,
        ...(payload.extractedData ?? {}),
      };
      const bookingLines = Array.isArray(payload.bookingLines)
        ? payload.bookingLines
        : invoice.bookingLineOverrides ?? invoice.purchaseJournal?.lines ?? [];
      const learned = learnInvoice(invoiceId, correctedData, bookingLines);
      return Response.json({
        message: "Learning saved for this supplier.",
        invoice: learned,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Learning failed.";
      return Response.json({ error: message, invoice: getInvoice(invoiceId) }, { status: 409 });
    }
  });
}
