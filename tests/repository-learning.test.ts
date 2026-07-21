import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyExtractedInvoiceData,
  LEARNING_ONLY_BOOKING_MESSAGE,
  type BookingLearningStore,
} from "../lib/domain/invoice";
import {
  approveInvoiceIntelligence,
  createUploadedInvoice,
  getCompanyConnectionUserId,
  getStore,
  learnInvoice,
  listSupplierLearningSummaries,
  markInvoiceBooked,
  markInvoiceBookingFailed,
  markInvoiceNeedsReview,
  recomputeInvoiceState,
  replaceInvoiceExtractionFromReread,
  resetLearningForSupplier,
  saveInvoiceReview,
  selectInvoiceSupplier,
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
  const initialRevision = invoice.revision!;
  updateInvoiceExtraction(invoice.id, extractedData, { applyLearning: false });
  const computed = recomputeInvoiceState(invoice.id);
  assert.ok(computed?.purchaseJournal?.lines[0]);
  assert.equal(computed.revision, initialRevision + 1);

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
  assert.equal(saved?.revision, initialRevision + 2);
  assert.ok(
    getStore().learning.corrections.some(
      (correction) =>
        correction.field === "glAccount" &&
        correction.correctedValue === "4420" &&
        correction.trustState === "pending"
    )
  );
  approveInvoiceIntelligence(invoice.id);
  assert.ok(
    getStore().learning.corrections.some(
      (correction) =>
        correction.invoiceId === invoice.id &&
        correction.field === "glAccount" &&
        correction.trustState === "trusted" &&
        correction.trustReason === "approval"
    )
  );
});

let learningInvoiceSequence = 0;

