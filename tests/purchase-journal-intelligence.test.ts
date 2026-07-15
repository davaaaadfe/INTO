import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyExtractedInvoiceData,
  type ExtractedInvoiceData,
  type UploadedInvoice,
} from "../lib/domain/invoice";
import {
  createInitialLearningStore,
  generatePurchaseJournalBooking,
  purchaseJournalValidationErrors,
  statusFromPurchaseJournal,
} from "../lib/services/purchase-journal-intelligence";
import { createMockExactMasterData } from "../lib/services/exact-master-data-service";
import {
  bookInvoiceInExact,
  createMockExactConnection,
} from "../lib/services/exact-online-service";
import { storeMockInvoiceFile } from "../lib/services/storage-service";

const exactMasterData = createMockExactMasterData();

function extractedInvoice(
  overrides: Partial<ExtractedInvoiceData> = {}
): ExtractedInvoiceData {
  return {
    ...emptyExtractedInvoiceData(),
    supplierName: "Noordzee Office Supplies",
    supplierVatNumber: "NL812345678B01",
    supplierChamberOfCommerceNumber: "34123456",
    supplierAddress: "Keizersgracht 100, Amsterdam",
    supplierCountry: "NL",
    invoiceNumber: "INV-PJ-001",
    invoiceDate: "2026-06-16",
    dueDate: "2026-07-16",
    paymentTerms: "7 days",
    currency: "EUR",
    netAmount: 100,
    vatAmount: 21,
    grossAmount: 121,
    iban: "NL91ABNA0417164300",
    expenseDescription: "Office Supplies",
    companyVatNumber: "NL857017263B01",
    lineItems: [
      {
        id: "line_1",
        description: "Office Supplies",
        quantity: 1,
        unitPrice: 100,
        netAmount: 100,
        vatRate: 0.21,
        vatAmount: 21,
        grossAmount: 121,
      },
    ],
    ...overrides,
  };
}

function uploadedInvoice(
  overrides: Partial<UploadedInvoice> = {},
  dataOverrides: Partial<ExtractedInvoiceData> = {}
): UploadedInvoice {
  const invoice: UploadedInvoice = {
    id: "invoice_test",
    userId: "user_accountant",
    uploadedByUserId: "user_accountant",
    uploadedByName: "Tammy Park",
    source: "manual_upload",
    fileName: "test-invoice.pdf",
    fileType: "application/pdf",
    fileSize: 12_000,
    storageKey: "invoices/test-invoice.pdf",
    localFileStatus: "available",
    status: "Uploaded",
    exactBookingStatus: "not_booked",
    extractedData: extractedInvoice(dataOverrides),
    extractionHistory: [],
    purchaseJournal: null,
    validationErrors: [],
    bookingAttempts: [],
    createdAt: "2026-06-16T00:00:00.000Z",
    updatedAt: "2026-06-16T00:00:00.000Z",
    ...overrides,
  };

  return invoice;
}

function buildBooking(invoice: UploadedInvoice) {
  return generatePurchaseJournalBooking(
    invoice,
    [invoice],
    createInitialLearningStore(),
    exactMasterData
  );
}

test("blocks booking until Exact master data is synced", () => {
  const invoice = uploadedInvoice();
  const booking = generatePurchaseJournalBooking(
    invoice,
    [invoice],
    createInitialLearningStore(),
    null
  );

  assert.equal(booking.autoBookAllowed, false);
  assert.equal(statusFromPurchaseJournal([], booking), "Booking Intelligence Review Required");
  assert.equal(
    purchaseJournalValidationErrors(booking).some(
      (error) => error.field === "exactMasterData"
    ),
    true
  );
});

test("blocks booking when the original invoice attachment is missing", () => {
  const invoice = uploadedInvoice({
    fileSize: 0,
    storageKey: "",
  });
  const booking = buildBooking(invoice);

  assert.equal(booking.attachmentPresent, false);
  assert.equal(statusFromPurchaseJournal([], booking), "Attachment Missing");
  assert.equal(
    purchaseJournalValidationErrors(booking).some(
      (error) => error.field === "attachment"
    ),
    true
  );
});

