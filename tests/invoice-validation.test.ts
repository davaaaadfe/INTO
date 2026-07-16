import test from "node:test";
import assert from "node:assert/strict";
import {
  type DuplicateCandidate,
  emptyExtractedInvoiceData,
  type ExtractedInvoiceData,
} from "../lib/domain/invoice";
import {
  amountToMinorUnits,
  BOOKING_TOTAL_MISMATCH_MESSAGE,
  validateInvoiceData,
} from "../lib/services/invoice-validation";
import {
  detectInvoiceDate,
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

function pdfBytesWithText(lines: string[]) {
  const escapedLines = lines.map((line) =>
    line.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")
  );
  const content = [
    "BT",
    "/F1 12 Tf",
    "14 TL",
    "72 740 Td",
    ...escapedLines.flatMap((line, index) => [
      index ? "T*" : "",
      `(${line}) Tj`,
    ]).filter(Boolean),
    "ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(body, "ascii");
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

  const mismatch = errors.find((error) => error.field === "grossAmount");
  assert.equal(mismatch?.message, BOOKING_TOTAL_MISMATCH_MESSAGE);
});

test("rejects amounts that need rounding instead of exact cents", () => {
  assert.equal(amountToMinorUnits("10.005"), null);
});

test("parses European and English invoice amounts as exact cents", () => {
  assert.equal(amountToMinorUnits("€1.234,56"), 123456);
  assert.equal(amountToMinorUnits("€1,234.56"), 123456);
  assert.equal(amountToMinorUnits("1 234,56 EUR"), 123456);
  assert.equal(amountToMinorUnits("1.234,56 PLN"), 123456);
  assert.equal(amountToMinorUnits("\u20ac1.234,56"), 123456);
  assert.equal(amountToMinorUnits("\u20ac1,234.56"), 123456);
});

test("extracts the nearest labelled amounts from a compact summary row", async () => {
  const data = await extractInvoiceData({
    name: "invoice-compact-summary.xml",
    type: "application/xml",
    size: 1000,
    text: async () =>
      [
        "Invoice number: COMPACT-2026-001",
        "Subtotal \u20ac1.234,56 VAT 21% \u20ac259,26 Total \u20ac1.493,82",
        "Payment terms: 30 days",
      ].join("\n"),
  });

  assert.equal(data.netAmount, 1234.56);
  assert.equal(data.vatAmount, 259.26);
  assert.equal(data.grossAmount, 1493.82);
});

test("extracts Amazon-style summary values split across nearby lines", async () => {
  const data = await extractInvoiceData({
    name: "invoice-amazon-summary.xml",
    type: "application/xml",
    size: 1000,
    text: async () =>
      [
        "Invoice number: AMAZON-2026-001",
        "Invoice Summary Invoice Amount Due",
        "500,15 EUR",
        "Subtotal 500,15 EUR",
        "VAT(0%) - GERMANY 0,00 EUR",
        "Tax Subtotal 0,00 EUR",
        "Total Amount Due 500,15 EUR",
      ].join("\n"),
  });

  assert.equal(data.netAmount, 500.15);
  assert.equal(data.vatAmount, 0);
  assert.equal(data.grossAmount, 500.15);
});

test("uses the invoice total instead of a zero post-payment balance", async () => {
  const data = await extractInvoiceData({
    name: "invoice-paid.xml",
    type: "application/xml",
    size: 1000,
    text: async () =>
      [
        "Invoice number: PAID-2026-001",
        "Subtotal \u20ac55.00",
        "VAT (0%) \u20ac0.00",
        "Invoice Amount \u20ac55.00 (EUR)",
        "Total \u20ac55.00",
        "Payments (\u20ac55.00)",
        "Amount Due \u20ac0.00",
      ].join("\n"),
  });

  assert.equal(data.netAmount, 55);
  assert.equal(data.vatAmount, 0);
  assert.equal(data.grossAmount, 55);
});

test("extracts Dutch tax summary labels without using item-row numbers", async () => {
  const data = await extractInvoiceData({
    name: "invoice-dutch-summary.xml",
    type: "application/xml",
    size: 1000,
    text: async () =>
      [
        "Factuurnummer: NL-2026-001",
        "PRODUCT HOEVEELHEID PRIJS NETTO BEDRAG BELASTING TOTAAL",
        "Acrobat Pro 1 19.99 19.99 0.00% 0.00 19.99",
        "FACTUURTOTAAL",
        "NETTO BEDRAG (EUR) 19.99",
        "BELASTING (ZIE DETAILS) 0.00",
        "TOTAAL (EUR) 19.99",
      ].join("\n"),
  });

  assert.equal(data.netAmount, 19.99);
  assert.equal(data.vatAmount, 0);
  assert.equal(data.grossAmount, 19.99);
});

test("keeps an explicit invoice total when a later line-item total is present", async () => {
  const data = await extractInvoiceData({
    name: "invoice-later-line-total.xml",
    type: "application/xml",
    size: 1000,
    text: async () =>
      [
        "Invoice number: TOTAL-2026-001",
        "Net amount 100.00",
        "VAT amount 21.00",
        "Invoice total 121.00",
        "Item A line total 40.00",
      ].join("\n"),
  });

  assert.equal(data.netAmount, 100);
  assert.equal(data.vatAmount, 21);
  assert.equal(data.grossAmount, 121);
});

test("does not use a VAT total as the invoice total", async () => {
  const data = await extractInvoiceData({
    name: "invoice-without-final-total.xml",
    type: "application/xml",
    size: 1000,
    text: async () =>
      [
        "Invoice number: NO-TOTAL-2026-001",
        "Net amount 100.00",
        "VAT Total 21.00",
        "Item A 100.00",
      ].join("\n"),
  });

  assert.equal(data.netAmount, 100);
  assert.equal(data.vatAmount, 21);
  assert.equal(data.grossAmount, null);
});

test("extracts the exact red-box summary amounts from representative invoice layouts", async () => {
  const examples = [
    {
      name: "dutch-three-column-total.xml",
      text: [
        "Te betalen inclusief btw 156,78",
        "Omschrijving Btw Exclusief btw Btw-bedrag Inclusief btw",
        "Boodschappen, zie specificatie 9% 136,70 12,28 148,98",
        "Totaal 144,10 12,68 156,78",
      ].join("\n"),
      expected: [144.1, 12.68, 156.78],
    },
    {
      name: "dutch-explicit-excl-incl.xml",
      text: [
        "Subtotaal EUR 271,80",
        "Toeslagen EUR 7,30",
        "Totaal (excl. BTW) EUR 279,10",
        "BTW 21,0% EUR 58,61",
        "Totaal (incl. BTW) EUR 337,71",
      ].join("\n"),
      expected: [279.1, 58.61, 337.71],
    },
    {
      name: "dutch-adjacent-summary-columns.xml",
      text: [
        "Subtotaal btw Totaal",
        "EUR 110,70 EUR 23,25 EUR 133,95",
        "Totaal te betalen EUR 133,95",
      ].join("\n"),
      expected: [110.7, 23.25, 133.95],
    },
    {
      name: "english-zero-vat-summary.xml",
      text: [
        "Subtotal EUR 28.00",
        "VAT 0.0% EUR 0.00",
        "Total EUR 28.00",
      ].join("\n"),
      expected: [28, 0, 28],
    },
    {
      name: "dutch-payable-summary.xml",
      text: [
        "Totaal excl. BTW 2.907,87",
        "BTW 0,00",
        "Te betalen (EUR) 2.907,87",
      ].join("\n"),
      expected: [2907.87, 0, 2907.87],
    },
    {
      name: "negative-credit-summary.xml",
      text: [
        "Total excl. VAT: -EUR 139,20",
        "21,00% VAT -EUR 29,23",
        "To receive: -EUR 168,43",
      ].join("\n"),
      expected: [-139.2, -29.23, -168.43],
    },
  ] as const;

  for (const example of examples) {
    const data = await extractInvoiceData({
      name: example.name,
      type: "application/xml",
      size: example.text.length,
      text: async () => example.text,
    });

    assert.deepEqual(
      [data.netAmount, data.vatAmount, data.grossAmount],
      example.expected,
      example.name
    );
  }
});

test("uses a clear first-page summary instead of totals on irrelevant later pages", async () => {
  const data = await extractInvoiceData({
    name: "multi-page-first-summary.xml",
    type: "application/xml",
    size: 1000,
    text: async () =>
      [
        [
          "Invoice number: MULTI-FIRST-001",
          "Net amount 100.00",
          "VAT amount 21.00",
          "Invoice total 121.00",
        ].join("\n"),
        "Line item appendix\nLine total 40.00",
        "Previous invoice total 999.00\nHistorical balance due 0.00",
      ].join("\f"),
  });

  assert.deepEqual(
    [data.netAmount, data.vatAmount, data.grossAmount],
    [100, 21, 121]
  );
});

test("prioritizes a clear last-page payable summary over a first-page total", async () => {
  const data = await extractInvoiceData({
    name: "multi-page-last-summary.xml",
    type: "application/xml",
    size: 1000,
    text: async () =>
      [
        "Invoice total shown in order history 999.00",
        "--- PAGE 2 ---\nItem A 80.00\nItem B 120.00",
        [
          "--- PAGE 3 ---",
          "Subtotal 200.00",
          "VAT amount 42.00",
          "Amount due 242.00",
        ].join("\n"),
      ].join("\f"),
  });

  assert.deepEqual(
    [data.netAmount, data.vatAmount, data.grossAmount],
    [200, 42, 242]
  );
});

test("extracts the exact European net, VAT, and printed invoice total", async () => {
  const data = await extractInvoiceData({
    name: "invoice-european.xml",
    type: "application/xml",
    size: 1000,
    text: async () =>
      [
        "Factuurnummer: EU-2026-001",
        "Netto bedrag: € 1.234,56",
        "BTW 21%: € 259,26",
        "Totaal factuur: € 1.493,82",
      ].join("\n"),
  });

  assert.equal(data.netAmount, 1234.56);
  assert.equal(data.vatAmount, 259.26);
  assert.equal(data.grossAmount, 1493.82);
  assert.equal(data.lineItems[0]?.netAmount, 1234.56);
  assert.equal(data.lineItems[0]?.vatAmount, 259.26);
  assert.equal(data.lineItems[0]?.grossAmount, 1493.82);
});

test("preserves an explicit English invoice total instead of recalculating it", async () => {
  const data = await extractInvoiceData({
    name: "invoice-english.xml",
    type: "application/xml",
    size: 1000,
    text: async () =>
      [
        "Invoice number: EN-2026-001",
        "Subtotal: €1,234.56",
        "VAT amount 21%: €259.26",
        "Invoice total: €1,493.83",
      ].join("\n"),
  });

  assert.equal(data.netAmount, 1234.56);
  assert.equal(data.vatAmount, 259.26);
  assert.equal(data.grossAmount, 1493.83);
  assert.equal(
    validateInvoiceData("invoice_explicit_total", data, []).some(
      (error) => error.field === "grossAmount"
    ),
    true
  );
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

test("extracts the labelled invoice date instead of due or delivery dates", () => {
  assert.equal(
    detectInvoiceDate(
      "Vervaldatum: 01-04-2026\nFactuurdatum: 20-03-2026\nLeverdatum: 18-03-2026"
    )?.value,
    "2026-03-20"
  );
  assert.equal(
    detectInvoiceDate("Invoice date: March 24, 2026\nDue date: April 24, 2026")
      ?.value,
    "2026-03-24"
  );
  assert.equal(
    detectInvoiceDate("Rechnungsdatum: 31.03.2026\nFaellig: 30.04.2026")
      ?.value,
    "2026-03-31"
  );
  assert.equal(
    detectInvoiceDate("Date de facture : 31/03/2026\nEcheance : 30/04/2026")
      ?.value,
    "2026-03-31"
  );
  assert.equal(
    detectInvoiceDate("Invoice date: 03/24/2026")?.value,
    "2026-03-24"
  );
  assert.equal(detectInvoiceDate("Due date: 04/05/2026"), null);
});

test("stores actual document text and evidence for extracted booking values", async () => {
  const text = [
    "Factuurnummer: AH-2026-004821",
    "Factuurdatum: 24-03-2026",
    "Totaal excl. BTW 110,70",
    "BTW 21% 23,25",
    "Totaal te betalen 133,95",
  ].join("\n");
  const data = await extractInvoiceData({
    name: "invoice.pdf",
    type: "application/pdf",
    size: text.length,
    text: async () => text,
  });

  assert.equal(data.invoiceDate, "2026-03-24");
  assert.equal(data.rawText, text);
  assert.equal(data.documentTextMode, "plain_text");
  assert.equal(data.extractionEvidence?.referenceCode?.rawValue, "AH-2026-004821");
  assert.equal(data.extractionEvidence?.invoiceDate?.rawValue, "24-03-2026");
  assert.equal(data.extractionEvidence?.grossAmount?.rawValue, "133,95");
});

test("extracts labelled values from embedded PDF text", async () => {
  const bytes = pdfBytesWithText([
    "Invoice number: PDF-2026-001",
    "Invoice date: March 24, 2026",
    "Net amount 100.00",
    "VAT amount 21.00",
    "Invoice total 121.00",
  ]);
  const data = await extractInvoiceData({
    name: "embedded-text.pdf",
    type: "application/pdf",
    size: bytes.length,
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  });

  assert.equal(data.documentTextMode, "embedded_pdf_text");
  assert.equal(data.referenceCode, "PDF-2026-001");
  assert.equal(data.invoiceDate, "2026-03-24");
  assert.equal(data.grossAmount, 121);
  assert.equal(data.extractionEvidence?.grossAmount?.page, 1);
});

test("does not invent reference or invoice date from the filename", async () => {
  const data = await extractInvoiceData({
    name: "INV-2026-7788-2026-03-24.pdf",
    type: "application/pdf",
    size: 0,
  });

  assert.equal(data.referenceCode, "");
  assert.equal(data.invoiceDate, "");
});
