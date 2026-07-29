import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { IntoStore } from "../lib/repository/invoice-store";
import {
  flushStoreToPersistence,
  getExactMasterData,
  getStore,
  hydrateStoreFromPersistence,
  listSupplierLearningSummaries,
  persistStoreSoon,
  resetLearningForSupplier,
  setExactConnection,
  syncExactDataNow,
} from "../lib/repository/invoice-store";
import { withPersistentStore } from "../lib/repository/persistent-request";
import {
  closeConfiguredLearningRepository,
} from "../lib/repository/configured-learning-repository";
import { persistLearningState } from "../lib/repository/learning-persistence";
import {
  closeSqliteStore,
  loadSqliteStoreSnapshot,
  saveSqliteStoreSnapshot,
} from "../lib/repository/sqlite-store";
import { createMockExactConnection } from "../lib/services/exact-online-service";
import { createMockExactMasterData } from "../lib/services/exact-master-data-service";

function testDatabasePath() {
  return resolve(
    "data/tmp-tests",
    `learning-runtime-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`
  );
}

function clearRuntime() {
  const runtime = globalThis as typeof globalThis & {
    __INTO_STORE?: IntoStore;
    __INTO_STORE_HYDRATED_FOR?: string;
    __INTO_STORE_HYDRATING?: Promise<void>;
    __INTO_STORE_PERSISTING?: Promise<void>;
    __INTO_STORE_PERSISTENCE_ERROR?: unknown;
    __INTO_STORE_DIRTY?: boolean;
    __INTO_STORE_DIRTY_REVISION?: number;
    __INTO_STORE_PERSISTED_DIRTY_REVISION?: number;
  };
  delete runtime.__INTO_STORE;
  delete runtime.__INTO_STORE_HYDRATED_FOR;
  delete runtime.__INTO_STORE_HYDRATING;
  delete runtime.__INTO_STORE_PERSISTING;
  delete runtime.__INTO_STORE_PERSISTENCE_ERROR;
  delete runtime.__INTO_STORE_DIRTY;
  delete runtime.__INTO_STORE_DIRTY_REVISION;
  delete runtime.__INTO_STORE_PERSISTED_DIRTY_REVISION;
}

async function removeDatabase(databasePath: string) {
  closeConfiguredLearningRepository();
  closeSqliteStore();
  clearRuntime();
  await rm(databasePath, { force: true });
  await rm(`${databasePath}-shm`, { force: true });
  await rm(`${databasePath}-wal`, { force: true });
}

test("legacy snapshots normalize learning arrays before repository migration", async () => {
  const databasePath = testDatabasePath();
  const previous = {
    mode: process.env.DATABASE_MODE,
    path: process.env.LOCAL_DATABASE_PATH,
    key: process.env.LEARNING_ARTIFACT_ENCRYPTION_KEY,
    enabled: process.env.LEARNING_V2_ENABLED,
    learningMode: process.env.SUPPLIER_LEARNING_MODE,
  };

  clearRuntime();
  const legacySnapshot = structuredClone(getStore());
  delete (
    legacySnapshot.learning as Partial<IntoStore["learning"]>
  ).supplierProfiles;
  process.env.DATABASE_MODE = "sqlite";
  process.env.LOCAL_DATABASE_PATH = databasePath;
  process.env.LEARNING_ARTIFACT_ENCRYPTION_KEY = "legacy-hydration-key";
  process.env.LEARNING_V2_ENABLED = "true";
  process.env.SUPPLIER_LEARNING_MODE = "apply";

  try {
    await saveSqliteStoreSnapshot(legacySnapshot, databasePath);
    clearRuntime();
    closeSqliteStore();

    await hydrateStoreFromPersistence();

    assert.deepEqual(getStore().learning.supplierProfiles, []);
  } finally {
    if (previous.mode === undefined) delete process.env.DATABASE_MODE;
    else process.env.DATABASE_MODE = previous.mode;
    if (previous.path === undefined) delete process.env.LOCAL_DATABASE_PATH;
    else process.env.LOCAL_DATABASE_PATH = previous.path;
    if (previous.key === undefined) {
      delete process.env.LEARNING_ARTIFACT_ENCRYPTION_KEY;
    } else {
      process.env.LEARNING_ARTIFACT_ENCRYPTION_KEY = previous.key;
    }
    if (previous.enabled === undefined) delete process.env.LEARNING_V2_ENABLED;
    else process.env.LEARNING_V2_ENABLED = previous.enabled;
    if (previous.learningMode === undefined) {
      delete process.env.SUPPLIER_LEARNING_MODE;
    } else {
      process.env.SUPPLIER_LEARNING_MODE = previous.learningMode;
    }
    await removeDatabase(databasePath);
  }
});

