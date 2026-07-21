import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyExtractedInvoiceData,
  LEARNING_ONLY_BOOKING_MESSAGE,
  type BookingLearningStore,
} from "../lib/domain/invoice";
import {
  createUploadedInvoice,
  getCompanyConnectionUserId,
  getStore,
  learnInvoice,
  listSupplierLearningSummaries,
  markInvoiceBooked,
  markInvoiceBookingFailed,
  markInvoiceNeedsReview,
  recomputeInvoiceState,
  resetLearningForSupplier,
  saveInvoiceReview,
  updateInvoiceExtraction,
} from "../lib/repository/invoice-store";
import { createMockExactMasterData } from "../lib/services/exact-master-data-service";

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

function learningInvoice() {
  const store = getStore();
  store.exactMasterDataCaches = [
    {
      userId: getCompanyConnectionUserId(),
      cache: createMockExactMasterData(),
    },
  ];
  const invoice = createUploadedInvoice({
    fileName: "trusted-learning-source.pdf",
    fileType: "application/pdf",
    fileSize: 2_048,
    checksum: "trusted-content-hash",
    storageKey: "storage/tmp-invoices/trusted-learning-source.pdf",
  });
  const extractedData = {
    ...emptyExtractedInvoiceData(),
    supplierName: "Noordzee Office Supplies",
    supplierVatNumber: "NL812345678B01",
    supplierChamberOfCommerceNumber: "34123456",
    supplierAddress: "Keizersgracht 100, Amsterdam",
    supplierCountry: "NL",
    invoiceNumber: "INV-LEARN-001",
    referenceCode: "INV-LEARN-001",
    invoiceDate: "2026-07-21",
    dueDate: "2026-08-20",
    paymentTerms: "7 days",
    currency: "EUR",
    netAmount: 100,
    vatAmount: 21,
    grossAmount: 121,
    iban: "NL91ABNA0417164300",
    expenseDescription: "Office Supplies",
    companyVatNumber: "NL857017263B01",
    rawText: "Invoice number INV-LEARN-001\nDescription Office Supplies",
  };
  updateInvoiceExtraction(invoice.id, extractedData, { applyLearning: false });
  const computed = recomputeInvoiceState(invoice.id);
  assert.ok(computed?.purchaseJournal?.lines[0]);
  return { invoice: computed, extractedData };
}

test("Learn stores the live corrected draft once and never books it", () => {
  const { invoice, extractedData } = learningInvoice();
  const revisionBefore = invoice.revision ?? 1;
  const correctedData = {
    ...extractedData,
    expenseDescription: "Corrected software subscriptions",
  };
  const bookingLines = [
    {
      ...invoice.purchaseJournal!.lines[0],
      glAccount: "4420",
      finalSelectedAccount: "4420",
      glAccountName: "Software subscriptions",
    },
  ];

  const learned = learnInvoice(invoice.id, correctedData, bookingLines);
  const learnedAgain = learnInvoice(invoice.id, correctedData, bookingLines);

  assert.equal(learned?.status, "Learned");
  assert.equal(learned?.processingPurpose, "learning_only");
  assert.equal(learned?.learningState, "saved");
  assert.equal(learned?.exactBookingStatus, "not_booked");
  assert.equal(learned?.exactBookingId, undefined);
  assert.equal(learned?.storageKey, invoice.storageKey);
  assert.equal(learned?.revision, revisionBefore + 1);
  assert.equal(learnedAgain?.revision, learned?.revision);
  assert.equal(getStore().learning.supplierExamples.length, 1);
  const example = getStore().learning.supplierExamples[0];
  assert.equal(example.originalExtractedData!.expenseDescription, "Office Supplies");
  assert.equal(
    example.finalExtractedData!.expenseDescription,
    "Corrected software subscriptions"
  );
  assert.equal(example.bookingLines![0].finalSelectedAccount, "4420");
  assert.equal(learned?.learningMetadata?.exampleId, example.id);
  assert.equal(learned?.bookingAttempts.length, 0);
  assert.equal(
    getStore().auditEvents.filter(
      (event) => event.invoiceId === invoice.id && event.type === "invoice_learned"
    ).length,
    1
  );
  assert.equal(listSupplierLearningSummaries()[0]?.supplierName, "Noordzee Office Supplies");
});