test("requires booking data fields but ignores empty additional and removed fields", () => {
  const invoice = uploadedInvoice(
    {},
    {
      supplierName: "",
      supplierVatNumber: "",
      supplierChamberOfCommerceNumber: "",
      supplierAddress: "",
      supplierCountry: "",
      invoiceNumber: "",
      referenceCode: "",
      invoiceDate: "",
      dueDate: "",
      paymentTerms: "",
      currency: "",
      netAmount: null,
      vatAmount: null,
      grossAmount: null,
      iban: "",
      expenseDescription: "",
      beneficiary: "",
      serviceStartDate: "",
      serviceEndDate: "",
      companyVatNumber: "",
    }
  );
  const booking = buildBooking(invoice);
  const firstLine = booking.lines[0];
  firstLine.finalSelectedAccount = "";
  firstLine.glAccount = "";
  firstLine.from = "";
  firstLine.to = "";
  firstLine.vatCode = "" as never;

  const errors = purchaseJournalValidationErrors(booking, invoice.extractedData);
  const errorFields = new Set(errors.map((error) => String(error.field)));

  assert.equal(
    errors.some((error) => error.message.includes("Duplicate invoices cannot be booked")),
    false
  );

  for (const field of [
    "supplierName",
    "expenseDescription",
    "referenceCode",
    "paymentTerms",
    "invoiceDate",
    "glAccount",
    "vatCode",
    "netAmount",
    "vatAmount",
    "grossAmount",
  ]) {
    assert.equal(
      errorFields.has(field),
      true,
      `${field} should block booking when missing`
    );
  }

  for (const field of [
    "dueDate",
    "invoiceNumber",
    "currency",
    "supplierVatNumber",
    "supplierChamberOfCommerceNumber",
    "supplierAddress",
    "supplierCountry",
    "iban",
    "beneficiary",
    "serviceStartDate",
    "serviceEndDate",
    "companyVatNumber",
  ]) {
    assert.equal(
      errorFields.has(field),
      false,
      `${field} should not block booking when empty`
    );
  }
});

test("does not require accrual dates for one-time invoices", () => {
  const invoice = uploadedInvoice({}, {
    referenceCode: "INV-PJ-001",
    serviceStartDate: "",
    serviceEndDate: "",
  });
  const booking = buildBooking(invoice);
  const firstLine = booking.lines[0];
  firstLine.from = "";
  firstLine.to = "";
  firstLine.accrualReason = undefined;

  const errors = purchaseJournalValidationErrors(booking, invoice.extractedData);
  const errorFields = new Set(errors.map((error) => String(error.field)));

  assert.equal(errorFields.has("accrualFrom"), false);
  assert.equal(errorFields.has("accrualTo"), false);
});

test("requires accrual dates only when accrual applies", () => {
  const invoice = uploadedInvoice({}, {
    referenceCode: "INV-PJ-001",
    serviceStartDate: "2026-01-15",
    serviceEndDate: "2026-06-30",
    expenseDescription: "Software subscription",
  });
  const booking = buildBooking(invoice);
  const firstLine = booking.lines[0];
  firstLine.from = "";
  firstLine.to = "";

  const errors = purchaseJournalValidationErrors(booking, invoice.extractedData);
  const errorFields = new Set(errors.map((error) => String(error.field)));

  assert.equal(errorFields.has("accrualFrom"), true);
  assert.equal(errorFields.has("accrualTo"), true);
});

test("blocks a duplicate Your ref for the same supplier with the required message", () => {
  const previous = uploadedInvoice(
    { id: "invoice_previous" },
    { invoiceNumber: "AH-2026-004821", referenceCode: "AH-2026-004821" }
  );
  const current = uploadedInvoice(
    { id: "invoice_current" },
    { invoiceNumber: "AH-2026-004821", referenceCode: "AH-2026-004821" }
  );
  const booking = generatePurchaseJournalBooking(
    current,
    [previous, current],
    createInitialLearningStore(),
    exactMasterData
  );
  const errors = purchaseJournalValidationErrors(booking, current.extractedData);

  assert.equal(booking.yourRefUnique, false);
  assert.equal(
    errors.some(
      (error) =>
        error.field === "yourRef" &&
        error.message ===
          "This invoice reference already exists for this supplier. Duplicate invoices cannot be booked."
    ),
    true
  );
});

test("marks multiple matching suppliers for manual supplier review", () => {
  const invoice = uploadedInvoice({}, {
    supplierName: "Acme Supplies BV",
    supplierVatNumber: "NL123456789B01",
    supplierChamberOfCommerceNumber: "",
    iban: "",
    invoiceNumber: "INV-ACME-001",
  });
  const booking = buildBooking(invoice);

  assert.equal(booking.supplierResolution.reviewRequired, true);
  assert.equal(booking.supplierResolution.selectedAccountId, undefined);
  assert.equal(statusFromPurchaseJournal([], booking), "Supplier Review Required");
  assert.equal(
    purchaseJournalValidationErrors(booking).some(
      (error) =>
        error.field === "supplier" &&
        error.message ===
          "Multiple Exact suppliers match this invoice. Please choose the correct supplier."
    ),
    true
  );
});

