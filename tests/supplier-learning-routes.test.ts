import assert from "node:assert/strict";
import test from "node:test";
import { POST as learnInvoiceRoute } from "../app/api/invoices/[invoiceId]/learn/route";
import { POST as bookInvoiceRoute } from "../app/api/invoices/[invoiceId]/book/route";
import { POST as bookReadyRoute } from "../app/api/invoices/book-ready/route";
import { POST as intelligenceRoute } from "../app/api/invoices/[invoiceId]/intelligence/route";
import { GET as listSupplierLearningRoute } from "../app/api/suppliers/learning/route";
import { GET as supplierLearningDetailRoute } from "../app/api/suppliers/[accountId]/learning/route";
import { POST as resetSupplierLearningRoute } from "../app/api/suppliers/[accountId]/learning/reset/route";
import {
  emptyExtractedInvoiceData,
  LEARNING_ONLY_BOOKING_MESSAGE,
} from "../lib/domain/invoice";
import {
  createUploadedInvoice,
  getCompanyConnectionUserId,
  getStore,
  recomputeInvoiceState,
  resetLearningForSupplier,
  selectInvoiceSupplier,
  updateInvoiceExtraction,
} from "../lib/repository/invoice-store";
import { createMockExactMasterData } from "../lib/services/exact-master-data-service";
import { createIntoAccessSession } from "../lib/services/into-access-auth";

let routeLearningInvoiceSequence = 0;

function routeLearningInvoice() {
  routeLearningInvoiceSequence += 1;
  const sequence = routeLearningInvoiceSequence;
  getStore().exactMasterDataCaches = [
    {
      userId: getCompanyConnectionUserId(),
      cache: createMockExactMasterData(),
    },
  ];
  const invoice = createUploadedInvoice({
    fileName: `route-learning-${sequence}.pdf`,
    fileType: "application/pdf",
    fileSize: 1_024,
    checksum: `route-learning-hash-${sequence}`,
    storageKey: `storage/tmp-invoices/route-learning-${sequence}.pdf`,
  });
  const extractedData = {
    ...emptyExtractedInvoiceData(),
    supplierName: "Noordzee Office Supplies",
    supplierVatNumber: "NL812345678B01",
    supplierCountry: "NL",
    invoiceNumber: "ROUTE-LEARN-1",
    referenceCode: "ROUTE-LEARN-1",
    invoiceDate: "2026-07-21",
    paymentTerms: "7 days",
    currency: "EUR",
    netAmount: 100,
    vatAmount: 21,
    grossAmount: 121,
    expenseDescription: "Office Supplies",
    companyVatNumber: "NL857017263B01",
    rawText: "Invoice number ROUTE-LEARN-1\nOffice Supplies",
    documentTextMode: "plain_text" as const,
  };
  updateInvoiceExtraction(invoice.id, extractedData, { applyLearning: false });
  const computed = recomputeInvoiceState(invoice.id)!;
  return computed.purchaseJournal?.supplierResolution.selectedAccountId
    ? computed
    : selectInvoiceSupplier(computed.id, "supplier_noordzee")!;
}

test("supplier selection atomically saves the live corrected draft", async () => {
  const invoice = routeLearningInvoice();
  invoice.purchaseJournal!.supplierResolution.shadowEvaluation = {
    selectedAccountId: "supplier_noordzee",
    matchConfidence: 0.97,
    reviewRequired: false,
  };
  const correctedData = {
    ...invoice.extractedData,
    expenseDescription: "Corrected before supplier selection",
  };
  const response = await intelligenceRoute(
    new Request(`http://localhost/api/invoices/${invoice.id}/intelligence`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "selectSupplier",
        accountId: "supplier_delta_it",
        expectedRevision: invoice.revision,
        extractedData: correctedData,
        bookingLines: invoice.purchaseJournal?.lines ?? [],
      }),
    }),
    { params: { invoiceId: invoice.id } }
  );
  const payload = (await response.json()) as {
    invoice?: ReturnType<typeof routeLearningInvoice>;
  };

  assert.equal(response.status, 200);
  assert.equal(
    payload.invoice?.extractedData.expenseDescription,
    "Corrected before supplier selection"
  );
  assert.equal(
    payload.invoice?.purchaseJournal?.supplierResolution.selectedAccountId,
    "supplier_delta_it"
  );
  const supplierAudit = getStore().auditEvents.find(
    (event) => event.invoiceId === invoice.id && event.field === "supplier"
  );
  assert.deepEqual(
    {
      policyVersion: supplierAudit?.metadata?.shadowPolicyVersion,
      eligible: supplierAudit?.metadata?.shadowEligible,
      outcome: supplierAudit?.metadata?.shadowSelectionOutcome,
      confidence: supplierAudit?.metadata?.shadowMatchConfidence,
    },
    {
      policyVersion: "supplier-resolution-v2.1",
      eligible: true,
      outcome: "overridden",
      confidence: 0.97,
    },
    "supplier outcome must use the pre-edit shadow decision and survive audit sanitization"
  );
});

