import test from "node:test";
import assert from "node:assert/strict";
import {
  type DuplicateCandidate,
  emptyExtractedInvoiceData,
  type ExtractedInvoiceData,
} from "../lib/domain/invoice";
import {
  amountToMinorUnits,
  validateInvoiceData,
} from "../lib/services/invoice-validation";
import { detectInvoiceReference } from "../lib/services/invoice-extraction-service";

function validInvoice(overrides: Partial<ExtractedInvoiceData> = {}) {
  return {
    ...emptyExtractedInvoiceData(),
    supplierName: "Noordzee Office Supplies",
    supplierVatNumber: "NL812345678B01",
    invoiceNumber: "INV-001",
    referenceCode: "INV-001",
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

test("allows optional additional invoice data to be empty", () => {
  const errors = validateInvoiceData(
    "invoice_1",
    validInvoice({ dueDate: "", invoiceNumber: "", currency: "" }),
    []
  );

  assert.equal(errors.some((error) => error.field === "dueDate"), false);
  assert.equal(errors.some((error) => error.field === "invoiceNumber"), false);
  assert.equal(errors.some((error) => error.field === "currency"), false);
});

test("requires Your ref before booking to Exact Online", () => {
  const errors = validateInvoiceData(
    "invoice_1",
    validInvoice({ referenceCode: "" }),
    []
  );

  assert.equal(
    errors.some(
      (error) =>
        error.field === "referenceCode" &&
        error.message === "Your ref. is required before booking to Exact Online."
    ),
    true
  );
});

test("flags duplicate Your ref for the same supplier near the field", () => {
  const duplicateCandidates: DuplicateCandidate[] = [
    {
      id: "invoice_1",
      supplierName: "noordzee office supplies",
      invoiceNumber: "inv-old",
      referenceCode: "fac-2026-001",
    },
  ];
  const errors = validateInvoiceData(
    "invoice_2",
    validInvoice({ invoiceNumber: "INV-NEW", referenceCode: "FAC-2026-001" }),
    duplicateCandidates
  );

  assert.equal(
    errors.some(
      (error) =>
        error.field === "referenceCode" &&
        error.message ===
          "This invoice reference already exists for this supplier. Duplicate invoices cannot be booked."
    ),
    true
  );
});

test("still flags duplicate invoice numbers for the same supplier when Your ref falls back to invoice number", () => {
  const errors = validateInvoiceData("invoice_2", validInvoice(), [
    {
      id: "invoice_1",
      supplierName: "noordzee office supplies",
      invoiceNumber: "inv-001",
    },
  ]);

  assert.equal(errors.some((error) => error.field === "referenceCode"), true);
});

test("detects multilingual invoice reference labels without using VAT or IBAN", () => {
  assert.equal(
    detectInvoiceReference("Factuurnummer: FAC-2026-001\nIBAN NL91ABNA0417164300")
      ?.value,
    "FAC-2026-001"
  );
  assert.equal(
    detectInvoiceReference("Rechnungsnummer: RE-2026-778\nUSt-IdNr DE123456789")
      ?.value,
    "RE-2026-778"
  );
  assert.equal(
    detectInvoiceReference("IBAN NL91ABNA0417164300\nVAT NL857017263B01"),
    null
  );
});