test("uses a unique VAT match before conflicting historical evidence", () => {
  const invoice = uploadedInvoice(
    {},
    {
      supplierName: "Acme Supplies BV - Eindhoven",
      supplierVatNumber: "NL812345678B01",
      supplierChamberOfCommerceNumber: "",
      iban: "",
      expenseDescription: "Office Supplies",
      invoiceNumber: "INV-VAT-PRIORITY-001",
    }
  );
  const masterData = {
    ...exactMasterData,
    historicalPurchaseBookings: [
      ...exactMasterData.historicalPurchaseBookings,
      {
        id: "hist_conflicting_supplier",
        supplierAccountId: "supplier_ambiguous_b",
        descriptionKey: "office-supplies",
        glAccount: "4400",
        vatCode: "4",
      },
    ],
  };
  const booking = generatePurchaseJournalBooking(
    invoice,
    [invoice],
    createInitialLearningStore(),
    masterData
  );

  assert.equal(booking.supplierResolution.reviewRequired, false);
  assert.equal(booking.supplierResolution.selectedAccountId, "supplier_noordzee");
  assert.equal(booking.supplierResolution.method, "VAT number");
});

test("shows the required guidance when no Exact supplier can be matched", () => {
  const invoice = uploadedInvoice(
    {},
    {
      supplierName: "Completely Unknown Vendor",
      supplierVatNumber: "",
      supplierChamberOfCommerceNumber: "",
      iban: "",
      expenseDescription: "Unrelated expense",
      invoiceNumber: "INV-UNKNOWN-001",
    }
  );
  const booking = buildBooking(invoice);

  assert.equal(booking.supplierResolution.reviewRequired, true);
  assert.equal(booking.supplierResolution.selectedAccountId, undefined);
  assert.equal(
    purchaseJournalValidationErrors(booking).some(
      (error) =>
        error.field === "supplier" &&
        error.message ===
          "Supplier could not be matched to Exact Online master data. Please select the supplier manually."
    ),
    true
  );
});

test("matches an Exact supplier name despite legal suffix punctuation", () => {
  const invoice = uploadedInvoice(
    {},
    {
      supplierName: "Booking.com B.V.",
      supplierVatNumber: "",
      supplierChamberOfCommerceNumber: "",
      iban: "",
      expenseDescription: "Unrelated expense",
      invoiceNumber: "INV-NAME-001",
    }
  );
  const booking = buildBooking(invoice);

  assert.equal(booking.supplierResolution.reviewRequired, false);
  assert.equal(booking.supplierResolution.selectedAccountId, "supplier_booking");
  assert.equal(booking.supplierResolution.method, "Name similarity");
});

test("matches an Exact supplier IBAN despite invoice spacing", () => {
  const invoice = uploadedInvoice(
    {},
    {
      supplierName: "Unknown supplier name",
      supplierVatNumber: "",
      supplierChamberOfCommerceNumber: "",
      iban: "NL39 RABO 0300 0652 64",
      expenseDescription: "Unrelated expense",
      invoiceNumber: "INV-IBAN-001",
    }
  );
  const booking = buildBooking(invoice);

  assert.equal(booking.supplierResolution.reviewRequired, false);
  assert.equal(booking.supplierResolution.selectedAccountId, "supplier_delta_it");
  assert.equal(booking.supplierResolution.method, "IBAN");
});

test("uses learned supplier decisions to unblock future ambiguous matches", () => {
  const invoice = uploadedInvoice({}, {
    supplierName: "Acme Supplies BV",
    supplierVatNumber: "NL123456789B01",
    supplierChamberOfCommerceNumber: "",
    iban: "",
    invoiceNumber: "INV-ACME-002",
  });
  const learning = createInitialLearningStore();
  learning.supplierSelections.push({
    supplierIdentity: "vat:NL123456789B01",
    accountId: "supplier_ambiguous_a",
    decidedAt: "2026-06-16T00:00:00.000Z",
  });
  const booking = generatePurchaseJournalBooking(
    invoice,
    [invoice],
    learning,
    exactMasterData
  );

  assert.equal(booking.supplierResolution.reviewRequired, false);
  assert.equal(
    booking.supplierResolution.selectedAccountId,
    "supplier_ambiguous_a"
  );
});

