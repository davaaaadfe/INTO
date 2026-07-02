import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyExtractedInvoiceData,
  type ExtractedInvoiceData,
} from "../lib/domain/invoice";
import {
  amountToMinorUnits,
  validateInvoiceData,
} from "../lib/services/invoice-validation";

function validInvoice(overrides: Partial<ExtractedInvoiceData> = {}) {
  return {
    ...emptyExtractedInvoiceData(),
    supplierName: "Noordzee Office Supplies",
    supplierVatNumber: "NL812345678B01",
    invoiceNumber: "INV-001",
    invoiceDate: "2026-02-12",
    dueDate: "2026-03-13",
    currency: "EUR",
    netAmount: 100,
    vatAmount: 21,
    grossAmount: 121,
    iban: "NL91ABNA0417164300",
    lineItems: [],
    ...overrides,
  };
}

test("accepts a complete invoice with exact net plus VAT total", () => {
  const errors = validateInvoiceData("invoice_1", validInvoice(), []);
  assert.equal(errors.length, 0);
});

test("does not allow rounding differences in the gross amount", () => {
  const errors = validateInvoiceData(
    "invoice_1",
    validInvoice({ grossAmount: 121.01 }),
    []
  );

  assert.equal(errors.some((error) => error.field === "grossAmount"), true);
});

test("rejects amounts that need rounding instead of exact cents", () => {
  assert.equal(amountToMinorUnits("10.005"), null);
});

test("requires due date and invoice number", () => {
  const errors = validateInvoiceData(
    "invoice_1",
    validInvoice({ dueDate: "", invoiceNumber: "" }),
    []
  );

  assert.equal(errors.some((error) => error.field === "dueDate"), true);
  assert.equal(errors.some((error) => error.field === "invoiceNumber"), true);
});

test("flags duplicate invoice numbers for the same supplier", () => {
  const errors = validateInvoiceData("invoice_2", validInvoice(), [
    {
      id: "invoice_1",
      supplierName: "noordzee office supplies",
      invoiceNumber: "inv-001",
    },
  ]);

  assert.equal(errors.some((error) => error.field === "duplicate"), true);
});