test("supplier learning routes return stable not-found and list responses", async () => {
  const learnResponse = await learnInvoiceRoute(
    new Request("http://localhost/api/invoices/missing/learn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ extractedData: {}, bookingLines: [] }),
    }),
    { params: { invoiceId: "missing" } }
  );
  assert.equal(learnResponse.status, 404);

  const resetResponse = await resetSupplierLearningRoute(
    new Request("http://localhost/api/suppliers/missing/learning/reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedGeneration: 1 }),
    }),
    { params: { accountId: "missing" } }
  );
  assert.equal(resetResponse.status, 404);

  const listResponse = await listSupplierLearningRoute(new Request("http://localhost/api/suppliers/learning"));
  assert.equal(listResponse.status, 200);
  const payload = (await listResponse.json()) as { suppliers?: unknown[] };
  assert.ok(Array.isArray(payload.suppliers));
});

test("supplier learning list paginates and detail returns sanitized cluster outcomes", async () => {
  const invoice = routeLearningInvoice();
  const supplierAccountId = invoice.purchaseJournal!.supplierResolution.selectedAccountId!;
  getStore().learning.supplierProfiles = [{
    supplierAccountId,
    generation: 2,
    exampleCount: 1,
    formatDrift: "none",
  }];
  getStore().learning.supplierExamples = [{
    id: "detail-example",
    supplierAccountId,
    generation: 2,
    invoiceId: invoice.id,
    contentHash: "detail-hash",
    formatFingerprint: "detail-fingerprint",
    formatSignature: "detail-signature",
    formatCluster: "cluster-detail",
    learnedAt: "2026-08-17T10:00:00.000Z",
    trustState: "trusted",
  }];
  getStore().learning.supplierOutcomeEvents = [{
    id: "detail-event",
    supplierAccountId,
    generation: 2,
    invoiceId: invoice.id,
    invoiceRevision: invoice.revision,
    type: "acceptance",
    candidateIds: ["candidate-detail"],
    fields: ["referenceCode"],
    createdAt: "2026-08-17T10:01:00.000Z",
  }];

  const listResponse = await listSupplierLearningRoute(
    new Request("http://localhost/api/suppliers/learning?page=1&pageSize=1&q=noordzee")
  );
  const list = (await listResponse.json()) as {
    suppliers: unknown[];
    pagination: { page: number; pageSize: number; total: number; totalPages: number };
  };
  assert.equal(listResponse.status, 200);
  assert.equal(list.suppliers.length, 1);
  assert.equal(list.pagination.pageSize, 1);
  assert.ok(list.pagination.total >= 1);

  const detailResponse = await supplierLearningDetailRoute(
    new Request(`http://localhost/api/suppliers/${supplierAccountId}/learning`),
    { params: { accountId: supplierAccountId } }
  );
  const detail = (await detailResponse.json()) as {
    profile: { generation: number };
    clusters: Array<{ id: string; exampleCount: number }>;
    recentEvents: Array<{ type: string; fields: string[] }>;
  };
  assert.equal(detailResponse.status, 200);
  assert.equal(detail.profile.generation, 2);
  assert.deepEqual(detail.clusters, [{ id: "cluster-detail", exampleCount: 1 }]);
  assert.deepEqual(detail.recentEvents[0], {
    type: "acceptance",
    fields: ["referenceCode"],
    createdAt: "2026-08-17T10:01:00.000Z",
  });
  assert.doesNotMatch(JSON.stringify(detail), /candidate-detail|detail-hash|detail-signature/);
});

