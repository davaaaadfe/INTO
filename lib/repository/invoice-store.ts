import { createHash } from "node:crypto";
import {
  assertInvoiceBookingAllowed,
  emptyExtractedInvoiceData,
  SHARED_ACCESS_PERMISSIONS,
} from "../domain/invoice";
import type {
  AuditEvent,
  BookingAttempt,
  BookingLearningStore,
  CurrentUserContext,
  DuplicateCandidate,
  DuplicateDecisionLog,
  DuplicateDetectionOutcome,
  DuplicateDetectionResult,
  DuplicateInvoiceCandidate,
  DuplicateResolutionDecision,
  ExactConnection,
  ExactMasterDataCache,
  ExtractedInvoiceData,
  IntoUser,
  InvoiceArchiveFilters,
  InvoiceArchiveResult,
  PermissionAction,
  PurchaseJournalLine,
  PublicExactConnection,
  SupplierOverviewImport,
  SupplierOverviewImportStatus,
  SupplierOverviewRecord,
  SupplierLearningSummary,
  UploadedInvoice,
  ValidationError,
} from "../domain/invoice";
import { validateInvoiceData } from "../services/invoice-validation";
import {
  isExactMasterDataStale,
  syncExactMasterData,
} from "../services/exact-master-data-service";
import {
  deleteStoredInvoiceFile,
  storeMockInvoiceFile,
  temporaryInvoiceRetentionDays,
} from "../services/storage-service";
import {
  createInitialLearningStore,
  generatePurchaseJournalBooking,
  purchaseJournalValidationErrors,
  rememberDecisionsFromInvoice,
  statusFromPurchaseJournal,
  supplierIdentityForInvoice,
} from "../services/purchase-journal-intelligence";
import {
  applyLearnedExtractedData,
  canonicalSupplierIdentityKey,
  canonicalSupplierIdentityKeys,
  captureSupplierAccountCorrection,
  captureUserCorrections,
  promoteInvoiceCorrections,
} from "../services/correction-learning";
import { refreshExactTokenIfNeeded } from "../services/exact-online-service";
import { mergeSupplierOverviewWithExactSuppliers } from "../services/supplier-overview-import";
import {
  formatFingerprint,
  learnSupplierInvoice,
  resetSupplierLearning,
  supplierReliability,
  supplierReliabilityEvidenceFromLearningStore,
} from "../services/supplier-learning";
import { createId } from "../utils/id";
import {
  isPostgresPersistenceEnabled,
  loadStoreRevision,
  loadStoreSnapshot,
  saveStoreSnapshot,
} from "./postgres-store";
import {
  databasePersistenceIdentity,
  databaseMode,
  loadSqliteStoreRevision,
  loadSqliteStoreSnapshot,
  saveSqliteStoreSnapshot,
  SnapshotRevisionConflictError,
} from "./sqlite-store";
import { CURRENT_STORE_SCHEMA_VERSION } from "./store-migrations";
import { currentRequestPrincipal } from "./request-principal-context";
import {
  hydrateLearningState,
  persistAnalysisArtifacts,
  persistLearningState,
  pruneExpiredLearningArtifacts,
  snapshotWithoutActiveLearning,
  snapshotWithoutDocumentEvidence,
  type LearningPersistenceContext,
} from "./learning-persistence";

const sharedUserPermissions: PermissionAction[] = [
  ...SHARED_ACCESS_PERMISSIONS,
];

export const SHARED_USER_ID = "shared_user";

export const COMPANY_CONNECTION_USER_ID = "company_connection";

export function getCompanyConnectionUserId() {
  return COMPANY_CONNECTION_USER_ID;
}

export type IntoStore = {
  schemaVersion: number;
  revision: number;
  users: IntoUser[];
  currentUserId: string;
  invoices: UploadedInvoice[];
  exactConnections: ExactConnection[];
  exactMasterDataCaches: Array<{
    userId: string;
    cache: ExactMasterDataCache;
  }>;
  supplierOverviewImport: SupplierOverviewImport | null;
  duplicateLogs: DuplicateDecisionLog[];
  auditEvents: AuditEvent[];
  learning: BookingLearningStore;
  learningRepositoryMigratedAt?: string;
  legacyLearningRollback?: BookingLearningStore;
};

function now() {
  return new Date().toISOString();
}

function exactMasterDataForUser(
  store: IntoStore,
  userId: string
): ExactMasterDataCache | null {
  const cache =
    store.exactMasterDataCaches.find((item) => item.userId === userId)?.cache ?? null;
  const supplierOverview = store.supplierOverviewImport;
  if (!supplierOverview) return cache;

  const suppliers = mergeSupplierOverviewWithExactSuppliers(
    supplierOverview.suppliers,
    cache?.suppliers ?? []
  );
  if (cache) return { ...cache, suppliers };

  return {
    source: "exact-online",
    divisionCode: "supplier-overview",
    lastSyncedAt: supplierOverview.importedAt,
    staleAfter: supplierOverview.importedAt,
    suppliers,
    paymentConditions: [],
    journals: [],
    glAccounts: [],
    costCenters: [],
    costUnits: [],
    vatCodes: [],
    historicalPurchaseBookings: [],
  };
}

