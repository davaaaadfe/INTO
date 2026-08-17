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
import { supplierReliabilityEvidenceFromLearningStore } from "../lib/services/supplier-reliability-evidence";

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
    documentTextMode: "plain_text" as const,
  };
  const initialRevision = invoice.revision!;
  updateInvoiceExtraction(invoice.id, extractedData, { applyLearning: false });
  const computed = recomputeInvoiceState(invoice.id);
  assert.ok(computed?.purchaseJournal?.lines[0]);
  assert.equal(computed.revision, initialRevision + 1);
  return { invoice: computed, extractedData };
}

test("Learn assigns close structural layouts to one supplier cluster", () => {
  const learnLayout = (rawText: string) => {
    const { invoice, extractedData } = learningInvoice();
    const finalData = { ...extractedData, rawText };
    const learned = learnInvoice(
      invoice.id,
      finalData,
      invoice.purchaseJournal!.lines,
      invoice.revision!
    )!;
    return getStore().learning.supplierExamples.find(
      (example) => example.id === learned.learningMetadata!.exampleId
    )!;
  };
  const first = learnLayout([
    "Invoice number: A-1",
    "Invoice date: 2026-08-01",
    "Description | Quantity | Price",
    "Chair | 2 | EUR 100.00",
    "Total: EUR 200.00",
  ].join("\n"));
  const close = learnLayout([
    "Supplier: Noordzee",
    "Invoice number: A-2",
    "Invoice date: 2026-08-17",
    "Description | Quantity | Price",
    "Cloud subscription | 12 | EUR 50.00",
    "Total: EUR 600.00",
  ].join("\n"));
  const distinct = learnLayout([
    "Document reference: B-1",
    "Amount due: EUR 600.00",
    "Issued: 2026-08-17",
  ].join("\n"));

  assert.notEqual(first.formatFingerprint, close.formatFingerprint);
  assert.equal(first.formatCluster, close.formatCluster);
  assert.notEqual(first.formatCluster, distinct.formatCluster);
});

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
  const invoiceExamples = getStore().learning.supplierExamples.filter(
    (item) => item.invoiceId === invoice.id
  );
  assert.equal(invoiceExamples.length, 1);
  const example = invoiceExamples[0]!;
  assert.equal(example.originalExtractedData!.expenseDescription, "Office Supplies");
  assert.equal(
    example.finalExtractedData!.expenseDescription,
    "Corrected software subscriptions"
  );
  assert.equal(example.bookingLines![0].finalSelectedAccount, "4420");
  const reliabilityEvidence = supplierReliabilityEvidenceFromLearningStore(
    getStore().learning,
    getStore().learning.supplierProfiles[0]!
  );
  assert.ok(
    reliabilityEvidence.outcomes.some(
      (outcome) => outcome.metric === "accounting" && !outcome.success
    ),
    "the corrected draft is a failed original prediction, not a false success"
  );
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

test("Learn requires completed source analysis and at least one trainable field", () => {
  const withoutEvidence = learningInvoice();
  withoutEvidence.invoice.checksum = undefined;
  withoutEvidence.invoice.extractedData.rawText = "";
  withoutEvidence.invoice.extractedData.extractionEvidence = undefined;
  assert.throws(
    () =>
      learnInvoice(
        withoutEvidence.invoice.id,
        withoutEvidence.invoice.extractedData,
        withoutEvidence.invoice.purchaseJournal!.lines,
        withoutEvidence.invoice.revision!
      ),
    /complete document analysis/i
  );

  const withoutFields = learningInvoice();
  const supplierOnly = {
    ...emptyExtractedInvoiceData(),
    supplierName: withoutFields.extractedData.supplierName,
    supplierVatNumber: withoutFields.extractedData.supplierVatNumber,
    rawText: withoutFields.extractedData.rawText,
    documentTextMode: withoutFields.extractedData.documentTextMode,
  };
  assert.throws(
    () =>
      learnInvoice(
        withoutFields.invoice.id,
        supplierOnly,
        [],
        withoutFields.invoice.revision!
      ),
    /at least one trainable invoice field/i
  );
});