test("supplier reset replays one request and rejects changed or synthetic targets", async () => {
  const invoice = routeLearningInvoice();
  const supplierAccountId = invoice.purchaseJournal!.supplierResolution.selectedAccountId!;
  getStore().learning.supplierProfiles = [{
    supplierAccountId,
    generation: 1,
    exampleCount: 1,
    formatDrift: "none",
  }];
  getStore().learning.supplierExamples = [];
  getStore().learning.corrections = [];
  const post = (accountId: string, expectedGeneration: number, key: string) =>
    resetSupplierLearningRoute(
      new Request(`http://localhost/api/suppliers/${accountId}/learning/reset`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": key,
        },
        body: JSON.stringify({ expectedGeneration }),
      }),
      { params: { accountId } }
    );

  const first = await post(supplierAccountId, 1, "reset-route-a");
  const firstPayload = (await first.json()) as {
    profile: { generation: number };
    replayed: boolean;
    summary: { confidence: { score: number } };
  };
  assert.equal(first.status, 200);
  assert.equal(firstPayload.profile.generation, 2);
  assert.equal(firstPayload.replayed, false);
  assert.equal(firstPayload.summary.confidence.score, 35);

  const replay = await post(supplierAccountId, 1, "reset-route-a");
  assert.equal(replay.status, 200);
  assert.equal(((await replay.json()) as { replayed: boolean }).replayed, true);
  assert.equal((await post(supplierAccountId, 2, "reset-route-a")).status, 409);
  assert.equal((await post("supplier-overview:fake", 1, "reset-synthetic")).status, 422);
});