test("suggests booking fields from the most similar previous Exact purchase entry", () => {
  const invoice = uploadedInvoice(
    { fileName: "security-platform-renewal-2026.pdf" },
    {
      supplierName: "Delta IT Services",
      supplierVatNumber: "NL855512340B01",
      supplierChamberOfCommerceNumber: "55230119",
      supplierAddress: "Europalaan 21, Utrecht",
      supplierCountry: "NL",
      invoiceNumber: "DELTA-SEC-2026",
      referenceCode: "DELTA-SEC-2026",
      invoiceDate: "2026-06-16",
      paymentTerms: "",
      netAmount: 1_000,
      vatAmount: 210,
      grossAmount: 1_210,
      iban: "NL39RABO0300065264",
      expenseDescription: "Invoice expenses",
      rawText: "Annual security platform renewal and managed endpoint protection",
      lineItems: [
        {
          id: "line_security",
          description: "Service charge",
          quantity: 1,
          unitPrice: 1_000,
          netAmount: 1_000,
          vatRate: 0.21,
          vatAmount: 210,
          grossAmount: 1_210,
        },
      ],
    }
  );
  const masterData = {
    ...exactMasterData,
    suppliers: exactMasterData.suppliers.map((supplier) =>
      supplier.id === "supplier_delta_it"
        ? {
            ...supplier,
            paymentConditionCode: "",
            paymentConditionLabel: "",
            defaultGlAccount: "",
            defaultGlAccountName: "",
            defaultCostCentre: undefined,
            defaultCostUnit: undefined,
          }
        : supplier
    ),
    historicalPurchaseBookings: [
      {
        id: "hist_delta_office",
        entryId: "entry_delta_office",
        lineId: "hist_delta_office",
        supplierAccountId: "supplier_delta_it",
        description: "Office furniture",
        descriptionKey: "office-furniture",
        glAccount: "4400",
        vatCode: "4",
        totalAmount: 1_205,
        lineAmount: 995.87,
        vatAmount: 209.13,
        vatPercentage: 21,
        paymentConditionCode: "21",
        invoiceDate: "2026-05-01",
      },
      {
        id: "hist_delta_security_2025",
        entryId: "entry_delta_security_2025",
        lineId: "hist_delta_security_2025",
        supplierAccountId: "supplier_delta_it",
        description: "Annual security platform renewal",
        descriptionKey: "annual-security-platform-renewal",
        glAccount: "4420",
        vatCode: "4",
        costCentre: "AMS",
        costUnit: "IT",
        totalAmount: 1_200,
        lineAmount: 991.74,
        vatAmount: 208.26,
        vatPercentage: 21,
        paymentConditionCode: "30",
        invoiceDate: "2025-06-16",
        accrualFrom: "2025-06-01",
        accrualTo: "2026-05-31",
      },
      {
        id: "hist_delta_security_2024",
        entryId: "entry_delta_security_2024",
        lineId: "hist_delta_security_2024",
        supplierAccountId: "supplier_delta_it",
        description: "Annual security platform renewal",
        descriptionKey: "annual-security-platform-renewal",
        glAccount: "4420",
        vatCode: "4",
        costCentre: "AMS",
        costUnit: "IT",
        totalAmount: 1_150,
        lineAmount: 950.41,
        vatAmount: 199.59,
        vatPercentage: 21,
        paymentConditionCode: "30",
        invoiceDate: "2024-06-17",
        accrualFrom: "2024-06-01",
        accrualTo: "2025-05-31",
      },
    ],
  };
  const booking = generatePurchaseJournalBooking(
    invoice,
    [invoice],
    createInitialLearningStore(),
    masterData
  );

  assert.equal(booking.lines[0]?.glAccount, "4420");
  assert.equal(booking.lines[0]?.vatCode, "4");
  assert.equal(booking.lines[0]?.costCentre, "AMS");
  assert.equal(booking.lines[0]?.costUnit, "IT");
  assert.equal(booking.paymentConditionCode, "30");
  assert.equal(booking.lines[0]?.from, "2026-06-01");
  assert.equal(booking.lines[0]?.to, "2027-05-31");
  assert.match(booking.description, /Annual security platform renewal/i);
  assert.ok(
    booking.learningSummary.includes("Suggested from previous Exact bookings.")
  );
  assert.ok(
    booking.lines[0]?.reasoning.includes(
      "Suggested from previous Exact bookings."
    )
  );
});

