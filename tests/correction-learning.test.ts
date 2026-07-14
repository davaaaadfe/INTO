import test from "node:test";
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
} from "../lib/services/correction-learning";
import {
  createInitialLearningStore,
  generatePurchaseJournalBooking,
} from "../lib/services/purchase-journal-intelligence";
import { createMockExactMasterData } from "../lib/services/exact-master-data-service";

const exactMasterData = createMockExactMasterData();

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
  assert.equal(glCorrection.filenamePattern, "ah-invoice-#.pdf");
  assert.equal(glCorrection.correctedAt, "2026-06-16T10:00:00.000Z");
  assert.equal(glCorrection.correctedByUserId, "user-accountant");

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
  assert.equal(storedGlRules[0].correctedValue, "4510");
  assert.equal(storedGlRules[0].correctedByUserId, "user-owner");
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

  const future = invoice({ id: "invoice-future", fileName: "AH-invoice-002.pdf" }, {
    invoiceNumber: "INV-002",
    referenceCode: "INV-002",
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
  assert.equal(booking.totals.difference, 0);
  assert.ok(
    booking.reasoningLog.includes("Applied from previous user correction.")
  );
});
