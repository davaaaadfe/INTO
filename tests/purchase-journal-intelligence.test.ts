import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import {
  emptyExtractedInvoiceData,
  LEARNING_ONLY_BOOKING_MESSAGE,
  type ExactSupplierAccount,
  type ExtractedInvoiceData,
  type UploadedInvoice,
} from "../lib/domain/invoice";
import {
  createInitialLearningStore,
  generatePurchaseJournalBooking,
  purchaseJournalValidationErrors,
  supplierIdentityForInvoice,
  statusFromPurchaseJournal,
  SUPPLIER_RESOLUTION_V2_POLICY,
} from "../lib/services/purchase-journal-intelligence";
import { formatFingerprint } from "../lib/services/supplier-learning";
import { createMockExactMasterData } from "../lib/services/exact-master-data-service";
import {
  bookInvoiceInExact,
  createMockExactConnection,
} from "../lib/services/exact-online-service";
import { storeMockInvoiceFile } from "../lib/services/storage-service";

const exactMasterData = createMockExactMasterData();

const originalSupplierResolutionV2Enabled =
  process.env.SUPPLIER_RESOLUTION_V2_ENABLED;
const originalLearningShadowMode = process.env.LEARNING_SHADOW_MODE;
const originalSupplierLearningMode = process.env.SUPPLIER_LEARNING_MODE;
const originalSupplierAutoSelectionEvaluationApproved =
  process.env.SUPPLIER_LEARNED_AUTO_SELECTION_EVALUATION_APPROVED;