test("reuses a previous Exact booking line split while preserving current totals", () => {
  const invoice = uploadedInvoice(
    { fileName: "delta-cloud-support-june-2026.pdf" },
    {
      supplierName: "Delta IT Services",
      supplierVatNumber: "NL855512340B01",
      supplierChamberOfCommerceNumber: "55230119",
      supplierAddress: "Europalaan 21, Utrecht",
      supplierCountry: "NL",
      invoiceNumber: "DELTA-CLOUD-2026-06",
      referenceCode: "DELTA-CLOUD-2026-06",
      paymentTerms: "30 days",
      netAmount: 1_000,
      vatAmount: 210,
      grossAmount: 1_210,
      iban: "NL39RABO0300065264",
      expenseDescription: "Cloud hosting and support",
      rawText: "Monthly cloud hosting and managed support bundle",
      lineItems: [
        {
          id: "line_cloud_bundle",
          description: "Cloud hosting and support bundle",
          quantity: 1,
          unitPrice: 1_000,
          netAmount: 1_000,
          vatRate: 0.21,
          vatAmount: 210,
          grossAmount: 1_210,
        },
      ],
    }
  );
  const masterData = {
    ...exactMasterData,
    historicalPurchaseBookings: [
      {
        id: "hist_cloud_hosting",
        entryId: "entry_cloud_bundle",
        lineId: "hist_cloud_hosting",
        supplierAccountId: "supplier_delta_it",
        description: "Cloud hosting",
        descriptionKey: "cloud-hosting",
        glAccount: "4420",
        vatCode: "4",
        costCentre: "AMS",
        costUnit: "IT",
        totalAmount: 605,
        lineAmount: 400,
        vatAmount: 84,
        vatPercentage: 21,
        paymentConditionCode: "30",
        invoiceDate: "2026-05-16",
      },
      {
        id: "hist_cloud_support",
        entryId: "entry_cloud_bundle",
        lineId: "hist_cloud_support",
        supplierAccountId: "supplier_delta_it",
        description: "Managed support",
        descriptionKey: "managed-support",
        glAccount: "4800",
        vatCode: "4",
        costCentre: "AMS",
        costUnit: "IT",
        totalAmount: 605,
        lineAmount: 100,
        vatAmount: 21,
        vatPercentage: 21,
        paymentConditionCode: "30",
        invoiceDate: "2026-05-16",
      },
    ],
  };
  const booking = generatePurchaseJournalBooking(
    invoice,
    [invoice],
    createInitialLearningStore(),
    masterData
  );

  assert.equal(booking.lines.length, 2);
  assert.deepEqual(
    booking.lines.map((line) => line.glAccount),
    ["4420", "4800"]
  );
  assert.deepEqual(
    booking.lines.map((line) => line.amount),
    [800, 200]
  );
  assert.deepEqual(
    booking.lines.map((line) => line.vatAmount),
    [168, 42]
  );
  assert.equal(booking.totals.lineAmount, 1_000);
  assert.equal(booking.totals.vatAmount, 210);
  assert.equal(booking.totals.grossAmount, 1_210);
  assert.equal(booking.totals.difference, 0);
  assert.ok(
    booking.lines.every((line) =>
      line.reasoning.includes("Suggested from previous Exact bookings.")
    )
  );
});

test("requires payment condition review when invoice terms differ from Exact default", () => {
  const invoice = uploadedInvoice({}, { paymentTerms: "immediately" });
  const booking = buildBooking(invoice);

  assert.equal(booking.paymentConditionMismatch, true);
  assert.equal(
    statusFromPurchaseJournal([], booking),
    "Payment Condition Review Required"
  );
});

test("selects VAT code 7 for EU reverse-charge acquisitions", () => {
  const invoice = uploadedInvoice({}, {
    supplierName: "Google Ireland Limited",
    supplierVatNumber: "IE6388047V",
    supplierChamberOfCommerceNumber: "368047",
    supplierAddress: "Gordon House, Dublin",
    supplierCountry: "IE",
    invoiceNumber: "INV-GOOGLE-001",
    paymentTerms: "30 days",
    netAmount: 100,
    vatAmount: 0,
    grossAmount: 100,
    iban: "IE29AIBK93115212345678",
    expenseDescription: "Google Workspace",
    reverseChargeMentioned: true,
    intraCommunityMentioned: true,
    lineItems: [
      {
        id: "line_google",
        description: "Google Workspace",
        quantity: 1,
        unitPrice: 100,
        netAmount: 100,
        vatRate: 0,
        vatAmount: 0,
        grossAmount: 100,
      },
    ],
  });
  const booking = buildBooking(invoice);

  assert.equal(booking.lines[0].vatCode, "7");
  assert.equal(booking.lines[0].amount, 100);
  assert.equal(booking.lines[0].vatAmount, 0);
});