test("supplier learning read state stays off until both rollout flags are enabled", async () => {
  const original = {
    NODE_ENV: process.env.NODE_ENV,
    AUTH_MODE: process.env.AUTH_MODE,
    INTO_ACCESS_PASSWORD: process.env.INTO_ACCESS_PASSWORD,
    LEARNING_V2_ENABLED: process.env.LEARNING_V2_ENABLED,
    LEARNING_UI_ENABLED: process.env.LEARNING_UI_ENABLED,
  };

  try {
    Reflect.set(process.env, "NODE_ENV", "production");
    process.env.AUTH_MODE = "legacy_password";
    process.env.INTO_ACCESS_PASSWORD = "test-shared-route-password";
    const authenticatedRequest = () => new Request("http://localhost/api/suppliers/learning", {
      headers: { cookie: `into_access_session=${createIntoAccessSession()}` },
    });
    delete process.env.LEARNING_V2_ENABLED;
    delete process.env.LEARNING_UI_ENABLED;

    const productionDefault = await listSupplierLearningRoute(authenticatedRequest());
    assert.deepEqual(await productionDefault.json(), {
      enabled: false,
      suppliers: [],
    });

    process.env.LEARNING_V2_ENABLED = "true";
    process.env.LEARNING_UI_ENABLED = "false";
    const hiddenUi = await listSupplierLearningRoute(authenticatedRequest());
    assert.deepEqual(await hiddenUi.json(), {
      enabled: false,
      suppliers: [],
    });

    process.env.LEARNING_V2_ENABLED = "false";
    process.env.LEARNING_UI_ENABLED = "true";
    const disabledLearning = await listSupplierLearningRoute(authenticatedRequest());
    assert.deepEqual(await disabledLearning.json(), {
      enabled: false,
      suppliers: [],
    });

    process.env.LEARNING_V2_ENABLED = "true";
    const enabled = await listSupplierLearningRoute(authenticatedRequest());
    const payload = (await enabled.json()) as {
      enabled?: boolean;
      suppliers?: unknown[];
    };
    assert.equal(payload.enabled, true);
    assert.ok(Array.isArray(payload.suppliers));
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("supplier learning write routes stay unavailable behind the main kill switch", async () => {
  const previousEnabled = process.env.LEARNING_V2_ENABLED;
  const previousMode = process.env.SUPPLIER_LEARNING_MODE;
  process.env.LEARNING_V2_ENABLED = "false";
  process.env.SUPPLIER_LEARNING_MODE = "apply";
  try {
    const invoice = routeLearningInvoice();
    const before = structuredClone(invoice);
    const learnResponse = await learnInvoiceRoute(
      new Request(`http://localhost/api/invoices/${invoice.id}/learn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: invoice.revision,
          extractedData: invoice.extractedData,
          bookingLines: invoice.purchaseJournal?.lines ?? [],
        }),
      }),
      { params: { invoiceId: invoice.id } }
    );
    assert.equal(learnResponse.status, 404);
    assert.deepEqual(invoice, before);

    const resetResponse = await resetSupplierLearningRoute(
      new Request("http://localhost/api/suppliers/disabled/learning/reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedGeneration: 1 }),
      }),
      { params: { accountId: "disabled" } }
    );
    assert.equal(resetResponse.status, 404);
  } finally {
    if (previousEnabled === undefined) delete process.env.LEARNING_V2_ENABLED;
    else process.env.LEARNING_V2_ENABLED = previousEnabled;
    if (previousMode === undefined) delete process.env.SUPPLIER_LEARNING_MODE;
    else process.env.SUPPLIER_LEARNING_MODE = previousMode;
  }
});

test("Learn route requires an integer revision and rejects stale drafts without mutation", async () => {
  const invoice = routeLearningInvoice();
  const invoiceBefore = structuredClone(invoice);
  const learningBefore = structuredClone(getStore().learning);
  const auditsBefore = structuredClone(getStore().auditEvents);

  const missingResponse = await learnInvoiceRoute(
    new Request(`http://localhost/api/invoices/${invoice.id}/learn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ extractedData: {}, bookingLines: [] }),
    }),
    { params: { invoiceId: invoice.id } }
  );
  assert.equal(missingResponse.status, 422);

  const staleResponse = await learnInvoiceRoute(
    new Request(`http://localhost/api/invoices/${invoice.id}/learn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: invoice.revision! - 1,
        extractedData: { expenseDescription: "Stale route edit" },
        bookingLines: invoice.purchaseJournal!.lines,
      }),
    }),
    { params: { invoiceId: invoice.id } }
  );
  assert.equal(staleResponse.status, 409);

  assert.deepEqual(invoice, invoiceBefore);
  assert.deepEqual(getStore().learning, learningBefore);
  assert.deepEqual(getStore().auditEvents, auditsBefore);
});

test("Learn route saves a reset Learned invoice into the active generation", async () => {
  const invoice = routeLearningInvoice();
  const firstResponse = await learnInvoiceRoute(
    new Request(`http://localhost/api/invoices/${invoice.id}/learn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: invoice.revision,
        extractedData: invoice.extractedData,
        bookingLines: invoice.purchaseJournal!.lines,
      }),
    }),
    { params: { invoiceId: invoice.id } }
  );
  assert.equal(firstResponse.status, 200);
  const first = (await firstResponse.json()) as {
    invoice: typeof invoice;
    message: string;
    learning: {
      exampleId: string;
      generation: number;
      savedAt: string;
      replayed: boolean;
    };
  };
  assert.equal(first.message, "Learning saved for this supplier.");
  assert.equal(first.learning.exampleId, first.invoice.learningMetadata!.exampleId);
  assert.equal(first.learning.generation, first.invoice.learningMetadata!.generation);
  assert.equal(first.learning.savedAt, first.invoice.learningMetadata!.learnedAt);
  assert.equal(first.learning.replayed, false);
  const firstGeneration = first.invoice.learningMetadata!.generation;

  resetLearningForSupplier(
    first.invoice.learningMetadata!.supplierAccountId,
    firstGeneration
  );
  const secondResponse = await learnInvoiceRoute(
    new Request(`http://localhost/api/invoices/${invoice.id}/learn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: first.invoice.revision,
        extractedData: first.invoice.extractedData,
        bookingLines:
          first.invoice.bookingLineOverrides ?? first.invoice.purchaseJournal!.lines,
      }),
    }),
    { params: { invoiceId: invoice.id } }
  );
  assert.equal(secondResponse.status, 200);
  const second = (await secondResponse.json()) as { invoice: typeof invoice };
  assert.equal(second.invoice.learningMetadata!.generation, firstGeneration + 1);
  assert.equal(second.invoice.revision, first.invoice.revision! + 1);
});

test("Learn route accepts the exact original retry and rejects a changed stale retry", async () => {
  const invoice = routeLearningInvoice();
  const requestPayload = {
    expectedRevision: invoice.revision!,
    extractedData: invoice.extractedData,
    bookingLines: invoice.purchaseJournal!.lines,
  };
  const post = (payload: typeof requestPayload) =>
    learnInvoiceRoute(
      new Request(`http://localhost/api/invoices/${invoice.id}/learn`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "route-learn-retry-contract",
        },
        body: JSON.stringify(payload),
      }),
      { params: { invoiceId: invoice.id } }
    );

  const firstResponse = await post(requestPayload);
  assert.equal(firstResponse.status, 200);
  const first = (await firstResponse.json()) as {
    invoice: typeof invoice;
    learning: { replayed: boolean };
  };
  assert.equal(first.learning.replayed, false);

  const retryResponse = await post(requestPayload);
  assert.equal(retryResponse.status, 200);
  const retry = (await retryResponse.json()) as typeof first;
  assert.equal(retry.invoice.revision, first.invoice.revision);
  assert.equal(
    retry.invoice.learningMetadata!.exampleId,
    first.invoice.learningMetadata!.exampleId
  );
  assert.equal(retry.learning.replayed, true);

  const changedResponse = await post({
    ...requestPayload,
    extractedData: {
      ...requestPayload.extractedData,
      expenseDescription: "Different stale route payload",
    },
  });
  assert.equal(changedResponse.status, 409);
  const changedCurrentRevision = await post({
    ...requestPayload,
    expectedRevision: first.invoice.revision,
    extractedData: {
      ...requestPayload.extractedData,
      expenseDescription: "Different current-revision payload",
    },
  });
  assert.equal(changedCurrentRevision.status, 409);
});