function setEnvironmentValue(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

function withSupplierResolutionFlags<T>(
  supplierResolutionV2Enabled: boolean,
  learningShadowMode: boolean,
  action: () => T
) {
  const previousSupplierResolutionV2Enabled =
    process.env.SUPPLIER_RESOLUTION_V2_ENABLED;
  const previousLearningShadowMode = process.env.LEARNING_SHADOW_MODE;
  process.env.SUPPLIER_RESOLUTION_V2_ENABLED = String(
    supplierResolutionV2Enabled
  );
  process.env.LEARNING_SHADOW_MODE = String(learningShadowMode);
  try {
    return action();
  } finally {
    setEnvironmentValue(
      "SUPPLIER_RESOLUTION_V2_ENABLED",
      previousSupplierResolutionV2Enabled
    );
    setEnvironmentValue("LEARNING_SHADOW_MODE", previousLearningShadowMode);
  }
}

function withSupplierLearningMode<T>(mode: "off" | "observe" | "apply", action: () => T) {
  const previous = process.env.SUPPLIER_LEARNING_MODE;
  process.env.SUPPLIER_LEARNING_MODE = mode;
  try {
    return action();
  } finally {
    setEnvironmentValue("SUPPLIER_LEARNING_MODE", previous);
  }
}

before(() => {
  process.env.SUPPLIER_RESOLUTION_V2_ENABLED = "true";
  process.env.LEARNING_SHADOW_MODE = "false";
  process.env.SUPPLIER_LEARNED_AUTO_SELECTION_EVALUATION_APPROVED = "true";
  process.env.SUPPLIER_LEARNING_MODE = "apply";
});

after(() => {
  setEnvironmentValue(
    "SUPPLIER_RESOLUTION_V2_ENABLED",
    originalSupplierResolutionV2Enabled
  );
  setEnvironmentValue("LEARNING_SHADOW_MODE", originalLearningShadowMode);
  setEnvironmentValue("SUPPLIER_LEARNING_MODE", originalSupplierLearningMode);
  setEnvironmentValue(
    "SUPPLIER_LEARNED_AUTO_SELECTION_EVALUATION_APPROVED",
    originalSupplierAutoSelectionEvaluationApproved
  );
});

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
    processingPurpose: "booking",
    learningState: "not_saved",
    revision: 1,
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

function confirmedLearning(invoice: UploadedInvoice, accountId: string) {
  const learning = createInitialLearningStore();
  const layout = formatFingerprint(invoice.extractedData.rawText ?? "");
  learning.supplierProfiles.push({
    supplierAccountId: accountId,
    generation: 1,
    exampleCount: 1,
    formatFingerprint: layout,
    formatDrift: "none",
  });
  learning.supplierExamples.push({
    id: `confirmed-${accountId}`,
    supplierAccountId: accountId,
    generation: 1,
    invoiceId: "confirmed-invoice",
    contentHash: `confirmed-hash-${accountId}`,
    formatFingerprint: layout,
    learnedAt: "2026-06-15T00:00:00.000Z",
    trustState: "trusted",
    active: true,
  });
  learning.supplierSelections.push({
    supplierIdentity: supplierIdentityForInvoice(invoice),
    accountId,
    decidedAt: "2026-06-15T00:00:00.000Z",
    formatFingerprint: layout,
    trustState: "trusted",
  });
  return learning;
}

function buildBooking(invoice: UploadedInvoice, accountId = "supplier_noordzee") {
  return generatePurchaseJournalBooking(
    invoice,
    [invoice],
    confirmedLearning(invoice, accountId),
    exactMasterData
  );
}

function supplierAccount(
  overrides: Partial<ExactSupplierAccount>
): ExactSupplierAccount {
  return {
    ...exactMasterData.suppliers[0],
    id: "supplier_imported",
    code: "90000",
    name: "Imported Supplier",
    vatNumber: "",
    iban: "",
    chamberOfCommerceNumber: "",
    address: "",
    country: "",
    ...overrides,
  };
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

test("learning-only invoices stay non-bookable during intelligence recompute", () => {
  const invoice = uploadedInvoice({
    status: "Learned",
    processingPurpose: "learning_only",
  });
  const booking = buildBooking(invoice);

  assert.equal(booking.autoBookAllowed, false);
  assert.equal(booking.reviewReasons.includes(LEARNING_ONLY_BOOKING_MESSAGE), true);
});

test("direct Exact booking rejects learning-only invoices before connection checks", async () => {
  const invoice = uploadedInvoice({
    status: "Ready to Book",
    processingPurpose: "learning_only",
  });
  invoice.purchaseJournal = buildBooking(invoice);

  await assert.rejects(
    bookInvoiceInExact(null, invoice, null),
    new RegExp(LEARNING_ONLY_BOOKING_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  );
  assert.deepEqual(invoice.bookingAttempts, []);
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
    supplierAddress: "",
    supplierCountry: "",
    iban: "",
    expenseDescription: "Ambiguous widgets",
    invoiceNumber: "INV-ACME-001",
  });
  const booking = buildBooking(invoice);

  assert.equal(booking.supplierResolution.reviewRequired, true);
  assert.equal(booking.supplierResolution.selectedAccountId, undefined);
  assert.equal(
    statusFromPurchaseJournal([], booking),
    "Booking Intelligence Review Required"
  );
  assert.equal(booking.supplierResolution.reasonCode, "supplier_ambiguous");
  assert.equal(
    purchaseJournalValidationErrors(booking).some(
      (error) =>
        error.field === "supplier" &&
        error.message ===
          "Multiple supplier matches found. Please choose the correct supplier."
    ),
    true
  );
});

test("reports an unresolved supplier warning only once", () => {
  const invoice = uploadedInvoice({}, {
    supplierName: "Acme Supplies BV",
    supplierVatNumber: "NL123456789B01",
    supplierChamberOfCommerceNumber: "",
    supplierAddress: "",
    supplierCountry: "",
    iban: "",
    expenseDescription: "Ambiguous widgets",
    invoiceNumber: "INV-ACME-WARNING",
  });
  const booking = buildBooking(invoice);
  const supplierWarnings = purchaseJournalValidationErrors(booking).filter(
    (error) =>
      error.message ===
      "Multiple supplier matches found. Please choose the correct supplier."
  );

  assert.equal(supplierWarnings.length, 1);
  assert.equal(supplierWarnings[0]?.field, "supplier");
});

test("keeps a first unique VAT match manual before supplier and format confirmation", () => {
  const invoice = uploadedInvoice(
    {},
    {
      supplierName: "Unknown VAT supplier",
      supplierVatNumber: "NL812345678B01",
      supplierChamberOfCommerceNumber: "",
      supplierAddress: "",
      supplierCountry: "",
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

  assert.equal(booking.supplierResolution.reviewRequired, true);
  assert.equal(booking.supplierResolution.selectedAccountId, undefined);
  assert.equal(booking.supplierResolution.manualReason, "unfamiliar_supplier");
  assert.equal(booking.supplierResolution.candidates.length, 0);
});

test("shows the required guidance when no Exact supplier can be matched", () => {
  const invoice = uploadedInvoice(
    {},
    {
      supplierName: "Completely Unknown Vendor",
      supplierVatNumber: "",
      supplierChamberOfCommerceNumber: "",
      supplierAddress: "",
      supplierCountry: "",
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
          "Supplier could not be confidently matched. Please select the correct supplier."
    ),
    true
  );
});

test("uses a normalized Exact name to constrain first manual selection", () => {
  const invoice = uploadedInvoice(
    {},
    {
      supplierName: "Booking.com B.V.",
      supplierVatNumber: "",
      supplierChamberOfCommerceNumber: "",
      supplierAddress: "Herengracht 597, Amsterdam",
      supplierCountry: "NL",
      iban: "",
      expenseDescription: "Unrelated expense",
      invoiceNumber: "INV-NAME-001",
    }
  );
  const booking = buildBooking(invoice);

  assert.equal(booking.supplierResolution.reviewRequired, true);
  assert.equal(booking.supplierResolution.selectedAccountId, undefined);
  assert.equal(booking.supplierResolution.manualReason, "unfamiliar_supplier");
});

test("uses a normalized Exact IBAN to constrain first manual selection", () => {
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

  assert.equal(booking.supplierResolution.reviewRequired, true);
  assert.equal(booking.supplierResolution.selectedAccountId, undefined);
  assert.equal(booking.supplierResolution.manualReason, "unfamiliar_supplier");
});

test("prioritizes an imported supplier IBAN over a conflicting supplier name", () => {
  const masterData = {
    ...exactMasterData,
    suppliers: [
      supplierAccount({
        id: "supplier_name_match",
        code: "90001",
        name: "Visible Invoice Supplier",
        iban: "NL11BANK0000000001",
        city: "Amsterdam",
        bicCode: "BANKNL2A",
        isSupplier: true,
      }),
      supplierAccount({
        id: "supplier_iban_match",
        code: "90002",
        name: "Exact Legal Supplier Name",
        iban: "NL22BANK0000000002",
        city: "Utrecht",
        bicCode: "BANKNL2U",
        isSupplier: true,
      }),
    ],
  };
  const invoice = uploadedInvoice({}, {
    supplierName: "Visible Invoice Supplier",
    supplierVatNumber: "",
    iban: "NL22 BANK 0000 0000 02",
    invoiceNumber: "INV-IBAN-PRIORITY-001",
  });
  const booking = generatePurchaseJournalBooking(
    invoice,
    [invoice],
    createInitialLearningStore(),
    masterData
  );

  assert.equal(booking.supplierResolution.selectedAccountId, undefined);
  assert.equal(booking.supplierResolution.manualReason, "unfamiliar_supplier");
  assert.equal(booking.supplierResolution.candidates.length, 0);
});

test("uses BIC only as supporting evidence and never auto-selects from BIC alone", () => {
  const masterData = {
    ...exactMasterData,
    suppliers: [
      supplierAccount({
        id: "supplier_bic_match",
        code: "90003",
        name: "Northwind Trading",
        bicCode: "RABONL2U",
        isSupplier: true,
      }),
    ],
  };
  const invoice = uploadedInvoice({}, {
    supplierName: "Unknown invoice supplier",
    supplierVatNumber: "",
    iban: "",
    rawText: "Bank details\nBIC: RABO NL 2U\nInvoice INV-BIC-001",
    invoiceNumber: "INV-BIC-001",
  });
  const booking = generatePurchaseJournalBooking(
    invoice,
    [invoice],
    createInitialLearningStore(),
    masterData
  );

  assert.equal(booking.supplierResolution.selectedAccountId, undefined);
  assert.equal(booking.supplierResolution.reviewRequired, true);
  assert.equal(booking.supplierResolution.reasonCode, "supplier_low_confidence");
});

test("conflicting hard supplier identifiers block automatic selection", () => {
  const masterData = {
    ...exactMasterData,
    suppliers: [
      supplierAccount({
        id: "supplier_vat_hard_match",
        code: "91001",
        name: "VAT Match BV",
        vatNumber: "NL111111111B01",
        iban: "NL11BANK0000000001",
        isSupplier: true,
      }),
      supplierAccount({
        id: "supplier_iban_hard_match",
        code: "91002",
        name: "IBAN Match BV",
        vatNumber: "NL222222222B01",
        iban: "NL22BANK0000000002",
        isSupplier: true,
      }),
    ],
  };
  const invoice = uploadedInvoice({}, {
    supplierName: "VAT Match BV",
    supplierVatNumber: "NL111111111B01",
    iban: "NL22 BANK 0000 0000 02",
    invoiceNumber: "INV-HARD-CONFLICT-1",
  });
  const booking = generatePurchaseJournalBooking(
    invoice,
    [invoice],
    createInitialLearningStore(),
    masterData
  );

  assert.equal(booking.supplierResolution.selectedAccountId, undefined);
  assert.equal(booking.supplierResolution.reasonCode, "supplier_ambiguous");
  assert.equal(booking.supplierResolution.manualReason, "hard_identifier_conflict");
  assert.equal(booking.supplierResolution.candidates.length, 0);
});

test("an unmatched hard supplier identifier blocks a contradictory soft match", () => {
  const invoice = uploadedInvoice({}, {
    supplierName: "Noordzee Office Supplies",
    supplierVatNumber: "NL999999999B99",
    supplierChamberOfCommerceNumber: "",
    supplierAddress: "Keizersgracht 100, Amsterdam",
    iban: "",
    invoiceNumber: "INV-UNMATCHED-HARD-1",
  });

  const booking = buildBooking(invoice);

  assert.equal(booking.supplierResolution.selectedAccountId, undefined);
  assert.equal(booking.supplierResolution.reviewRequired, true);
  assert.equal(booking.supplierResolution.reasonCode, "supplier_low_confidence");
  assert.equal(booking.supplierResolution.candidates.length, 0);
});

test("low supplier reliability requests field review without overriding a unique identity", () => {
  const invoice = uploadedInvoice();
  const learning = confirmedLearning(invoice, "supplier_noordzee");
  learning.supplierExamples = [{
    id: "low-reliability-example",
    supplierAccountId: "supplier_noordzee",
    generation: 1,
    invoiceId: "previous-invoice",
    contentHash: "low-reliability-hash",
    formatFingerprint: formatFingerprint(invoice.extractedData.rawText ?? ""),
    learnedAt: "2026-07-20T00:00:00.000Z",
    originalExtractedData: structuredClone(invoice.extractedData),
    finalExtractedData: structuredClone(invoice.extractedData),
    source: "review",
    trustState: "trusted",
    trigger: "review",
    validationResult: { valid: true },
    active: true,
  }];

  const booking = generatePurchaseJournalBooking(
    invoice,
    [invoice],
    learning,
    exactMasterData
  );

  assert.equal(
    booking.supplierResolution.selectedAccountId,
    "supplier_noordzee",
    "a unique hard supplier match remains selected"
  );
  assert.ok(
    booking.reviewReasons.includes(
      "Supplier reliability is below 65%. Review the extracted fields."
    )
  );
});

test("uses raw confidence rather than rounded display confidence for auto-selection", () => {
  const masterData = {
    ...exactMasterData,
    suppliers: [
      supplierAccount({
        id: "supplier_threshold",
        code: "93001",
        name: "Alpha Beta Gamma Delta Epsilon",
        address: "one two three four",
        country: "",
        isSupplier: true,
      }),
    ],
  };
  const invoice = uploadedInvoice({}, {
    supplierName: "Alpha Beta Gamma",
    supplierVatNumber: "",
    supplierChamberOfCommerceNumber: "",
    supplierAddress: "one two three five",
    supplierCountry: "",
    iban: "",
    invoiceNumber: "INV-RAW-THRESHOLD-1",
  });

  const booking = generatePurchaseJournalBooking(
    invoice,
    [invoice],
    createInitialLearningStore(),
    masterData
  );

  assert.equal(booking.supplierResolution.matchConfidence, 0.9);
  assert.equal(booking.supplierResolution.selectedAccountId, undefined);
  assert.equal(booking.supplierResolution.reviewRequired, true);
});

test("does not reuse a pending supplier choice from another invoice as trusted history", () => {
  const learning = createInitialLearningStore();
  const previous = uploadedInvoice(
    { id: "invoice_pending_supplier_choice" },
    {
      supplierName: "Acme Supplies BV",
      supplierVatNumber: "",
      supplierChamberOfCommerceNumber: "",
      supplierAddress: "",
      supplierCountry: "",
      iban: "",
      invoiceNumber: "INV-PENDING-1",
    }
  );
  learning.supplierSelections.push({
    supplierIdentity: "name:acme-supplies",
    accountId: "supplier_ambiguous_a",
    decidedAt: "2026-06-16T00:00:00.000Z",
    invoiceId: previous.id,
    trustState: "pending",
  });
  previous.purchaseJournal = generatePurchaseJournalBooking(
    previous,
    [previous],
    learning,
    exactMasterData
  );
  const next = uploadedInvoice(
    { id: "invoice_after_pending_supplier_choice" },
    {
      supplierName: "Acme Supplies BV",
      supplierVatNumber: "",
      supplierChamberOfCommerceNumber: "",
      supplierAddress: "",
      supplierCountry: "",
      iban: "",
      invoiceNumber: "INV-PENDING-2",
    }
  );

  const booking = generatePurchaseJournalBooking(
    next,
    [previous, next],
    learning,
    exactMasterData
  );

  assert.equal(booking.supplierResolution.selectedAccountId, undefined);
  assert.equal(booking.supplierResolution.reviewRequired, true);
  assert.equal(booking.supplierResolution.reasonCode, "supplier_ambiguous");
});

test("keeps V2 supplier auto-selection off when its rollout flag is disabled", () => {
  withSupplierResolutionFlags(false, false, () => {
    const booking = buildBooking(uploadedInvoice());

    assert.equal(booking.supplierResolution.selectedAccountId, undefined);
    assert.equal(booking.supplierResolution.reviewRequired, true);
    assert.equal(booking.supplierResolution.shadowEvaluation, undefined);
  });
});

test("the versioned supplier resolver policy exposes the rollout thresholds", () => {
  assert.deepEqual(SUPPLIER_RESOLUTION_V2_POLICY, {
    version: "supplier-resolution-v2.1",
    minimumConfidence: 0.9,
    minimumMargin: 0.12,
    minimumSoftSignalFamilies: 2,
    minimumCandidateConfidence: 0.3,
    maximumCandidates: 5,
  });
});

test("shadow scoring runs while V2 application remains disabled", () => {
  withSupplierResolutionFlags(false, true, () => {
    const booking = buildBooking(uploadedInvoice());

    assert.equal(booking.supplierResolution.selectedAccountId, undefined);
    assert.deepEqual(booking.supplierResolution.shadowEvaluation, {
      selectedAccountId: "supplier_noordzee",
      matchConfidence: 0.99,
      reviewRequired: false,
    });
  });
});

test("records a non-sensitive supplier comparison without selecting in shadow mode", () => {
  withSupplierResolutionFlags(true, true, () => {
    const booking = buildBooking(uploadedInvoice());

    assert.equal(booking.supplierResolution.selectedAccountId, undefined);
    assert.equal(booking.supplierResolution.reviewRequired, true);
    assert.deepEqual(booking.supplierResolution.shadowEvaluation, {
      selectedAccountId: "supplier_noordzee",
      matchConfidence: 0.99,
      reviewRequired: false,
    });
    assert.deepEqual(
      Object.keys(booking.supplierResolution.shadowEvaluation ?? {}).sort(),
      ["matchConfidence", "reviewRequired", "selectedAccountId"]
    );
  });
});

test("applies V2 supplier auto-selection only when enabled outside shadow mode", () => {
  withSupplierResolutionFlags(true, false, () => {
    const booking = buildBooking(uploadedInvoice());

    assert.equal(
      booking.supplierResolution.selectedAccountId,
      "supplier_noordzee"
    );
    assert.equal(booking.supplierResolution.reviewRequired, false);
    assert.equal(booking.supplierResolution.selectionOrigin, "automatic");
    assert.equal(booking.supplierResolution.shadowEvaluation, undefined);
  });
});

test("learned auto-selection rollout is scoped to the confirmed supplier", () => {
  const previous = {
    enabled: process.env.SUPPLIER_LEARNED_AUTO_SELECTION_ENABLED,
    allowlist: process.env.SUPPLIER_LEARNED_AUTO_SELECTION_ALLOWLIST,
    percentage: process.env.SUPPLIER_LEARNED_AUTO_SELECTION_PERCENTAGE,
  };
  process.env.SUPPLIER_LEARNED_AUTO_SELECTION_ENABLED = "true";
  process.env.SUPPLIER_LEARNED_AUTO_SELECTION_PERCENTAGE = "0";
  try {
    withSupplierResolutionFlags(true, false, () => {
      process.env.SUPPLIER_LEARNED_AUTO_SELECTION_ALLOWLIST = "supplier_delta_it";
      assert.equal(
        buildBooking(uploadedInvoice()).supplierResolution.selectedAccountId,
        undefined
      );

      process.env.SUPPLIER_LEARNED_AUTO_SELECTION_ALLOWLIST = "supplier_noordzee";
      assert.equal(
        buildBooking(uploadedInvoice()).supplierResolution.selectedAccountId,
        "supplier_noordzee"
      );
    });
  } finally {
    setEnvironmentValue(
      "SUPPLIER_LEARNED_AUTO_SELECTION_ENABLED",
      previous.enabled
    );
    setEnvironmentValue(
      "SUPPLIER_LEARNED_AUTO_SELECTION_ALLOWLIST",
      previous.allowlist
    );
    setEnvironmentValue(
      "SUPPLIER_LEARNED_AUTO_SELECTION_PERCENTAGE",
      previous.percentage
    );
  }
});

test("a narrow score margin remains ambiguous even with multiple soft signals", () => {
  const masterData = {
    ...exactMasterData,
    suppliers: [
      supplierAccount({
        id: "supplier_soft_a",
        code: "92001",
        name: "Northwind Services BV",
        address: "Coolsingel 88, Rotterdam",
        city: "Rotterdam",
        country: "NL",
        isSupplier: true,
      }),
      supplierAccount({
        id: "supplier_soft_b",
        code: "92002",
        name: "Northwind Services B.V.",
        address: "Coolsingel 88, Rotterdam",
        city: "Rotterdam",
        country: "NL",
        isSupplier: true,
      }),
    ],
  };
  const invoice = uploadedInvoice({}, {
    supplierName: "Northwind Services",
    supplierVatNumber: "",
    iban: "",
    supplierAddress: "Coolsingel 88, Rotterdam",
    supplierCountry: "NL",
    invoiceNumber: "INV-SOFT-MARGIN-1",
  });
  const booking = generatePurchaseJournalBooking(
    invoice,
    [invoice],
    createInitialLearningStore(),
    masterData
  );

  assert.equal(booking.supplierResolution.selectedAccountId, undefined);
  assert.equal(booking.supplierResolution.reasonCode, "supplier_ambiguous");
  assert.equal(booking.supplierResolution.manualReason, "unfamiliar_supplier");
  assert.equal(booking.supplierResolution.candidates.length, 0);
});

test("matches an imported supplier by a labeled supplier code", () => {
  const masterData = {
    ...exactMasterData,
    suppliers: [
      supplierAccount({
        id: "supplier_code_match",
        code: "90004",
        name: "Code Matched Supplier",
        isSupplier: true,
      }),
    ],
  };
  const invoice = uploadedInvoice({}, {
    supplierName: "Unknown invoice supplier",
    supplierVatNumber: "",
    iban: "",
    rawText: "Supplier code: 90004\nInvoice number: INV-CODE-001",
    invoiceNumber: "INV-CODE-001",
  });
  const booking = generatePurchaseJournalBooking(
    invoice,
    [invoice],
    createInitialLearningStore(),
    masterData
  );

  assert.equal(booking.supplierResolution.selectedAccountId, undefined);
  assert.equal(booking.supplierResolution.manualReason, "unfamiliar_supplier");
});

test("combines supplier name and address before automatic selection", () => {
  const masterData = {
    ...exactMasterData,
    suppliers: [
      supplierAccount({
        id: "supplier_address_match",
        code: "90005",
        name: "Address Matched Supplier",
        address: "Coolsingel 88, Rotterdam",
        city: "Rotterdam",
        country: "NL",
        isSupplier: true,
      }),
    ],
  };
  const invoice = uploadedInvoice({}, {
    supplierName: "Address Matched Supplier",
    supplierVatNumber: "",
    iban: "",
    supplierAddress: "Coolsingel 88, 3011 AD Rotterdam",
    supplierCountry: "NL",
    invoiceNumber: "INV-ADDRESS-001",
  });
  const booking = generatePurchaseJournalBooking(
    invoice,
    [invoice],
    createInitialLearningStore(),
    masterData
  );

  assert.equal(booking.supplierResolution.selectedAccountId, undefined);
  assert.equal(booking.supplierResolution.manualReason, "unfamiliar_supplier");
});

test("treats city-and-country-only supplier matches as low confidence", () => {
  const masterData = {
    ...exactMasterData,
    suppliers: [
      supplierAccount({
        id: "supplier_city_a",
        code: "90006",
        name: "Rotterdam Supplier One",
        city: "Rotterdam",
        country: "NL",
        isSupplier: true,
      }),
      supplierAccount({
        id: "supplier_city_b",
        code: "90007",
        name: "Rotterdam Supplier Two",
        city: "Rotterdam",
        country: "NL",
        isSupplier: true,
      }),
    ],
  };
  const invoice = uploadedInvoice({}, {
    supplierName: "Unknown invoice supplier",
    supplierVatNumber: "",
    iban: "",
    supplierAddress: "Rotterdam",
    supplierCountry: "NL",
    invoiceNumber: "INV-CITY-001",
  });
  const booking = generatePurchaseJournalBooking(
    invoice,
    [invoice],
    createInitialLearningStore(),
    masterData
  );

  assert.equal(booking.supplierResolution.selectedAccountId, undefined);
  assert.equal(booking.supplierResolution.reviewRequired, true);
  assert.equal(booking.supplierResolution.reasonCode, "supplier_low_confidence");
  assert.equal(booking.supplierResolution.candidates.length, 0);
});

test("does not suggest unrelated suppliers that only share a city", () => {
  const masterData = {
    ...exactMasterData,
    suppliers: Array.from({ length: 12 }, (_, index) =>
      supplierAccount({
        id: `supplier_city_${index}`,
        code: `91${String(index).padStart(3, "0")}`,
        name: `Rotterdam Supplier ${index}`,
        city: "Rotterdam",
        country: "NL",
        isSupplier: true,
      })
    ),
  };
  const invoice = uploadedInvoice({}, {
    supplierName: "Unknown invoice supplier",
    supplierVatNumber: "",
    iban: "",
    supplierAddress: "Rotterdam",
    supplierCountry: "NL",
    invoiceNumber: "INV-CITY-MANY",
  });
  const booking = generatePurchaseJournalBooking(
    invoice,
    [invoice],
    createInitialLearningStore(),
    masterData
  );

  assert.equal(booking.supplierResolution.reviewRequired, true);
  assert.equal(booking.supplierResolution.reasonCode, "supplier_low_confidence");
  assert.equal(booking.supplierResolution.candidates.length, 0);
});

test("does not match an imported account that is not marked as a supplier", () => {
  const masterData = {
    ...exactMasterData,
    suppliers: [
      supplierAccount({
        id: "customer_only",
        code: "90008",
        name: "Customer Only Account",
        isSupplier: false,
      }),
    ],
  };
  const invoice = uploadedInvoice({}, {
    supplierName: "Customer Only Account",
    supplierVatNumber: "",
    iban: "",
    invoiceNumber: "INV-CUSTOMER-001",
  });
  const booking = generatePurchaseJournalBooking(
    invoice,
    [invoice],
    createInitialLearningStore(),
    masterData
  );

  assert.equal(booking.supplierResolution.selectedAccountId, undefined);
  assert.equal(booking.supplierResolution.reviewRequired, true);
});

test("uses learned supplier decisions to unblock future ambiguous matches", () => {
  const invoice = uploadedInvoice({}, {
    supplierName: "Acme Supplies BV",
    supplierVatNumber: "",
    supplierChamberOfCommerceNumber: "",
    iban: "",
    invoiceNumber: "INV-ACME-002",
  });
  const learning = confirmedLearning(invoice, "supplier_ambiguous_a");
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

test("observe mode does not apply a trusted supplier decision", () => {
  withSupplierLearningMode("observe", () => {
    const invoice = uploadedInvoice({}, {
      supplierName: "Acme Supplies BV",
      supplierVatNumber: "",
      supplierChamberOfCommerceNumber: "",
      supplierAddress: "",
      supplierCountry: "",
      iban: "",
      invoiceNumber: "INV-OBSERVE-SUPPLIER-1",
    });
    const learning = createInitialLearningStore();
    learning.supplierSelections.push({
      supplierIdentity: "name:acme-supplies",
      accountId: "supplier_ambiguous_a",
      decidedAt: "2026-06-16T00:00:00.000Z",
      trustState: "trusted",
    });

    const booking = generatePurchaseJournalBooking(
      invoice,
      [invoice],
      learning,
      exactMasterData
    );

    assert.equal(booking.supplierResolution.selectedAccountId, undefined);
    assert.equal(booking.supplierResolution.reviewRequired, true);
  });
});

test("observe mode still honors the supplier manually selected for this invoice", () => {
  withSupplierLearningMode("observe", () => {
    const invoice = uploadedInvoice({}, {
      supplierName: "Acme Supplies BV",
      supplierVatNumber: "",
      supplierChamberOfCommerceNumber: "",
      supplierAddress: "",
      supplierCountry: "",
      iban: "",
      invoiceNumber: "INV-OBSERVE-MANUAL-1",
    });
    const learning = createInitialLearningStore();
    learning.supplierSelections.push({
      supplierIdentity: "name:acme-supplies",
      accountId: "supplier_ambiguous_a",
      decidedAt: "2026-06-16T00:00:00.000Z",
      invoiceId: invoice.id,
      trustState: "pending",
    });

    const booking = generatePurchaseJournalBooking(
      invoice,
      [invoice],
      learning,
      exactMasterData
    );

    assert.equal(
      booking.supplierResolution.selectedAccountId,
      "supplier_ambiguous_a"
    );
    assert.equal(booking.supplierResolution.reviewRequired, false);
    assert.equal(booking.supplierResolution.selectionOrigin, "manual");
  });
});

test("observe mode does not apply learned journal account, VAT, or cost mappings", () => {
  withSupplierLearningMode("observe", () => {
    const invoice = uploadedInvoice({}, {
      invoiceNumber: "INV-OBSERVE-MAPPINGS-1",
    });
    const learning = createInitialLearningStore();
    learning.supplierSelections.push({
      supplierIdentity: supplierIdentityForInvoice(invoice),
      accountId: "supplier_noordzee",
      decidedAt: "2026-06-16T00:00:00.000Z",
      invoiceId: invoice.id,
      trustState: "pending",
    });
    learning.glAccountSelections.push({
      supplierAccountId: "supplier_noordzee",
      descriptionKey: "office-supplies",
      glAccount: "4420",
      decidedAt: "2026-06-16T00:00:00.000Z",
    });
    learning.vatCodeSelections.push({
      supplierAccountId: "supplier_noordzee",
      descriptionKey: "office-supplies",
      vatCode: "5",
      decidedAt: "2026-06-16T00:00:00.000Z",
    });
    for (const glAccount of ["4400", "4420"]) {
      learning.costCentreSelections.push({
        supplierAccountId: "supplier_noordzee",
        glAccount,
        costCentre: "RTM",
        decidedAt: "2026-06-16T00:00:00.000Z",
      });
      learning.costUnitSelections.push({
        supplierAccountId: "supplier_noordzee",
        glAccount,
        costUnit: "IT",
        decidedAt: "2026-06-16T00:00:00.000Z",
      });
    }

    const booking = generatePurchaseJournalBooking(
      invoice,
      [invoice],
      learning,
      exactMasterData
    );
    const line = booking.lines[0];

    assert.equal(line.finalSelectedAccount, "4400");
    assert.equal(line.vatCode, "4");
    assert.equal(line.costCentre, "AMS");
    assert.equal(line.costUnit, "OPS");
    assert.equal(
      line.reasoning.includes("Applied from previous user correction."),
      false
    );
  });
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
    confirmedLearning(invoice, "supplier_delta_it"),
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
    confirmedLearning(invoice, "supplier_delta_it"),
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
      expected: /multiple supplier matches/i,
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
  const booking = buildBooking(invoice, "supplier_google_ireland");
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
