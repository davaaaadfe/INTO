import test from "node:test";
import assert from "node:assert/strict";
import { emptyExtractedInvoiceData } from "../lib/domain/invoice";
import {
  createUploadedInvoice,
  getStore,
  recomputeInvoiceState,
  saveInvoiceReview,
  updateInvoiceExtraction,
} from "../lib/repository/invoice-store";

test("the active review save path persists booking-line corrections", () => {
  const invoice = createUploadedInvoice({
    fileName: "learning-save-001.pdf",
    fileType: "application/pdf",
    fileSize: 1000,
    storageKey: "storage/tmp-invoices/learning-save-001.pdf",
  });
  const extractedData = {
    ...emptyExtractedInvoiceData(),
    supplierName: "Noordzee Office Supplies",
    supplierVatNumber: "NL812345678B01",
    supplierCountry: "NL",
    invoiceNumber: "INV-SAVE-001",
    referenceCode: "INV-SAVE-001",
    invoiceDate: "2026-06-16",
    paymentTerms: "7 days",
    currency: "EUR",
    netAmount: 100,
    vatAmount: 21,
    grossAmount: 121,
    expenseDescription: "Office Supplies",
    companyVatNumber: "NL857017263B01",
    rawText: "Factuurnummer INV-SAVE-001\nOffice Supplies",
  };
  updateInvoiceExtraction(invoice.id, extractedData, { applyLearning: false });
  const computed = recomputeInvoiceState(invoice.id);
  assert.ok(computed?.purchaseJournal?.lines[0]);

  const originalLine = computed.purchaseJournal.lines[0];
  const saved = saveInvoiceReview(invoice.id, extractedData, [
    {
      ...originalLine,
      glAccount: "4420",
      finalSelectedAccount: "4420",
      glAccountName: "Software subscriptions",
    },
  ]);

  assert.equal(saved?.bookingLineOverrides?.[0].finalSelectedAccount, "4420");
  assert.equal(saved?.purchaseJournal?.lines[0].finalSelectedAccount, "4420");
  assert.ok(
    getStore().learning.corrections.some(
      (correction) =>
        correction.field === "glAccount" && correction.correctedValue === "4420"
    )
  );
});