test("legacy migration skips Exact suppliers without learning evidence", async () => {
  const databasePath = testDatabasePath();
  const previous = {
    mode: process.env.DATABASE_MODE,
    path: process.env.LOCAL_DATABASE_PATH,
    key: process.env.LEARNING_ARTIFACT_ENCRYPTION_KEY,
    enabled: process.env.LEARNING_V2_ENABLED,
    learningMode: process.env.SUPPLIER_LEARNING_MODE,
  };
  process.env.DATABASE_MODE = "sqlite";
  process.env.LOCAL_DATABASE_PATH = databasePath;
  process.env.LEARNING_ARTIFACT_ENCRYPTION_KEY = "evidence-only-migration-key";
  process.env.LEARNING_V2_ENABLED = "true";
  process.env.SUPPLIER_LEARNING_MODE = "apply";

  try {
    clearRuntime();
    const store = getStore();
    store.invoices = [];
    store.exactMasterDataCaches = [{
      userId: "company_connection",
      cache: createMockExactMasterData(),
    }];

    await persistLearningState(store, { requestId: "legacy-migration" });

    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = database
        .prepare("SELECT COUNT(*) AS count FROM supplier_learning_profiles")
        .get() as { count: number };
      assert.equal(row.count, 0);
    } finally {
      database.close();
    }
  } finally {
    if (previous.mode === undefined) delete process.env.DATABASE_MODE;
    else process.env.DATABASE_MODE = previous.mode;
    if (previous.path === undefined) delete process.env.LOCAL_DATABASE_PATH;
    else process.env.LOCAL_DATABASE_PATH = previous.path;
    if (previous.key === undefined) {
      delete process.env.LEARNING_ARTIFACT_ENCRYPTION_KEY;
    } else {
      process.env.LEARNING_ARTIFACT_ENCRYPTION_KEY = previous.key;
    }
    if (previous.enabled === undefined) delete process.env.LEARNING_V2_ENABLED;
    else process.env.LEARNING_V2_ENABLED = previous.enabled;
    if (previous.learningMode === undefined) {
      delete process.env.SUPPLIER_LEARNING_MODE;
    } else {
      process.env.SUPPLIER_LEARNING_MODE = previous.learningMode;
    }
    await removeDatabase(databasePath);
  }
});

