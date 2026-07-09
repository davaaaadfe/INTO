import { emptyExtractedInvoiceData } from "../domain/invoice";
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
  PublicExactConnection,
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
  deleteStoredInvoiceFileSync,
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
import { refreshExactTokenIfNeeded } from "../services/exact-online-service";
import { createId } from "../utils/id";
import {
  isPostgresPersistenceEnabled,
  loadStoreSnapshot,
  saveStoreSnapshot,
} from "./postgres-store";

const verifiedUserPermissions: PermissionAction[] = [
  "view",
  "search_archive",
  "upload",
  "edit",
  "review",
  "approve",
  "book",
];

const systemOwnerPermissions: PermissionAction[] = [
  "manage_connections",
  "manage_users",
  "manage_settings",
];

export const COMPANY_CONNECTION_USER_ID = "company_connection";

export function getCompanyConnectionUserId() {
  return COMPANY_CONNECTION_USER_ID;
}

export type IntoStore = {
  users: IntoUser[];
  currentUserId: string;
  invoices: UploadedInvoice[];
  exactConnections: ExactConnection[];
  exactMasterDataCaches: Array<{
    userId: string;
    cache: ExactMasterDataCache;
  }>;
  duplicateLogs: DuplicateDecisionLog[];
  auditEvents: AuditEvent[];
  learning: BookingLearningStore;
};

function now() {
  return new Date().toISOString();
}

function exactMasterDataForUser(store: IntoStore, userId: string) {
  return store.exactMasterDataCaches.find((item) => item.userId === userId)?.cache ?? null;
}