function createSharedUser(): IntoUser {
  const timestamp = now();

  return {
    id: SHARED_USER_ID,
    email: "shared_user@internal",
    name: SHARED_USER_ID,
    status: "active",
    isSystemOwner: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function userDisplayName(user: IntoUser | null | undefined) {
  return user?.name || user?.email || "Unknown user";
}

function mutationUser(): IntoUser {
  const principal = currentRequestPrincipal();
  if (!principal || principal.accessLevel === "legacy_shared") return getCurrentUser();
  const timestamp = now();
  return {
    id: principal.actorId,
    email: "",
    name: principal.actorName,
    status: "active",
    isSystemOwner: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function createSeedInvoice(overrides: Partial<UploadedInvoice>): UploadedInvoice {
  const createdAt = now();
  const ownerId = overrides.userId ?? SHARED_USER_ID;
  const ownerName = overrides.uploadedByName ?? SHARED_USER_ID;
  const invoice: UploadedInvoice = {
    id: createId("invoice"),
    userId: ownerId,
    uploadedByUserId: overrides.uploadedByUserId ?? ownerId,
    uploadedByName: ownerName,
    source: "manual_upload",
    fileName: "seed-invoice.pdf",
    fileType: "application/pdf",
    fileSize: 120_000,
    checksum: "seed-invoice-checksum",
    storageKey: "seed/seed-invoice.pdf",
    localFileStatus: "available",
    status: "Ready to Book",
    processingPurpose: "booking",
    learningState: "not_saved",
    revision: 1,
    exactBookingStatus: "not_booked",
    extractedData: {
      ...emptyExtractedInvoiceData(),
      supplierName: "Noordzee Office Supplies",
      supplierVatNumber: "NL812345678B01",
      supplierChamberOfCommerceNumber: "34123456",
      supplierAddress: "Keizersgracht 100, Amsterdam",
      supplierCountry: "NL",
      invoiceNumber: "INV-SEED-001",
      referenceCode: "",
      invoiceDate: "2026-02-12",
      dueDate: "2026-03-13",
      paymentTerms: "7 days",
      currency: "EUR",
      netAmount: 480,
      vatAmount: 100.8,
      grossAmount: 580.8,
      iban: "NL91ABNA0417164300",
      expenseDescription: "Office Supplies",
      beneficiary: "",
      serviceStartDate: "",
      serviceEndDate: "",
      companyVatNumber: "NL857017263B01",
      reverseChargeMentioned: false,
      intraCommunityMentioned: false,
      confidence: 0.96,
      rawText: "Seeded mock invoice.",
      lineItems: [
        {
          id: createId("line"),
          description: "Office furniture",
          quantity: 1,
          unitPrice: 480,
          netAmount: 480,
          vatRate: 0.21,
          vatAmount: 100.8,
          grossAmount: 580.8,
        },
      ],
    },
    extractionHistory: [],
    purchaseJournal: null,
    validationErrors: [],
    bookingAttempts: [],
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };

  const storedSeedFile = storeMockInvoiceFile({
    fileName: invoice.fileName,
    fileType: "text/plain",
    content: [
      "INTO demo source invoice file",
      `File: ${invoice.fileName}`,
      "This is the stored source attachment used by the mock workspace.",
    ].join("\n"),
  });
  invoice.storageKey = storedSeedFile.storageKey;
  invoice.fileSize = storedSeedFile.fileSize;
  invoice.fileType = storedSeedFile.fileType;
  invoice.checksum = storedSeedFile.checksum;

  return invoice;
}

function createInitialStore(): IntoStore {
  const sharedUser = createSharedUser();
  const seedDemoInvoices = process.env.NODE_ENV !== "production";
  const readyInvoice = seedDemoInvoices ? createSeedInvoice({}) : null;
  const checkInvoice = seedDemoInvoices
    ? createSeedInvoice({
        userId: SHARED_USER_ID,
        uploadedByUserId: SHARED_USER_ID,
        uploadedByName: SHARED_USER_ID,
        fileName: "missing-due-date-invoice.png",
        fileType: "image/png",
        checksum: "missing-due-date-checksum",
        status: "Validation Failed",
        extractedData: {
          ...emptyExtractedInvoiceData(),
          supplierName: "Delta IT Services",
          supplierVatNumber: "NL855512340B01",
          supplierChamberOfCommerceNumber: "55230119",
          supplierAddress: "Europalaan 21, Utrecht",
          supplierCountry: "NL",
          invoiceNumber: "INV-CHECK-104",
          referenceCode: "",
          invoiceDate: "2026-04-08",
          dueDate: "",
          paymentTerms: "30 days",
          currency: "EUR",
          netAmount: 210,
          vatAmount: 44.1,
          grossAmount: 254.1,
          iban: "NL39RABO0300065264",
          expenseDescription: "Google Workspace",
          beneficiary: "",
          serviceStartDate: "",
          serviceEndDate: "",
          companyVatNumber: "NL857017263B01",
          reverseChargeMentioned: false,
          intraCommunityMentioned: false,
          confidence: 0.74,
          rawText: "Seeded invoice with missing due date.",
          lineItems: [],
        },
      })
    : null;
  const store: IntoStore = {
    schemaVersion: CURRENT_STORE_SCHEMA_VERSION,
    revision: 0,
    users: [sharedUser],
    currentUserId: SHARED_USER_ID,
    invoices: [checkInvoice, readyInvoice].filter(
      (invoice): invoice is UploadedInvoice => Boolean(invoice)
    ),
    exactConnections: [],
    exactMasterDataCaches: [],
    supplierOverviewImport: null,
    duplicateLogs: [],
    auditEvents: [],
    learning: createInitialLearningStore(),
  };

  if (readyInvoice) {
    recomputeInvoiceInStore(store, readyInvoice.id);
  }
  if (checkInvoice) {
    recomputeInvoiceInStore(store, checkInvoice.id);
  }

  for (const invoice of store.invoices) {
    store.auditEvents.push({
      id: createId("audit"),
      invoiceId: invoice.id,
      userId: invoice.uploadedByUserId,
      userName: invoice.uploadedByName,
      type: "invoice_uploaded",
      message: `${invoice.uploadedByName} added ${invoice.fileName}.`,
      metadata: {
        source: invoice.source,
        fileName: invoice.fileName,
        status: invoice.status,
      },
      createdAt: invoice.createdAt,
    });
  }

  return store;
}

const globalStore = globalThis as typeof globalThis & {
  __INTO_STORE?: IntoStore;
  __INTO_STORE_HYDRATED_FOR?: string;
  __INTO_STORE_HYDRATING?: {
    identity: string;
    promise: Promise<void>;
  };
  __INTO_STORE_PERSISTING?: Promise<void>;
  __INTO_STORE_PERSISTENCE_BATCH?: StorePersistenceBatch;
  __INTO_STORE_PERSISTENCE_ERROR?: unknown;
  __INTO_STORE_DIRTY?: boolean;
  __INTO_STORE_DIRTY_REVISION?: number;
  __INTO_STORE_PERSISTED_DIRTY_REVISION?: number;
  __INTO_LEARNING_PERSISTENCE_CONTEXT?: LearningPersistenceContext;
  __INTO_STORE_TEST_HOOKS?: StorePersistenceTestHooks;
};

type StorePersistenceFailure = {
  identity: string;
  store: IntoStore;
  error: unknown;
};

type StorePersistenceTestHooks = {
  beforeLearningProjection?: () => void | Promise<void>;
};

type StorePersistenceBatch = {
  identity: string;
  store: IntoStore;
  context: LearningPersistenceContext | undefined;
  dirtyRevision: number;
  started: boolean;
};

function isStorePersistenceFailure(
  value: unknown
): value is StorePersistenceFailure {
  return Boolean(
    value &&
      typeof value === "object" &&
      "identity" in value &&
      "store" in value &&
      "error" in value
  );
}

function hasStorePersistenceFailure(identity: string, store: IntoStore) {
  const failure = globalStore.__INTO_STORE_PERSISTENCE_ERROR;
  return Boolean(
    failure &&
      (!isStorePersistenceFailure(failure) ||
        (failure.identity === identity && failure.store === store))
  );
}

export function getStore() {
  if (
    !globalStore.__INTO_STORE ||
    !Array.isArray(globalStore.__INTO_STORE.users) ||
    !Array.isArray(globalStore.__INTO_STORE.exactConnections) ||
    !Array.isArray(globalStore.__INTO_STORE.auditEvents)
  ) {
    globalStore.__INTO_STORE = createInitialStore();
  }

  const sharedUser = globalStore.__INTO_STORE.users.find(
    (user) => user.id === SHARED_USER_ID
  );
  globalStore.__INTO_STORE.users = [sharedUser ?? createSharedUser()];
  globalStore.__INTO_STORE.currentUserId = SHARED_USER_ID;

  for (const invoice of globalStore.__INTO_STORE.invoices) {
    invoice.extractedData.lineItems ??= [];
    for (const extraction of invoice.extractionHistory ?? []) {
      extraction.extractedData.lineItems ??= [];
    }
    if (!invoice.localFileStatus) {
      invoice.localFileStatus = invoice.storageKey ? "available" : "missing";
    }
    invoice.processingPurpose ??=
      invoice.status === "Learned" ? "learning_only" : "booking";
    if (String(invoice.learningState ?? "") === "none") {
      invoice.learningState = "not_saved";
    }
    invoice.learningState ??=
      invoice.status === "Learned" ? "saved" : "not_saved";
    invoice.revision ??= 1;
    if (invoice.status === "Learned") {
      invoice.processingPurpose = "learning_only";
      invoice.learningState = "saved";
      invoice.exactBookingStatus = "not_booked";
    }
  }

  if (!globalStore.__INTO_STORE.learning) {
    globalStore.__INTO_STORE.learning = createInitialLearningStore();
  }
  const learningDefaults = createInitialLearningStore();
  globalStore.__INTO_STORE.learning.revision = 1;
  for (const key of Object.keys(learningDefaults) as Array<keyof BookingLearningStore>) {
    if (key !== "revision" && !Array.isArray(globalStore.__INTO_STORE.learning[key])) {
      Object.assign(globalStore.__INTO_STORE.learning, { [key]: [] });
    }
  }
  for (const correction of globalStore.__INTO_STORE.learning.corrections) {
    if (!correction.trustState) {
      correction.trustState = "legacy";
      correction.confidence = Math.min(correction.confidence, 0.8);
    }
  }
  for (const decision of globalStore.__INTO_STORE.learning.supplierSelections) {
    decision.trustState ??= "legacy";
  }
  if (globalStore.__INTO_STORE.supplierOverviewImport === undefined) {
    globalStore.__INTO_STORE.supplierOverviewImport = null;
  }

  return globalStore.__INTO_STORE;
}

async function loadConfiguredStoreSnapshot() {
  if (databaseMode() === "sqlite") {
    return loadSqliteStoreSnapshot();
  }

  if (isPostgresPersistenceEnabled()) {
    return loadStoreSnapshot();
  }

  return null;
}

async function loadConfiguredStoreRevision() {
  if (databaseMode() === "sqlite") {
    return loadSqliteStoreRevision();
  }

  if (isPostgresPersistenceEnabled()) {
    return loadStoreRevision();
  }

  return null;
}

async function saveConfiguredStoreSnapshot(
  store: IntoStore,
  context = globalStore.__INTO_LEARNING_PERSISTENCE_CONTEXT,
  expectedIdentity?: string
) {
  const identityIsCurrent = () =>
    !expectedIdentity || databasePersistenceIdentity() === expectedIdentity;
  const saveSnapshot = async (snapshot: IntoStore) => {
    if (!identityIsCurrent()) return false;
    if (databaseMode() === "sqlite") {
      await saveSqliteStoreSnapshot(snapshot);
    } else if (isPostgresPersistenceEnabled()) {
      await saveStoreSnapshot(snapshot);
    }
    return identityIsCurrent();
  };

  // Store OCR/layout evidence only in encrypted artifacts. Preparing those
  // artifacts before the CAS can at worst leave an unreferenced encrypted row;
  // it cannot publish a losing Learn or reset mutation.
  if (!identityIsCurrent()) return;
  const artifactsPrepared = await persistAnalysisArtifacts(store);
  if (!identityIsCurrent()) return;
  const commitSnapshot = artifactsPrepared
    ? snapshotWithoutDocumentEvidence(store)
    : store;

  // The revision-protected, already-sanitized snapshot is the mutation commit
  // point. Project learning only after this request wins the CAS, so a losing
  // serverless instance cannot leave behind a ghost Learn or reset operation.
  if (!(await saveSnapshot(commitSnapshot))) return;
  if (commitSnapshot !== store) {
    store.schemaVersion = commitSnapshot.schemaVersion;
    store.revision = commitSnapshot.revision;
  }
  await globalStore.__INTO_STORE_TEST_HOOKS?.beforeLearningProjection?.();
  const normalized = await persistLearningState(store, context);
  if (!identityIsCurrent()) return;
  if (normalized) {
    const compactSnapshot = snapshotWithoutActiveLearning(store);
    compactSnapshot.revision = store.revision;
    try {
      if (!(await saveSnapshot(compactSnapshot))) return;
      store.schemaVersion = compactSnapshot.schemaVersion;
      store.revision = compactSnapshot.revision;
    } catch (error) {
      if (!(error instanceof SnapshotRevisionConflictError)) throw error;
      // A newer authoritative snapshot won after our commit. Its request will
      // perform the same idempotent projection and compaction.
    }
  }
}

async function hydrateConfiguredStore(
  force: boolean,
  reuseUnchangedNormalizedLearning: boolean
) {
  const identity = databasePersistenceIdentity();
  if (
    databaseMode() === "memory" ||
    (!force && globalStore.__INTO_STORE_HYDRATED_FOR === identity)
  ) {
    return;
  }

  await globalStore.__INTO_STORE_PERSISTING;
  if (databasePersistenceIdentity() !== identity) {
    return hydrateConfiguredStore(force, reuseUnchangedNormalizedLearning);
  }

  let hydration = globalStore.__INTO_STORE_HYDRATING;
  if (!hydration) {
    const promise = (async () => {
      const previousStore = globalStore.__INTO_STORE;
      const canReuseCachedState = Boolean(
        reuseUnchangedNormalizedLearning &&
          previousStore &&
          globalStore.__INTO_STORE_HYDRATED_FOR === identity &&
          !globalStore.__INTO_STORE_DIRTY &&
          !hasStorePersistenceFailure(identity, previousStore)
      );
      if (
        canReuseCachedState &&
        previousStore &&
        (await loadConfiguredStoreRevision()) === previousStore.revision &&
        databasePersistenceIdentity() === identity &&
        (await hydrateLearningState(previousStore, false, true))
      ) {
        return;
      }

      delete globalStore.__INTO_STORE_HYDRATED_FOR;
      const snapshot = await loadConfiguredStoreSnapshot();
      if (databasePersistenceIdentity() !== identity) return;
      const snapshotLearning = snapshot?.learning;
      const reuseNormalizedLearning = Boolean(
        canReuseCachedState &&
          snapshot?.learningRepositoryMigratedAt &&
          previousStore?.revision === snapshot.revision
      );
      if (snapshot) {
        globalStore.__INTO_STORE = snapshot;
        globalStore.__INTO_STORE_DIRTY = false;
        globalStore.__INTO_STORE_PERSISTED_DIRTY_REVISION =
          globalStore.__INTO_STORE_DIRTY_REVISION ?? 0;
        if (reuseNormalizedLearning && previousStore) {
          snapshot.learning = previousStore.learning;
        }
      } else {
        globalStore.__INTO_STORE = createInitialStore();
        await saveConfiguredStoreSnapshot(
          globalStore.__INTO_STORE,
          undefined,
          identity
        );
        if (databasePersistenceIdentity() !== identity) return;
      }
      return hydrateLearningState(getStore(), !reuseNormalizedLearning).then(
        (learningEnabled) => {
          if (databasePersistenceIdentity() !== identity) return;
          if (
            !learningEnabled &&
            reuseNormalizedLearning &&
            snapshot &&
            snapshotLearning
          ) {
            snapshot.learning = snapshotLearning;
          }
          if (
            learningEnabled &&
            !snapshot?.learningRepositoryMigratedAt
          ) {
            globalStore.__INTO_STORE_DIRTY = true;
            globalStore.__INTO_STORE_DIRTY_REVISION =
              (globalStore.__INTO_STORE_DIRTY_REVISION ?? 0) + 1;
          }
          if (learningEnabled) {
            globalStore.__INTO_STORE_HYDRATED_FOR = identity;
          } else {
            delete globalStore.__INTO_STORE_HYDRATED_FOR;
          }
        }
      );
    })();
    hydration = { identity, promise };
    globalStore.__INTO_STORE_HYDRATING = hydration;
  }

  try {
    await hydration.promise;
  } catch (error) {
    if (databasePersistenceIdentity() === hydration.identity) throw error;
  } finally {
    if (globalStore.__INTO_STORE_HYDRATING === hydration) {
      delete globalStore.__INTO_STORE_HYDRATING;
    }
  }
  if (databasePersistenceIdentity() !== hydration.identity) {
    return hydrateConfiguredStore(force, reuseUnchangedNormalizedLearning);
  }
}

export function hydrateStoreFromPersistence(force = false) {
  return hydrateConfiguredStore(force, false);
}

export function hydrateStoreForPersistentRequest() {
  return hydrateConfiguredStore(true, true);
}

function queueStorePersistence() {
  const identity = databasePersistenceIdentity();
  const store = getStore();
  const context = globalStore.__INTO_LEARNING_PERSISTENCE_CONTEXT;
  const dirtyRevision = globalStore.__INTO_STORE_DIRTY_REVISION ?? 0;
  const pending = globalStore.__INTO_STORE_PERSISTENCE_BATCH;
  if (
    pending &&
    !pending.started &&
    pending.identity === identity &&
    pending.store === store &&
    pending.context === context
  ) {
    pending.dirtyRevision = Math.max(pending.dirtyRevision, dirtyRevision);
    return;
  }
  const batch: StorePersistenceBatch = {
    identity,
    store,
    context,
    dirtyRevision,
    started: false,
  };
  globalStore.__INTO_STORE_PERSISTENCE_BATCH = batch;
  const previous = (
    globalStore.__INTO_STORE_PERSISTING ?? Promise.resolve()
  ).catch((error: unknown) => {
    globalStore.__INTO_STORE_PERSISTENCE_ERROR ??= error;
  });
  globalStore.__INTO_STORE_PERSISTING = previous
    .then(async () => {
      batch.started = true;
      if (globalStore.__INTO_STORE_PERSISTENCE_BATCH === batch) {
        delete globalStore.__INTO_STORE_PERSISTENCE_BATCH;
      }
      if (
        databasePersistenceIdentity() !== batch.identity ||
        globalStore.__INTO_STORE !== batch.store
      ) {
        return;
      }
      const persistedRevision =
        globalStore.__INTO_STORE_PERSISTED_DIRTY_REVISION ?? 0;
      if (batch.dirtyRevision <= persistedRevision) return;
      await saveConfiguredStoreSnapshot(
        batch.store,
        batch.context,
        batch.identity
      );
      if (
        databasePersistenceIdentity() !== batch.identity ||
        globalStore.__INTO_STORE !== batch.store
      ) {
        return;
      }
      globalStore.__INTO_STORE_PERSISTED_DIRTY_REVISION = Math.max(
        globalStore.__INTO_STORE_PERSISTED_DIRTY_REVISION ?? 0,
        batch.dirtyRevision
      );
      globalStore.__INTO_STORE_DIRTY =
        (globalStore.__INTO_STORE_DIRTY_REVISION ?? 0) >
        (globalStore.__INTO_STORE_PERSISTED_DIRTY_REVISION ?? 0);
    })
    .catch((error: unknown) => {
      const current = globalStore.__INTO_STORE_PERSISTENCE_ERROR;
      if (
        !current ||
        (isStorePersistenceFailure(current) &&
          (current.identity !== batch.identity || current.store !== batch.store))
      ) {
        globalStore.__INTO_STORE_PERSISTENCE_ERROR = {
          identity: batch.identity,
          store: batch.store,
          error,
        } satisfies StorePersistenceFailure;
      }
    });
}

export function persistStoreSoon() {
  if (databaseMode() === "memory") {
    return;
  }

  globalStore.__INTO_STORE_DIRTY = true;
  globalStore.__INTO_STORE_DIRTY_REVISION =
    (globalStore.__INTO_STORE_DIRTY_REVISION ?? 0) + 1;
  queueStorePersistence();
}

export async function flushStoreToPersistence(
  context?: LearningPersistenceContext
) {
  if (context) {
    globalStore.__INTO_LEARNING_PERSISTENCE_CONTEXT = context;
  }
  const identity = databasePersistenceIdentity();
  const store = getStore();
  if (databaseMode() !== "memory" && globalStore.__INTO_STORE_DIRTY) {
    queueStorePersistence();
  }
  await globalStore.__INTO_STORE_PERSISTING;
  const failure = globalStore.__INTO_STORE_PERSISTENCE_ERROR;
  if (failure) {
    globalStore.__INTO_STORE_PERSISTENCE_ERROR = undefined;
    if (!isStorePersistenceFailure(failure)) {
      // Preserve one-time reporting for an untagged failure left by an older
      // hot-reloaded module.
      throw failure;
    }
    if (failure.identity === identity && failure.store === store) {
      throw failure.error;
    }
  }
}

export function setLearningPersistenceContext(
  context: LearningPersistenceContext | undefined
) {
  globalStore.__INTO_LEARNING_PERSISTENCE_CONTEXT = context;
}

export function listUsers() {
  return [...getStore().users];
}

export function getCurrentUser() {
  const store = getStore();
  return (
    store.users.find((user) => user.id === store.currentUserId) ??
    store.users[0]
  );
}

export function permissionsForUser(user = getCurrentUser()) {
  if (user.status !== "active") {
    return [];
  }

  return [...sharedUserPermissions];
}

export function canUser(action: PermissionAction, user = getCurrentUser()) {
  return permissionsForUser(user).includes(action);
}

export function currentUserContext(): CurrentUserContext {
  const user = getCurrentUser();
  return {
    user,
    permissions: permissionsForUser(user),
  };
}

export function requirePermission(action: PermissionAction, principal?: { accessLevel: string }) {
  if (principal?.accessLevel === "verified_user") return getCurrentUser();
  const user = getCurrentUser();
  if (!canUser(action, user)) {
    throw new Error(`This INTO account is not allowed to ${action.replace(/_/g, " ")}.`);
  }

  return user;
}

export function requireSystemOwner(principal?: { accessLevel: string }) {
  if (principal?.accessLevel === "verified_user") return getCurrentUser();
  const user = getCurrentUser();
  if (user.status !== "active" || !user.isSystemOwner) {
    throw new Error(
      "This INTO account is not allowed to manage shared Exact Online settings. Only the system owner can do this."
    );
  }

  return user;
}

export function getDemoUserId() {
  return getCurrentUser().id;
}

export function listInvoices() {
  const store = getStore();
  for (const invoice of store.invoices) {
    if (
      !invoice.deletedAt &&
      !invoice.purchaseJournal &&
      invoice.extractedData.invoiceNumber &&
      invoice.status !== "Uploaded" &&
      invoice.status !== "Reading"
    ) {
      recomputeInvoiceInStore(store, invoice.id);
    }
  }

  return [...store.invoices].filter((invoice) => !invoice.deletedAt).sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

export function getInvoice(invoiceId: string) {
  const store = getStore();
  const invoice = store.invoices.find((item) => item.id === invoiceId) ?? null;

  if (
    invoice &&
    !invoice.purchaseJournal &&
    invoice.extractedData.invoiceNumber &&
    invoice.status !== "Uploaded" &&
    invoice.status !== "Reading"
  ) {
    return recomputeInvoiceInStore(store, invoice.id);
  }

  return invoice;
}

export function duplicateCandidates(): DuplicateCandidate[] {
  return getStore().invoices.map((invoice) => ({
    id: invoice.id,
    supplierName: invoice.extractedData.supplierName,
    invoiceNumber: invoice.extractedData.invoiceNumber,
    referenceCode: invoice.extractedData.referenceCode,
  }));
}

function normalizedDuplicateText(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function invoiceReference(data: ExtractedInvoiceData) {
  return (data.referenceCode || data.invoiceNumber || "").trim();
}

function exactBookingReference(invoice: UploadedInvoice) {
  return invoice.exactBookingId || invoice.bookingAttempts[0]?.exactBookingId;
}

function isBookedInExact(invoice: UploadedInvoice) {
  return (
    invoice.exactBookingStatus === "booked" ||
    invoice.status === "Booked" ||
    Boolean(exactBookingReference(invoice))
  );
}

function isProcessedInvoice(invoice: UploadedInvoice) {
  return Boolean(invoice.extractedData.invoiceNumber || invoice.extractedData.supplierName);
}

function duplicateCandidateFor(
  invoice: UploadedInvoice,
  matchScore: number,
  matchReasons: string[]
): DuplicateInvoiceCandidate {
  return {
    invoiceId: invoice.id,
    fileName: invoice.fileName,
    supplierName: invoice.extractedData.supplierName,
    invoiceNumber: invoice.extractedData.invoiceNumber,
    yourRef: invoiceReference(invoice.extractedData),
    invoiceDate: invoice.extractedData.invoiceDate,
    totalAmount: invoice.extractedData.grossAmount,
    status: invoice.status,
    exactBookingId: exactBookingReference(invoice),
    matchScore,
    matchReasons,
  };
}

function duplicateDetectionResult(input: {
  outcome: DuplicateDetectionOutcome;
  message: string;
  checksum?: string;
  candidates: DuplicateInvoiceCandidate[];
}): DuplicateDetectionResult {
  return {
    id: createId("dup"),
    checkedAt: now(),
    ...input,
  };
}

export function findDuplicateBeforeProcessing(input: {
  fileName: string;
  fileSize: number;
  checksum?: string;
  source: UploadedInvoice["source"];
}) {
  const checksumMatch = input.checksum
    ? getStore().invoices.find((invoice) => invoice.checksum === input.checksum)
    : undefined;
  const fallbackMatch = getStore().invoices.find(
    (invoice) =>
      invoice.fileName.trim().toLowerCase() === input.fileName.trim().toLowerCase() &&
      invoice.fileSize === input.fileSize &&
      (!input.checksum || !invoice.checksum || invoice.checksum === input.checksum)
  );
  const duplicate = checksumMatch ?? fallbackMatch ?? null;

  if (!duplicate) {
    return null;
  }

  const candidate = duplicateCandidateFor(
    duplicate,
    checksumMatch ? 1 : 0.96,
    checksumMatch
      ? ["File checksum matches an existing INTO invoice."]
      : ["Filename and file size match an existing INTO invoice."]
  );
  const booked = isBookedInExact(duplicate);
  const outcome: DuplicateDetectionOutcome = booked
    ? "already_booked"
    : "processed_unbooked";
  const message = booked
    ? "This invoice has already been booked in Exact Online."
    : "This invoice was already processed but has not been booked in Exact Online yet. Do you want INTO to re-read it?";
  const detection = duplicateDetectionResult({
    outcome,
    message,
    checksum: input.checksum,
    candidates: [candidate],
  });
  if (booked) {
    logDuplicateDecision({
      invoiceId: undefined,
      duplicateInvoiceId: duplicate.id,
      source: input.source,
      fileName: input.fileName,
      checksum: input.checksum,
      detectionOutcome: outcome,
      decision: "blocked_already_booked",
      message,
      exactBookingId: candidate.exactBookingId,
    });
  }

  return { duplicate, detection };
}

export function detectContentDuplicate(invoiceId: string) {
  const invoice = getInvoice(invoiceId);
  if (!invoice) {
    return null;
  }

  const data = invoice.extractedData;
  const supplier = normalizedDuplicateText(data.supplierName);
  const reference = normalizedDuplicateText(invoiceReference(data));
  const date = data.invoiceDate;
  const total = data.grossAmount;
  const candidates = getStore().invoices
    .filter((candidate) => candidate.id !== invoice.id && isProcessedInvoice(candidate))
    .map((candidate) => {
      const reasons: string[] = [];
      let score = 0;
      const candidateData = candidate.extractedData;
      if (supplier && supplier === normalizedDuplicateText(candidateData.supplierName)) {
        score += 0.25;
        reasons.push("Supplier matches.");
      }
      if (
        reference &&
        reference === normalizedDuplicateText(invoiceReference(candidateData))
      ) {
        score += 0.35;
        reasons.push("Invoice number / Your ref. matches.");
      }
      if (date && date === candidateData.invoiceDate) {
        score += 0.15;
        reasons.push("Invoice date matches.");
      }
      if (
        typeof total === "number" &&
        typeof candidateData.grossAmount === "number" &&
        Math.abs(total - candidateData.grossAmount) < 0.005
      ) {
        score += 0.2;
        reasons.push("Total amount matches.");
      }
      if (invoice.checksum && invoice.checksum === candidate.checksum) {
        score = 1;
        reasons.push("File checksum matches.");
      }

      return duplicateCandidateFor(candidate, score, reasons);
    })
    .filter((candidate) => candidate.matchScore >= 0.55)
    .sort((a, b) => b.matchScore - a.matchScore);

  if (!candidates.length) {
    invoice.duplicateDetection = duplicateDetectionResult({
      outcome: "none",
      message: "No duplicate invoice detected.",
      checksum: invoice.checksum,
      candidates: [],
    });
    return invoice.duplicateDetection;
  }

  const detection = duplicateDetectionResult({
    outcome: "possible_duplicate",
    message: "Possible duplicate invoice detected. Review matching invoice candidates before booking.",
    checksum: invoice.checksum,
    candidates,
  });
  markInvoicePossibleDuplicate(invoice.id, detection);
  return detection;
}

export function logDuplicateDecision(input: Omit<DuplicateDecisionLog, "id" | "createdAt">) {
  const log: DuplicateDecisionLog = {
    id: createId("dup_log"),
    createdAt: now(),
    ...input,
  };
  getStore().duplicateLogs.unshift(log);
  persistStoreSoon();
  return log;
}

function sanitizedAuditMetadata(metadata: Record<string, unknown> | undefined) {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (/raw|document|evidence|line|text|payload|content|token|secret|password|file.?name|error.?message|reason/i.test(key)) {
      continue;
    }
    if (value === null || typeof value === "boolean" || typeof value === "number") {
      result[key] = value;
    } else if (typeof value === "string") {
      result[key] = value.slice(0, 256);
    }
  }
  return result;
}

export function addAuditEvent(
  input: Omit<AuditEvent, "id" | "createdAt" | "userId" | "userName"> &
    Partial<Pick<AuditEvent, "userId" | "userName" | "createdAt">>
) {
  const principal = currentRequestPrincipal();
  const field = input.field && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(input.field)
    ? input.field
    : undefined;
  const metadata = sanitizedAuditMetadata(input.metadata);
  if (input.oldValue !== undefined || input.newValue !== undefined) {
    metadata.changeClassification = field ? "field_changed" : "record_changed";
  }
  if (principal) {
    metadata.requestId = principal.requestId;
    metadata.sessionCorrelationId = principal.sessionCorrelationId;
  }
  const user = input.userId
    ? getStore().users.find((item) => item.id === input.userId) ?? mutationUser()
    : mutationUser();
  const event: AuditEvent = {
    id: createId("audit"),
    userId: input.userId ?? user.id,
    userName: input.userName ?? userDisplayName(user),
    createdAt: input.createdAt ?? now(),
    invoiceId: input.invoiceId,
    type: input.type,
    message: field
      ? `Field ${field} changed.`
      : `Audit event: ${input.type.replace(/_/g, " ")}.`,
    field,
    metadata: Object.keys(metadata).length ? metadata : undefined,
  };

  getStore().auditEvents.unshift(event);
  persistStoreSoon();
  return event;
}

export function listAuditEvents(invoiceId?: string) {
  const events = invoiceId
    ? getStore().auditEvents.filter((event) => event.invoiceId === invoiceId)
    : getStore().auditEvents;

  return [...events].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

export function auditInvoiceFieldChanges(
  invoiceId: string,
  previous: ExtractedInvoiceData,
  next: ExtractedInvoiceData
) {
  const fields = Object.keys(next) as Array<keyof ExtractedInvoiceData>;
  const changedFields = fields.filter((field) => {
    if (field === "lineItems") {
      return JSON.stringify(previous.lineItems) !== JSON.stringify(next.lineItems);
    }

    return previous[field] !== next[field];
  });

  for (const field of changedFields) {
    addAuditEvent({
      invoiceId,
      type: "invoice_field_edited",
      field,
      oldValue: previous[field],
      newValue: next[field],
      message: `${mutationUser().name} changed ${field}.`,
    });
  }

  return changedFields.length;
}

function uniqueValidationErrors(errors: ValidationError[]) {
  const seen = new Set<string>();

  return errors.filter((item) => {
    const key = `${item.field}:${item.message}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function canonicalJson(value: unknown) {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return item;
    }
    return Object.fromEntries(
      Object.entries(item as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
    );
  });
}

function learnRequestFingerprint(input: {
  correctedData: ExtractedInvoiceData;
  bookingLines: PurchaseJournalLine[];
  generation: number;
  requestKey?: string;
}) {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

function recomputedLearnInputs(invoice: UploadedInvoice) {
  if (!invoice.purchaseJournal) {
    return null;
  }
  return canonicalJson({
    supplierAccountId:
      invoice.purchaseJournal.supplierResolution.selectedAccountId ?? null,
    bookingLines: invoice.purchaseJournal.lines.map((line) => ({
      glAccount: line.glAccount,
      finalSelectedAccount: line.finalSelectedAccount,
      description: line.description,
      from: line.from,
      to: line.to,
      benefitStartDate: line.benefitStartDate,
      benefitEndDate: line.benefitEndDate,
      costCentre: line.costCentre,
      costUnit: line.costUnit,
      vatCode: line.vatCode,
      percentage: line.percentage,
      amount: line.amount,
      vatAmount: line.vatAmount,
      country: line.country,
      intercompany: line.intercompany,
      roundingAdjustment: line.roundingAdjustment,
    })),
  });
}

function recomputeInvoiceInStore(store: IntoStore, invoiceId: string) {
  const invoice = store.invoices.find((item) => item.id === invoiceId);
  if (!invoice) {
    return null;
  }

  const previousLearnInputs = recomputedLearnInputs(invoice);
  const baseValidationErrors = validateInvoiceData(
    invoice.id,
    invoice.extractedData,
    store.invoices.map((candidate) => ({
      id: candidate.id,
      supplierName: candidate.extractedData.supplierName,
      invoiceNumber: candidate.extractedData.invoiceNumber,
      referenceCode: candidate.extractedData.referenceCode,
    }))
  );
  const purchaseJournal = generatePurchaseJournalBooking(
    invoice,
    store.invoices,
    store.learning,
    exactMasterDataForUser(store, COMPANY_CONNECTION_USER_ID)
  );
  const purchaseErrors = purchaseJournalValidationErrors(
    purchaseJournal,
    invoice.extractedData
  );

  invoice.purchaseJournal = purchaseJournal;
  invoice.validationErrors = uniqueValidationErrors([
    ...baseValidationErrors,
    ...purchaseErrors,
  ]);

  if (invoice.status !== "Booked" && invoice.status !== "Possible Duplicate") {
    if (invoice.status !== "Learned") {
      invoice.status = statusFromPurchaseJournal(
        baseValidationErrors,
        purchaseJournal,
        invoice.extractedData
      );
    }
  }

  invoice.lastError = invoice.validationErrors.length
    ? invoice.validationErrors.map((item) => item.message).join(" ")
    : undefined;
  if (
    previousLearnInputs !== null &&
    previousLearnInputs !== recomputedLearnInputs(invoice)
  ) {
    invoice.revision = (invoice.revision ?? 1) + 1;
  }
  invoice.updatedAt = now();
  return invoice;
}

export function recomputeInvoiceState(invoiceId: string) {
  return recomputeInvoiceInStore(getStore(), invoiceId);
}

export function createUploadedInvoice(input: {
  source?: UploadedInvoice["source"];
  fileName: string;
  fileType: string;
  fileSize: number;
  checksum?: string;
  storageKey: string;
  userId?: string;
}) {
  const user =
    input.userId
      ? getStore().users.find((item) => item.id === input.userId) ?? mutationUser()
      : mutationUser();
  const timestamp = now();
  const invoice: UploadedInvoice = {
    id: createId("invoice"),
    userId: user.id,
    uploadedByUserId: user.id,
    uploadedByName: userDisplayName(user),
    source: input.source ?? "manual_upload",
    fileName: input.fileName,
    fileType: input.fileType,
    fileSize: input.fileSize,
    checksum: input.checksum,
    storageKey: input.storageKey,
    localFileStatus: input.storageKey ? "available" : "missing",
    status: "Uploaded",
    processingPurpose: "booking",
    learningState: "not_saved",
    revision: 1,
    exactBookingStatus: "not_booked",
    extractedData: emptyExtractedInvoiceData(),
    extractionHistory: [],
    purchaseJournal: null,
    validationErrors: [],
    bookingAttempts: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  const store = getStore();
  store.invoices.unshift(invoice);
  addAuditEvent({
    invoiceId: invoice.id,
    userId: user.id,
    userName: userDisplayName(user),
    type: "invoice_uploaded",
    message: `${userDisplayName(user)} uploaded ${input.fileName}.`,
    metadata: {
      source: input.source,
      fileName: input.fileName,
      checksum: input.checksum,
      fileSize: input.fileSize,
    },
  });
  return invoice;
}

export function findDuplicateUploadedFile(input: {
  fileName: string;
  fileSize: number;
  checksum?: string;
}) {
  const normalizedName = input.fileName.trim().toLowerCase();

  return (
    getStore().invoices.find((invoice) => {
      const sameName = invoice.fileName.trim().toLowerCase() === normalizedName;
      const sameSize = invoice.fileSize === input.fileSize;
      const sameChecksum =
        input.checksum && invoice.checksum
          ? invoice.checksum === input.checksum
          : true;

      return sameName && sameSize && sameChecksum;
    }) ?? null
  );
}

export function updateInvoiceExtraction(
  invoiceId: string,
  extractedData: ExtractedInvoiceData,
  options: { applyLearning?: boolean } = {}
) {
  const invoice = getInvoice(invoiceId);
  if (!invoice) {
    return null;
  }
  if (invoice.processingPurpose === "learning_only" || invoice.status === "Learned") {
    throw new Error("Learned invoices cannot be reprocessed.");
  }

  if (!invoice.extractionHistory.some((version) => version.reason === "initial")) {
    invoice.extractionHistory.push({
      id: createId("extraction_version"),
      version: 1,
      reason: "initial",
      extractedData: structuredClone(extractedData),
      createdAt: now(),
    });
  }

  const learned = options.applyLearning === false
    ? { data: extractedData, appliedFields: [] }
    : applyLearnedExtractedData(invoice, extractedData, getStore().learning);
  invoice.extractedData = learned.data;
  invoice.learnedFieldsApplied = learned.appliedFields;
  invoice.intelligenceApprovedAt = undefined;
  invoice.purchaseJournal = null;
  invoice.revision = (invoice.revision ?? 1) + 1;
  invoice.updatedAt = now();
  return invoice;
}

export function saveInvoiceReview(
  invoiceId: string,
  nextData: ExtractedInvoiceData,
  nextBookingLines?: PurchaseJournalLine[],
  options: { incrementRevision?: boolean } = {}
) {
  const invoice = getInvoice(invoiceId);
  if (!invoice) {
    return null;
  }
  if (invoice.processingPurpose === "learning_only" || invoice.status === "Learned") {
    throw new Error("Learned invoices cannot be edited.");
  }

  const user = mutationUser();
  const captured = captureUserCorrections({
    invoice,
    nextExtractedData: nextData,
    nextBookingLines:
      nextBookingLines ??
      invoice.bookingLineOverrides ??
      invoice.purchaseJournal?.lines ??
      [],
    learning: getStore().learning,
    user,
  });

  auditInvoiceFieldChanges(invoiceId, invoice.extractedData, nextData);
  for (const correction of captured) {
    if (
      correction.metadata?.lineIndex === undefined &&
      correction.field !== "bookingLineSplit"
    ) {
      continue;
    }

    addAuditEvent({
      invoiceId,
      type: "invoice_field_edited",
      field:
        correction.field === "bookingLineSplit"
          ? "bookingLines"
          : `bookingLine.${correction.field}`,
      oldValue: correction.originalValue,
      newValue: correction.correctedValue,
      message: `${user.name} corrected ${correction.field}; the decision is pending until Learn, approval, or booking.`,
      metadata: {
        learnedCorrectionId: correction.id,
        lineIndex: correction.metadata?.lineIndex,
      },
    });
  }

  invoice.extractedData = nextData;
  invoice.learnedFieldsApplied = [];
  if (nextBookingLines) {
    invoice.bookingLineOverrides = nextBookingLines.map((line) => ({ ...line }));
  }
  invoice.intelligenceApprovedAt = undefined;
  invoice.purchaseJournal = null;
  if (options.incrementRevision !== false) {
    invoice.revision = (invoice.revision ?? 1) + 1;
  }
  invoice.updatedAt = now();
  persistStoreSoon();
  return recomputeInvoiceState(invoiceId);
}

function trustedContentHash(invoice: UploadedInvoice) {
  return (
    invoice.checksum ||
    createHash("sha256")
      .update(
        invoice.extractedData.rawText ||
          `${invoice.fileName}:${invoice.fileSize}:${invoice.storageKey}`
      )
      .digest("hex")
  );
}

function assertInvoiceCanBeLearned(
  invoice: UploadedInvoice,
  correctedData: ExtractedInvoiceData,
  bookingLines: PurchaseJournalLine[]
) {
  const hasAnalysis =
    Boolean(
      correctedData.documentTextMode &&
      correctedData.documentTextMode !== "unavailable" &&
      (correctedData.rawText?.trim() ||
        Object.keys(correctedData.extractionEvidence ?? {}).length ||
        correctedData.documentAnalysis?.pages.length ||
        correctedData.documentAnalysis?.fieldCandidates.length)
    );
  if (!hasAnalysis) {
    throw new Error("Complete document analysis before saving learning.");
  }
  const hasTrainableField = Boolean(
    correctedData.invoiceNumber ||
      correctedData.referenceCode ||
      correctedData.invoiceDate ||
      correctedData.dueDate ||
      correctedData.netAmount !== null ||
      correctedData.vatAmount !== null ||
      correctedData.grossAmount !== null ||
      correctedData.lineItems.length ||
      bookingLines.length
  );
  if (!hasTrainableField) {
    throw new Error("Add at least one trainable invoice field before saving learning.");
  }
}

export function learnInvoice(
  invoiceId: string,
  correctedData: ExtractedInvoiceData,
  bookingLines: PurchaseJournalLine[],
  expectedRevision: number,
  requestKey?: string
) {
  const store = getStore();
  const invoice = store.invoices.find((item) => item.id === invoiceId);
  if (!invoice) {
    return null;
  }
  const activeProfile = invoice.learningMetadata
    ? store.learning.supplierProfiles.find(
        (item) =>
          item.supplierAccountId === invoice.learningMetadata!.supplierAccountId
      )
    : undefined;
  const previousExample = invoice.learningMetadata
    ? store.learning.supplierExamples.find(
        (item) => item.id === invoice.learningMetadata!.exampleId
      )
    : undefined;
  const activeGenerationSaved =
    invoice.learningState === "saved" &&
    invoice.learningMetadata?.generation === activeProfile?.generation;
  const retryFingerprint = invoice.learningMetadata
    ? learnRequestFingerprint({
        correctedData,
        bookingLines,
        generation: invoice.learningMetadata.generation,
        requestKey,
      })
    : "";
  const exactRetry =
    activeGenerationSaved &&
    expectedRevision === (invoice.revision ?? 1) - 1 &&
    Boolean(invoice.learningMetadata?.requestFingerprint) &&
    retryFingerprint === invoice.learningMetadata?.requestFingerprint;
  if (invoice.revision !== expectedRevision && !exactRetry) {
    throw new InvoiceRevisionConflictError(
      "Invoice revision changed. Refresh and try again."
    );
  }
  if (invoice.status === "Booked" || invoice.exactBookingId) {
    throw new Error("Booked invoices cannot be used as learning-only drafts.");
  }
  if (
    activeGenerationSaved
  ) {
    return invoice;
  }

  assertInvoiceCanBeLearned(invoice, correctedData, bookingLines);

  const isGenerationRelearn = invoice.status === "Learned";
  const initialExtractedData =
    invoice.extractionHistory.find((version) => version.reason === "initial")
      ?.extractedData ?? invoice.extractedData;
  const originalDraft: UploadedInvoice = {
    ...structuredClone(invoice),
    extractedData: structuredClone(initialExtractedData),
    bookingLineOverrides: undefined,
    purchaseJournal: null,
    intelligenceApprovedAt: undefined,
  };
  const originalBooking = generatePurchaseJournalBooking(
    originalDraft,
    store.invoices.map((item) =>
      item.id === invoiceId ? originalDraft : item
    ),
    createInitialLearningStore(),
    exactMasterDataForUser(store, COMPANY_CONNECTION_USER_ID)
  );
  const originalExtractedData = structuredClone(
    previousExample?.originalExtractedData ?? initialExtractedData
  );
  const originalBookingLines = structuredClone(
    previousExample?.originalBookingLines ?? originalBooking.lines
  );
  const originalSupplierAccountId =
    previousExample?.originalSupplierAccountId ??
    originalBooking.supplierResolution.selectedAccountId;
  const finalExtractedData = structuredClone(
    isGenerationRelearn && previousExample?.finalExtractedData
      ? previousExample.finalExtractedData
      : correctedData
  );
  const finalBookingLines = structuredClone(
    isGenerationRelearn && previousExample?.bookingLines
      ? previousExample.bookingLines
      : bookingLines
  );
  const draft: UploadedInvoice = {
    ...structuredClone(invoice),
    extractedData: finalExtractedData,
    bookingLineOverrides: finalBookingLines,
    purchaseJournal: null,
  };
  const draftInvoices = store.invoices.map((item) =>
    item.id === invoiceId ? draft : item
  );
  const draftBooking = generatePurchaseJournalBooking(
    draft,
    draftInvoices,
    store.learning,
    exactMasterDataForUser(store, COMPANY_CONNECTION_USER_ID)
  );
  const supplierAccountId = draftBooking.supplierResolution.selectedAccountId;
  if (!supplierAccountId) {
    throw new Error("Select one Exact supplier before saving learning.");
  }

  const saved = isGenerationRelearn
    ? invoice
    : saveInvoiceReview(invoiceId, finalExtractedData, finalBookingLines, {
        incrementRevision: false,
      });
  if (!saved) {
    return null;
  }
  const learnedAt = now();
  promoteInvoiceCorrections(store.learning, invoiceId, "learn", learnedAt);
  const exampleId = createId("supplier_learning_example");
  const contentHash = trustedContentHash(saved);
  const nextLearning = learnSupplierInvoice(store.learning, {
    id: exampleId,
    supplierAccountId,
    invoiceId,
    contentHash,
    formatFingerprint: formatFingerprint(finalExtractedData.rawText ?? ""),
    learnedAt,
    learnedByUserId: mutationUser().id,
    originalExtractedData,
    finalExtractedData,
    originalSupplierAccountId,
    originalBookingLines,
    bookingLines: finalBookingLines,
    source: "explicit_learn",
    trustState: "trusted",
    trigger: "learn",
    processingPurpose: "learning_only",
    validationResult: {
      valid: !saved.validationErrors.some((error) => error.severity === "error"),
      issues: saved.validationErrors.map((error) => ({
        field: error.field,
        severity: error.severity,
      })),
    },
    active: true,
  });
  Object.assign(store.learning, nextLearning);
  rememberDecisionsFromInvoice(saved, store.learning);
  const profile = store.learning.supplierProfiles.find(
    (item) => item.supplierAccountId === supplierAccountId
  );
  const example = store.learning.supplierExamples.find(
    (item) =>
      item.supplierAccountId === supplierAccountId &&
      item.generation === profile?.generation &&
      item.contentHash === contentHash
  );
  if (!profile || !example) {
    throw new Error("Supplier learning could not be saved.");
  }

  saved.processingPurpose = "learning_only";
  saved.learningState = "saved";
  saved.status = "Learned";
  saved.exactBookingId = undefined;
  saved.exactBookingStatus = "not_booked";
  saved.intelligenceApprovedAt = undefined;
  saved.revision = (saved.revision ?? 1) + 1;
  saved.learningMetadata = {
    exampleId: example.id ?? exampleId,
    supplierAccountId,
    generation: profile.generation,
    contentHash,
    requestFingerprint: learnRequestFingerprint({
      correctedData: finalExtractedData,
      bookingLines: finalBookingLines,
      generation: profile.generation,
      requestKey,
    }),
    learnedAt,
    learnedByUserId: mutationUser().id,
  };
  recomputeInvoiceInStore(store, invoiceId);
  addAuditEvent({
    invoiceId,
    type: "invoice_learned",
    message: "Learning saved for this supplier.",
    metadata: {
      exampleId: saved.learningMetadata.exampleId,
      supplierAccountId,
      generation: profile.generation,
      invoiceRevision: saved.revision,
    },
  });
  persistStoreSoon();
  return saved;
}

export class InvoiceRevisionConflictError extends Error {}
export class SupplierLearningNotFoundError extends Error {}
export class SupplierLearningGenerationConflictError extends Error {}

function supplierReliabilityForProfile(
  store: IntoStore,
  profile: BookingLearningStore["supplierProfiles"][number]
) {
  const evidence = supplierReliabilityEvidenceFromLearningStore(
    store.learning,
    profile
  );
  const confidence = supplierReliability({
    ...evidence,
    drift: profile.formatDrift,
  });
  return {
    ...confidence,
    exampleCount: confidence.distinctExampleCount,
  };
}

export function listSupplierLearningSummaries(): SupplierLearningSummary[] {
  const store = getStore();
  const suppliers = exactMasterDataForUser(store, COMPANY_CONNECTION_USER_ID)?.suppliers ?? [];
  const profiles = new Map(
    store.learning.supplierProfiles.map((profile) => [
      profile.supplierAccountId,
      profile,
    ])
  );
  const supplierAccountIds = [
    ...suppliers
      .filter((supplier) => supplier.isSupplier !== false)
      .map((supplier) => supplier.id),
    ...store.learning.supplierProfiles
      .map((profile) => profile.supplierAccountId)
      .filter((accountId) => !suppliers.some((supplier) => supplier.id === accountId)),
  ];
  return supplierAccountIds.map((supplierAccountId) => {
    const supplier = suppliers.find((item) => item.id === supplierAccountId);
    const profile = profiles.get(supplierAccountId) ?? {
      supplierAccountId,
      generation: 1,
      exampleCount: 0,
      formatDrift: "none" as const,
    };
    return {
      ...profile,
      confidence: supplierReliabilityForProfile(store, profile),
      supplierCode: supplier?.code ?? "",
      supplierName: supplier?.name ?? supplierAccountId,
    };
  });
}

function exactSupplierIdentityKeys(accountId: string) {
  const supplier = exactMasterDataForUser(
    getStore(),
    COMPANY_CONNECTION_USER_ID
  )?.suppliers.find((item) => item.id === accountId);
  if (!supplier) {
    return [];
  }
  return canonicalSupplierIdentityKeys({
    supplierVatNumber: supplier.vatNumber,
    iban: supplier.iban,
    supplierChamberOfCommerceNumber: supplier.chamberOfCommerceNumber,
    supplierName: supplier.name,
  });
}

export function resetLearningForSupplier(
  accountId: string,
  expectedGeneration: number
) {
  const store = getStore();
  const profile = store.learning.supplierProfiles.find(
    (item) => item.supplierAccountId === accountId
  );
  if (!profile) {
    throw new SupplierLearningNotFoundError("Supplier learning profile not found.");
  }
  if (profile.generation !== expectedGeneration) {
    throw new SupplierLearningGenerationConflictError(
      "Supplier learning generation changed. Refresh and try again."
    );
  }

  const supplierIdentities = new Set(
    [
      ...exactSupplierIdentityKeys(accountId),
      ...store.learning.supplierSelections
        .filter((item) => item.accountId === accountId)
        .map((item) => item.supplierIdentity),
    ].map(canonicalSupplierIdentityKey)
  );
  const resetAt = now();
  Object.assign(
    store.learning,
    resetSupplierLearning(store.learning, accountId, resetAt)
  );
  store.learning.supplierSelections = store.learning.supplierSelections.filter(
    (item) => item.accountId !== accountId
  );
  store.learning.glAccountSelections = store.learning.glAccountSelections.filter(
    (item) => item.supplierAccountId !== accountId
  );
  store.learning.vatCodeSelections = store.learning.vatCodeSelections.filter(
    (item) => item.supplierAccountId !== accountId
  );
  store.learning.costCentreSelections = store.learning.costCentreSelections.filter(
    (item) => item.supplierAccountId !== accountId
  );
  store.learning.costUnitSelections = store.learning.costUnitSelections.filter(
    (item) => item.supplierAccountId !== accountId
  );
  store.learning.corrections = store.learning.corrections.filter(
    (item) =>
      item.supplierAccountId
      ? item.supplierAccountId !== accountId
      : !supplierIdentities.has(
          canonicalSupplierIdentityKey(item.supplierIdentity)
        )
  );
  addAuditEvent({
    type: "supplier_learning_reset",
    message: "Supplier learning was reset.",
    metadata: {
      supplierAccountId: accountId,
      previousGeneration: expectedGeneration,
      generation: expectedGeneration + 1,
    },
  });
  persistStoreSoon();
  return store.learning.supplierProfiles.find(
    (item) => item.supplierAccountId === accountId
  )!;
}

export function applyValidation(
  invoiceId: string,
  validationErrors: ValidationError[]
) {
  const invoice = getInvoice(invoiceId);
  if (!invoice) {
    return null;
  }

  invoice.validationErrors = validationErrors;
  return recomputeInvoiceState(invoiceId);
}

export function markInvoiceReading(invoiceId: string) {
  const invoice = getInvoice(invoiceId);
  if (invoice) {
    invoice.status = "Reading";
    invoice.updatedAt = now();
  }
  return invoice;
}

export function markInvoiceFileError(invoiceId: string, message: string) {
  const invoice = getInvoice(invoiceId);
  if (!invoice) {
    return null;
  }

  invoice.status = "Validation Failed";
  invoice.purchaseJournal = null;
  invoice.validationErrors = [
    {
      id: createId("val"),
      field: "file",
      message,
      severity: "error",
    },
  ];
  invoice.lastError = message;
  invoice.updatedAt = now();
  return invoice;
}

export function markInvoicePossibleDuplicate(
  invoiceId: string,
  detection: DuplicateDetectionResult
) {
  const invoice = getInvoice(invoiceId);
  if (!invoice) {
    return null;
  }

  invoice.status = "Possible Duplicate";
  invoice.duplicateDetection = detection;
  invoice.validationErrors = uniqueValidationErrors([
    ...invoice.validationErrors,
    {
      id: createId("val"),
      field: "duplicate",
      message: detection.message,
      severity: "warning",
    },
  ]);
  invoice.lastError = detection.message;
  invoice.updatedAt = now();
  return invoice;
}

function pushExtractionHistory(
  invoice: UploadedInvoice,
  reason: "initial" | "manual_edit" | "duplicate_re_read",
  decision?: DuplicateResolutionDecision
) {
  if (!isProcessedInvoice(invoice)) {
    return;
  }

  invoice.extractionHistory.unshift({
    id: createId("extraction_version"),
    version: invoice.extractionHistory.length + 1,
    reason,
    decision,
    extractedData: { ...invoice.extractedData },
    createdAt: now(),
  });
}

export function replaceInvoiceExtractionFromReread(
  invoiceId: string,
  extractedData: ExtractedInvoiceData,
  decision: DuplicateResolutionDecision = "re_read"
) {
  const invoice = getInvoice(invoiceId);
  if (!invoice) {
    return null;
  }
  if (invoice.processingPurpose === "learning_only" || invoice.status === "Learned") {
    throw new Error("Learned invoices cannot be re-read.");
  }

  pushExtractionHistory(invoice, "duplicate_re_read", decision);
  const learned = applyLearnedExtractedData(invoice, extractedData, getStore().learning);
  invoice.extractedData = learned.data;
  invoice.learnedFieldsApplied = learned.appliedFields;
  invoice.bookingLineOverrides = undefined;
  invoice.duplicateResolutionDecision = decision;
  invoice.duplicateDetection = undefined;
  invoice.intelligenceApprovedAt = undefined;
  invoice.purchaseJournal = null;
  invoice.lastError = undefined;
  invoice.revision = (invoice.revision ?? 1) + 1;
  invoice.updatedAt = now();
  addAuditEvent({
    invoiceId,
    type: "invoice_reread",
    message: "Invoice was re-read and previous extraction was kept in history.",
    metadata: {
      decision,
      extractionHistoryCount: invoice.extractionHistory.length,
    },
  });
  return recomputeInvoiceState(invoiceId);
}

export async function resolveDuplicateDecision(input: {
  invoiceId?: string;
  duplicateInvoiceId?: string;
  source: UploadedInvoice["source"];
  fileName: string;
  checksum?: string;
  detectionOutcome: DuplicateDetectionOutcome;
  decision: DuplicateResolutionDecision;
  message: string;
  exactBookingId?: string;
}) {
  const log = logDuplicateDecision(input);
  const targetId = input.invoiceId ?? input.duplicateInvoiceId;
  const invoice = targetId ? getInvoice(targetId) : null;

  addAuditEvent({
    invoiceId: targetId,
    type: "duplicate_decision",
    message: `Duplicate decision: ${input.decision.replace(/_/g, " ")} for ${input.fileName}.`,
    metadata: {
      detectionOutcome: input.detectionOutcome,
      decision: input.decision,
      duplicateInvoiceId: input.duplicateInvoiceId,
      exactBookingId: input.exactBookingId,
    },
  });

  if (invoice) {
    if (input.decision === "cancel_upload" && invoice.status === "Possible Duplicate") {
      await deleteStoredInvoiceFile(invoice.storageKey);
      invoice.localFileStatus = "deleted_by_cleanup";
      const store = getStore();
      store.invoices = store.invoices.filter((item) => item.id !== invoice.id);
      return { log, invoice: null };
    }

    invoice.duplicateResolutionDecision = input.decision;
    if (input.decision === "continue_anyway" && invoice.status === "Possible Duplicate") {
      invoice.duplicateDetection = undefined;
      invoice.validationErrors = invoice.validationErrors.filter(
        (error) => error.field !== "duplicate"
      );
      invoice.lastError = undefined;
      invoice.status = "Uploaded";
      recomputeInvoiceInStore(getStore(), invoice.id);
    }
    invoice.updatedAt = now();
  }

  return { log, invoice };
}

export function addBookingAttempt(
  invoiceId: string,
  attempt: Omit<BookingAttempt, "id" | "invoiceId" | "createdAt">
) {
  const invoice = getInvoice(invoiceId);
  if (!invoice) {
    return null;
  }

  const bookingAttempt: BookingAttempt = {
    id: createId("booking_attempt"),
    invoiceId,
    createdAt: now(),
    ...attempt,
  };
  invoice.bookingAttempts.unshift(bookingAttempt);
  invoice.updatedAt = now();
  return bookingAttempt;
}

export function markInvoiceBooked(invoiceId: string, exactBookingId: string) {
  const invoice = getInvoice(invoiceId);
  if (!invoice) {
    return null;
  }
  assertInvoiceBookingAllowed(invoice);

  invoice.status = "Booked";
  invoice.exactBookingId = exactBookingId;
  invoice.exactBookingStatus = "booked";
  invoice.lastError = undefined;
  promoteInvoiceCorrections(getStore().learning, invoiceId, "booking", now());
  rememberDecisionsFromInvoice(invoice, getStore().learning);
  invoice.updatedAt = now();
  addAuditEvent({
    invoiceId,
    type: "invoice_booked",
    message: `Invoice booked to Exact Online as ${exactBookingId}.`,
    metadata: {
      exactBookingId,
    },
  });
  return invoice;
}

export async function deleteInvoiceFileAfterBooking(invoiceId: string) {
  const invoice = getInvoice(invoiceId);
  if (!invoice) {
    return null;
  }

  if (
    invoice.status !== "Booked" ||
    !invoice.exactBookingId ||
    !invoice.storageKey ||
    invoice.localFileStatus !== "available"
  ) {
    return invoice;
  }

  const deleted = await deleteStoredInvoiceFile(invoice.storageKey);
  invoice.localFileStatus = deleted ? "deleted_after_booking" : "missing";
  invoice.updatedAt = now();

  addAuditEvent({
    invoiceId,
    type: "invoice_file_deleted",
    message: deleted
      ? "Temporary invoice file was deleted after successful Exact booking."
      : "Temporary invoice file was already missing after successful Exact booking.",
    metadata: {
      storageKey: invoice.storageKey,
      localFileStatus: invoice.localFileStatus,
      exactBookingId: invoice.exactBookingId,
    },
  });

  return invoice;
}

export async function cleanupTemporaryInvoiceFiles(referenceDate = new Date()) {
  const retentionMs = temporaryInvoiceRetentionDays() * 24 * 60 * 60 * 1000;
  const cutoff = referenceDate.getTime() - retentionMs;
  const deletedInvoiceIds: string[] = [];
  const learningArtifactsPruned =
    await pruneExpiredLearningArtifacts(referenceDate);

  for (const invoice of getStore().invoices) {
    if (!invoice.storageKey || invoice.localFileStatus !== "available") {
      continue;
    }

    const createdAt = new Date(invoice.createdAt).getTime();
    const bookedAndAttached = invoice.status === "Booked" && Boolean(invoice.exactBookingId);
    const oldInactiveUpload =
      invoice.status === "Uploaded" &&
      Number.isFinite(createdAt) &&
      createdAt < cutoff;

    if (!bookedAndAttached && !oldInactiveUpload) {
      continue;
    }

    const deleted = await deleteStoredInvoiceFile(invoice.storageKey);
    invoice.localFileStatus = deleted
      ? bookedAndAttached
        ? "deleted_after_booking"
        : "deleted_by_cleanup"
      : "missing";
    invoice.updatedAt = now();
    deletedInvoiceIds.push(invoice.id);

    addAuditEvent({
      invoiceId: invoice.id,
      type: bookedAndAttached ? "invoice_file_deleted" : "invoice_file_cleanup",
      message: bookedAndAttached
        ? "Temporary invoice file was deleted after successful Exact booking."
        : "Old temporary invoice file was deleted by cleanup.",
      metadata: {
        storageKey: invoice.storageKey,
        localFileStatus: invoice.localFileStatus,
        retentionDays: temporaryInvoiceRetentionDays(),
      },
    });
  }

  return {
    checked: getStore().invoices.length,
    deleted: deletedInvoiceIds.length,
    invoiceIds: deletedInvoiceIds,
    learningArtifactsPruned,
  };
}

export function markInvoiceBookingFailed(invoiceId: string, message: string) {
  const invoice = getInvoice(invoiceId);
  if (!invoice) {
    return null;
  }
  assertInvoiceBookingAllowed(invoice);

  invoice.status = "Booking Failed";
  invoice.exactBookingStatus = "failed";
  invoice.lastError = message;
  invoice.updatedAt = now();
  addAuditEvent({
    invoiceId,
    type: "invoice_booking_failed",
    message: `Booking failed: ${message}`,
    metadata: {
      errorMessage: message,
    },
  });
  return invoice;
}

export function markInvoiceNeedsReview(
  invoiceId: string,
  reason = "Marked as needs review by user."
) {
  const invoice = getInvoice(invoiceId);
  if (!invoice || invoice.status === "Booked") {
    return null;
  }
  if (invoice.processingPurpose === "learning_only" || invoice.status === "Learned") {
    throw new Error("Learned invoices cannot be returned to review.");
  }

  const previousStatus = invoice.status;
  invoice.status = "Validation Failed";
  invoice.lastError = reason;
  invoice.validationErrors = uniqueValidationErrors([
    ...invoice.validationErrors,
    {
      id: createId("val"),
      field: "purchaseJournal",
      message: reason,
      severity: "warning",
    },
  ]);
  invoice.updatedAt = now();
  addAuditEvent({
    invoiceId,
    type: "invoice_field_edited",
    field: "status",
    oldValue: previousStatus,
    newValue: "Validation Failed",
    message: reason,
    metadata: {
      action: "needs_review",
    },
  });
  return invoice;
}

export function approveInvoiceIntelligence(invoiceId: string) {
  const invoice = getInvoice(invoiceId);
  if (!invoice) {
    return null;
  }
  if (invoice.processingPurpose === "learning_only" || invoice.status === "Learned") {
    throw new Error("Learned invoices cannot be approved for booking.");
  }

  invoice.intelligenceApprovedAt = now();
  const updatedInvoice = recomputeInvoiceState(invoiceId);

  if (updatedInvoice) {
    promoteInvoiceCorrections(
      getStore().learning,
      invoiceId,
      "approval",
      invoice.intelligenceApprovedAt
    );
    rememberDecisionsFromInvoice(updatedInvoice, getStore().learning);
    addAuditEvent({
      invoiceId,
      type: "invoice_approved",
      message: "Purchase Journal intelligence was approved.",
      metadata: {
        status: updatedInvoice.status,
        confidence: updatedInvoice.purchaseJournal?.confidenceScores.overall,
      },
    });
  }

  return updatedInvoice;
}

export function selectInvoiceSupplier(invoiceId: string, accountId: string) {
  const invoice = getInvoice(invoiceId);
  const store = getStore();
  const account =
    exactMasterDataForUser(store, COMPANY_CONNECTION_USER_ID)?.suppliers.find(
      (supplier) => supplier.id === accountId
    ) ??
    null;

  if (!invoice || !account) {
    return null;
  }
  if (invoice.processingPurpose === "learning_only" || invoice.status === "Learned") {
    throw new Error("Learned invoices cannot change supplier.");
  }

  const shadowEvaluation = structuredClone(
    invoice.purchaseJournal?.supplierResolution.shadowEvaluation
  );

  const supplierIdentity = supplierIdentityForInvoice(invoice);
  const supplierFormatFingerprint = formatFingerprint(
    invoice.extractedData.rawText ?? ""
  );
  const user = mutationUser();
  const decidedAt = now();
  captureSupplierAccountCorrection({
    invoice,
    learning: store.learning,
    accountId: account.id,
    accountName: account.name,
    user,
    correctedAt: decidedAt,
  });
  store.learning.supplierSelections = store.learning.supplierSelections.filter(
    (decision) =>
      !(
        decision.supplierIdentity === supplierIdentity &&
        (!decision.formatFingerprint ||
          decision.formatFingerprint === supplierFormatFingerprint)
      )
  );
  store.learning.supplierSelections.unshift({
    supplierIdentity,
    accountId: account.id,
    decidedAt,
    invoiceId,
    formatFingerprint: supplierFormatFingerprint || undefined,
    trustState: "trusted",
  });

  const updatedInvoice = recomputeInvoiceState(invoiceId);
  addAuditEvent({
    invoiceId,
    type: "invoice_field_edited",
    field: "supplier",
    message: `Supplier account selected: ${account.code} - ${account.name}.`,
    newValue: account.id,
    metadata: {
      accountCode: account.code,
      accountName: account.name,
      ...(shadowEvaluation ? { shadowEvaluation } : {}),
    },
  });

  return updatedInvoice;
}

export function setExactConnection(connection: ExactConnection) {
  const store = getStore();
  store.exactConnections = [
    connection,
    ...store.exactConnections.filter((item) => item.userId !== connection.userId),
  ];
  addAuditEvent({
    type: "connection_connected",
    message: "Company Exact Online connection updated.",
    metadata: {
      provider: "exact-online",
      connectionScope: "company",
      connectionOwnerId: connection.userId,
      divisionCode: connection.divisionCode,
      status: connection.status,
    },
  });
  return connection;
}

export function getExactConnection(userId = COMPANY_CONNECTION_USER_ID) {
  return (
    getStore().exactConnections.find((connection) => connection.userId === userId) ??
    null
  );
}

export function publicExactConnection(
  connection = getExactConnection()
): PublicExactConnection | null {
  if (!connection) {
    return null;
  }

  return {
    id: connection.id,
    userId: connection.userId,
    divisionCode: connection.divisionCode,
    status: connection.status,
    expiresAt: connection.expiresAt,
    scopes: connection.scopes,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

export function getExactMasterData(userId = COMPANY_CONNECTION_USER_ID) {
  return exactMasterDataForUser(getStore(), userId);
}

export function getSupplierOverviewImportStatus(): SupplierOverviewImportStatus | null {
  const imported = getStore().supplierOverviewImport;
  if (!imported) return null;
  return {
    sourceFileName: imported.sourceFileName,
    importedAt: imported.importedAt,
    supplierCount: imported.supplierCount,
  };
}

export function replaceSupplierOverviewImport(input: {
  sourceFileName: string;
  suppliers: SupplierOverviewRecord[];
  importedAt?: string;
}) {
  if (!input.suppliers.length) {
    throw new Error("Supplier overview contains no supplier records.");
  }

  const store = getStore();
  const imported: SupplierOverviewImport = {
    sourceFileName: input.sourceFileName,
    importedAt: input.importedAt ?? now(),
    supplierCount: input.suppliers.length,
    suppliers: input.suppliers,
  };
  store.supplierOverviewImport = imported;

  for (const invoice of store.invoices) {
    if (invoice.status !== "Uploaded" && invoice.status !== "Reading") {
      recomputeInvoiceInStore(store, invoice.id);
    }
  }

  addAuditEvent({
    type: "sync_operation",
    message: "Exact supplier overview imported from Excel.",
    metadata: {
      provider: "exact-supplier-overview",
      sourceFileName: imported.sourceFileName,
      supplierCount: imported.supplierCount,
      importedAt: imported.importedAt,
    },
  });
  persistStoreSoon();
  return imported;
}

export function isCachedExactMasterDataStale(userId = COMPANY_CONNECTION_USER_ID) {
  return isExactMasterDataStale(getExactMasterData(userId));
}

export async function syncExactDataNow(userId = COMPANY_CONNECTION_USER_ID) {
  const store = getStore();
  const connection = await refreshExactConnectionForUser(userId);
  if (connection) {
    store.exactConnections = [
      connection,
      ...store.exactConnections.filter((item) => item.userId !== userId),
    ];
  }
  const cache = await syncExactMasterData(connection);
  store.exactMasterDataCaches = [
    { userId, cache },
    ...store.exactMasterDataCaches.filter((item) => item.userId !== userId),
  ];

  for (const invoice of store.invoices) {
    if (invoice.status !== "Uploaded" && invoice.status !== "Reading") {
      recomputeInvoiceInStore(store, invoice.id);
    }
  }

  addAuditEvent({
    type: "sync_operation",
    message: "Company Exact Online master data cache synced.",
    metadata: {
      provider: "exact-online",
      connectionScope: "company",
      connectionOwnerId: userId,
      divisionCode: cache.divisionCode,
      supplierCount: cache.suppliers.length,
      glAccountCount: cache.glAccounts.length,
      vatCodeCount: cache.vatCodes.length,
      lastSyncedAt: cache.lastSyncedAt,
    },
  });

  return exactMasterDataForUser(store, userId) ?? cache;
}

export async function refreshExactConnectionForUser(userId = COMPANY_CONNECTION_USER_ID) {
  const connection = getExactConnection(userId);
  if (!connection) {
    return null;
  }

  try {
    const refreshed = await refreshExactTokenIfNeeded(connection);
    if (refreshed && refreshed.updatedAt !== connection.updatedAt) {
      getStore().exactConnections = [
        refreshed,
        ...getStore().exactConnections.filter((item) => item.userId !== userId),
      ];
      addAuditEvent({
        type: "token_refresh_success",
        message: "Company Exact Online token refresh succeeded.",
        metadata: {
          provider: "exact-online",
          connectionScope: "company",
          connectionOwnerId: userId,
          connectionId: refreshed.id,
          expiresAt: refreshed.expiresAt,
        },
      });
    }

    return refreshed;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Exact Online token refresh failed.";
    markExactConnectionNeedsReconnect(userId, message);
    throw error;
  }
}

export function markExactConnectionNeedsReconnect(
  userId = COMPANY_CONNECTION_USER_ID,
  reason = "Exact Online access must be re-authorized."
) {
  const store = getStore();
  const connection = getExactConnection(userId);
  if (!connection) {
    return null;
  }

  const updatedConnection: ExactConnection = {
    ...connection,
    status: "needs_reconnect",
    updatedAt: now(),
  };
  store.exactConnections = [
    updatedConnection,
    ...store.exactConnections.filter((item) => item.userId !== userId),
  ];
  addAuditEvent({
    type: "token_refresh_failure",
    message: "Company Exact Online token refresh failed; reconnect required.",
    metadata: {
      provider: "exact-online",
      connectionScope: "company",
      connectionOwnerId: userId,
      connectionId: connection.id,
      reason,
    },
  });
  return updatedConnection;
}

export function disconnectExactConnection(userId = COMPANY_CONNECTION_USER_ID) {
  const store = getStore();
  const connection = getExactConnection(userId);
  store.exactConnections = store.exactConnections.filter(
    (item) => item.userId !== userId
  );
  store.exactMasterDataCaches = store.exactMasterDataCaches.filter(
    (item) => item.userId !== userId
  );

  if (connection) {
    addAuditEvent({
      type: "connection_disconnected",
      message: "Company Exact Online connection disconnected and local tokens removed.",
      metadata: {
        provider: "exact-online",
        connectionScope: "company",
        connectionOwnerId: userId,
        connectionId: connection.id,
      },
    });
  }

  return connection;
}

function includesText(value: string | null | undefined, query: string) {
  return (value ?? "").toLowerCase().includes(query.toLowerCase());
}

function dateWithin(value: string | undefined, from?: string, to?: string) {
  if (!value) {
    return !from && !to;
  }

  const timestamp = new Date(value).getTime();
  if (from && timestamp < new Date(from).getTime()) {
    return false;
  }

  if (to) {
    const end = new Date(to);
    end.setHours(23, 59, 59, 999);
    if (timestamp > end.getTime()) {
      return false;
    }
  }

  return true;
}

function invoiceKeywordText(invoice: UploadedInvoice) {
  const lineDescriptions =
    invoice.purchaseJournal?.lines.map((line) => line.description).join(" ") ?? "";

  return [
    invoice.fileName,
    invoice.uploadedByName,
    invoice.exactBookingId,
    invoice.extractedData.supplierName,
    invoice.extractedData.invoiceNumber,
    invoice.extractedData.referenceCode,
    invoice.extractedData.expenseDescription,
    lineDescriptions,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function invoiceValidationStatus(invoice: UploadedInvoice) {
  if (invoice.validationErrors.some((error) => error.severity === "error")) {
    return "error";
  }

  if (invoice.validationErrors.length) {
    return "warning";
  }

  return "valid";
}

function invoiceDuplicateStatus(invoice: UploadedInvoice) {
  return invoice.duplicateDetection?.outcome ?? "none";
}

function invoiceSortValue(invoice: UploadedInvoice, sortBy: NonNullable<InvoiceArchiveFilters["sortBy"]>) {
  switch (sortBy) {
    case "invoiceDate":
      return invoice.extractedData.invoiceDate;
    case "supplier":
      return invoice.extractedData.supplierName;
    case "amount":
      return invoice.extractedData.grossAmount ?? 0;
    case "status":
      return invoice.status;
    case "uploader":
      return invoice.uploadedByName;
    case "uploadedAt":
    default:
      return invoice.createdAt;
  }
}

export function searchInvoiceArchive(filters: InvoiceArchiveFilters): InvoiceArchiveResult {
  const page = Math.max(1, Number(filters.page ?? 1));
  const pageSize = Math.min(100, Math.max(5, Number(filters.pageSize ?? 10)));
  const keyword = filters.keyword?.trim().toLowerCase() ?? "";
  const supplier = filters.supplier?.trim() ?? "";
  const invoiceNumber = filters.invoiceNumber?.trim() ?? "";
  const exactBookingReference = filters.exactBookingReference?.trim() ?? "";
  const sortBy = filters.sortBy ?? "uploadedAt";
  const sortDirection = filters.sortDirection ?? "desc";

  const filtered = getStore().invoices
    .filter((invoice) => !invoice.deletedAt)
    .filter((invoice) => (keyword ? invoiceKeywordText(invoice).includes(keyword) : true))
    .filter((invoice) =>
      dateWithin(
        invoice.extractedData.invoiceDate || undefined,
        filters.invoiceDateFrom,
        filters.invoiceDateTo
      )
    )
    .filter((invoice) => dateWithin(invoice.createdAt, filters.uploadedAtFrom, filters.uploadedAtTo))
    .filter((invoice) => (supplier ? includesText(invoice.extractedData.supplierName, supplier) : true))
    .filter((invoice) => {
      const amount = invoice.extractedData.grossAmount;
      if (typeof filters.amountMin === "number" && (amount ?? -Infinity) < filters.amountMin) {
        return false;
      }

      if (typeof filters.amountMax === "number" && (amount ?? Infinity) > filters.amountMax) {
        return false;
      }

      return true;
    })
    .filter((invoice) => (filters.currency ? invoice.extractedData.currency === filters.currency : true))
    .filter((invoice) =>
      invoiceNumber
        ? includesText(invoice.extractedData.invoiceNumber, invoiceNumber) ||
          includesText(invoice.extractedData.referenceCode, invoiceNumber)
        : true
    )
    .filter((invoice) => (filters.bookingStatus ? invoice.status === filters.bookingStatus : true))
    .filter((invoice) =>
      filters.validationStatus
        ? invoiceValidationStatus(invoice) === filters.validationStatus
        : true
    )
    .filter((invoice) => (filters.source ? invoice.source === filters.source : true))
    .filter((invoice) =>
      filters.uploadedByUserId ? invoice.uploadedByUserId === filters.uploadedByUserId : true
    )
    .filter((invoice) =>
      exactBookingReference ? includesText(invoice.exactBookingId, exactBookingReference) : true
    )
    .filter((invoice) => (filters.journal ? invoice.purchaseJournal?.journal === filters.journal : true))
    .filter((invoice) =>
      filters.glAccount
        ? invoice.purchaseJournal?.lines.some((line) => line.glAccount === filters.glAccount)
        : true
    )
    .filter((invoice) =>
      filters.vatCode
        ? invoice.purchaseJournal?.lines.some((line) => line.vatCode === filters.vatCode)
        : true
    )
    .filter((invoice) =>
      filters.costCenter
        ? invoice.purchaseJournal?.lines.some((line) => line.costCentre === filters.costCenter)
        : true
    )
    .filter((invoice) =>
      filters.costUnit
        ? invoice.purchaseJournal?.lines.some((line) => line.costUnit === filters.costUnit)
        : true
    )
    .filter((invoice) =>
      filters.country ? invoice.extractedData.supplierCountry === filters.country : true
    )
    .filter((invoice) =>
      filters.duplicateStatus
        ? invoiceDuplicateStatus(invoice) === filters.duplicateStatus
        : true
    )
    .sort((a, b) => {
      const left = invoiceSortValue(a, sortBy);
      const right = invoiceSortValue(b, sortBy);
      const direction = sortDirection === "asc" ? 1 : -1;

      if (typeof left === "number" && typeof right === "number") {
        return (left - right) * direction;
      }

      return String(left).localeCompare(String(right)) * direction;
    });

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = (page - 1) * pageSize;

  return {
    invoices: filtered.slice(start, start + pageSize),
    total,
    page,
    pageSize,
    totalPages,
  };
}