test("persistent supplier learning is normalized, encrypted, and authoritative", async () => {
  const databasePath = testDatabasePath();
  const previous = {
    mode: process.env.DATABASE_MODE,
    path: process.env.LOCAL_DATABASE_PATH,
    key: process.env.LEARNING_ARTIFACT_ENCRYPTION_KEY,
    enabled: process.env.LEARNING_V2_ENABLED,
    learningMode: process.env.SUPPLIER_LEARNING_MODE,
  };
  process.env.DATABASE_MODE = "sqlite";
  process.env.LOCAL_DATABASE_PATH = databasePath;
  process.env.LEARNING_ARTIFACT_ENCRYPTION_KEY = "integration-artifact-key";
  process.env.LEARNING_V2_ENABLED = "true";
  process.env.SUPPLIER_LEARNING_MODE = "apply";

  try {
    await hydrateStoreFromPersistence();
    setExactConnection(createMockExactConnection("company_connection"));
    await syncExactDataNow();

    const store = getStore();
    const invoice = store.invoices[0]!;
    const supplier = getExactMasterData()!.suppliers[0]!;
    const otherSupplier = getExactMasterData()!.suppliers[1]!;
    const learnedAt = "2026-07-21T10:00:00.000Z";
    const rawText = "Sensitive invoice text for normalized persistence";
    invoice.checksum = "sha256:normalized-invoice";
    invoice.extractedData.rawText = rawText;
    invoice.extractedData.documentTextMode = "plain_text";
    invoice.extractedData.documentAnalysis = {
      pages: [{
        pageNumber: 1,
        width: 1,
        height: 1,
        unit: "normalized",
        text: rawText,
        tokens: [{
          text: "Sensitive",
          polygon: [
            { x: 0, y: 0 },
            { x: 0.2, y: 0 },
            { x: 0.2, y: 0.1 },
            { x: 0, y: 0.1 },
          ],
          confidence: 1,
        }],
        tables: [],
      }],
      fieldCandidates: [],
      confidence: 1,
      provider: { name: "integration-provider", model: "fixture-v1" },
      sourceMode: "plain_text",
    };
    invoice.status = "Learned";
    invoice.processingPurpose = "learning_only";
    invoice.learningState = "saved";
    invoice.learningMetadata = {
      exampleId: "example-normalized",
      supplierAccountId: supplier.id,
      generation: 1,
      contentHash: invoice.checksum,
      requestFingerprint: "request-fingerprint",
      learnedAt,
      learnedByUserId: "shared_user",
    };
    store.learning.supplierProfiles = [
      {
        supplierAccountId: supplier.id,
        generation: 1,
        exampleCount: 1,
        lastLearnedAt: learnedAt,
        formatFingerprint: "layout-a",
        formatDrift: "none",
      },
    ];
    store.learning.supplierExamples = [
      {
        id: "example-normalized",
        supplierAccountId: supplier.id,
        generation: 1,
        invoiceId: invoice.id,
        contentHash: invoice.checksum,
        formatFingerprint: "layout-a",
        learnedAt,
        learnedByUserId: "shared_user",
        originalExtractedData: { ...invoice.extractedData, referenceCode: "wrong" },
        finalExtractedData: { ...invoice.extractedData, referenceCode: "INV-100" },
        bookingLines: [],
      },
    ];
    store.learning.supplierSelections = [
      {
        supplierIdentity: `name:${otherSupplier.name}`,
        accountId: otherSupplier.id,
        decidedAt: learnedAt,
        trustState: "legacy",
      },
    ];
    store.learning.glAccountSelections = [
      {
        supplierAccountId: supplier.id,
        descriptionKey: "software",
        glAccount: "4400",
        decidedAt: learnedAt,
      },
    ];
    store.learning.corrections = [
      {
        id: "legacy-correction-without-profile",
        invoiceId: "legacy-invoice",
        field: "expenseDescription",
        supplierIdentity: `name:${otherSupplier.name}`,
        supplierName: otherSupplier.name,
        matchKey: "legacy-description",
        originalValue: "old",
        correctedValue: "new",
        invoiceTextContext: rawText,
        confidence: 0.6,
        confidenceBefore: 0.5,
        confidenceAfter: 0.6,
        correctedAt: learnedAt,
        correctedByUserId: "shared_user",
        correctedByUserName: "Shared user",
        trustState: "legacy",
      },
    ];
    persistStoreSoon();
    await flushStoreToPersistence();

    const databaseBytes = await readFile(databasePath);
    const walBytes = await readFile(`${databasePath}-wal`).catch(() => Buffer.alloc(0));
    assert.doesNotMatch(
      Buffer.concat([databaseBytes, walBytes]).toString("utf8"),
      /Sensitive invoice text/,
      "runtime snapshot pages and WAL never receive plaintext OCR evidence"
    );

    const snapshot = await loadSqliteStoreSnapshot(databasePath);
    assert.ok(snapshot);
    assert.equal(snapshot!.learning.supplierExamples.length, 0);
    assert.equal(snapshot!.learning.supplierProfiles.length, 0);
    assert.ok(snapshot!.invoices[0]?.analysisArtifactId);
    assert.equal(snapshot!.invoices[0]?.extractedData.rawText, undefined);
    assert.equal(snapshot!.invoices[0]?.extractedData.documentAnalysis, undefined);
    assert.doesNotMatch(JSON.stringify(snapshot), /Sensitive invoice text/);

    let database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const artifact = database
        .prepare(
          "SELECT raw_text_ciphertext FROM document_analysis_artifacts LIMIT 1"
        )
        .get() as { raw_text_ciphertext: string };
      assert.match(artifact.raw_text_ciphertext, /^v1\./);
      assert.doesNotMatch(artifact.raw_text_ciphertext, /Sensitive invoice text/);
      const examplePayload = database
        .prepare(
          `SELECT original_prediction_json, final_fields_json
           FROM supplier_learning_examples LIMIT 1`
        )
        .get() as {
        original_prediction_json: string;
        final_fields_json: string;
      };
      assert.doesNotMatch(
        `${examplePayload.original_prediction_json}${examplePayload.final_fields_json}`,
        /Sensitive invoice text|NL91ABNA0417164300|Keizersgracht 100/
      );
      const otherProfile = database
        .prepare(
          "SELECT supplier_account_id FROM supplier_learning_profiles WHERE supplier_account_id = ?"
        )
        .get(otherSupplier.id);
      assert.ok(otherProfile, "legacy evidence creates a normalized supplier profile");
      const legacyCorrection = database
        .prepare(
          `SELECT support_count, booking_mapping_json FROM supplier_learning_patterns
           WHERE supplier_account_id = ? AND field = 'runtime_correction:expenseDescription'`
        )
        .get(otherSupplier.id) as {
        support_count: number;
        booking_mapping_json: string;
      };
      assert.equal(legacyCorrection.support_count, 0.35);
      assert.doesNotMatch(legacyCorrection.booking_mapping_json, /Sensitive invoice text/);
      const glPattern = database
        .prepare(
          `SELECT support_count FROM supplier_learning_patterns
           WHERE supplier_account_id = ? AND field = 'runtime_gl_selection'`
        )
        .get(supplier.id) as { support_count: number };
      assert.equal(glPattern.support_count, 1);
    } finally {
      database.close();
    }

    persistStoreSoon();
    await flushStoreToPersistence();
    database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const glPattern = database
        .prepare(
          `SELECT support_count FROM supplier_learning_patterns
           WHERE supplier_account_id = ? AND field = 'runtime_gl_selection'`
        )
        .get(supplier.id) as { support_count: number };
      assert.equal(glPattern.support_count, 1, "retries do not inflate evidence");
    } finally {
      database.close();
    }

    closeConfiguredLearningRepository();
    closeSqliteStore();
    clearRuntime();
    await hydrateStoreFromPersistence();

    assert.equal(getStore().invoices[0]?.extractedData.rawText, rawText);
    assert.equal(
      getStore().invoices[0]?.extractedData.documentAnalysis?.provider.name,
      "integration-provider"
    );
    assert.equal(getStore().learning.supplierExamples.length, 1);
    assert.equal(
      getStore().learning.supplierExamples[0]?.finalExtractedData?.referenceCode,
      "INV-100"
    );
    assert.ok(
      getStore().learning.supplierProfiles.some(
        (profile) => profile.supplierAccountId === supplier.id
      )
    );
    const reliability = listSupplierLearningSummaries().find(
      (summary) => summary.supplierAccountId === supplier.id
    )!.confidence as {
      score: number;
      copy?: string;
      distinctExampleCount?: number;
      metrics?: unknown[];
    };
    assert.equal(reliability.copy, "More training invoices needed.");
    assert.equal(reliability.distinctExampleCount, 1);
    assert.ok(reliability.metrics?.length);
    database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const cached = database
        .prepare(
          "SELECT confidence_score FROM supplier_learning_profiles WHERE supplier_account_id = ?"
        )
        .get(supplier.id) as { confidence_score: number };
      assert.equal(cached.confidence_score, reliability.score);
    } finally {
      database.close();
    }

    const currentProfile = getStore().learning.supplierProfiles.find(
      (profile) => profile.supplierAccountId === supplier.id
    )!;
    resetLearningForSupplier(supplier.id, currentProfile.generation);
    await flushStoreToPersistence();
    database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const resetProfile = database
        .prepare(
          "SELECT generation, learned_count, confidence_score FROM supplier_learning_profiles WHERE supplier_account_id = ?"
        )
        .get(supplier.id) as {
        generation: number;
        learned_count: number;
        confidence_score: number;
      };
      assert.equal(resetProfile.generation, currentProfile.generation + 1);
      assert.equal(resetProfile.learned_count, 0);
      assert.equal(resetProfile.confidence_score, 35);
      const activeExample = database
        .prepare(
          "SELECT active FROM supplier_learning_examples WHERE supplier_account_id = ?"
        )
        .get(supplier.id) as { active: number };
      assert.equal(activeExample.active, 0);
      const resetEvent = database
        .prepare(
          "SELECT type FROM supplier_learning_events WHERE supplier_account_id = ? AND type = 'reset'"
        )
        .get(supplier.id);
      assert.ok(resetEvent);
    } finally {
      database.close();
    }

    getStore().learning.supplierSelections.unshift({
      supplierIdentity: "name:noordzee office supplies",
      accountId: supplier.id,
      invoiceId: "post-reset-training",
      decidedAt: "2026-07-21T14:00:00.000Z",
      trustState: "trusted",
    });
    persistStoreSoon();
    await flushStoreToPersistence();
    database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const activeLearnedAlias = database
        .prepare(
          `SELECT generation, active FROM supplier_identity_aliases
           WHERE supplier_account_id = ? AND source = 'learned'
             AND normalized_value = ? AND active = 1`
        )
        .get(supplier.id, "noordzee office supplies") as {
        generation: number;
        active: number;
      };
      assert.equal(activeLearnedAlias.generation, currentProfile.generation + 1);
      assert.equal(activeLearnedAlias.active, 1);
    } finally {
      database.close();
    }
  } finally {
    if (previous.mode === undefined) delete process.env.DATABASE_MODE;
    else process.env.DATABASE_MODE = previous.mode;
    if (previous.path === undefined) delete process.env.LOCAL_DATABASE_PATH;
    else process.env.LOCAL_DATABASE_PATH = previous.path;
    if (previous.key === undefined) delete process.env.LEARNING_ARTIFACT_ENCRYPTION_KEY;
    else process.env.LEARNING_ARTIFACT_ENCRYPTION_KEY = previous.key;
    if (previous.enabled === undefined) delete process.env.LEARNING_V2_ENABLED;
    else process.env.LEARNING_V2_ENABLED = previous.enabled;
    if (previous.learningMode === undefined) delete process.env.SUPPLIER_LEARNING_MODE;
    else process.env.SUPPLIER_LEARNING_MODE = previous.learningMode;
    await removeDatabase(databasePath);
  }
});