test("Learn route returns 422 when document evidence is not trainable", async () => {
  const invoice = createUploadedInvoice({
    fileName: "untrainable.pdf",
    fileType: "application/pdf",
    fileSize: 100,
    storageKey: "storage/tmp-invoices/untrainable.pdf",
  });
  const response = await learnInvoiceRoute(
    new Request(`http://localhost/api/invoices/${invoice.id}/learn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: invoice.revision,
        extractedData: invoice.extractedData,
        bookingLines: [],
      }),
    }),
    { params: { invoiceId: invoice.id } }
  );

  assert.equal(response.status, 422);
});

test("Learn route treats malformed JSON as invalid input", async () => {
  const invoice = routeLearningInvoice();
  const response = await learnInvoiceRoute(
    new Request(`http://localhost/api/invoices/${invoice.id}/learn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    }),
    { params: { invoiceId: invoice.id } }
  );

  assert.equal(response.status, 422);
});

test("Learn route keeps retries isolated when invoices share a content hash", async () => {
  const firstInvoice = routeLearningInvoice();
  const secondInvoice = routeLearningInvoice();
  firstInvoice.checksum = "route-shared-content-hash";
  secondInvoice.checksum = "route-shared-content-hash";
  const payloadFor = (invoice: typeof firstInvoice, description: string) => ({
    expectedRevision: invoice.revision!,
    requestKey: `request-${invoice.id}`,
    extractedData: { ...invoice.extractedData, expenseDescription: description },
    bookingLines: invoice.purchaseJournal!.lines,
  });
  const firstPayload = payloadFor(firstInvoice, "First route correction");
  const secondPayload = payloadFor(secondInvoice, "Second route correction");
  const post = (invoice: typeof firstInvoice, payload: typeof firstPayload) =>
    learnInvoiceRoute(
      new Request(`http://localhost/api/invoices/${invoice.id}/learn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      { params: { invoiceId: invoice.id } }
    );

  const firstResponse = await post(firstInvoice, firstPayload);
  assert.equal(
    firstResponse.status,
    200,
    JSON.stringify(await firstResponse.clone().json())
  );
  const secondResponse = await post(secondInvoice, secondPayload);
  assert.equal(
    secondResponse.status,
    200,
    JSON.stringify(await secondResponse.clone().json())
  );
  const firstReplayResponse = await post(firstInvoice, firstPayload);
  assert.equal(
    firstReplayResponse.status,
    200,
    JSON.stringify(await firstReplayResponse.clone().json())
  );
  const secondReplayResponse = await post(secondInvoice, secondPayload);
  assert.equal(
    secondReplayResponse.status,
    200,
    JSON.stringify(await secondReplayResponse.clone().json())
  );
  assert.equal(
    (await post(secondInvoice, { ...secondPayload, requestKey: "wrong-key" })).status,
    409
  );
  assert.equal(
    (
      await post(secondInvoice, {
        ...secondPayload,
        extractedData: firstPayload.extractedData,
      })
    ).status,
    409
  );
});

test("single booking rejects learning-only invoices before attempts or connection work", async () => {
  const invoice = createUploadedInvoice({
    fileName: "single-learning-only.pdf",
    fileType: "application/pdf",
    fileSize: 100,
    storageKey: "storage/tmp-invoices/single-learning-only.pdf",
  });
  invoice.status = "Ready to Book";
  invoice.processingPurpose = "learning_only";
  const auditCount = getStore().auditEvents.length;

  const response = await bookInvoiceRoute(
    new Request(`http://localhost/api/invoices/${invoice.id}/book`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: invoice.revision }),
    }),
    { params: { invoiceId: invoice.id } }
  );
  const payload = (await response.json()) as { error?: string };

  assert.equal(response.status, 409);
  assert.equal(payload.error, LEARNING_ONLY_BOOKING_MESSAGE);
  assert.deepEqual(invoice.bookingAttempts, []);
  assert.equal(invoice.status, "Ready to Book");
  assert.equal(getStore().auditEvents.length, auditCount);
});