test("replaces an unsupported booking-line VAT code with safe fallback code 6", () => {
  const invoice = uploadedInvoice();
  const originalLine = buildBooking(invoice).lines[0];
  const booking = buildBooking(
    uploadedInvoice({
      bookingLineOverrides: [
        {
          ...originalLine,
          vatCode: "9" as never,
          vatCodeName: "Unsupported VAT",
          vatReasoning: [],
        },
      ],
    })
  );

  assert.equal(booking.lines[0]?.vatCode, "6");
  assert.equal(
    booking.lines[0]?.vatReasoning.includes(
      "Unsupported VAT code detected. VAT code 6 was selected as the safe fallback."
    ),
    true
  );
});

test("booking validation rejects unsupported VAT codes", () => {
  const invoice = uploadedInvoice();
  const booking = buildBooking(invoice);
  booking.lines[0].vatCode = "9" as never;

  const errors = purchaseJournalValidationErrors(booking, invoice.extractedData);

  assert.equal(
    errors.some(
      (error) =>
        error.field === "vatCode" &&
        error.message.includes("Unsupported VAT code 9")
    ),
    true
  );
});

test("booking validation checks every booking line independently", () => {
  const invoice = uploadedInvoice();
  const booking = buildBooking(invoice);
  const firstLine = booking.lines[0];

  firstLine.accrualReason = "Annual subscription";
  firstLine.from = "2026-06-01";
  firstLine.to = "2027-05-31";
  booking.lines.push({
    ...firstLine,
    id: "line_2",
    finalSelectedAccount: "",
    glAccount: "",
    description: "",
    vatCode: "" as never,
    amount: Number.NaN,
    vatAmount: Number.NaN,
    accrualReason: undefined,
    from: "",
    to: "",
  });

  const messages = purchaseJournalValidationErrors(
    booking,
    invoice.extractedData
  ).map((error) => error.message);

  assert.equal(messages.includes("Line 2: G/L Account is required."), true);
  assert.equal(messages.includes("Line 2: Description is required."), true);
  assert.equal(messages.includes("Line 2: VAT code is required."), true);
  assert.equal(messages.includes("Line 2: Net amount is required."), true);
  assert.equal(messages.includes("Line 2: VAT amount is required."), true);
  assert.equal(
    messages.some((message) => message.startsWith("Line 2: Accrual")),
    false,
    "a non-accrual line must not inherit another line's accrual requirement"
  );
});

test("booking validation requires From and To only on the line with accrual", () => {
  const invoice = uploadedInvoice();
  const booking = buildBooking(invoice);
  booking.lines.push({
    ...booking.lines[0],
    id: "line_2",
    accrualReason: "Annual subscription",
    from: "",
    to: "",
  });

  const messages = purchaseJournalValidationErrors(
    booking,
    invoice.extractedData
  ).map((error) => error.message);

  assert.equal(messages.includes("Line 2: Accrual From is required."), true);
  assert.equal(messages.includes("Line 2: Accrual To is required."), true);
});

test("uses safe fallback VAT code 6 for air travel", () => {
  const invoice = uploadedInvoice({}, {
    supplierName: "KLM Royal Dutch Airlines",
    supplierVatNumber: "NL004983269B01",
    supplierChamberOfCommerceNumber: "33014286",
    supplierAddress: "Amsterdamseweg 55, Amstelveen",
    supplierCountry: "NL",
    invoiceNumber: "INV-KLM-001",
    paymentTerms: "7 days",
    netAmount: 350,
    vatAmount: 0,
    grossAmount: 350,
    iban: "NL20ABNA0999999999",
    expenseDescription: "Air travel expenses",
    lineItems: [
      {
        id: "line_klm",
        description: "Flight Amsterdam Seoul",
        quantity: 1,
        unitPrice: 350,
        netAmount: 350,
        vatRate: 0,
        vatAmount: 0,
        grossAmount: 350,
      },
    ],
  });
  const booking = buildBooking(invoice);

  assert.equal(booking.lines[0].vatCode, "6");
  assert.equal(booking.lines[0].vatConfidence >= booking.confidenceThreshold, true);
});