test("persistent requests serialize reload-mutate-save cycles", async () => {
  const databasePath = testDatabasePath();
  const previousMode = process.env.DATABASE_MODE;
  const previousPath = process.env.LOCAL_DATABASE_PATH;
  const previousLearningEnabled = process.env.LEARNING_V2_ENABLED;
  process.env.DATABASE_MODE = "sqlite";
  process.env.LOCAL_DATABASE_PATH = databasePath;
  process.env.LEARNING_V2_ENABLED = "false";

  try {
    await Promise.all([
      withPersistentStore(async () => {
        await Promise.resolve();
        getStore().auditEvents.push({ id: "concurrent-a" } as never);
        persistStoreSoon();
      }),
      withPersistentStore(async () => {
        getStore().auditEvents.push({ id: "concurrent-b" } as never);
        persistStoreSoon();
      }),
    ]);

    closeSqliteStore();
    clearRuntime();
    await hydrateStoreFromPersistence();
    const ids = new Set(getStore().auditEvents.map((event) => event.id));
    assert.equal(ids.has("concurrent-a"), true);
    assert.equal(ids.has("concurrent-b"), true);
  } finally {
    if (previousMode === undefined) delete process.env.DATABASE_MODE;
    else process.env.DATABASE_MODE = previousMode;
    if (previousPath === undefined) delete process.env.LOCAL_DATABASE_PATH;
    else process.env.LOCAL_DATABASE_PATH = previousPath;
    if (previousLearningEnabled === undefined) delete process.env.LEARNING_V2_ENABLED;
    else process.env.LEARNING_V2_ENABLED = previousLearningEnabled;
    await removeDatabase(databasePath);
  }
});