test("Learn rejects a synthetic supplier-overview identity", () => {
  const { invoice, extractedData } = learningInvoice();
  const cache = getStore().exactMasterDataCaches[0]!.cache;
  const supplier = cache.suppliers.find(
    (item) => item.id === invoice.purchaseJournal?.supplierResolution.selectedAccountId
  )!;
  const originalId = supplier.id;
  try {
    supplier.id = `supplier-overview:${supplier.code}`;
    const recomputed = recomputeInvoiceState(invoice.id)!;
    assert.match(
      recomputed.purchaseJournal?.supplierResolution.selectedAccountId ?? "",
      /^supplier-overview:/
    );

    assert.throws(
      () =>
        learnInvoice(
          invoice.id,
          extractedData,
          recomputed.purchaseJournal!.lines,
          recomputed.revision
        ),
      /canonical Exact supplier/i
    );
  } finally {
    supplier.id = originalId;
  }
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
  assert.equal(
    getStore().learning.supplierSelections.some(
      (decision) =>
        decision.supplierIdentity === "vat:NL123456789B01" &&
        decision.accountId === "supplier_ambiguous_b"
    ),
    false,
    "the explicit choice must replace the prior default for the same layout"
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

test("an explicit duplicate-supplier choice becomes the default for the same layout", () => {
  const store = getStore();
  store.exactMasterDataCaches = [
    {
      userId: getCompanyConnectionUserId(),
      cache: createMockExactMasterData(),
    },
  ];
  const extractedData = {
    ...emptyExtractedInvoiceData(),
    supplierName: "Acme Supplies BV",
    supplierVatNumber: "NL123456789B01",
    invoiceNumber: "ACME-TRAIN-001",
    referenceCode: "ACME-TRAIN-001",
    invoiceDate: "2026-08-03",
    paymentTerms: "30 days",
    currency: "EUR",
    netAmount: 100,
    vatAmount: 21,
    grossAmount: 121,
    expenseDescription: "Office supplies",
    rawText:
      "ACME SUPPLIES INVOICE\nFactuurnummer ACME-TRAIN-001\nNet 100.00 VAT 21.00 Total 121.00",
    documentTextMode: "plain_text" as const,
  };
  const trainingInvoice = createUploadedInvoice({
    fileName: "acme-training.pdf",
    fileType: "application/pdf",
    fileSize: 1_000,
    checksum: "acme-training-hash",
    storageKey: "storage/tmp-invoices/acme-training.pdf",
  });
  updateInvoiceExtraction(trainingInvoice.id, extractedData, {
    applyLearning: false,
  });
  const ambiguous = recomputeInvoiceState(trainingInvoice.id)!;

  assert.equal(ambiguous.purchaseJournal!.supplierResolution.reasonCode, "supplier_ambiguous");
  const selected = selectInvoiceSupplier(
    trainingInvoice.id,
    "supplier_ambiguous_a"
  )!;
  const learnedChoice = store.learning.supplierSelections.find(
    (decision) =>
      decision.invoiceId === trainingInvoice.id &&
      decision.accountId === "supplier_ambiguous_a"
  );

  assert.equal(learnedChoice?.trustState, "trusted");
  assert.ok(learnedChoice?.formatFingerprint);
  assert.equal(
    selected.purchaseJournal!.supplierResolution.selectedAccountId,
    "supplier_ambiguous_a"
  );

  const futureInvoice = createUploadedInvoice({
    fileName: "acme-future.pdf",
    fileType: "application/pdf",
    fileSize: 1_000,
    checksum: "acme-future-hash",
    storageKey: "storage/tmp-invoices/acme-future.pdf",
  });
  updateInvoiceExtraction(
    futureInvoice.id,
    {
      ...extractedData,
      invoiceNumber: "ACME-TRAIN-002",
      referenceCode: "ACME-TRAIN-002",
      rawText:
        "ACME SUPPLIES INVOICE\nFactuurnummer ACME-TRAIN-002\nNet 200.00 VAT 42.00 Total 242.00",
      netAmount: 200,
      vatAmount: 42,
      grossAmount: 242,
    },
    { applyLearning: false }
  );
  const learnedMatch = recomputeInvoiceState(futureInvoice.id)!;

  assert.equal(
    learnedMatch.purchaseJournal!.supplierResolution.selectedAccountId,
    "supplier_ambiguous_a"
  );
  assert.equal(learnedMatch.purchaseJournal!.supplierResolution.reviewRequired, false);

  const conflictingInvoice = createUploadedInvoice({
    fileName: "acme-conflict.pdf",
    fileType: "application/pdf",
    fileSize: 1_000,
    checksum: "acme-conflict-hash",
    storageKey: "storage/tmp-invoices/acme-conflict.pdf",
  });
  updateInvoiceExtraction(
    conflictingInvoice.id,
    {
      ...extractedData,
      invoiceNumber: "ACME-TRAIN-003",
      referenceCode: "ACME-TRAIN-003",
      iban: "NL11ABNA0101010102",
    },
    { applyLearning: false }
  );
  const conflictingMatch = recomputeInvoiceState(conflictingInvoice.id)!;

  assert.equal(conflictingMatch.purchaseJournal!.supplierResolution.selectedAccountId, undefined);
  assert.equal(conflictingMatch.purchaseJournal!.supplierResolution.reasonCode, "supplier_ambiguous");
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
  const supplierAccountId = first.invoice.purchaseJournal!.supplierResolution
    .selectedAccountId!;
  const exampleCountBefore =
    getStore().learning.supplierProfiles.find(
      (profile) => profile.supplierAccountId === supplierAccountId
    )?.exampleCount ?? 0;

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

  const versions = getStore().learning.supplierExamples.filter(
    (example) => example.contentHash === "shared-content-hash"
  );
  assert.equal(versions.length, 2);
  assert.equal(versions.filter((example) => example.active !== false).length, 1);
  assert.equal(
    versions.find((example) => example.active === false)?.supersededById,
    versions.find((example) => example.active !== false)?.id
  );
  assert.equal(
    versions.find((example) => example.active !== false)?.finalExtractedData
      ?.expenseDescription,
    "Second correction"
  );
  assert.equal(
    getStore().learning.supplierProfiles.find(
      (profile) => profile.supplierAccountId === supplierAccountId
    )?.exampleCount,
    exampleCountBefore + 1
  );

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

test("Learned invoices remain terminal across every review mutation", () => {
  const { invoice, extractedData } = learningInvoice();
  const learned = learnInvoice(
    invoice.id,
    extractedData,
    invoice.purchaseJournal!.lines,
    invoice.revision
  )!;
  const revisionBefore = learned.revision;

  assert.throws(
    () => updateInvoiceExtraction(learned.id, extractedData),
    /cannot be reprocessed/i
  );
  assert.throws(
    () => saveInvoiceReview(learned.id, extractedData),
    /cannot be edited/i
  );
  assert.throws(
    () => replaceInvoiceExtractionFromReread(learned.id, extractedData),
    /cannot be re-read/i
  );
  assert.throws(
    () => approveInvoiceIntelligence(learned.id),
    /cannot be approved/i
  );
  assert.throws(
    () => selectInvoiceSupplier(learned.id, "supplier_noordzee"),
    /cannot change supplier/i
  );
  const recomputed = recomputeInvoiceState(learned.id)!;
  assert.equal(recomputed.status, "Learned");
  assert.equal(recomputed.processingPurpose, "learning_only");
  assert.equal(recomputed.learningState, "saved");
  assert.equal(recomputed.revision, revisionBefore);
  assert.equal(recomputed.exactBookingStatus, "not_booked");
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
  delete (invoice as Partial<typeof invoice>).processingPurpose;
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