test("learning-only repository booking mutations reject before changing state", () => {
  const { invoice, extractedData } = learningInvoice();
  const learned = learnInvoice(
    invoice.id,
    extractedData,
    invoice.purchaseJournal!.lines
  )!;
  const before = JSON.stringify(learned);

  assert.throws(
    () => markInvoiceBooked(learned.id, "exact-forbidden"),
    new RegExp(LEARNING_ONLY_BOOKING_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  );
  assert.throws(
    () => markInvoiceBookingFailed(learned.id, "should not mutate"),
    new RegExp(LEARNING_ONLY_BOOKING_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  );
  assert.throws(() => markInvoiceNeedsReview(learned.id), /Learned invoices/i);
  assert.equal(JSON.stringify(getStore().invoices.find((item) => item.id === learned.id)), before);
});

test("supplier reset checks generation, removes legacy rules, and preserves records", () => {
  const { invoice, extractedData } = learningInvoice();
  const learned = learnInvoice(invoice.id, extractedData, invoice.purchaseJournal!.lines)!;
  const accountId = learned.learningMetadata!.supplierAccountId;
  const generation = learned.learningMetadata!.generation;
  const learning = getStore().learning;
  learning.supplierSelections.push({
    supplierIdentity: "vat:NL812345678B01",
    accountId,
    decidedAt: learned.learningMetadata!.learnedAt,
  });
  learning.glAccountSelections.push({
    supplierAccountId: accountId,
    descriptionKey: "office-supplies",
    glAccount: "4420",
    decidedAt: learned.learningMetadata!.learnedAt,
  });
  learning.vatCodeSelections.push({
    supplierAccountId: accountId,
    descriptionKey: "office-supplies",
    vatCode: "4",
    decidedAt: learned.learningMetadata!.learnedAt,
  });
  learning.costCentreSelections.push({
    supplierAccountId: accountId,
    glAccount: "4420",
    costCentre: "AMS",
    decidedAt: learned.learningMetadata!.learnedAt,
  });
  learning.costUnitSelections.push({
    supplierAccountId: accountId,
    glAccount: "4420",
    costUnit: "IT",
    decidedAt: learned.learningMetadata!.learnedAt,
  });
  learning.corrections.push({
    id: "legacy-target-correction",
    invoiceId: learned.id,
    field: "glAccount",
    supplierIdentity: "vat:NL812345678B01",
    supplierName: "Noordzee Office Supplies",
    supplierAccountId: accountId,
    matchKey: "office-supplies",
    originalValue: "4400",
    correctedValue: "4420",
    confidence: 1,
    confidenceBefore: 0.5,
    confidenceAfter: 1,
    correctedAt: learned.learningMetadata!.learnedAt,
    correctedByUserId: "shared_user",
    correctedByUserName: "shared_user",
  });
  const invoicesBefore = JSON.stringify(getStore().invoices);
  const exactBefore = JSON.stringify(getStore().exactMasterDataCaches);

  assert.throws(
    () => resetLearningForSupplier(accountId, generation + 1),
    /generation/i
  );
  const reset = resetLearningForSupplier(accountId, generation);

  assert.equal(reset.generation, generation + 1);
  assert.equal(reset.exampleCount, 0);
  assert.equal(learning.supplierSelections.some((item) => item.accountId === accountId), false);
  assert.equal(learning.glAccountSelections.some((item) => item.supplierAccountId === accountId), false);
  assert.equal(learning.vatCodeSelections.some((item) => item.supplierAccountId === accountId), false);
  assert.equal(learning.costCentreSelections.some((item) => item.supplierAccountId === accountId), false);
  assert.equal(learning.costUnitSelections.some((item) => item.supplierAccountId === accountId), false);
  assert.equal(learning.corrections.some((item) => item.supplierAccountId === accountId), false);
  assert.equal(JSON.stringify(getStore().invoices), invoicesBefore);
  assert.equal(JSON.stringify(getStore().exactMasterDataCaches), exactBefore);
});

test("legacy snapshots hydrate safe learning and invoice defaults", () => {
  const invoice = createUploadedInvoice({
    fileName: "legacy-learned.pdf",
    fileType: "application/pdf",
    fileSize: 100,
    storageKey: "storage/tmp-invoices/legacy-learned.pdf",
  });
  invoice.status = "Learned";
  delete invoice.processingPurpose;
  delete (invoice as Partial<typeof invoice>).learningState;
  delete (invoice as Partial<typeof invoice>).revision;
  const legacyLearning = getStore().learning as Partial<BookingLearningStore>;
  delete legacyLearning.revision;
  delete legacyLearning.supplierProfiles;
  delete legacyLearning.supplierExamples;
  delete legacyLearning.supplierPatterns;
  delete legacyLearning.supplierSelections;
  delete legacyLearning.glAccountSelections;
  delete legacyLearning.vatCodeSelections;
  delete legacyLearning.costCentreSelections;
  delete legacyLearning.costUnitSelections;

  const hydrated = getStore();

  assert.equal(invoice.processingPurpose, "learning_only");
  assert.equal(invoice.learningState, "saved");
  assert.equal(invoice.revision, 1);
  assert.equal(hydrated.learning.revision, 1);
  assert.deepEqual(hydrated.learning.supplierProfiles, []);
  assert.deepEqual(hydrated.learning.supplierExamples, []);
  assert.deepEqual(hydrated.learning.supplierPatterns, []);
  assert.deepEqual(hydrated.learning.supplierSelections, []);
  assert.deepEqual(hydrated.learning.glAccountSelections, []);
});
