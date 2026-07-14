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
import {
  detectInvoiceReference,
  extractInvoiceData,
} from "../lib/services/invoice-extraction-service";

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

test("supports the configured Dutch, English, German, French, Spanish, and Italian labels", () => {
  const labelledReferences = [
    ["Factuur nr.", "NL-10001"],
    ["Factuurnr", "NL-10002"],
    ["Referentie", "NL-10003"],
    ["Kenmerk", "NL-10004"],
    ["Invoice number", "EN-10001"],
    ["Invoice no.", "EN-10002"],
    ["Invoice #", "EN-10003"],
    ["Reference", "EN-10004"],
    ["Ref.", "EN-10005"],
    ["Document number", "EN-10006"],
    ["Bill number", "EN-10007"],
    ["Rechnungsnummer", "DE-10001"],
    ["Rechnung Nr.", "DE-10002"],
    ["Belegnummer", "DE-10003"],
    ["Referenz", "DE-10004"],
    ["Num\u00e9ro de facture", "FR-10001"],
    ["N\u00b0 facture", "FR-10002"],
    ["R\u00e9f\u00e9rence", "FR-10003"],
    ["N\u00famero de factura", "ES-10001"],
    ["N\u00ba factura", "ES-10002"],
    ["Referencia", "ES-10003"],
    ["Numero fattura", "IT-10001"],
    ["N. fattura", "IT-10002"],
    ["Riferimento", "IT-10003"],
  ];

  for (const [label, expected] of labelledReferences) {
    assert.equal(detectInvoiceReference(`${label}: ${expected}`)?.value, expected);
  }
});

test("keeps the exact invoice reference text when detected", () => {
  assert.equal(
    detectInvoiceReference("Invoice no.: Inv-2026/Ab-001")?.value,
    "Inv-2026/Ab-001"
  );
});

test("extracts Albert Heijn Factuurnummer from the uploaded invoice text", async () => {
  const file = {
    name: "albert-heijn-invoice.pdf",
    type: "application/pdf",
    size: 1000,
    text: async () =>
      "Albert Heijn\nFactuurnummer: AH-2026-004821\nKlantnummer: 887766\nIBAN: NL91ABNA0417164300",
  };

  const data = await extractInvoiceData(file);

  assert.equal(data.invoiceNumber, "AH-2026-004821");
  assert.equal(data.referenceCode, "AH-2026-004821");
});

test("leaves Your ref empty when only an unlabeled invoice-like token is present", async () => {
  const file = {
    name: "supplier-document.pdf",
    type: "application/pdf",
    size: 1000,
    text: async () => "INV-2026-004821\nOrder number: PO-778899\nCustomer number: 887766",
  };

  const data = await extractInvoiceData(file);

  assert.equal(data.invoiceNumber, "");
  assert.equal(data.referenceCode, "");
});

test("does not treat payment, order, customer, supplier, VAT, or IBAN values as Your ref", () => {
  for (const text of [
    "Payment reference: RF-2026-004821",
    "Order number: PO-778899",
    "Customer number: 887766",
    "Supplier number: 112233",
    "VAT number: NL857017263B01",
    "IBAN: NL91ABNA0417164300",
  ]) {
    assert.equal(detectInvoiceReference(text), null);
  }
});

test("does not invent Your ref when no invoice reference is confidently detected", async () => {
  const data = await extractInvoiceData({
    name: "plain-office-supplies.pdf",
    type: "application/pdf",
    size: 1000,
  });

  assert.equal(data.referenceCode, "");
  assert.equal(data.invoiceNumber, "");
});