test("selects VAT code 8 for non-EU 0% VAT invoices", () => {
  const invoice = uploadedInvoice({}, {
    supplierName: "US Cloud Inc",
    supplierVatNumber: "US123456789",
    supplierChamberOfCommerceNumber: "US-2231",
    supplierAddress: "100 Market Street, San Francisco",
    supplierCountry: "US",
    invoiceNumber: "INV-US-001",
    paymentTerms: "30 days",
    netAmount: 200,
    vatAmount: 0,
    grossAmount: 200,
    iban: "US00000000000001",
    expenseDescription: "Cloud subscription",
    lineItems: [
      {
        id: "line_us",
        description: "Cloud subscription",
        quantity: 1,
        unitPrice: 200,
        netAmount: 200,
        vatRate: 0,
        vatAmount: 0,
        grossAmount: 200,
      },
    ],
  });
  const booking = buildBooking(invoice);

  assert.equal(booking.lines[0].vatCode, "8");
  assert.equal(booking.lines[0].amount, 200);
});

test("moves closed invoice periods to the first available open period", () => {
  const invoice = uploadedInvoice({}, { invoiceDate: "2026-01-12" });
  const booking = buildBooking(invoice);

  assert.equal(booking.financialYear, 2026);
  assert.equal(booking.period, 6);
  assert.equal(booking.periodAdjusted, true);
});

test("does not alter booking lines to hide an invoice total difference", () => {
  const invoice = uploadedInvoice({}, { grossAmount: 121.01 });
  const booking = buildBooking(invoice);

  assert.equal(booking.lines[0]?.amount, 100);
  assert.equal(booking.lines[0]?.vatAmount, 21);
  assert.equal(booking.totals.grossAmount, 121);
  assert.equal(booking.totals.difference, 0.01);
  assert.equal(booking.autoBookAllowed, false);
  assert.ok(
    booking.reviewReasons.includes(
      "Booking total does not match the invoice total. Difference must be 0.00 before booking to Exact Online."
    )
  );
});

test("server-side booking rejects mismatched line totals even if saved totals are stale", async () => {
  const invoice = uploadedInvoice(
    {
      status: "Ready to Book",
      storageKey: "tests/amount-mismatch.pdf",
    },
    { referenceCode: "INV-PJ-001" }
  );
  storeMockInvoiceFile({
    storageKey: invoice.storageKey,
    fileName: invoice.fileName,
    fileType: invoice.fileType,
    content: "Amount mismatch invoice",
  });
  const booking = buildBooking(invoice);
  booking.lines[0].amount = 99.99;
  invoice.purchaseJournal = {
    ...booking,
    totals: { lineAmount: 100, vatAmount: 21, grossAmount: 121, difference: 0 },
    autoBookAllowed: true,
    reviewRequired: false,
    reviewReasons: [],
  };

  await assert.rejects(
    () =>
      bookInvoiceInExact(
        createMockExactConnection("company_connection"),
        invoice,
        exactMasterData
      ),
    /Booking total does not match the invoice total\. Difference must be 0\.00 before booking to Exact Online\./
  );
});