function createSeedUsers(): IntoUser[] {
  const timestamp = now();

  return [
    {
      id: "user_admin",
      email: "david.kwon@inbody.com",
      name: "David Kwon",
      status: "active",
      isSystemOwner: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      id: "user_accountant",
      email: "tammy.park@inbody.com",
      name: "Tammy Park",
      status: "active",
      isSystemOwner: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      id: "user_reviewer",
      email: "reviewer@inbody.com",
      name: "Verified Finance User",
      status: "active",
      isSystemOwner: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      id: "user_viewer",
      email: "viewer@inbody.com",
      name: "Verified Archive User",
      status: "active",
      isSystemOwner: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ];
}

function userDisplayName(user: IntoUser | null | undefined) {
  return user?.name || user?.email || "Unknown user";
}

function createSeedInvoice(overrides: Partial<UploadedInvoice>): UploadedInvoice {
  const createdAt = now();
  const ownerId = overrides.userId ?? "user_accountant";
  const ownerName =
    overrides.uploadedByName ??
    (ownerId === "user_admin" ? "David Kwon" : "Tammy Park");
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
  const users = createSeedUsers();
  const seedDemoInvoices = process.env.NODE_ENV !== "production";
  const readyInvoice = seedDemoInvoices ? createSeedInvoice({}) : null;
  const checkInvoice = seedDemoInvoices
    ? createSeedInvoice({
        userId: "user_admin",
        uploadedByUserId: "user_admin",
        uploadedByName: "David Kwon",
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
    users,
    currentUserId: "user_accountant",
    invoices: [checkInvoice, readyInvoice].filter(
      (invoice): invoice is UploadedInvoice => Boolean(invoice)
    ),
    exactConnections: [],
    exactMasterDataCaches: [],
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
  __INTO_STORE_HYDRATED?: boolean;
  __INTO_STORE_HYDRATING?: Promise<void>;
  __INTO_STORE_PERSISTING?: Promise<void>;
};

export function getStore() {
  if (
    !globalStore.__INTO_STORE ||
    !Array.isArray(globalStore.__INTO_STORE.users) ||
    !Array.isArray(globalStore.__INTO_STORE.exactConnections) ||
    !Array.isArray(globalStore.__INTO_STORE.auditEvents)
  ) {
    globalStore.__INTO_STORE = createInitialStore();
  }

  for (const invoice of globalStore.__INTO_STORE.invoices) {
    if (!invoice.localFileStatus) {
      invoice.localFileStatus = invoice.storageKey ? "available" : "missing";
    }
  }

  return globalStore.__INTO_STORE;
}

export async function hydrateStoreFromPostgres() {
  if (!isPostgresPersistenceEnabled() || globalStore.__INTO_STORE_HYDRATED) {
    return;
  }

  if (!globalStore.__INTO_STORE_HYDRATING) {
    globalStore.__INTO_STORE_HYDRATING = loadStoreSnapshot()
      .then((snapshot) => {
        if (snapshot) {
          globalStore.__INTO_STORE = snapshot;
        } else {
          globalStore.__INTO_STORE = createInitialStore();
          globalStore.__INTO_STORE_PERSISTING = saveStoreSnapshot(
            globalStore.__INTO_STORE
          );
        }
        globalStore.__INTO_STORE_HYDRATED = true;
      })
      .finally(() => {
        globalStore.__INTO_STORE_HYDRATING = undefined;
      });
  }

  await globalStore.__INTO_STORE_HYDRATING;
}

export function persistStoreSoon() {
  if (!isPostgresPersistenceEnabled()) {
    return;
  }

  globalStore.__INTO_STORE_PERSISTING = saveStoreSnapshot(getStore()).catch(() => {
    // Persistence failures surface in setup status and API retries; never leak secrets.
  });
}

export async function flushStoreToPostgres() {
  await globalStore.__INTO_STORE_PERSISTING;
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

  return user.isSystemOwner
    ? [...verifiedUserPermissions, ...systemOwnerPermissions]
    : [...verifiedUserPermissions];
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

export function switchCurrentUser(userId: string) {
  const store = getStore();
  const user = store.users.find((item) => item.id === userId && item.status === "active");
  if (!user) {
    return null;
  }

  store.currentUserId = user.id;
  return currentUserContext();
}

export function requirePermission(action: PermissionAction) {
  const user = getCurrentUser();
  if (!canUser(action, user)) {
    throw new Error(`This INTO account is not allowed to ${action.replace(/_/g, " ")}.`);
  }

  return user;
}

export function requireSystemOwner() {
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

export function addAuditEvent(
  input: Omit<AuditEvent, "id" | "createdAt" | "userId" | "userName"> &
    Partial<Pick<AuditEvent, "userId" | "userName" | "createdAt">>
) {
  const user = input.userId
    ? getStore().users.find((item) => item.id === input.userId) ?? getCurrentUser()
    : getCurrentUser();
  const event: AuditEvent = {
    id: createId("audit"),
    userId: input.userId ?? user.id,
    userName: input.userName ?? userDisplayName(user),
    createdAt: input.createdAt ?? now(),
    invoiceId: input.invoiceId,
    type: input.type,
    message: input.message,
    field: input.field,
    oldValue: input.oldValue,
    newValue: input.newValue,
    metadata: input.metadata,
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
      message: `${getCurrentUser().name} changed ${field}.`,
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

function recomputeInvoiceInStore(store: IntoStore, invoiceId: string) {
  const invoice = store.invoices.find((item) => item.id === invoiceId);
  if (!invoice) {
    return null;
  }

  const baseValidationErrors = validateInvoiceData(
    invoice.id,
    invoice.extractedData,
    store.invoices.map((candidate) => ({
      id: candidate.id,
      supplierName: candidate.extractedData.supplierName,
      invoiceNumber: candidate.extractedData.invoiceNumber,
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
    invoice.status = statusFromPurchaseJournal(
      baseValidationErrors,
      purchaseJournal,
      invoice.extractedData
    );
  }

  invoice.lastError = invoice.validationErrors.length
    ? invoice.validationErrors.map((item) => item.message).join(" ")
    : undefined;
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
      ? getStore().users.find((item) => item.id === input.userId) ?? getCurrentUser()
      : getCurrentUser();
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
  extractedData: ExtractedInvoiceData
) {
  const invoice = getInvoice(invoiceId);
  if (!invoice) {
    return null;
  }

  invoice.extractedData = extractedData;
  invoice.intelligenceApprovedAt = undefined;
  invoice.purchaseJournal = null;
  invoice.updatedAt = now();
  return invoice;
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

  pushExtractionHistory(invoice, "duplicate_re_read", decision);
  invoice.extractedData = extractedData;
  invoice.duplicateResolutionDecision = decision;
  invoice.duplicateDetection = undefined;
  invoice.intelligenceApprovedAt = undefined;
  invoice.purchaseJournal = null;
  invoice.lastError = undefined;
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

export function resolveDuplicateDecision(input: {
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
      deleteStoredInvoiceFileSync(invoice.storageKey);
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

  invoice.status = "Booked";
  invoice.exactBookingId = exactBookingId;
  invoice.exactBookingStatus = "booked";
  invoice.lastError = undefined;
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
  };
}

export function markInvoiceBookingFailed(invoiceId: string, message: string) {
  const invoice = getInvoice(invoiceId);
  if (!invoice) {
    return null;
  }

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

  invoice.intelligenceApprovedAt = now();
  const updatedInvoice = recomputeInvoiceState(invoiceId);

  if (updatedInvoice) {
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

  const supplierIdentity = supplierIdentityForInvoice(invoice);

  if (
    !store.learning.supplierSelections.some(
      (decision) =>
        decision.supplierIdentity === supplierIdentity &&
        decision.accountId === account.id
    )
  ) {
    store.learning.supplierSelections.unshift({
      supplierIdentity,
      accountId: account.id,
      decidedAt: now(),
    });
  }

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

  return cache;
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