test("reviewed and booked legacy invoices contribute one immutable trusted example", async () => {
  const databasePath = testDatabasePath();
  const previous = {
    mode: process.env.DATABASE_MODE,
    path: process.env.LOCAL_DATABASE_PATH,
    key: process.env.LEARNING_ARTIFACT_ENCRYPTION_KEY,
    enabled: process.env.LEARNING_V2_ENABLED,
    learningMode: process.env.SUPPLIER_LEARNING_MODE,
  };
  process.env.DATABASE_MODE = "sqlite";
  process.env.LOCAL_DATABASE_PATH = databasePath;
  process.env.LEARNING_ARTIFACT_ENCRYPTION_KEY = "review-artifact-key";
  process.env.LEARNING_V2_ENABLED = "true";
  process.env.SUPPLIER_LEARNING_MODE = "apply";

  try {
    await hydrateStoreFromPersistence();
    setExactConnection(createMockExactConnection("company_connection"));
    await syncExactDataNow();
    const invoice = getStore().invoices[0]!;
    const supplier = getExactMasterData()!.suppliers[0]!;
    assert.ok(invoice.purchaseJournal);
    const reviewedAt = "2026-07-21T12:00:00.000Z";
    invoice.checksum = "sha256:reviewed-invoice";
    invoice.extractedData.rawText = "Invoice number PREDICTED-1 total 121.00";
    invoice.extractedData.documentTextMode = "plain_text";
    invoice.extractedData.lineItems = undefined as never;
    invoice.extractionHistory = [
      {
        id: "review-original",
        version: 1,
        reason: "initial",
        extractedData: { ...invoice.extractedData, referenceCode: "PREDICTED-1" },
        createdAt: reviewedAt,
      },
    ];
    invoice.extractedData.referenceCode = "FINAL-1";
    invoice.validationErrors = [];
    invoice.processingPurpose = "booking";
    invoice.status = "Ready to Book";
    invoice.intelligenceApprovedAt = reviewedAt;
    invoice.purchaseJournal!.supplierResolution = {
      selectedAccountId: supplier.id,
      selectedAccountCode: supplier.code,
      selectedAccountName: supplier.name,
      matchConfidence: 1,
      threshold: 0.9,
      method: "VAT number",
      reviewRequired: false,
      candidates: [],
      reasoning: ["Unique Exact supplier."],
    };
    getStore();
    assert.deepEqual(invoice.extractedData.lineItems, []);
    assert.deepEqual(invoice.extractionHistory[0]?.extractedData.lineItems, []);
    persistStoreSoon();
    await flushStoreToPersistence();

    let database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const example = database
        .prepare(
          `SELECT source, trigger, trust_state, original_prediction_json,
                  final_fields_json
           FROM supplier_learning_examples
           WHERE supplier_account_id = ? AND content_hash = ?`
        )
        .get(supplier.id, invoice.checksum) as {
        source: string;
        trigger: string;
        trust_state: string;
        original_prediction_json: string;
        final_fields_json: string;
      };
      assert.equal(example.source, "review");
      assert.equal(example.trigger, "review");
      assert.equal(example.trust_state, "trusted");
      assert.equal(
        (
          JSON.parse(example.original_prediction_json) as {
            extractedData: { referenceCode: string };
          }
        ).extractedData.referenceCode,
        "PREDICTED-1"
      );
      assert.equal(
        (
          JSON.parse(example.final_fields_json) as {
            extractedData: { referenceCode: string; lineItems: unknown[] };
          }
        ).extractedData.referenceCode,
        "FINAL-1"
      );
      assert.deepEqual(
        (
          JSON.parse(example.final_fields_json) as {
            extractedData: { lineItems: unknown[] };
          }
        ).extractedData.lineItems,
        []
      );
      const artifact = database
        .prepare(
          "SELECT retention_until FROM document_analysis_artifacts WHERE content_hash = ?"
        )
        .get(invoice.checksum) as { retention_until: string | null };
      assert.ok(artifact.retention_until);
    } finally {
      database.close();
    }

    invoice.status = "Booked";
    invoice.exactBookingId = "exact-booking-reviewed";
    invoice.exactBookingStatus = "booked";
    invoice.updatedAt = "2026-07-21T13:00:00.000Z";
    persistStoreSoon();
    await flushStoreToPersistence();
    database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const count = database
        .prepare(
          "SELECT COUNT(*) AS count FROM supplier_learning_examples WHERE supplier_account_id = ? AND content_hash = ?"
        )
        .get(supplier.id, invoice.checksum) as { count: number };
      assert.equal(count.count, 1, "booking confirmation does not duplicate volume");
    } finally {
      database.close();
    }
  } finally {
    if (previous.mode === undefined) delete process.env.DATABASE_MODE;
    else process.env.DATABASE_MODE = previous.mode;
    if (previous.path === undefined) delete process.env.LOCAL_DATABASE_PATH;
    else process.env.LOCAL_DATABASE_PATH = previous.path;
    if (previous.key === undefined) delete process.env.LEARNING_ARTIFACT_ENCRYPTION_KEY;
    else process.env.LEARNING_ARTIFACT_ENCRYPTION_KEY = previous.key;
    if (previous.enabled === undefined) delete process.env.LEARNING_V2_ENABLED;
    else process.env.LEARNING_V2_ENABLED = previous.enabled;
    if (previous.learningMode === undefined) delete process.env.SUPPLIER_LEARNING_MODE;
    else process.env.SUPPLIER_LEARNING_MODE = previous.learningMode;
    await removeDatabase(databasePath);
  }
});
