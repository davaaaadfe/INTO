import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import {
  emptyExtractedInvoiceData,
  type ExtractedInvoiceData,
  type PurchaseJournalLine,
  type UploadedInvoice,
} from "../lib/domain/invoice";
import {
  applyLearnedExtractedData,
  captureUserCorrections,
  promoteInvoiceCorrections,
} from "../lib/services/correction-learning";
import {
  createInitialLearningStore,
  generatePurchaseJournalBooking,
} from "../lib/services/purchase-journal-intelligence";
import { createMockExactMasterData } from "../lib/services/exact-master-data-service";

const exactMasterData = createMockExactMasterData();

const originalSupplierLearningMode = process.env.SUPPLIER_LEARNING_MODE;
const originalSupplierResolutionV2Enabled =
  process.env.SUPPLIER_RESOLUTION_V2_ENABLED;
const originalLearningShadowMode = process.env.LEARNING_SHADOW_MODE;

function setEnvironmentValue(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
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
  process.env.SUPPLIER_LEARNING_MODE = "apply";
  process.env.SUPPLIER_RESOLUTION_V2_ENABLED = "true";
  process.env.LEARNING_SHADOW_MODE = "false";
});

after(() => {
  setEnvironmentValue("SUPPLIER_LEARNING_MODE", originalSupplierLearningMode);
  setEnvironmentValue(
    "SUPPLIER_RESOLUTION_V2_ENABLED",
    originalSupplierResolutionV2Enabled
  );
  setEnvironmentValue("LEARNING_SHADOW_MODE", originalLearningShadowMode);
});

