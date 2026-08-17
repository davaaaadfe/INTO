import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { IntoStore } from "../lib/repository/invoice-store";
import {
  cleanupTemporaryInvoiceFiles,
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
import { withPersistentStoreForTest as withPersistentStore } from "../lib/repository/persistent-request";
import {
  configuredLearningRepository,
  closeConfiguredLearningRepository,
} from "../lib/repository/configured-learning-repository";
import { SqliteLearningRepository } from "../lib/repository/learning-repository";
import {
  hydrateLearningState,
  persistAnalysisArtifacts,
  persistLearningState,
  snapshotWithoutDocumentEvidence,
} from "../lib/repository/learning-persistence";
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

test("SQLite rolls back snapshot and normalized learning together when projection fails", async () => {
  const databasePath = testDatabasePath();
  const previous = {
    mode: process.env.DATABASE_MODE,
    path: process.env.LOCAL_DATABASE_PATH,
    key: process.env.LEARNING_ARTIFACT_ENCRYPTION_KEY,
    enabled: process.env.LEARNING_V2_ENABLED,
    learningMode: process.env.SUPPLIER_LEARNING_MODE,
  };
  const runtime = globalThis as typeof globalThis & {
    __INTO_STORE_TEST_HOOKS?: {
      beforeLearningProjection?: () => void | Promise<void>;
    };
  };
  process.env.DATABASE_MODE = "sqlite";
  process.env.LOCAL_DATABASE_PATH = databasePath;
  process.env.LEARNING_ARTIFACT_ENCRYPTION_KEY = "post-cas-fault-key";
  process.env.LEARNING_V2_ENABLED = "true";
  process.env.SUPPLIER_LEARNING_MODE = "apply";

  try {
    clearRuntime();
    await hydrateStoreFromPersistence();
    const store = getStore();
    const supplier = createMockExactMasterData().suppliers[0]!;
    const invoice = store.invoices[0]!;
    delete invoice.analysisArtifactId;
    invoice.extractedData.rawText = "Atomic rollback source evidence";
    store.exactMasterDataCaches = [{ userId: "company_connection", cache: createMockExactMasterData() }];
    store.learning.supplierProfiles = [{
      supplierAccountId: supplier.id,
      generation: 0,
      exampleCount: 1,
      lastLearnedAt: "2026-08-10T10:00:00.000Z",
      formatFingerprint: "post-cas-layout",
      formatDrift: "none",
    }];
    store.learning.supplierExamples = [{
      id: "post-cas-example",
      supplierAccountId: supplier.id,
      generation: 0,
      invoiceId: invoice.id,
      contentHash: "sha256:post-cas-example",
      formatFingerprint: "post-cas-layout",
      learnedAt: "2026-08-10T10:00:00.000Z",
      learnedByUserId: "shared_user",
      originalExtractedData: structuredClone(invoice.extractedData),
      finalExtractedData: structuredClone(invoice.extractedData),
      bookingLines: [],
    }];
    const previousArtifactId = invoice.analysisArtifactId;
    runtime.__INTO_STORE_TEST_HOOKS = {
      beforeLearningProjection: () => {
        throw new Error("post-CAS projection fault");
      },
    };

    persistStoreSoon();
    await assert.rejects(flushStoreToPersistence(), /post-CAS projection fault/);

    const snapshot = await loadSqliteStoreSnapshot(databasePath);
    assert.deepEqual(snapshot?.learning.supplierExamples, []);
    assert.equal(
      snapshot?.auditEvents.some((event) => event.id === "post-cas-example"),
      false
    );
    assert.equal(invoice.analysisArtifactId, previousArtifactId);
    const repository = await configuredLearningRepository();
    assert.equal(
      (await repository?.listProfiles("into-company", "unassigned"))?.length,
      0
    );
  } finally {
    delete runtime.__INTO_STORE_TEST_HOOKS;
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

test("a failed persistent Learn-style mutation restores the live server invoice", async () => {
  const databasePath = testDatabasePath();
  const previous = {
    mode: process.env.DATABASE_MODE,
    path: process.env.LOCAL_DATABASE_PATH,
    key: process.env.LEARNING_ARTIFACT_ENCRYPTION_KEY,
    enabled: process.env.LEARNING_V2_ENABLED,
  };
  const runtime = globalThis as typeof globalThis & {
    __INTO_STORE_TEST_HOOKS?: {
      beforeLearningProjection?: () => void | Promise<void>;
    };
  };
  process.env.DATABASE_MODE = "sqlite";
  process.env.LOCAL_DATABASE_PATH = databasePath;
  process.env.LEARNING_ARTIFACT_ENCRYPTION_KEY = "learn-request-rollback-key";
  process.env.LEARNING_V2_ENABLED = "true";

  try {
    clearRuntime();
    await hydrateStoreFromPersistence();
    const before = structuredClone(getStore().invoices[0]!);
    runtime.__INTO_STORE_TEST_HOOKS = {
      beforeLearningProjection: () => {
        throw new Error("learn transaction failed");
      },
    };

    const result = await withPersistentStore(() => {
      const invoice = getStore().invoices[0]!;
      invoice.status = "Learned";
      invoice.processingPurpose = "learning_only";
      invoice.learningState = "saved";
      invoice.revision += 1;
      persistStoreSoon();
      return Response.json({ invoice });
    });

    assert.ok(result instanceof Response);
    assert.equal(result.status, 500);
    assert.deepEqual(
      JSON.parse(JSON.stringify(getStore().invoices[0])),
      JSON.parse(JSON.stringify(before))
    );
  } finally {
    delete runtime.__INTO_STORE_TEST_HOOKS;
    if (previous.mode === undefined) delete process.env.DATABASE_MODE;
    else process.env.DATABASE_MODE = previous.mode;
    if (previous.path === undefined) delete process.env.LOCAL_DATABASE_PATH;
    else process.env.LOCAL_DATABASE_PATH = previous.path;
    if (previous.key === undefined) delete process.env.LEARNING_ARTIFACT_ENCRYPTION_KEY;
    else process.env.LEARNING_ARTIFACT_ENCRYPTION_KEY = previous.key;
    if (previous.enabled === undefined) delete process.env.LEARNING_V2_ENABLED;
    else process.env.LEARNING_V2_ENABLED = previous.enabled;
    await removeDatabase(databasePath);
  }
});

test("storage cleanup prunes only expired encrypted learning artifacts", async () => {
  const databasePath = testDatabasePath();
  const previous = {
    mode: process.env.DATABASE_MODE,
    path: process.env.LOCAL_DATABASE_PATH,
    key: process.env.LEARNING_ARTIFACT_ENCRYPTION_KEY,
    enabled: process.env.LEARNING_V2_ENABLED,
    learningMode: process.env.SUPPLIER_LEARNING_MODE,
    retentionDays: process.env.LEARNING_ARTIFACT_RETENTION_DAYS,
  };
  process.env.DATABASE_MODE = "sqlite";
  process.env.LOCAL_DATABASE_PATH = databasePath;
  process.env.LEARNING_ARTIFACT_ENCRYPTION_KEY = "cleanup-artifact-key";
  process.env.LEARNING_V2_ENABLED = "true";
  process.env.SUPPLIER_LEARNING_MODE = "apply";
  process.env.LEARNING_ARTIFACT_RETENTION_DAYS = "30";

  try {
    clearRuntime();
    const store = getStore();
    const expiredInvoice = structuredClone(store.invoices[0]!);
    expiredInvoice.id = "expired-artifact-invoice";
    expiredInvoice.checksum = "sha256:expired-cleanup-artifact";
    expiredInvoice.localFileStatus = "missing";
    expiredInvoice.createdAt = "2026-05-01T00:00:00.000Z";
    expiredInvoice.updatedAt = "2026-05-01T00:00:00.000Z";
    expiredInvoice.extractedData.rawText =
      "Expired encrypted learning artifact";
    const futureInvoice = structuredClone(expiredInvoice);
    futureInvoice.id = "future-artifact-invoice";
    futureInvoice.checksum = "sha256:future-cleanup-artifact";
    futureInvoice.createdAt = "2026-07-15T00:00:00.000Z";
    futureInvoice.updatedAt = "2026-07-15T00:00:00.000Z";
    futureInvoice.extractedData.rawText = "Future encrypted learning artifact";
    store.invoices = [expiredInvoice, futureInvoice];

    assert.equal(await persistAnalysisArtifacts(store), true);
    const repository = await configuredLearningRepository();
    assert.ok(repository);
    const profile = await repository.ensureProfile({
      companyId: "into-company",
      divisionCode: "unassigned",
      supplierAccountId: "supplier-cleanup",
      fallbackSupplierCode: "CLEANUP",
      createdAt: "2026-05-01T00:00:00.000Z",
    });
    await repository.saveExample({
      id: "example-expired-cleanup",
      companyId: profile.companyId,
      divisionCode: profile.divisionCode,
      supplierAccountId: profile.supplierAccountId,
      generation: profile.generation,
      invoiceId: expiredInvoice.id,
      artifactId: expiredInvoice.analysisArtifactId,
      contentHash: expiredInvoice.checksum,
      originalFilename: expiredInvoice.fileName,
      originalPrediction: {},
      finalFields: {},
      bookingLines: [],
      fingerprint: "cleanup-layout",
      fingerprintVersion: "layout-v1",
      validationResult: { valid: true },
      processingPurpose: "learning_only",
      source: "explicit_learn",
      trustState: "trusted",
      trigger: "learn",
      actorId: "shared_user",
      sessionCorrelationId: "cleanup-session",
      requestId: "cleanup-request",
      createdAt: "2026-05-01T00:00:00.000Z",
    });

    let database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const artifacts = database
        .prepare(
          `SELECT content_hash, raw_text_ciphertext
           FROM document_analysis_artifacts ORDER BY content_hash`
        )
        .all() as Array<{
        content_hash: string;
        raw_text_ciphertext: string;
      }>;
      assert.equal(artifacts.length, 2);
      assert.ok(
        artifacts.every(
          (artifact) =>
            /^v1\./.test(artifact.raw_text_ciphertext) &&
            !artifact.raw_text_ciphertext.includes("learning artifact")
        )
      );
    } finally {
      database.close();
    }

    const cleanup = await cleanupTemporaryInvoiceFiles(
      new Date("2026-07-29T00:00:00.000Z")
    );

    assert.equal(cleanup.learningArtifactsPruned, 1);
    database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const artifacts = database
        .prepare(
          "SELECT content_hash FROM document_analysis_artifacts ORDER BY content_hash"
        )
        .all() as Array<{ content_hash: string }>;
      assert.deepEqual(
        artifacts.map((artifact) => artifact.content_hash),
        ["sha256:future-cleanup-artifact"]
      );
      const example = database
        .prepare(
          "SELECT artifact_id FROM supplier_learning_examples WHERE id = ?"
        )
        .get("example-expired-cleanup") as { artifact_id: string | null };
      assert.equal(example.artifact_id, null);
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
    if (previous.retentionDays === undefined) {
      delete process.env.LEARNING_ARTIFACT_RETENTION_DAYS;
    } else {
      process.env.LEARNING_ARTIFACT_RETENTION_DAYS = previous.retentionDays;
    }
    await removeDatabase(databasePath);
  }
});

test("booking attempt snapshots omit nested document evidence without losing audit data", () => {
  const store = structuredClone(getStore());
  const invoice = store.invoices[0]!;
  store.learning.supplierOutcomeEvents = [{
    id: "transient-outcome",
    supplierAccountId: "supplier-a",
    generation: 1,
    invoiceId: invoice.id,
    invoiceRevision: invoice.revision,
    type: "correction",
    candidateIds: ["candidate-a"],
    fields: ["referenceCode"],
    createdAt: "2026-08-17T10:00:00.000Z",
  }];
  invoice.bookingAttempts = [{
    id: "attempt-privacy-regression",
    invoiceId: invoice.id,
    status: "success",
    exactBookingId: "exact-safe-123",
    createdAt: "2026-07-29T10:00:00.000Z",
    requestPayload: {
      extractedData: {
        invoiceNumber: "SAFE-INVOICE-123",
        rawText: "BOOKING_REQUEST_SENSITIVE_RAW_TEXT",
        extractionEvidence: {
          invoiceNumber: {
            rawValue: "BOOKING_REQUEST_SENSITIVE_EVIDENCE",
          },
        },
        nested: [{
          keep: "safe-request-nested",
          documentAnalysis: {
            pages: [{ text: "BOOKING_REQUEST_SENSITIVE_LAYOUT" }],
          },
        }],
      },
      purchaseJournal: {
        journal: "60",
        yourRef: "SAFE-REQUEST-REF",
      },
    },
    responsePayload: {
      exactBookingId: "exact-safe-123",
      accepted: true,
      result: {
        keep: "safe-response-nested",
        rawText: "BOOKING_RESPONSE_SENSITIVE_RAW_TEXT",
        extractionEvidence: {
          referenceCode: {
            rawValue: "BOOKING_RESPONSE_SENSITIVE_EVIDENCE",
          },
        },
        documentAnalysis: {
          pages: [{ text: "BOOKING_RESPONSE_SENSITIVE_LAYOUT" }],
        },
      },
    },
  }];

  const snapshot = snapshotWithoutDocumentEvidence(store);
  const attempt = snapshot.invoices[0]!.bookingAttempts[0]!;
  assert.equal(snapshot.learning.supplierOutcomeEvents, undefined);

  assert.deepEqual(
    {
      id: attempt.id,
      invoiceId: attempt.invoiceId,
      status: attempt.status,
      exactBookingId: attempt.exactBookingId,
      createdAt: attempt.createdAt,
    },
    {
      id: "attempt-privacy-regression",
      invoiceId: invoice.id,
      status: "success",
      exactBookingId: "exact-safe-123",
      createdAt: "2026-07-29T10:00:00.000Z",
    }
  );
  assert.deepEqual(attempt.requestPayload, {
    extractedData: {
      invoiceNumber: "SAFE-INVOICE-123",
      nested: [{ keep: "safe-request-nested" }],
    },
    purchaseJournal: {
      journal: "60",
      yourRef: "SAFE-REQUEST-REF",
    },
  });
  assert.deepEqual(attempt.responsePayload, {
    exactBookingId: "exact-safe-123",
    accepted: true,
    result: {
      keep: "safe-response-nested",
    },
  });
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /BOOKING_(?:REQUEST|RESPONSE)_SENSITIVE/
  );
  assert.match(
    JSON.stringify(store.invoices[0]!.bookingAttempts[0]),
    /BOOKING_REQUEST_SENSITIVE_RAW_TEXT/
  );
  assert.match(
    JSON.stringify(store.invoices[0]!.bookingAttempts[0]),
    /BOOKING_RESPONSE_SENSITIVE_LAYOUT/
  );
});

test("legacy snapshots with missing learning arrays survive migration and the next write", async () => {
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
  legacySnapshot.schemaVersion = 1;
  delete (
    legacySnapshot.learning as Partial<IntoStore["learning"]>
  ).supplierProfiles;
  delete (
    legacySnapshot.learning as Partial<IntoStore["learning"]>
  ).supplierExamples;
  delete (
    legacySnapshot.learning as Partial<IntoStore["learning"]>
  ).corrections;
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
    persistStoreSoon();
    await flushStoreToPersistence();

    assert.deepEqual(getStore().learning.supplierProfiles, []);
    assert.deepEqual(getStore().learning.supplierExamples, []);
    assert.deepEqual(getStore().learning.corrections, []);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const migrations = database
        .prepare(
          `SELECT migration_name, status, row_counts_json
           FROM supplier_learning_data_migrations`
        )
        .all() as Array<{
        migration_name: string;
        status: string;
        row_counts_json: string;
      }>;
      assert.equal(migrations.length, 1);
      assert.match(migrations[0]!.migration_name, /^legacy-learning:/);
      assert.equal(migrations[0]!.status, "completed");
      assert.deepEqual(JSON.parse(migrations[0]!.row_counts_json), {
        corrections: 0,
        examples: 0,
        mappings: 0,
        patterns: 0,
        selections: 0,
      });
    } finally {
      database.close();
    }
    assert.ok((await loadSqliteStoreSnapshot(databasePath))?.learningRepositoryMigratedAt);
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

test("supplier candidate outcome events project idempotently without values", async () => {
  const databasePath = testDatabasePath();
  const repository = new SqliteLearningRepository(databasePath);
  try {
    await repository.migrate();
    const store = structuredClone(getStore());
    const supplier = createMockExactMasterData().suppliers[0]!;
    store.invoices = [];
    store.exactMasterDataCaches = [{
      userId: "company_connection",
      cache: createMockExactMasterData(),
    }];
    store.learning.supplierProfiles = [{
      supplierAccountId: supplier.id,
      generation: 1,
      exampleCount: 1,
      formatDrift: "none",
    }];
    store.learning.supplierOutcomeEvents = [{
      id: "outcome-application-a",
      supplierAccountId: supplier.id,
      generation: 1,
      invoiceId: "invoice-a",
      invoiceRevision: 4,
      type: "application",
      candidateIds: ["candidate-a"],
      fields: ["referenceCode"],
      createdAt: "2026-08-17T10:00:00.000Z",
    }];

    const context = {
      actorId: "verified-a",
      requestId: "request-a",
      sessionCorrelationId: "session-a",
    };
    await persistLearningState(store, context, repository);
    await persistLearningState(store, context, repository);

    const events = await repository.listEvents({
      companyId: process.env.INTO_COMPANY_ID?.trim() || "into-company",
      divisionCode: store.exactMasterDataCaches[0]!.cache.divisionCode,
      supplierAccountId: supplier.id,
    });
    assert.equal(events.filter((event) => event.type === "application").length, 1);
    assert.deepEqual(events.find((event) => event.type === "application")?.metadata, {
      invoiceId: "invoice-a",
      invoiceRevision: 4,
      candidateIds: ["candidate-a"],
      fields: ["referenceCode"],
    });
    assert.doesNotMatch(JSON.stringify(events), /SECRET|rawValue|correctedValue/);
  } finally {
    repository.close();
    await removeDatabase(databasePath);
  }
});

test("normalized supplier outcomes and reset replay metadata hydrate after restart", async () => {
  const databasePath = testDatabasePath();
  const previous = {
    mode: process.env.DATABASE_MODE,
    path: process.env.LOCAL_DATABASE_PATH,
    enabled: process.env.LEARNING_V2_ENABLED,
  };
  process.env.DATABASE_MODE = "sqlite";
  process.env.LOCAL_DATABASE_PATH = databasePath;
  process.env.LEARNING_V2_ENABLED = "true";
  const repository = new SqliteLearningRepository(databasePath);
  try {
    await repository.migrate();
    const store = structuredClone(getStore());
    const supplier = createMockExactMasterData().suppliers[0]!;
    store.invoices = [];
    store.exactMasterDataCaches = [{
      userId: "company_connection",
      cache: createMockExactMasterData(),
    }];
    store.learning.supplierProfiles = [{
      supplierAccountId: supplier.id,
      generation: 1,
      exampleCount: 0,
      formatDrift: "none",
    }];
    store.learning.supplierOutcomeEvents = [{
      id: "outcome-acceptance-restart",
      supplierAccountId: supplier.id,
      generation: 1,
      invoiceId: "invoice-restart",
      invoiceRevision: 7,
      type: "acceptance",
      candidateIds: ["private-candidate-id"],
      fields: ["referenceCode"],
      createdAt: "2026-08-17T11:00:00.000Z",
    }];
    await persistLearningState(store, { requestId: "outcome-restart" }, repository);
    const profile = (await repository.listProfiles(
      process.env.INTO_COMPANY_ID?.trim() || "into-company",
      store.exactMasterDataCaches[0]!.cache.divisionCode
    ))[0]!;
    await repository.saveEvent({
      id: "reset-restart",
      companyId: profile.companyId,
      divisionCode: profile.divisionCode,
      supplierAccountId: supplier.id,
      generation: 1,
      type: "reset",
      idempotencyKey: "reset:restart-key",
      actorId: "verified-a",
      sessionCorrelationId: "session-a",
      requestId: "restart-key",
      metadata: { previousGeneration: 0 },
      createdAt: "2026-08-17T12:00:00.000Z",
    });

    store.learning.supplierProfiles = [];
    store.learning.supplierOutcomeEvents = [];
    await closeConfiguredLearningRepository();
    assert.equal(await hydrateLearningState(store), true);

    assert.deepEqual(store.learning.supplierOutcomeEvents, [{
      id: "outcome-acceptance-restart",
      supplierAccountId: supplier.id,
      generation: 1,
      invoiceId: "invoice-restart",
      invoiceRevision: 7,
      type: "acceptance",
      candidateIds: [],
      fields: ["referenceCode"],
      createdAt: "2026-08-17T11:00:00.000Z",
    }]);
    assert.equal(store.learning.supplierProfiles[0]?.lastResetRequestKey, "restart-key");
    assert.equal(store.learning.supplierProfiles[0]?.lastResetExpectedGeneration, 0);
  } finally {
    repository.close();
    await closeConfiguredLearningRepository();
    if (previous.mode === undefined) delete process.env.DATABASE_MODE;
    else process.env.DATABASE_MODE = previous.mode;
    if (previous.path === undefined) delete process.env.LOCAL_DATABASE_PATH;
    else process.env.LOCAL_DATABASE_PATH = previous.path;
    if (previous.enabled === undefined) delete process.env.LEARNING_V2_ENABLED;
    else process.env.LEARNING_V2_ENABLED = previous.enabled;
    await removeDatabase(databasePath);
  }
});

test("legacy migration trusts only corroborated Learn examples and deactivates generation-zero history", async () => {
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
  process.env.LEARNING_ARTIFACT_ENCRYPTION_KEY = "legacy-trust-split-key";
  process.env.LEARNING_V2_ENABLED = "true";
  process.env.SUPPLIER_LEARNING_MODE = "apply";

  try {
    clearRuntime();
    const snapshot = structuredClone(getStore());
    const masterData = createMockExactMasterData();
    const trustedSupplier = masterData.suppliers[0]!;
    const legacySupplier = masterData.suppliers[1]!;
    const trustedInvoice = snapshot.invoices[0]!;
    const legacyInvoice = structuredClone(trustedInvoice);
    const learnedAt = "2026-08-10T10:00:00.000Z";
    trustedInvoice.id = "trusted-migrated-invoice";
    trustedInvoice.checksum = "sha256:trusted-migrated";
    trustedInvoice.status = "Learned";
    trustedInvoice.processingPurpose = "learning_only";
    trustedInvoice.learningState = "saved";
    trustedInvoice.learningMetadata = {
      exampleId: "trusted-migrated-example",
      supplierAccountId: trustedSupplier.id,
      generation: 1,
      contentHash: trustedInvoice.checksum,
      requestFingerprint: "trusted-migrated-request",
      learnedAt,
      learnedByUserId: "shared_user",
    };
    legacyInvoice.id = "uncorroborated-migrated-invoice";
    legacyInvoice.checksum = "sha256:uncorroborated-migrated";
    legacyInvoice.status = "Ready to Book";
    legacyInvoice.processingPurpose = "booking";
    legacyInvoice.learningState = "not_saved";
    delete legacyInvoice.learningMetadata;
    snapshot.invoices = [trustedInvoice, legacyInvoice];
    snapshot.exactMasterDataCaches = [{
      userId: "company_connection",
      cache: masterData,
    }];
    snapshot.learning.supplierProfiles = [trustedSupplier, legacySupplier].map(
      (supplier) => ({
        supplierAccountId: supplier.id,
        generation: 1,
        exampleCount: 1,
        lastLearnedAt: learnedAt,
        formatFingerprint: `layout-${supplier.id}`,
        formatDrift: "none" as const,
      })
    );
    snapshot.learning.supplierExamples = [
      {
        id: "trusted-migrated-example",
        supplierAccountId: trustedSupplier.id,
        generation: 1,
        invoiceId: trustedInvoice.id,
        contentHash: trustedInvoice.checksum,
        formatFingerprint: "trusted-layout",
        learnedAt,
        learnedByUserId: "shared_user",
        originalExtractedData: structuredClone(trustedInvoice.extractedData),
        finalExtractedData: structuredClone(trustedInvoice.extractedData),
        bookingLines: [],
      },
      {
        id: "uncorroborated-migrated-example",
        supplierAccountId: legacySupplier.id,
        generation: 1,
        invoiceId: legacyInvoice.id,
        contentHash: legacyInvoice.checksum,
        formatFingerprint: "legacy-layout",
        learnedAt,
        learnedByUserId: "shared_user",
        originalExtractedData: structuredClone(legacyInvoice.extractedData),
        finalExtractedData: structuredClone(legacyInvoice.extractedData),
        bookingLines: [],
      },
    ];
    snapshot.auditEvents.push({
      id: "trusted-migrated-audit",
      invoiceId: trustedInvoice.id,
      type: "invoice_learned",
      createdAt: learnedAt,
      userId: "shared_user",
      userName: "Shared user",
      message: "Learning saved.",
      metadata: { exampleId: "trusted-migrated-example" },
    });
    await saveSqliteStoreSnapshot(snapshot, databasePath);
    clearRuntime();
    closeSqliteStore();

    await hydrateStoreFromPersistence();
    const interruptedMigration = new DatabaseSync(databasePath);
    try {
      interruptedMigration.exec("DELETE FROM supplier_learning_data_migrations");
    } finally {
      interruptedMigration.close();
    }
    closeConfiguredLearningRepository();
    closeSqliteStore();
    clearRuntime();
    await hydrateStoreFromPersistence();
    assert.deepEqual(
      getStore().learning.supplierProfiles.map((profile) => profile.supplierAccountId),
      [trustedSupplier.id]
    );

    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const examples = database
        .prepare(
          `SELECT invoice_id, generation, source, trust_state, active
           FROM supplier_learning_examples ORDER BY invoice_id`
        )
        .all() as Array<{
        invoice_id: string;
        generation: number;
        source: string;
        trust_state: string;
        active: number;
      }>;
      assert.deepEqual(examples.map((example) => ({ ...example })), [
        {
          invoice_id: trustedInvoice.id,
          generation: 1,
          source: "explicit_learn",
          trust_state: "trusted",
          active: 1,
        },
        {
          invoice_id: legacyInvoice.id,
          generation: 0,
          source: "legacy",
          trust_state: "legacy",
          active: 0,
        },
      ]);
      const events = database
        .prepare(
          `SELECT type, metadata_json FROM supplier_learning_events
           WHERE type = 'migration' ORDER BY supplier_account_id`
        )
        .all() as Array<{ type: string; metadata_json: string }>;
      assert.equal(events.length, 2);
      assert.ok(
        events.every((event) => {
          const metadata = JSON.parse(event.metadata_json) as Record<string, unknown>;
          return (
            event.type === "migration" &&
            metadata.legacyGeneration === 0 &&
            typeof metadata.trustedExampleCount === "number" &&
            !event.metadata_json.includes("invoice")
          );
        })
      );
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
        formatSignature: "invoice number:<value>\n<text>",
        formatCluster: "cluster-layout-a",
        learnedAt,
        learnedByUserId: "shared_user",
        originalExtractedData: { ...invoice.extractedData, referenceCode: "wrong" },
        finalExtractedData: { ...invoice.extractedData, referenceCode: "INV-100" },
        bookingLines: [],
      },
    ];
    store.learning.supplierExamples[0]!.originalExtractedData!.lineItems =
      undefined as never;
    store.learning.supplierExamples[0]!.finalExtractedData!.lineItems =
      undefined as never;
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
      const derivedPattern = database
        .prepare(
          `SELECT format_cluster, support_count, correction_count
           FROM supplier_learning_patterns
           WHERE supplier_account_id = ? AND field = 'referenceCode'`
        )
        .get(supplier.id) as {
        format_cluster: string;
        support_count: number;
        correction_count: number;
      };
      assert.equal(derivedPattern.format_cluster, "cluster-layout-a");
      assert.equal(derivedPattern.support_count, 1);
      assert.equal(derivedPattern.correction_count, 1);
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

test("persistent requests reuse unchanged normalized learning but refresh artifacts and changed snapshots", async () => {
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
  process.env.LEARNING_ARTIFACT_ENCRYPTION_KEY = "request-hydration-key";
  process.env.LEARNING_V2_ENABLED = "true";
  process.env.SUPPLIER_LEARNING_MODE = "apply";
  const persistenceRuntime = globalThis as typeof globalThis & {
    __INTO_STORE_TEST_HOOKS?: {
      beforeLearningProjection?: () => void | Promise<void>;
    };
  };

  let restoreRepositoryMethods: (() => void) | undefined;
  try {
    clearRuntime();
    const seededStore = getStore();
    const invoice = seededStore.invoices[0]!;
    invoice.checksum = "sha256:request-hydration-artifact";
    invoice.extractedData.rawText = "Request hydration OCR evidence";
    invoice.extractedData.extractionEvidence = {
      referenceCode: {
        sourceLabel: "Reference",
        rawValue: "Request hydration reference",
        confidence: 0.99,
      },
    };
    invoice.extractedData.documentAnalysis = {
      pages: [],
      fieldCandidates: [],
      confidence: 0.99,
      provider: { name: "integration-provider", model: "fixture-v1" },
      sourceMode: "plain_text",
    };
    seededStore.learningRepositoryMigratedAt = "2026-07-29T10:00:00.000Z";
    assert.equal(await persistAnalysisArtifacts(seededStore), true);

    const repository = await configuredLearningRepository();
    assert.ok(repository instanceof SqliteLearningRepository);
    const profile = await repository.ensureProfile({
      companyId: "into-company",
      divisionCode: "unassigned",
      supplierAccountId: "supplier-request-hydration",
      fallbackSupplierCode: "HYDRATE",
      createdAt: "2026-07-29T10:00:00.000Z",
    });
    await repository.saveExample({
      id: "example-request-hydration",
      companyId: profile.companyId,
      divisionCode: profile.divisionCode,
      supplierAccountId: profile.supplierAccountId,
      generation: profile.generation,
      invoiceId: invoice.id,
      artifactId: invoice.analysisArtifactId,
      contentHash: invoice.checksum,
      originalFilename: invoice.fileName,
      originalPrediction: {},
      finalFields: {},
      bookingLines: [],
      fingerprint: "request-layout",
      fingerprintVersion: "layout-v1",
      validationResult: { valid: true },
      processingPurpose: "learning_only",
      source: "explicit_learn",
      trustState: "trusted",
      trigger: "learn",
      actorId: "shared_user",
      sessionCorrelationId: "request-hydration-session",
      requestId: "request-hydration-request",
      createdAt: "2026-07-29T10:00:00.000Z",
    });
    await saveSqliteStoreSnapshot(
      snapshotWithoutDocumentEvidence(seededStore),
      databasePath
    );
    clearRuntime();

    const requestRepository = await configuredLearningRepository();
    assert.ok(requestRepository instanceof SqliteLearningRepository);
    let profileReads = 0;
    let exampleReads = 0;
    let patternReads = 0;
    let artifactReads = 0;
    let artifactExistenceReads = 0;
    const listProfiles = requestRepository.listProfiles.bind(requestRepository);
    const listExamples = requestRepository.listExamples.bind(requestRepository);
    const listPatterns = requestRepository.listPatterns.bind(requestRepository);
    const readArtifact = requestRepository.readArtifact.bind(requestRepository);
    const countedReadArtifact: typeof requestRepository.readArtifact =
      async (...args) => {
        artifactReads += 1;
        return readArtifact(...args);
      };
    const existingArtifactIds =
      requestRepository.existingArtifactIds.bind(requestRepository);
    const saveArtifact = requestRepository.saveArtifact.bind(requestRepository);
    requestRepository.listProfiles = async (...args) => {
      profileReads += 1;
      return listProfiles(...args);
    };
    requestRepository.listExamples = async (...args) => {
      exampleReads += 1;
      return listExamples(...args);
    };
    requestRepository.listPatterns = async (...args) => {
      patternReads += 1;
      return listPatterns(...args);
    };
    requestRepository.readArtifact = countedReadArtifact;
    requestRepository.existingArtifactIds = async (...args) => {
      artifactExistenceReads += 1;
      return existingArtifactIds(...args);
    };
    restoreRepositoryMethods = () => {
      requestRepository.listProfiles = listProfiles;
      requestRepository.listExamples = listExamples;
      requestRepository.listPatterns = listPatterns;
      requestRepository.readArtifact = readArtifact;
      requestRepository.existingArtifactIds = existingArtifactIds;
      requestRepository.saveArtifact = saveArtifact;
    };

    const first = await withPersistentStore(() => ({
      store: getStore(),
      rawText: getStore().invoices[0]?.extractedData.rawText,
      learning: getStore().learning,
    }));
    assert.ok(!(first instanceof Response));
    assert.equal(first.rawText, "Request hydration OCR evidence");
    assert.equal(first.learning.supplierExamples.length, 1);
    const readsAfterFirst = {
      profiles: profileReads,
      examples: exampleReads,
      patterns: patternReads,
    };
    assert.deepEqual(readsAfterFirst, {
      profiles: 1,
      examples: 1,
      patterns: 1,
    });
    const artifactReadsAfterFirst = artifactReads;
    assert.equal(artifactReadsAfterFirst > 0, true);

    const warm = await withPersistentStore(() => ({
      store: getStore(),
      rawText: getStore().invoices[0]?.extractedData.rawText,
      extractionEvidence:
        getStore().invoices[0]?.extractedData.extractionEvidence,
      documentAnalysis:
        getStore().invoices[0]?.extractedData.documentAnalysis,
      learning: getStore().learning,
    }));
    assert.ok(!(warm instanceof Response));
    assert.equal(warm.store, first.store);
    assert.equal(warm.rawText, "Request hydration OCR evidence");
    assert.deepEqual(warm.extractionEvidence, {
      referenceCode: {
        sourceLabel: "Reference",
        rawValue: "Request hydration reference",
        confidence: 0.99,
      },
    });
    assert.equal(warm.documentAnalysis?.provider.name, "integration-provider");
    assert.equal(warm.learning, first.learning);
    assert.equal(artifactReads, artifactReadsAfterFirst);
    assert.equal(artifactExistenceReads, 1);

    const advancedSnapshot = await loadSqliteStoreSnapshot(databasePath);
    assert.ok(advancedSnapshot);
    const advancedAuditEventId = "advanced-before-hydration-failure";
    advancedSnapshot.auditEvents.push({ id: advancedAuditEventId } as never);
    await saveSqliteStoreSnapshot(advancedSnapshot, databasePath);

    requestRepository.readArtifact = async () => {
      artifactReads += 1;
      throw new Error("Forced full artifact hydration failure");
    };
    const failedHydration = await withPersistentStore(() => {
      assert.fail("handler must not run after failed full hydration");
    });
    assert.ok(failedHydration instanceof Response);
    assert.equal(failedHydration.status, 500);
    const partialStore = getStore();
    const partialLearning = partialStore.learning;
    requestRepository.readArtifact = countedReadArtifact;

    const artifactReadsAfterFailedHydration = artifactReads;
    const hydrationRecovered = await withPersistentStore(() => ({
      store: getStore(),
      rawText: getStore().invoices[0]?.extractedData.rawText,
      extractionEvidence:
        getStore().invoices[0]?.extractedData.extractionEvidence,
      documentAnalysis:
        getStore().invoices[0]?.extractedData.documentAnalysis,
      learning: getStore().learning,
      hasAdvancedChange: getStore().auditEvents.some(
        (event) => event.id === advancedAuditEventId
      ),
    }));
    assert.ok(!(hydrationRecovered instanceof Response));
    assert.notEqual(hydrationRecovered.store, partialStore);
    assert.equal(hydrationRecovered.rawText, "Request hydration OCR evidence");
    assert.deepEqual(hydrationRecovered.extractionEvidence, {
      referenceCode: {
        sourceLabel: "Reference",
        rawValue: "Request hydration reference",
        confidence: 0.99,
      },
    });
    assert.equal(
      hydrationRecovered.documentAnalysis?.provider.name,
      "integration-provider"
    );
    assert.notEqual(hydrationRecovered.learning, partialLearning);
    assert.equal(hydrationRecovered.learning.supplierExamples.length, 1);
    assert.equal(hydrationRecovered.hasAdvancedChange, true);
    assert.equal(artifactReads > artifactReadsAfterFailedHydration, true);
    assert.equal(artifactExistenceReads, 1);

    persistenceRuntime.__INTO_STORE_TEST_HOOKS = {
      beforeLearningProjection: () => {
        throw new Error("Forced atomic persistence failure");
      },
    };
    const rejectedAuditEventId = "rejected-persistence-change";
    const rejectedLearningPatternKey = "rejected-learning-pattern";
    const revisionBeforeRejection = hydrationRecovered.store.revision;
    const rejected = await withPersistentStore(() => {
      getStore().auditEvents.push({ id: rejectedAuditEventId } as never);
      getStore().learning.supplierPatterns.push({
        supplierAccountId: "rejected-supplier",
        generation: 99,
        key: rejectedLearningPatternKey,
        successes: 0,
        attempts: 0,
        weight: 0,
      });
      persistStoreSoon();
    });
    assert.ok(rejected instanceof Response);
    assert.equal(rejected.status, 500);
    assert.equal(artifactExistenceReads, 2);
    delete persistenceRuntime.__INTO_STORE_TEST_HOOKS;

    const snapshotAfterRejection =
      await loadSqliteStoreSnapshot(databasePath);
    assert.ok(snapshotAfterRejection);
    assert.equal(snapshotAfterRejection.revision, revisionBeforeRejection);
    assert.equal(
      snapshotAfterRejection.auditEvents.some(
        (event) => event.id === rejectedAuditEventId
      ),
      false
    );

    const recovered = await withPersistentStore(() => ({
      store: getStore(),
      learning: getStore().learning,
      hasRejectedChange: getStore().auditEvents.some(
        (event) => event.id === rejectedAuditEventId
      ),
      hasRejectedLearning: getStore().learning.supplierPatterns.some(
        (pattern) => pattern.key === rejectedLearningPatternKey
      ),
    }));
    assert.ok(!(recovered instanceof Response));
    assert.notEqual(recovered.store, hydrationRecovered.store);
    assert.notEqual(recovered.learning, hydrationRecovered.learning);
    assert.equal(recovered.hasRejectedChange, false);
    assert.equal(recovered.hasRejectedLearning, false);
    assert.equal(artifactExistenceReads, 3);
    const persistedAfterRecovery =
      await loadSqliteStoreSnapshot(databasePath);
    assert.ok(persistedAfterRecovery);
    assert.equal(
      persistedAfterRecovery.auditEvents.some(
        (event) => event.id === rejectedAuditEventId
      ),
      false
    );
    const readsAfterRecovery = {
      profiles: profileReads,
      examples: exampleReads,
      patterns: patternReads,
    };
    const artifactReadsAfterRecovery = artifactReads;

    const externalDatabase = new DatabaseSync(databasePath);
    try {
      externalDatabase.exec(`
        PRAGMA foreign_keys = OFF;
        DELETE FROM document_analysis_artifacts;
      `);
    } finally {
      externalDatabase.close();
    }

    const second = await withPersistentStore(() => ({
      store: getStore(),
      rawText: getStore().invoices[0]?.extractedData.rawText,
      extractionEvidence:
        getStore().invoices[0]?.extractedData.extractionEvidence,
      documentAnalysis:
        getStore().invoices[0]?.extractedData.documentAnalysis,
      learning: getStore().learning,
    }));
    assert.ok(!(second instanceof Response));
    assert.equal(second.store, recovered.store);
    assert.equal(second.rawText, undefined);
    assert.equal(second.extractionEvidence, undefined);
    assert.equal(second.documentAnalysis, undefined);
    assert.equal(second.learning, recovered.learning);
    assert.equal(artifactReads, artifactReadsAfterRecovery);
    assert.equal(artifactExistenceReads, 4);
    assert.deepEqual(
      {
        profiles: profileReads,
        examples: exampleReads,
        patterns: patternReads,
      },
      readsAfterRecovery
    );

    process.env.LEARNING_V2_ENABLED = "false";
    const disabled = await withPersistentStore(() => ({
      store: getStore(),
      learning: getStore().learning,
    }));
    assert.ok(!(disabled instanceof Response));
    assert.notEqual(disabled.store, second.store);
    assert.notEqual(disabled.learning, second.learning);
    assert.deepEqual(disabled.learning.supplierProfiles, []);
    assert.deepEqual(disabled.learning.supplierExamples, []);
    assert.deepEqual(disabled.learning.supplierPatterns, []);
    assert.deepEqual(
      {
        profiles: profileReads,
        examples: exampleReads,
        patterns: patternReads,
      },
      readsAfterRecovery
    );
    process.env.LEARNING_V2_ENABLED = "true";

    const reenabled = await withPersistentStore(() => ({
      store: getStore(),
      learning: getStore().learning,
    }));
    assert.ok(!(reenabled instanceof Response));
    assert.notEqual(reenabled.store, disabled.store);
    assert.notEqual(reenabled.learning, disabled.learning);
    assert.equal(reenabled.learning.supplierProfiles.length, 1);
    assert.equal(reenabled.learning.supplierExamples.length, 1);
    assert.equal(profileReads, readsAfterRecovery.profiles + 1);
    assert.equal(exampleReads, readsAfterRecovery.examples + 1);
    assert.equal(patternReads, readsAfterRecovery.patterns + 1);
    const artifactReadsAfterReenable = artifactReads;
    assert.equal(artifactReadsAfterReenable > artifactReadsAfterRecovery, true);

    const externalSnapshot = await loadSqliteStoreSnapshot(databasePath);
    assert.ok(externalSnapshot);
    assert.ok(externalSnapshot.invoices[0]?.analysisArtifactId);
    externalSnapshot.invoices[0]!.extractedData.rawText =
      "Externally persisted stale OCR evidence";
    externalSnapshot.invoices[0]!.extractedData.extractionEvidence = {
      referenceCode: {
        sourceLabel: "Stale reference",
        rawValue: "STALE-REF",
        confidence: 0.1,
      },
    };
    externalSnapshot.invoices[0]!.extractedData.documentAnalysis = {
      pages: [],
      fieldCandidates: [],
      confidence: 0.1,
      provider: { name: "stale-provider", model: "stale-v1" },
      sourceMode: "plain_text",
    };
    externalSnapshot.auditEvents.push({ id: "external-hydration-change" } as never);
    await saveSqliteStoreSnapshot(externalSnapshot, databasePath);

    const third = await withPersistentStore(() => ({
      store: getStore(),
      rawText: getStore().invoices[0]?.extractedData.rawText,
      extractionEvidence:
        getStore().invoices[0]?.extractedData.extractionEvidence,
      documentAnalysis:
        getStore().invoices[0]?.extractedData.documentAnalysis,
      hasExternalChange: getStore().auditEvents.some(
        (event) => event.id === "external-hydration-change"
      ),
      learning: getStore().learning,
    }));
    assert.ok(!(third instanceof Response));
    assert.equal(third.hasExternalChange, true);
    assert.equal(third.rawText, undefined);
    assert.equal(third.extractionEvidence, undefined);
    assert.equal(third.documentAnalysis, undefined);
    assert.notEqual(third.store, reenabled.store);
    assert.notEqual(third.learning, reenabled.learning);
    assert.equal(profileReads, readsAfterRecovery.profiles + 2);
    assert.equal(exampleReads, readsAfterRecovery.examples + 2);
    assert.equal(patternReads, readsAfterRecovery.patterns + 2);
    assert.equal(artifactReads > artifactReadsAfterReenable, true);
    assert.equal(artifactExistenceReads, 4);
  } finally {
    delete persistenceRuntime.__INTO_STORE_TEST_HOOKS;
    restoreRepositoryMethods?.();
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
          `SELECT source, trigger, trust_state, original_filename,
                  format_signature, format_cluster,
                  observation_state_json, original_prediction_json,
                  final_fields_json
           FROM supplier_learning_examples
           WHERE supplier_account_id = ? AND content_hash = ?`
        )
        .get(supplier.id, invoice.checksum) as {
        source: string;
        trigger: string;
        trust_state: string;
        original_filename: string;
        format_signature: string;
        format_cluster: string;
        observation_state_json: string;
        original_prediction_json: string;
        final_fields_json: string;
      };
      assert.equal(example.source, "review");
      assert.equal(example.trigger, "review");
      assert.equal(example.trust_state, "trusted");
      assert.equal(example.original_filename, "*.png");
      assert.ok(example.format_signature);
      assert.match(example.format_cluster, /^cluster_[a-f0-9]{16}$/);
      const observationState = JSON.parse(example.observation_state_json) as Record<
        string,
        string
      >;
      assert.equal(observationState.referenceCode, "observed");
      assert.equal(observationState.dueDate, "unknown");
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
