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
    source: "manual",
    fileName: "test-invoice.pdf",
    fileType: "application/pdf",
    fileSize: 12_000,
    storageKey: "invoices/test-invoice.pdf",
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

test("blocks booking when Exact already has the same reference and amount", async () => {
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
      paymentTerms: "30 days",
      netAmount: 121,
      vatAmount: 0,
      grossAmount: 121,
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
          unitPrice: 121,
          netAmount: 121,
          vatRate: 0,
          vatAmount: 0,
          grossAmount: 121,
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
    /Duplicate invoice blocked.*GOOGLE-2026-06.*121\.00/
  );
});