function data(overrides: Partial<ExtractedInvoiceData> = {}): ExtractedInvoiceData {
  return {
    ...emptyExtractedInvoiceData(),
    supplierName: "Noordzee Office Supplies",
    supplierVatNumber: "NL812345678B01",
    supplierCountry: "NL",
    invoiceNumber: "INV-001",
    referenceCode: "INV-001",
    referenceCodeConfidence: 0.94,
    invoiceDate: "2026-06-16",
    dueDate: "2026-07-16",
    paymentTerms: "7 days",
    currency: "EUR",
    netAmount: 100,
    vatAmount: 21,
    grossAmount: 121,
    expenseDescription: "Office Supplies",
    companyVatNumber: "NL857017263B01",
    rawText: "Factuurnummer INV-001\nOffice Supplies",
    lineItems: [
      {
        id: "source-line-1",
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

function invoice(
  overrides: Partial<UploadedInvoice> = {},
  dataOverrides: Partial<ExtractedInvoiceData> = {}
): UploadedInvoice {
  return {
    id: "invoice-learning",
    userId: "user-accountant",
    uploadedByUserId: "user-accountant",
    uploadedByName: "Tammy Park",
    source: "manual_upload",
    fileName: "AH-invoice-001.pdf",
    fileType: "application/pdf",
    fileSize: 1000,
    storageKey: "storage/tmp-invoices/AH-invoice-001.pdf",
    localFileStatus: "available",
    status: "Uploaded",
    processingPurpose: "booking",
    learningState: "not_saved",
    revision: 1,
    exactBookingStatus: "not_booked",
    extractedData: data(dataOverrides),
    extractionHistory: [],
    purchaseJournal: null,
    validationErrors: [],
    bookingAttempts: [],
    createdAt: "2026-06-16T00:00:00.000Z",
    updatedAt: "2026-06-16T00:00:00.000Z",
    ...overrides,
  };
}

function correctedLine(
  base: PurchaseJournalLine,
  overrides: Partial<PurchaseJournalLine>
): PurchaseJournalLine {
  return { ...base, ...overrides };
}

test("stores correction provenance and replaces an older rule", () => {
  const learning = createInitialLearningStore();
  const current = invoice();
  current.purchaseJournal = generatePurchaseJournalBooking(
    current,
    [current],
    learning,
    exactMasterData
  );
  const originalLine = current.purchaseJournal.lines[0];
  const firstLine = correctedLine(originalLine, {
    glAccount: "4420",
    finalSelectedAccount: "4420",
    glAccountName: "Software subscriptions",
  });

  const first = captureUserCorrections({
    invoice: current,
    nextExtractedData: {
      ...current.extractedData,
      expenseDescription: "Software subscriptions",
    },
    nextBookingLines: [firstLine],
    learning,
    user: { id: "user-accountant", name: "Tammy Park" },
    correctedAt: "2026-06-16T10:00:00.000Z",
  });

  const glCorrection = first.find((item) => item.field === "glAccount");
  assert.ok(glCorrection);
  assert.equal(glCorrection.originalValue, originalLine.finalSelectedAccount);
  assert.equal(glCorrection.correctedValue, "4420");
  assert.equal(glCorrection.supplierName, "Noordzee Office Supplies");
  assert.match(glCorrection.invoiceTextContext ?? "", /Office Supplies/i);
  assert.equal(glCorrection.filenamePattern, "*.pdf");
  assert.equal(glCorrection.correctedAt, "2026-06-16T10:00:00.000Z");
  assert.equal(glCorrection.correctedByUserId, "user-accountant");
  assert.equal(glCorrection.trustState, "pending");

  current.purchaseJournal.lines = [firstLine];
  captureUserCorrections({
    invoice: current,
    nextExtractedData: current.extractedData,
    nextBookingLines: [
      correctedLine(firstLine, {
        glAccount: "4510",
        finalSelectedAccount: "4510",
        glAccountName: "Hotel expenses",
      }),
    ],
    learning,
    user: { id: "user-owner", name: "System Owner" },
    correctedAt: "2026-06-17T10:00:00.000Z",
  });

  const storedGlRules = learning.corrections.filter(
    (item) => item.field === "glAccount"
  );
  assert.equal(storedGlRules.length, 1);
  assert.equal(storedGlRules[0].originalValue, originalLine.finalSelectedAccount);
  assert.equal(storedGlRules[0].correctedValue, "4510");
  assert.equal(storedGlRules[0].correctedByUserId, "user-owner");
});

test("pending corrections do not apply until a trusted workflow promotes them", () => {
  const learning = createInitialLearningStore();
  const original = invoice({}, {
    supplierName: "Misspelled Supplier",
    supplierVatNumber: "",
  });
  captureUserCorrections({
    invoice: original,
    nextExtractedData: {
      ...original.extractedData,
      supplierName: "Correct Supplier",
    },
    nextBookingLines: [],
    learning,
    user: { id: "shared_user", name: "Shared INTO User" },
    correctedAt: "2026-06-16T10:00:00.000Z",
  });
  const future = invoice(
    { id: "future-invoice" },
    { supplierName: "Misspelled Supplier", supplierVatNumber: "" }
  );

  assert.equal(
    applyLearnedExtractedData(future, future.extractedData, learning).data
      .supplierName,
    "Misspelled Supplier"
  );

  promoteInvoiceCorrections(
    learning,
    original.id,
    "learn",
    "2026-06-16T11:00:00.000Z"
  );

  assert.equal(learning.corrections[0].trustState, "trusted");
  assert.equal(learning.corrections[0].trustedAt, "2026-06-16T11:00:00.000Z");
  assert.equal(
    applyLearnedExtractedData(future, future.extractedData, learning).data
      .supplierName,
    "Correct Supplier"
  );
});

test("a correction to a learned value replaces the original rule", () => {
  const learning = createInitialLearningStore();
  const original = invoice({}, {
    supplierName: "Noordzee Office Supplys",
    supplierVatNumber: "",
  });
  captureUserCorrections({
    invoice: original,
    nextExtractedData: {
      ...original.extractedData,
      supplierName: "Noordzee Office Supplies",
    },
    nextBookingLines: [],
    learning,
    user: { id: "shared_user", name: "Shared INTO User" },
  });
  promoteInvoiceCorrections(learning, original.id, "learn");

  const second = invoice(
    { id: "invoice-second", fileName: "AH-invoice-002.pdf" },
    { supplierName: "Noordzee Office Supplys", supplierVatNumber: "" }
  );
  const learned = applyLearnedExtractedData(
    second,
    second.extractedData,
    learning
  );
  assert.equal(learned.data.supplierName, "Noordzee Office Supplies");
  second.extractedData = learned.data;
  second.learnedFieldsApplied = learned.appliedFields;

  captureUserCorrections({
    invoice: second,
    nextExtractedData: {
      ...second.extractedData,
      supplierName: "Noordzee Office Supplies B.V.",
    },
    nextBookingLines: [],
    learning,
    user: { id: "shared_user", name: "Shared INTO User" },
  });
  promoteInvoiceCorrections(learning, second.id, "learn");

  const supplierRules = learning.corrections.filter(
    (item) =>
      item.field === "supplier" &&
      item.metadata?.correctionKind === "extractedValue"
  );
  assert.equal(supplierRules.length, 1);
  assert.equal(supplierRules[0].originalValue, "Noordzee Office Supplys");
  assert.equal(supplierRules[0].correctedValue, "Noordzee Office Supplies B.V.");
  assert.equal(supplierRules[0].invoiceId, "invoice-second");

  const third = invoice(
    { id: "invoice-third", fileName: "AH-invoice-003.pdf" },
    { supplierName: "Noordzee Office Supplys", supplierVatNumber: "" }
  );
  assert.equal(
    applyLearnedExtractedData(third, third.extractedData, learning).data
      .supplierName,
    "Noordzee Office Supplies B.V."
  );
});

test("stores invoice field corrections with complete provenance and confidence", () => {
  const learning = createInitialLearningStore();
  const current = invoice({}, {
    invoiceDate: "2026-06-15",
    netAmount: 99,
    vatAmount: 20.79,
    grossAmount: 119.79,
    confidence: 0.72,
    rawText: [
      "Invoice date: 16-06-2026",
      "Net amount: EUR 100,00",
      "VAT amount: EUR 21,00",
      "Total amount: EUR 121,00",
    ].join("\n"),
  });
  current.purchaseJournal = generatePurchaseJournalBooking(
    current,
    [current],
    learning,
    exactMasterData
  );

  const captured = captureUserCorrections({
    invoice: current,
    nextExtractedData: {
      ...current.extractedData,
      invoiceDate: "2026-06-16",
      netAmount: 100,
      vatAmount: 21,
      grossAmount: 121,
    },
    nextBookingLines: current.purchaseJournal.lines,
    learning,
    user: { id: "shared_user", name: "Shared INTO User" },
    correctedAt: "2026-06-16T10:00:00.000Z",
  });

  assert.deepEqual(
    captured.map((item) => item.field).sort(),
    ["invoiceDate", "netAmount", "totalAmount", "vatAmount"]
  );
  for (const correction of captured) {
    assert.equal(correction.invoiceId, "invoice-learning");
    assert.equal(correction.supplierName, "Noordzee Office Supplies");
    assert.equal(correction.correctedAt, "2026-06-16T10:00:00.000Z");
    assert.equal(correction.correctedByUserId, "shared_user");
    assert.equal(correction.confidenceBefore, 0.72);
    assert.equal(correction.confidenceAfter, 1);
    assert.match(correction.invoiceTextContext ?? "", /amount|date/i);
    assert.equal(correction.filenamePattern, "*.pdf");
  }
});

test("stores extraction evidence labels with learned field corrections", () => {
  const learning = createInitialLearningStore();
  const current = invoice({}, {
    referenceCode: "SOURCE-REF",
    invoiceNumber: "SOURCE-REF",
    invoiceDate: "2026-06-15",
    rawText: "Document date: 16-06-2026\nVendor reference: CORRECT-REF",
    extractionEvidence: {
      referenceCode: {
        sourceLabel: "Vendor reference",
        rawValue: "SOURCE-REF",
        confidence: 0.7,
        page: 1,
        context: "Vendor reference: CORRECT-REF",
      },
      invoiceDate: {
        sourceLabel: "Document date",
        rawValue: "16-06-2026",
        confidence: 0.75,
        page: 1,
        context: "Document date: 16-06-2026",
      },
    },
  });

  const captured = captureUserCorrections({
    invoice: current,
    nextExtractedData: {
      ...current.extractedData,
      referenceCode: "CORRECT-REF",
      invoiceNumber: "CORRECT-REF",
      invoiceDate: "2026-06-16",
    },
    nextBookingLines: [],
    learning,
    user: { id: "shared_user", name: "Shared INTO User" },
  });

  assert.equal(
    captured.find((item) => item.field === "yourRefPattern")?.metadata
      ?.referenceLabel,
    "Vendor reference"
  );
  assert.equal(
    captured.find((item) => item.field === "invoiceDate")?.metadata
      ?.sourceLabel,
    "Document date"
  );
});

test("uses learned OCR labels for a future invoice date and amounts", () => {
  const learning = createInitialLearningStore();
  const original = invoice({}, {
    invoiceDate: "2026-06-15",
    netAmount: 99,
    vatAmount: 20.79,
    grossAmount: 119.79,
    rawText: [
      "Invoice date: 16-06-2026",
      "Net amount: EUR 100,00",
      "VAT amount: EUR 21,00",
      "Total amount: EUR 121,00",
    ].join("\n"),
  });
  captureUserCorrections({
    invoice: original,
    nextExtractedData: {
      ...original.extractedData,
      invoiceDate: "2026-06-16",
      netAmount: 100,
      vatAmount: 21,
      grossAmount: 121,
    },
    nextBookingLines: [],
    learning,
    user: { id: "shared_user", name: "Shared INTO User" },
  });
  promoteInvoiceCorrections(learning, original.id, "learn");

  const future = invoice(
    { id: "invoice-future", fileName: "AH-invoice-002.pdf" },
    {
      invoiceDate: "2026-07-16",
      netAmount: 199,
      vatAmount: 41.79,
      grossAmount: 240.79,
      rawText: [
        "Invoice date: 17-07-2026",
        "Net amount: EUR 200,00",
        "VAT amount: EUR 42,00",
        "Total amount: EUR 242,00",
      ].join("\n"),
    }
  );
  const result = applyLearnedExtractedData(future, future.extractedData, learning);

  assert.equal(result.data.invoiceDate, "2026-07-17");
  assert.equal(result.data.netAmount, 200);
  assert.equal(result.data.vatAmount, 42);
  assert.equal(result.data.grossAmount, 242);
  assert.ok(result.appliedFields.includes("invoiceDate"));
  assert.ok(result.appliedFields.includes("netAmount"));
  assert.ok(result.appliedFields.includes("vatAmount"));
  assert.ok(result.appliedFields.includes("totalAmount"));
});

test("normalizes a cased evidence label before applying a learned date", () => {
  const learning = createInitialLearningStore();
  const original = invoice({}, {
    invoiceDate: "2026-06-15",
    rawText: "Invoice date: 16-06-2026",
    extractionEvidence: {
      invoiceDate: {
        sourceLabel: "Invoice date",
        rawValue: "16-06-2026",
        confidence: 0.75,
      },
    },
  });
  captureUserCorrections({
    invoice: original,
    nextExtractedData: {
      ...original.extractedData,
      invoiceDate: "2026-06-16",
    },
    nextBookingLines: [],
    learning,
    user: { id: "shared_user", name: "Shared INTO User" },
  });
  promoteInvoiceCorrections(learning, original.id, "learn");
  const future = invoice(
    { id: "invoice-future", fileName: "AH-invoice-002.pdf" },
    {
      invoiceDate: "2026-07-16",
      rawText: "Invoice date: 17-07-2026",
    }
  );

  const result = applyLearnedExtractedData(
    future,
    future.extractedData,
    learning
  );

  assert.equal(result.data.invoiceDate, "2026-07-17");
  assert.ok(result.appliedFields.includes("invoiceDate"));
});

test("observe mode records corrections but does not apply trusted extraction learning", () => {
  withSupplierLearningMode("observe", () => {
    const learning = createInitialLearningStore();
    const original = invoice({}, {
      supplierName: "Misspelled Supplier",
      supplierVatNumber: "",
    });
    captureUserCorrections({
      invoice: original,
      nextExtractedData: {
        ...original.extractedData,
        supplierName: "Correct Supplier",
      },
      nextBookingLines: [],
      learning,
      user: { id: "shared_user", name: "Shared INTO User" },
    });
    assert.equal(learning.corrections.length, 1);
    promoteInvoiceCorrections(learning, original.id, "learn");
    const future = invoice(
      { id: "invoice-future" },
      { supplierName: "Misspelled Supplier", supplierVatNumber: "" }
    );

    const result = applyLearnedExtractedData(
      future,
      future.extractedData,
      learning
    );

    assert.equal(result.data.supplierName, "Misspelled Supplier");
    assert.deepEqual(result.appliedFields, []);
    assert.equal(result.candidates[0]?.field, "supplierName");
    assert.equal(result.candidates[0]?.value, "Correct Supplier");
    assert.equal(result.candidates[0]?.source, "supplier_learning");
    assert.equal(result.candidates[0]?.rule, learning.corrections[0]?.id);
  });
});

test("supplier correction candidates require the active generation and recognized cluster", () => {
  withSupplierLearningMode("observe", () => {
    const learning = createInitialLearningStore();
    const rawText = "Invoice number: INV-001\nTotal: EUR 121.00";
    const original = invoice({}, { expenseDescription: "Old", rawText });
    captureUserCorrections({
      invoice: original,
      nextExtractedData: { ...original.extractedData, expenseDescription: "Learned" },
      nextBookingLines: [],
      learning,
      user: { id: "shared_user", name: "Shared INTO User" },
    });
    promoteInvoiceCorrections(learning, original.id, "learn");
    const correction = learning.corrections[0]!;
    correction.supplierAccountId = "supplier-a";
    correction.generation = 1;
    correction.formatCluster = "cluster-a";
    learning.supplierProfiles = [{
      supplierAccountId: "supplier-a",
      generation: 2,
      exampleCount: 1,
      formatDrift: "none",
    }];
    learning.supplierExamples = [{
      supplierAccountId: "supplier-a",
      generation: 2,
      invoiceId: "trusted-layout",
      contentHash: "trusted-layout-hash",
      formatFingerprint: "layout-a",
      formatSignature: "invoice number:<value>\ntotal:<value>",
      formatCluster: "cluster-a",
      learnedAt: "2026-08-17T10:00:00.000Z",
      trustState: "trusted",
    }];
    const future = invoice({ id: "future" }, { expenseDescription: "Old", rawText });

    assert.deepEqual(
      applyLearnedExtractedData(future, future.extractedData, learning).candidates,
      []
    );
    correction.generation = 2;
    const activeCandidate = applyLearnedExtractedData(
      future,
      future.extractedData,
      learning
    ).candidates[0];
    assert.equal(activeCandidate?.value, "Learned");
    assert.deepEqual(activeCandidate?.clusterContext, {
      supplierAccountId: "supplier-a",
      generation: 2,
      clusterId: "cluster-a",
    });
    future.extractedData.rawText = "Document reference: B-1\nAmount due: EUR 121.00";
    assert.deepEqual(
      applyLearnedExtractedData(future, future.extractedData, learning).candidates,
      []
    );
  });
});

test("does not treat a subtotal label as the learned invoice total", () => {
  const learning = createInitialLearningStore();
  const original = invoice({}, {
    grossAmount: 119,
    rawText: [
      "Subtotal amount: EUR 100,00",
      "VAT amount: EUR 21,00",
      "Total amount: EUR 121,00",
    ].join("\n"),
  });
  captureUserCorrections({
    invoice: original,
    nextExtractedData: { ...original.extractedData, grossAmount: 121 },
    nextBookingLines: [],
    learning,
    user: { id: "shared_user", name: "Shared INTO User" },
  });
  promoteInvoiceCorrections(learning, original.id, "learn");

  const future = invoice(
    { id: "invoice-future", fileName: "AH-invoice-002.pdf" },
    {
      grossAmount: 240,
      rawText: [
        "Subtotal amount: EUR 200,00",
        "VAT amount: EUR 42,00",
        "Total amount: EUR 242,00",
      ].join("\n"),
    }
  );
  assert.equal(
    applyLearnedExtractedData(future, future.extractedData, learning).data
      .grossAmount,
    242
  );
});

test("uses a learned Factuurnummer pattern for a future invoice", () => {
  const learning = createInitialLearningStore();
  const original = invoice({}, {
    referenceCode: "WRONG-REF",
    invoiceNumber: "WRONG-REF",
    rawText: "Factuurnummer AH-2026-004821\nTotaal EUR 121.00",
  });

  captureUserCorrections({
    invoice: original,
    nextExtractedData: {
      ...original.extractedData,
      referenceCode: "AH-2026-004821",
    },
    nextBookingLines: [],
    learning,
    user: { id: "user-accountant", name: "Tammy Park" },
    correctedAt: "2026-06-16T10:00:00.000Z",
  });
  promoteInvoiceCorrections(learning, original.id, "learn");

  const future = invoice(
    { id: "invoice-future", fileName: "AH-invoice-002.pdf" },
    {
      invoiceNumber: "",
      referenceCode: "",
      referenceCodeConfidence: 0,
      rawText: "Factuurnummer AH-2026-009999\nTotaal EUR 242.00",
    }
  );
  const result = applyLearnedExtractedData(
    future,
    future.extractedData,
    learning
  );

  assert.equal(result.data.referenceCode, "AH-2026-009999");
  assert.equal(result.data.invoiceNumber, "AH-2026-009999");
  assert.ok(result.appliedFields.includes("yourRefPattern"));
});

test("does not apply a learned rule to a different supplier", () => {
  const learning = createInitialLearningStore();
  const original = invoice({}, {
    paymentTerms: "7 days",
  });
  captureUserCorrections({
    invoice: original,
    nextExtractedData: { ...original.extractedData, paymentTerms: "30 days" },
    nextBookingLines: [],
    learning,
    user: { id: "user-accountant", name: "Tammy Park" },
  });

  const unrelated = invoice(
    { id: "invoice-unrelated", fileName: "other-invoice-001.pdf" },
    {
      supplierName: "Different Supplier",
      supplierVatNumber: "NL999999999B01",
      paymentTerms: "7 days",
    }
  );
  const result = applyLearnedExtractedData(
    unrelated,
    unrelated.extractedData,
    learning
  );

  assert.equal(result.data.paymentTerms, "7 days");
  assert.deepEqual(result.appliedFields, []);
});

test("does not apply a contextless rule to an unrelated invoice", () => {
  const learning = createInitialLearningStore();
  const original = invoice(
    { fileName: "first-document.pdf" },
    { expenseDescription: "", lineItems: [], paymentTerms: "7 days" }
  );
  captureUserCorrections({
    invoice: original,
    nextExtractedData: { ...original.extractedData, paymentTerms: "30 days" },
    nextBookingLines: [],
    learning,
    user: { id: "shared_user", name: "Shared INTO User" },
  });

  const unrelated = invoice(
    { id: "invoice-unrelated", fileName: "different-document.pdf" },
    { expenseDescription: "", lineItems: [], paymentTerms: "7 days" }
  );
  const result = applyLearnedExtractedData(
    unrelated,
    unrelated.extractedData,
    learning
  );
  assert.equal(result.data.paymentTerms, "7 days");
  assert.deepEqual(result.appliedFields, []);
});

test("does not activate a correction from a matching filename pattern", () => {
  const learning = createInitialLearningStore();
  const original = invoice(
    { fileName: "monthly-invoice-001.pdf" },
    { expenseDescription: "", lineItems: [], paymentTerms: "7 days" }
  );
  captureUserCorrections({
    invoice: original,
    nextExtractedData: { ...original.extractedData, paymentTerms: "30 days" },
    nextBookingLines: [],
    learning,
    user: { id: "shared_user", name: "Shared INTO User" },
  });
  promoteInvoiceCorrections(learning, original.id, "learn");

  const later = invoice(
    { id: "invoice-later", fileName: "monthly-invoice-002.pdf" },
    { expenseDescription: "", lineItems: [], paymentTerms: "7 days" }
  );
  const result = applyLearnedExtractedData(later, later.extractedData, learning);

  assert.equal(result.data.paymentTerms, "7 days");
  assert.deepEqual(result.appliedFields, []);
});

test("applies a learned booking-line split before default suggestions", () => {
  const learning = createInitialLearningStore();
  const original = invoice();
  original.purchaseJournal = generatePurchaseJournalBooking(
    original,
    [original],
    learning,
    exactMasterData
  );
  const seedLine = original.purchaseJournal.lines[0];
  const splitLines = [
    correctedLine(seedLine, {
      id: "corrected-line-1",
      description: "Office supplies",
      amount: 60,
      vatAmount: 12.6,
      glAccount: "4400",
      finalSelectedAccount: "4400",
    }),
    correctedLine(seedLine, {
      id: "corrected-line-2",
      description: "Software subscription",
      amount: 40,
      vatAmount: 8.4,
      glAccount: "4420",
      finalSelectedAccount: "4420",
      glAccountName: "Software subscriptions",
    }),
  ];

  captureUserCorrections({
    invoice: original,
    nextExtractedData: original.extractedData,
    nextBookingLines: splitLines,
    learning,
    user: { id: "user-accountant", name: "Tammy Park" },
    correctedAt: "2026-06-16T10:00:00.000Z",
  });
  promoteInvoiceCorrections(learning, original.id, "learn");

  const future = invoice({ id: "invoice-future", fileName: "AH-invoice-002.pdf" }, {
    invoiceNumber: "INV-002",
    referenceCode: "INV-002",
    netAmount: 200,
    vatAmount: 42,
    grossAmount: 242,
  });
  const booking = generatePurchaseJournalBooking(
    future,
    [future],
    learning,
    exactMasterData
  );

  assert.equal(booking.lines.length, 2);
  assert.deepEqual(
    booking.lines.map((line) => line.finalSelectedAccount),
    ["4400", "4420"]
  );
  assert.deepEqual(
    booking.lines.map((line) => [line.amount, line.vatAmount]),
    [
      [120, 25.2],
      [80, 16.8],
    ]
  );
  assert.equal(booking.totals.difference, 0);
  assert.ok(
    booking.reasoningLog.includes("Applied from previous user correction.")
  );

  withSupplierLearningMode("observe", () => {
    const observedFuture = invoice(
      { id: "invoice-observed", fileName: "AH-invoice-003.pdf" },
      {
        invoiceNumber: "INV-003",
        referenceCode: "INV-003",
        netAmount: 300,
        vatAmount: 63,
        grossAmount: 363,
      }
    );
    const observedBooking = generatePurchaseJournalBooking(
      observedFuture,
      [observedFuture],
      learning,
      exactMasterData
    );

    assert.equal(observedBooking.lines.length, 1);
    assert.equal(
      observedBooking.reasoningLog.includes(
        "Applied from previous user correction."
      ),
      false
    );
  });
});

test("applies learned line allocation and accrual behavior to current invoice totals", () => {
  const learning = createInitialLearningStore();
  const original = invoice();
  original.purchaseJournal = generatePurchaseJournalBooking(
    original,
    [original],
    learning,
    exactMasterData
  );
  const seedLine = original.purchaseJournal.lines[0];
  const corrected = correctedLine(seedLine, {
    description: "Software license",
    glAccount: "4420",
    finalSelectedAccount: "4420",
    glAccountName: "Software subscriptions",
    vatCode: "5",
    vatCodeName: "VAT to claim 9%",
    costCentre: "RTM",
    costUnit: "IT",
    from: "2026-07-01",
    to: "2027-06-30",
    amount: 100,
    vatAmount: 21,
  });
  captureUserCorrections({
    invoice: original,
    nextExtractedData: original.extractedData,
    nextBookingLines: [corrected],
    learning,
    user: { id: "shared_user", name: "Shared INTO User" },
  });
  promoteInvoiceCorrections(learning, original.id, "learn");

  const future = invoice(
    { id: "invoice-future", fileName: "AH-invoice-002.pdf" },
    {
      invoiceNumber: "INV-002",
      referenceCode: "INV-002",
      invoiceDate: "2026-07-16",
      netAmount: 200,
      vatAmount: 18,
      grossAmount: 218,
    }
  );
  const booking = generatePurchaseJournalBooking(
    future,
    [future],
    learning,
    exactMasterData
  );

  assert.equal(booking.lines.length, 1);
  assert.equal(booking.lines[0].finalSelectedAccount, "4420");
  assert.equal(booking.lines[0].vatCode, "5");
  assert.equal(booking.lines[0].costCentre, "RTM");
  assert.equal(booking.lines[0].costUnit, "IT");
  assert.equal(booking.lines[0].description, "Software license");
  assert.equal(booking.lines[0].from, "2026-08-01");
  assert.equal(booking.lines[0].to, "2027-07-31");
  assert.equal(booking.lines[0].amount, 200);
  assert.equal(booking.lines[0].vatAmount, 18);
  assert.equal(booking.totals.difference, 0);
  assert.ok(
    booking.reasoningLog.includes("Applied from previous user correction.")
  );
});

test("preserves negative discount lines in a learned split", () => {
  const learning = createInitialLearningStore();
  const original = invoice();
  original.purchaseJournal = generatePurchaseJournalBooking(
    original,
    [original],
    learning,
    exactMasterData
  );
  const seedLine = original.purchaseJournal.lines[0];
  captureUserCorrections({
    invoice: original,
    nextExtractedData: original.extractedData,
    nextBookingLines: [
      correctedLine(seedLine, { amount: 110, vatAmount: 21 }),
      correctedLine(seedLine, {
        id: "discount-line",
        description: "Discount",
        amount: -10,
        vatAmount: 0,
      }),
    ],
    learning,
    user: { id: "shared_user", name: "Shared INTO User" },
  });
  promoteInvoiceCorrections(learning, original.id, "learn");

  const future = invoice(
    { id: "invoice-future", fileName: "AH-invoice-002.pdf" },
    {
      invoiceNumber: "INV-002",
      referenceCode: "INV-002",
      netAmount: 180,
      vatAmount: 37.8,
      grossAmount: 217.8,
    }
  );
  const booking = generatePurchaseJournalBooking(
    future,
    [future],
    learning,
    exactMasterData
  );

  assert.equal(booking.lines.length, 2);
  assert.ok(booking.lines.some((line) => line.amount < 0));
  assert.equal(
    booking.lines.reduce((sum, line) => sum + line.amount, 0),
    180
  );
  assert.equal(
    booking.lines.reduce((sum, line) => sum + line.vatAmount, 0),
    37.8
  );
});

test("keeps untouched low-confidence line fields review-required", () => {
  const learning = createInitialLearningStore();
  const original = invoice();
  original.purchaseJournal = generatePurchaseJournalBooking(
    original,
    [original],
    learning,
    exactMasterData
  );
  const seedLine = {
    ...original.purchaseJournal.lines[0],
    vatConfidence: 0.4,
  };
  original.purchaseJournal.lines = [seedLine];
  captureUserCorrections({
    invoice: original,
    nextExtractedData: original.extractedData,
    nextBookingLines: [
      correctedLine(seedLine, {
        glAccount: "4420",
        finalSelectedAccount: "4420",
        glAccountName: "Software subscriptions",
      }),
    ],
    learning,
    user: { id: "shared_user", name: "Shared INTO User" },
  });
  promoteInvoiceCorrections(learning, original.id, "learn");

  const future = invoice(
    { id: "invoice-future", fileName: "AH-invoice-002.pdf" },
    { invoiceNumber: "INV-002", referenceCode: "INV-002" }
  );
  const booking = generatePurchaseJournalBooking(
    future,
    [future],
    learning,
    exactMasterData
  );

  assert.equal(booking.lines[0].finalSelectedAccount, "4420");
  assert.equal(booking.lines[0].vatConfidence, 0.4);
  assert.equal(booking.lines[0].reviewRequired, true);
});