test("final Exact booking gate rejects every required booking blocker", async (t) => {
  const storageKey = "tests/final-booking-blockers.pdf";
  storeMockInvoiceFile({
    storageKey,
    fileName: "final-booking-blockers.pdf",
    fileType: "application/pdf",
    content: "Final booking blocker checks",
  });

  const readyInvoice = () => {
    const invoice = uploadedInvoice(
      { status: "Ready to Book", storageKey },
      { referenceCode: "INV-PJ-001" }
    );
    const booking = buildBooking(invoice);
    invoice.purchaseJournal = {
      ...booking,
      autoBookAllowed: true,
      reviewRequired: false,
      reviewReasons: [],
      userApproved: true,
      yourRefUnique: true,
      supplierResolution: {
        ...booking.supplierResolution,
        reviewRequired: false,
      },
    };
    return invoice;
  };

  const cases: Array<{
    name: string;
    mutate: (invoice: UploadedInvoice) => void;
    expected: RegExp;
  }> = [
    {
      name: "supplier is missing",
      mutate: (invoice) => {
        invoice.extractedData.supplierName = "";
      },
      expected: /required fields|supplier/i,
    },
    {
      name: "supplier is not matched to Exact",
      mutate: (invoice) => {
        invoice.purchaseJournal!.supplierResolution.selectedAccountId = undefined;
      },
      expected: /supplier.*Exact/i,
    },
    {
      name: "multiple supplier matches are unresolved",
      mutate: (invoice) => {
        const account = exactMasterData.suppliers[0];
        invoice.purchaseJournal!.supplierResolution.reviewRequired = true;
        invoice.purchaseJournal!.supplierResolution.candidates = [
          {
            account,
            confidence: 0.95,
            method: "VAT number",
            reasoning: ["VAT match"],
          },
          {
            account: exactMasterData.suppliers[1],
            confidence: 0.94,
            method: "Name similarity",
            reasoning: ["Name match"],
          },
        ];
      },
      expected: /multiple Exact suppliers/i,
    },
    {
      name: "Your ref is missing",
      mutate: (invoice) => {
        invoice.purchaseJournal!.yourRef = "";
      },
      expected: /Your ref/i,
    },
    {
      name: "Your ref is a duplicate for the supplier",
      mutate: (invoice) => {
        invoice.purchaseJournal!.yourRefUnique = false;
      },
      expected: /invoice reference already exists|duplicate/i,
    },
    {
      name: "invoice date is missing",
      mutate: (invoice) => {
        invoice.extractedData.invoiceDate = "";
      },
      expected: /required fields|invoice date/i,
    },
    {
      name: "payment condition is missing",
      mutate: (invoice) => {
        invoice.purchaseJournal!.paymentConditionCode = "";
        invoice.purchaseJournal!.paymentConditionLabel = "";
      },
      expected: /payment condition/i,
    },
    {
      name: "no booking lines exist",
      mutate: (invoice) => {
        invoice.purchaseJournal!.lines = [];
      },
      expected: /at least one booking line/i,
    },
    {
      name: "a booking line is missing its G/L account",
      mutate: (invoice) => {
        invoice.purchaseJournal!.lines[0].glAccount = "";
        invoice.purchaseJournal!.lines[0].finalSelectedAccount = "";
      },
      expected: /G\/L Account is required/i,
    },
    {
      name: "a booking line is missing its VAT code",
      mutate: (invoice) => {
        invoice.purchaseJournal!.lines[0].vatCode = "" as never;
      },
      expected: /VAT code is required/i,
    },
    {
      name: "a booking line amount is missing",
      mutate: (invoice) => {
        invoice.purchaseJournal!.lines[0].amount = Number.NaN;
      },
      expected: /Net amount is required/i,
    },
    {
      name: "a booking line uses an unsupported VAT code",
      mutate: (invoice) => {
        invoice.purchaseJournal!.lines[0].vatCode = "9" as never;
      },
      expected: /Unsupported VAT code 9/i,
    },
    {
      name: "booking total differs from invoice total",
      mutate: (invoice) => {
        invoice.purchaseJournal!.lines[0].amount -= 0.01;
      },
      expected: /Difference must be 0\.00/i,
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const invoice = readyInvoice();
      item.mutate(invoice);
      await assert.rejects(
        () =>
          bookInvoiceInExact(
            createMockExactConnection("company_connection"),
            invoice,
            exactMasterData
          ),
        item.expected
      );
    });
  }
});

test("blocks booking when Exact already has the same supplier reference with a different amount", async () => {
  const invoice = uploadedInvoice(
    {
      fileName: "google-duplicate.pdf",
      storageKey: "tests/google-duplicate.pdf",
      status: "Ready to Book",
    },
    {
      supplierName: "Google Ireland Limited",
      supplierVatNumber: "IE6388047V",
      supplierChamberOfCommerceNumber: "368047",
      supplierAddress: "Gordon House, Dublin",
      supplierCountry: "IE",
      invoiceNumber: "GOOGLE-2026-06",
      referenceCode: "GOOGLE-2026-06",
      paymentTerms: "30 days",
      netAmount: 200,
      vatAmount: 0,
      grossAmount: 200,
      iban: "IE29AIBK93115212345678",
      expenseDescription: "Google Workspace",
      companyVatNumber: "NL857017263B01",
      reverseChargeMentioned: true,
      intraCommunityMentioned: true,
      lineItems: [
        {
          id: "line_google",
          description: "Google Workspace",
          quantity: 1,
          unitPrice: 200,
          netAmount: 200,
          vatRate: 0,
          vatAmount: 0,
          grossAmount: 200,
        },
      ],
    }
  );
  storeMockInvoiceFile({
    storageKey: invoice.storageKey,
    fileName: invoice.fileName,
    fileType: invoice.fileType,
    content: "Google duplicate invoice",
  });
  const booking = buildBooking(invoice);
  invoice.purchaseJournal = {
    ...booking,
    autoBookAllowed: true,
    reviewRequired: false,
    reviewReasons: [],
  };

  await assert.rejects(
    () =>
      bookInvoiceInExact(
        createMockExactConnection("company_connection"),
        invoice,
        exactMasterData
      ),
    /This invoice reference already exists for this supplier\. Duplicate invoices cannot be booked\./
  );
});