test("single booking requires a positive expectedRevision before booking work", async () => {
  const invoice = createUploadedInvoice({
    fileName: "single-booking-revision.pdf",
    fileType: "application/pdf",
    fileSize: 100,
    storageKey: "storage/tmp-invoices/single-booking-revision.pdf",
  });
  invoice.status = "Ready to Book";
  const before = structuredClone(invoice);

  const response = await bookInvoiceRoute(
    new Request(`http://localhost/api/invoices/${invoice.id}/book`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 0, requestKey: "invalid-revision" }),
    }),
    { params: { invoiceId: invoice.id } }
  );
  const payload = (await response.json()) as { code?: string };

  assert.equal(response.status, 422);
  assert.equal(payload.code, "invalid_expected_revision");
  assert.deepEqual(invoice, before);
});

test("single booking rejects malformed JSON as invalid request data", async () => {
  const invoice = createUploadedInvoice({
    fileName: "single-booking-malformed.pdf",
    fileType: "application/pdf",
    fileSize: 100,
    storageKey: "storage/tmp-invoices/single-booking-malformed.pdf",
  });
  invoice.status = "Ready to Book";
  const before = structuredClone(invoice);

  const response = await bookInvoiceRoute(
    new Request(`http://localhost/api/invoices/${invoice.id}/book`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    }),
    { params: { invoiceId: invoice.id } }
  );

  assert.equal(response.status, 422);
  assert.deepEqual(invoice, before);
});

test("bulk booking excludes learning-only ready invoices before attempts or connection work", async () => {
  const invoice = createUploadedInvoice({
    fileName: "bulk-learning-only.pdf",
    fileType: "application/pdf",
    fileSize: 100,
    storageKey: "storage/tmp-invoices/bulk-learning-only.pdf",
  });
  invoice.status = "Ready to Book";
  invoice.processingPurpose = "learning_only";
  const learnedStatusOnly = createUploadedInvoice({
    fileName: "bulk-learned-status.pdf",
    fileType: "application/pdf",
    fileSize: 100,
    storageKey: "storage/tmp-invoices/bulk-learned-status.pdf",
  });
  learnedStatusOnly.status = "Learned";
  learnedStatusOnly.processingPurpose = "booking";
  const auditCount = getStore().auditEvents.length;

  const response = await bookReadyRoute(
    new Request("http://localhost/api/invoices/book-ready", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: [
          { invoiceId: invoice.id, expectedRevision: invoice.revision },
          {
            invoiceId: learnedStatusOnly.id,
            expectedRevision: learnedStatusOnly.revision,
          },
        ],
        requestKey: "learning-only-exclusion",
      }),
    })
  );
  const payload = (await response.json()) as {
    results?: Array<{ invoiceId: string; status: string }>;
  };

  assert.equal(response.status, 200);
  assert.equal(payload.results?.[0]?.invoiceId, invoice.id);
  assert.equal(payload.results?.[0]?.status, "excluded");
  assert.equal(payload.results?.[1]?.invoiceId, learnedStatusOnly.id);
  assert.equal(payload.results?.[1]?.status, "excluded");
  assert.deepEqual(invoice.bookingAttempts, []);
  assert.equal(invoice.status, "Ready to Book");
  assert.equal(getStore().auditEvents.length, auditCount);
});