function learningInvoice() {
  learningInvoiceSequence += 1;
  const sequence = learningInvoiceSequence;
  const store = getStore();
  store.exactMasterDataCaches = [
    {
      userId: getCompanyConnectionUserId(),
      cache: createMockExactMasterData(),
    },
  ];
  const invoice = createUploadedInvoice({
    fileName: `trusted-learning-source-${sequence}.pdf`,
    fileType: "application/pdf",
    fileSize: 2_048,
    checksum: `trusted-content-hash-${sequence}`,
    storageKey: `storage/tmp-invoices/trusted-learning-source-${sequence}.pdf`,
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
  const initialRevision = invoice.revision!;
  updateInvoiceExtraction(invoice.id, extractedData, { applyLearning: false });
  const computed = recomputeInvoiceState(invoice.id);
  assert.ok(computed?.purchaseJournal?.lines[0]);
  assert.equal(computed.revision, initialRevision + 1);
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
  const requestRevision = invoice.revision!;

  const learned = learnInvoice(
    invoice.id,
    correctedData,
    bookingLines,
    requestRevision
  );
  const learnedAgain = learnInvoice(
    invoice.id,
    correctedData,
    bookingLines,
    requestRevision
  );

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
  assert.equal(
    getStore().learning.corrections
      .filter((correction) => correction.invoiceId === invoice.id)
      .every(
        (correction) =>
          correction.trustState === "trusted" &&
          correction.trustReason === "learn"
      ),
    true
  );
});

test("successful booking promotes pending corrections", () => {
  const { invoice, extractedData } = learningInvoice();
  const saved = saveInvoiceReview(
    invoice.id,
    { ...extractedData, expenseDescription: "Booked correction" },
    invoice.purchaseJournal!.lines
  )!;
  assert.ok(
    getStore().learning.corrections.some(
      (correction) =>
        correction.invoiceId === invoice.id && correction.trustState === "pending"
    )
  );

  markInvoiceBooked(saved.id, "exact-trust-promotion");

  assert.equal(
    getStore().learning.corrections
      .filter((correction) => correction.invoiceId === invoice.id)
      .every(
        (correction) =>
          correction.trustState === "trusted" &&
          correction.trustReason === "booking"
      ),
    true
  );
});

test("Learn rejects an earlier draft after intervening extraction and review edits", () => {
  const { invoice, extractedData } = learningInvoice();
  const staleRevision = invoice.revision!;
  const extractionEdit = {
    ...extractedData,
    expenseDescription: "Extraction edit",
  };
  updateInvoiceExtraction(
    invoice.id,
    extractionEdit,
    { applyLearning: false }
  );
  const afterExtraction = recomputeInvoiceState(invoice.id)!;
  const extractionRevision = afterExtraction.revision;
  const reviewLines = structuredClone(afterExtraction.purchaseJournal!.lines);
  const afterReview = saveInvoiceReview(
    invoice.id,
    { ...extractionEdit, expenseDescription: "Review edit" },
    reviewLines
  )!;
  const editedBeforeLearn = structuredClone(afterReview);
  const learningBefore = structuredClone(getStore().learning);
  const auditsBefore = structuredClone(getStore().auditEvents);

  assert.equal(extractionRevision, staleRevision + 1);
  assert.equal(afterReview.revision, staleRevision + 2);
  assert.throws(
    () =>
      learnInvoice(
        invoice.id,
        extractedData,
        afterReview.purchaseJournal!.lines,
        staleRevision
      ),
    /revision changed/i
  );
  assert.deepEqual(afterReview, editedBeforeLearn);
  assert.deepEqual(getStore().learning, learningBefore);
  assert.deepEqual(getStore().auditEvents, auditsBefore);
});

test("re-read and supplier selection each invalidate an earlier Learn draft", () => {
  const { invoice, extractedData } = learningInvoice();
  const beforeRereadRevision = invoice.revision!;
  const reread = replaceInvoiceExtractionFromReread(invoice.id, {
    ...extractedData,
    expenseDescription: "Re-read description",
  })!;

  assert.equal(reread.revision, beforeRereadRevision + 1);
  assert.throws(
    () =>
      learnInvoice(
        invoice.id,
        extractedData,
        reread.purchaseJournal!.lines,
        beforeRereadRevision
      ),
    /revision changed/i
  );

  updateInvoiceExtraction(
    invoice.id,
    {
      ...extractedData,
      supplierName: "Acme Supplies BV",
      supplierVatNumber: "NL123456789B01",
      supplierChamberOfCommerceNumber: "",
      supplierAddress: "",
      supplierCountry: "",
      iban: "",
    },
    { applyLearning: false }
  );
  const ambiguous = recomputeInvoiceState(invoice.id)!;
  assert.equal(ambiguous.purchaseJournal!.supplierResolution.selectedAccountId, undefined);
  getStore().learning.supplierSelections.unshift({
    supplierIdentity: "vat:NL123456789B01",
    accountId: "supplier_ambiguous_b",
    decidedAt: "2026-07-20T00:00:00.000Z",
    invoiceId: "previous-approved-invoice",
    trustState: "trusted",
  });
  const beforeSelectionRevision = ambiguous.revision!;
  const selected = selectInvoiceSupplier(invoice.id, "supplier_ambiguous_a")!;

  assert.equal(
    selected.purchaseJournal!.supplierResolution.selectedAccountId,
    "supplier_ambiguous_a"
  );
  assert.equal(selected.revision, beforeSelectionRevision + 1);
  assert.ok(
    getStore().learning.supplierSelections.some(
      (decision) =>
        decision.supplierIdentity === "vat:NL123456789B01" &&
        decision.accountId === "supplier_ambiguous_b" &&
        decision.trustState === "trusted"
    ),
    "an unapproved selection must not erase prior trusted evidence"
  );
  assert.throws(
    () =>
      learnInvoice(
        invoice.id,
        selected.extractedData,
        selected.purchaseJournal!.lines,
        beforeSelectionRevision
      ),
    /revision changed/i
  );
});

test("a recompute that changes Learn-visible supplier data increments the revision", () => {
  const { invoice, extractedData } = learningInvoice();
  const staleRevision = invoice.revision!;
  const store = getStore();
  const cache = store.exactMasterDataCaches[0]!.cache;
  cache.suppliers = cache.suppliers.filter(
    (supplier) => supplier.id !== "supplier_noordzee"
  );

  const recomputed = recomputeInvoiceState(invoice.id)!;

  assert.equal(recomputed.revision, staleRevision + 1);
  assert.equal(recomputed.purchaseJournal!.supplierResolution.selectedAccountId, undefined);
  assert.throws(
    () =>
      learnInvoice(
        invoice.id,
        extractedData,
        invoice.purchaseJournal!.lines,
        staleRevision
      ),
    /revision changed/i
  );
});

test("an exact Learn retry is idempotent but a different stale payload conflicts", () => {
  const { invoice, extractedData } = learningInvoice();
  const requestRevision = invoice.revision!;
  const bookingLines = invoice.purchaseJournal!.lines;
  const learned = learnInvoice(
    invoice.id,
    extractedData,
    bookingLines,
    requestRevision
  )!;
  const learnedBeforeRetry = structuredClone(learned);
  const learningBeforeRetry = structuredClone(getStore().learning);
  const auditsBeforeRetry = structuredClone(getStore().auditEvents);
  const savedExample = getStore().learning.supplierExamples.find(
    (example) => example.id === learned.learningMetadata?.exampleId
  )!;

  assert.deepEqual(savedExample.finalExtractedData, extractedData);
  assert.deepEqual(savedExample.bookingLines, bookingLines);

  const retry = learnInvoice(
    invoice.id,
    extractedData,
    bookingLines,
    requestRevision
  );
  assert.deepEqual(retry, learnedBeforeRetry);
  assert.deepEqual(getStore().learning, learningBeforeRetry);
  assert.deepEqual(getStore().auditEvents, auditsBeforeRetry);

  assert.throws(
    () =>
      learnInvoice(
        invoice.id,
        { ...extractedData, expenseDescription: "Different stale payload" },
        bookingLines,
        requestRevision
      ),
    /revision changed/i
  );
  assert.deepEqual(learned, learnedBeforeRetry);
  assert.deepEqual(getStore().learning, learningBeforeRetry);
  assert.deepEqual(getStore().auditEvents, auditsBeforeRetry);
});

test("same-content invoices replay only their own canonical Learn request", () => {
  const first = learningInvoice();
  const second = learningInvoice();
  first.invoice.checksum = "shared-content-hash";
  second.invoice.checksum = "shared-content-hash";
  const firstRevision = first.invoice.revision!;
  const secondRevision = second.invoice.revision!;
  const firstData = {
    ...first.extractedData,
    expenseDescription: "First correction",
  };
  const secondData = {
    ...second.extractedData,
    expenseDescription: "Second correction",
  };
  const firstLines = first.invoice.purchaseJournal!.lines;
  const secondLines = second.invoice.purchaseJournal!.lines;

  const firstLearned = learnInvoice(
    first.invoice.id,
    firstData,
    firstLines,
    firstRevision
  )!;
  const secondLearned = learnInvoice(
    second.invoice.id,
    secondData,
    secondLines,
    secondRevision
  )!;

  assert.notEqual(
    firstLearned.learningMetadata?.requestFingerprint,
    secondLearned.learningMetadata?.requestFingerprint
  );
  assert.equal(
    learnInvoice(first.invoice.id, firstData, firstLines, firstRevision)?.revision,
    firstLearned.revision
  );
  assert.equal(
    learnInvoice(second.invoice.id, secondData, secondLines, secondRevision)?.revision,
    secondLearned.revision
  );
  assert.throws(
    () =>
      learnInvoice(
        second.invoice.id,
        firstData,
        secondLines,
        secondRevision
      ),
    /revision changed/i
  );
});

test("learning-only repository booking mutations reject before changing state", () => {
  const { invoice, extractedData } = learningInvoice();
  const learned = learnInvoice(
    invoice.id,
    extractedData,
    invoice.purchaseJournal!.lines,
    invoice.revision!
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

test("Learn rejects a stale invoice revision before mutating any draft or learning state", () => {
  const { invoice, extractedData } = learningInvoice();
  const correctedData = {
    ...extractedData,
    expenseDescription: "Stale corrected description",
  };
  const bookingLines = [
    {
      ...invoice.purchaseJournal!.lines[0],
      glAccount: "4420",
      finalSelectedAccount: "4420",
    },
  ];
  const extractedBefore = structuredClone(invoice.extractedData);
  const linesBefore = structuredClone(invoice.bookingLineOverrides);
  const learningBefore = structuredClone(getStore().learning);
  const revisionBefore = invoice.revision;
  const statusBefore = invoice.status;
  const auditsBefore = structuredClone(getStore().auditEvents);

  assert.throws(
    () =>
      learnInvoice(
        invoice.id,
        correctedData,
        bookingLines,
        invoice.revision! - 1
      ),
    /revision changed/i
  );

  assert.deepEqual(invoice.extractedData, extractedBefore);
  assert.deepEqual(invoice.bookingLineOverrides, linesBefore);
  assert.deepEqual(getStore().learning, learningBefore);
  assert.equal(invoice.revision, revisionBefore);
  assert.equal(invoice.status, statusBefore);
  assert.deepEqual(getStore().auditEvents, auditsBefore);
});

test("supplier reset checks generation, removes legacy rules, and preserves records", () => {
  const { invoice, extractedData } = learningInvoice();
  const learned = learnInvoice(
    invoice.id,
    extractedData,
    invoice.purchaseJournal!.lines,
    invoice.revision!
  )!;
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

test("a reset Learned invoice can save the same trusted snapshots in the new generation", () => {
  const { invoice, extractedData } = learningInvoice();
  const learned = learnInvoice(
    invoice.id,
    extractedData,
    invoice.purchaseJournal!.lines,
    invoice.revision!
  )!;
  const firstExample = getStore().learning.supplierExamples.find(
    (item) => item.id === learned.learningMetadata!.exampleId
  )!;
  const firstGeneration = learned.learningMetadata!.generation;
  const revisionBefore = learned.revision!;

  resetLearningForSupplier(
    learned.learningMetadata!.supplierAccountId,
    firstGeneration
  );
  const relearned = learnInvoice(
    learned.id,
    learned.extractedData,
    learned.bookingLineOverrides ?? learned.purchaseJournal!.lines,
    revisionBefore
  )!;
  const secondExample = getStore().learning.supplierExamples.find(
    (item) => item.id === relearned.learningMetadata!.exampleId
  )!;

  assert.equal(relearned.status, "Learned");
  assert.equal(relearned.learningMetadata!.generation, firstGeneration + 1);
  assert.equal(relearned.revision, revisionBefore + 1);
  assert.notEqual(secondExample.id, firstExample.id);
  assert.deepEqual(
    secondExample.originalExtractedData,
    firstExample.originalExtractedData
  );
  assert.deepEqual(secondExample.finalExtractedData, firstExample.finalExtractedData);
  assert.deepEqual(secondExample.bookingLines, firstExample.bookingLines);
});

test("reset preserves a different account's correction when supplier aliases collide", () => {
  const { invoice, extractedData } = learningInvoice();
  const learned = learnInvoice(
    invoice.id,
    extractedData,
    invoice.purchaseJournal!.lines,
    invoice.revision!
  )!;
  const learning = getStore().learning;
  learning.corrections.push({
    id: "other-account-shared-alias",
    invoiceId: "other-invoice",
    field: "supplier",
    supplierIdentity: "vat:NL812345678B01",
    supplierName: "Other supplier using a shared alias",
    supplierAccountId: "supplier_delta_it",
    matchKey: "other-supplier",
    originalValue: "Other supplier",
    correctedValue: "supplier_delta_it",
    confidence: 1,
    confidenceBefore: 0.5,
    confidenceAfter: 1,
    correctedAt: learned.learningMetadata!.learnedAt,
    correctedByUserId: "shared_user",
    correctedByUserName: "shared_user",
  });

  resetLearningForSupplier(
    learned.learningMetadata!.supplierAccountId,
    learned.learningMetadata!.generation
  );

  assert.ok(
    learning.corrections.some(
      (item) => item.id === "other-account-shared-alias"
    )
  );
});

test("reset removes an accountless formatted-IBAN legacy correction", () => {
  const { invoice, extractedData } = learningInvoice();
  const learned = learnInvoice(
    invoice.id,
    extractedData,
    invoice.purchaseJournal!.lines,
    invoice.revision!
  )!;
  const learning = getStore().learning;
  learning.corrections.push({
    id: "formatted-iban-legacy-correction",
    invoiceId: learned.id,
    field: "glAccount",
    supplierIdentity: "iban:nl91-abna-0417-1643-00",
    supplierName: "Noordzee Office Supplies",
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

  resetLearningForSupplier(
    learned.learningMetadata!.supplierAccountId,
    learned.learningMetadata!.generation
  );

  assert.equal(
    learning.corrections.some(
      (item) => item.id === "formatted-iban-legacy-correction"
    ),
    false
  );
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
