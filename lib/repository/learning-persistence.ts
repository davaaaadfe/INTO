import { createHash } from "node:crypto";
import type {
  BookingLearningStore,
  ExactSupplierAccount,
  ExtractedInvoiceData,
  LearnedCorrection,
  UploadedInvoice,
  SupplierLearningDecision,
  SupplierLearningPattern,
} from "../domain/invoice";
import type { IntoStore } from "./invoice-store";
import type {
  LearningAliasInput,
  LearningArtifactInput,
  LearningExampleInput,
  LearningPatternInput,
  LearningScope,
} from "./learning-repository";
import { configuredLearningRepository } from "./configured-learning-repository";
import type { LearningRepository } from "./learning-repository-contract";
import {
  canonicalSupplierIdentityKey,
  learnedFilenamePattern,
} from "../services/correction-learning";
import {
  normalizeSupplierAddress,
  normalizeSupplierBic,
  normalizeSupplierChamberOfCommerce,
  normalizeSupplierCode,
  normalizeSupplierIban,
  normalizeSupplierName,
  normalizeSupplierVat,
} from "../services/supplier-identity";
import {
  assignFormatCluster,
  structuralFormat,
  supplierReliability,
  supplierReliabilityEvidenceFromExamples,
} from "../services/supplier-learning";
import {
  createInitialLearningStore,
  generatePurchaseJournalBooking,
} from "../services/purchase-journal-intelligence";
import {
  rebuildSupplierPatterns,
  SUPPLIER_PATTERN_MODEL_VERSION,
} from "../services/supplier-pattern-derivation";

const COMPANY_CONNECTION_USER_ID = "company_connection";
const RUNTIME_PATTERN_VERSION = "runtime-pattern-v1";

function companyId() {
  return process.env.INTO_COMPANY_ID?.trim() || "into-company";
}

export type LearningPersistenceContext = {
  actorId?: string;
  actorName?: string;
  requestId?: string;
  sessionCorrelationId?: string;
};

type PatternRow = Record<string, unknown>;

function stableId(prefix: string, values: unknown[]) {
  return `${prefix}_${createHash("sha256")
    .update(JSON.stringify(values))
    .digest("hex")
    .slice(0, 24)}`;
}

function exactCache(store: IntoStore) {
  return (
    store.exactMasterDataCaches.find(
      (item) => item.userId === COMPANY_CONNECTION_USER_ID
    )?.cache ?? store.exactMasterDataCaches[0]?.cache
  );
}

function divisionCode(store: IntoStore) {
  return (
    exactCache(store)?.divisionCode ||
    store.exactConnections.find(
      (item) => item.userId === COMPANY_CONNECTION_USER_ID
    )?.divisionCode ||
    "unassigned"
  );
}

function supplierForAccount(store: IntoStore, accountId: string) {
  return exactCache(store)?.suppliers.find((supplier) => supplier.id === accountId);
}

function canonicalAccount(store: IntoStore, accountId: string) {
  if (!accountId.startsWith("supplier-overview:")) {
    const supplier = supplierForAccount(store, accountId);
    return { accountId, code: supplier?.code ?? "", supplier };
  }
  const code = normalizeSupplierCode(accountId.slice("supplier-overview:".length));
  const candidates = (exactCache(store)?.suppliers ?? []).filter(
    (supplier) =>
      !supplier.id.startsWith("supplier-overview:") &&
      normalizeSupplierCode(supplier.code) === code
  );
  if (candidates.length === 1) {
    return {
      accountId: candidates[0].id,
      code: candidates[0].code,
      supplier: candidates[0],
    };
  }
  return {
    accountId,
    code,
    supplier: supplierForAccount(store, accountId),
  };
}

function scopeFor(
  store: IntoStore,
  supplierAccountId: string
): LearningScope & { fallbackSupplierCode: string } {
  const canonical = canonicalAccount(store, supplierAccountId);
  return {
    companyId: companyId(),
    divisionCode: divisionCode(store),
    supplierAccountId: canonical.accountId,
    fallbackSupplierCode: canonical.code,
  };
}

function canonicalIdentity(identity: string) {
  return canonicalSupplierIdentityKey(identity).toLowerCase();
}

function accountIdentityIndex(store: IntoStore) {
  const index = new Map<string, Set<string>>();
  const add = (identity: string, accountId: string) => {
    if (!identity) return;
    const key = canonicalIdentity(identity);
    const accounts = index.get(key) ?? new Set<string>();
    accounts.add(canonicalAccount(store, accountId).accountId);
    index.set(key, accounts);
  };

  for (const supplier of exactCache(store)?.suppliers ?? []) {
    if (supplier.id.startsWith("supplier-overview:")) continue;
    for (const [kind, normalizedValue] of aliasValues(supplier)) {
      if (normalizedValue) add(`${kind}:${normalizedValue}`, supplier.id);
    }
  }
  for (const decision of store.learning.supplierSelections) {
    add(decision.supplierIdentity, decision.accountId);
  }
  return index;
}

function correctionAccountId(
  store: IntoStore,
  correction: LearnedCorrection,
  identities = accountIdentityIndex(store)
) {
  if (correction.supplierAccountId) {
    return canonicalAccount(store, correction.supplierAccountId).accountId;
  }
  const accounts = identities.get(canonicalIdentity(correction.supplierIdentity));
  return accounts?.size === 1 ? [...accounts][0] : undefined;
}

function learningAccountIds(store: IntoStore) {
  const identities = accountIdentityIndex(store);
  const accountIds = new Set<string>();
  const add = (accountId: string | undefined) => {
    if (accountId) accountIds.add(canonicalAccount(store, accountId).accountId);
  };

  for (const profile of store.learning.supplierProfiles) add(profile.supplierAccountId);
  for (const example of store.learning.supplierExamples) add(example.supplierAccountId);
  for (const decision of store.learning.supplierSelections) add(decision.accountId);
  for (const decision of store.learning.glAccountSelections) add(decision.supplierAccountId);
  for (const decision of store.learning.vatCodeSelections) add(decision.supplierAccountId);
  for (const decision of store.learning.costCentreSelections) add(decision.supplierAccountId);
  for (const decision of store.learning.costUnitSelections) add(decision.supplierAccountId);
  for (const correction of store.learning.corrections) {
    add(correctionAccountId(store, correction, identities));
  }
  for (const invoice of store.invoices) {
    const supplierAccountId =
      invoice.purchaseJournal?.supplierResolution.selectedAccountId;
    const confirmed =
      Boolean(invoice.intelligenceApprovedAt) ||
      (invoice.status === "Booked" && Boolean(invoice.exactBookingId));
    if (
      supplierAccountId &&
      confirmed &&
      invoice.processingPurpose !== "learning_only" &&
      hasSourceEvidence(invoice) &&
      hasTrainableFields(invoice) &&
      supplierForAccount(store, supplierAccountId)
    ) {
      add(supplierAccountId);
    }
  }
  return { accountIds: [...accountIds], identities };
}

function runtimeProfileForAccount(store: IntoStore, supplierAccountId: string) {
  return store.learning.supplierProfiles.find(
    (profile) =>
      canonicalAccount(store, profile.supplierAccountId).accountId === supplierAccountId
  );
}

function aliasValues(supplier: ExactSupplierAccount) {
  return [
    ["vat", normalizeSupplierVat(supplier.vatNumber)],
    ["iban", normalizeSupplierIban(supplier.iban)],
    ["bic", normalizeSupplierBic(supplier.bicCode)],
    ["code", normalizeSupplierCode(supplier.code)],
    ["coc", normalizeSupplierChamberOfCommerce(supplier.chamberOfCommerceNumber)],
    ["name", normalizeSupplierName(supplier.name)],
    ["address", normalizeSupplierAddress(supplier.address)],
  ] as const;
}

function aliasFromDecision(
  store: IntoStore,
  decision: SupplierLearningDecision,
  generation: number,
  createdAt: string
): LearningAliasInput | null {
  const separator = decision.supplierIdentity.indexOf(":");
  if (separator < 1) return null;
  const kind = decision.supplierIdentity.slice(0, separator);
  if (!["vat", "iban", "bic", "code", "coc", "name", "address"].includes(kind)) {
    return null;
  }
  const normalizedValue = decision.supplierIdentity.slice(separator + 1);
  if (!normalizedValue) return null;
  const scope = scopeFor(store, decision.accountId);
  return {
    id: stableId("alias", [
      scope,
      generation,
      kind,
      normalizedValue,
      "learned",
    ]),
    ...scope,
    generation,
    kind: kind as LearningAliasInput["kind"],
    normalizedValue,
    source: decision.trustState === "legacy" ? "legacy" : "learned",
    createdAt,
  };
}

function jsonValue(value: unknown) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function rowText(row: PatternRow, snake: string, camel: string) {
  return String(row[snake] ?? row[camel] ?? "");
}

function rowMapping(row: PatternRow) {
  return jsonValue(row.booking_mapping_json ?? row.bookingMapping) as
    | Record<string, unknown>
    | undefined;
}

function sanitizeCorrection(correction: LearnedCorrection) {
  const variableFields = new Set([
    "yourRefPattern",
    "invoiceDate",
    "netAmount",
    "vatAmount",
    "totalAmount",
  ]);
  const sanitized = structuredClone(correction) as LearnedCorrection & {
    originalValue?: unknown;
    correctedValue?: unknown;
  };
  delete sanitized.invoiceTextContext;
  if (variableFields.has(correction.field)) {
    delete sanitized.originalValue;
    delete sanitized.correctedValue;
  }
  return sanitized;
}

function minimizedExtractedData(data: ExtractedInvoiceData | undefined) {
  if (!data) return {};
  return {
    invoiceNumber: data.invoiceNumber,
    referenceCode: data.referenceCode,
    invoiceDate: data.invoiceDate,
    dueDate: data.dueDate,
    paymentTerms: data.paymentTerms,
    currency: data.currency,
    netAmount: data.netAmount,
    vatAmount: data.vatAmount,
    grossAmount: data.grossAmount,
    expenseDescription: data.expenseDescription,
    serviceStartDate: data.serviceStartDate,
    serviceEndDate: data.serviceEndDate,
    reverseChargeMentioned: data.reverseChargeMentioned,
    intraCommunityMentioned: data.intraCommunityMentioned,
    lineItems: (data.lineItems ?? []).map((line) => ({
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      netAmount: line.netAmount,
      vatRate: line.vatRate,
      vatAmount: line.vatAmount,
      grossAmount: line.grossAmount,
    })),
  };
}

const observationFields = [
  "supplierName",
  "supplierVatNumber",
  "supplierChamberOfCommerceNumber",
  "supplierAddress",
  "supplierCountry",
  "invoiceNumber",
  "referenceCode",
  "invoiceDate",
  "dueDate",
  "paymentTerms",
  "currency",
  "netAmount",
  "vatAmount",
  "grossAmount",
  "iban",
  "expenseDescription",
  "beneficiary",
  "serviceStartDate",
  "serviceEndDate",
  "companyVatNumber",
  "reverseChargeMentioned",
  "intraCommunityMentioned",
  "lineItems",
] as const satisfies readonly (keyof ExtractedInvoiceData)[];

function observationState(
  data: ExtractedInvoiceData | undefined,
  corrections: readonly LearnedCorrection[]
): NonNullable<LearningExampleInput["observationState"]> {
  const correctionFields: Partial<Record<LearnedCorrection["field"], keyof ExtractedInvoiceData>> = {
    supplier: "supplierName",
    yourRefPattern: "referenceCode",
    invoiceDate: "invoiceDate",
    netAmount: "netAmount",
    vatAmount: "vatAmount",
    totalAmount: "grossAmount",
    expenseDescription: "expenseDescription",
    paymentCondition: "paymentTerms",
  };
  return Object.fromEntries(
    observationFields.map((field) => {
      const value = data?.[field];
      const observed =
        typeof value === "string"
          ? Boolean(value.trim())
          : typeof value === "number"
            ? Number.isFinite(value)
            : typeof value === "boolean"
              ? value
              : Array.isArray(value) && value.length > 0;
      const reviewedEmpty = corrections.some(
        (correction) =>
          correctionFields[correction.field] === field &&
          (correction.correctedValue === "" || correction.correctedValue === null)
      );
      return [field, observed ? "observed" : reviewedEmpty ? "reviewed_empty" : "unknown"];
    })
  );
}

function extractedDataWithoutDocumentEvidence(
  data: ExtractedInvoiceData | undefined
) {
  if (!data) return undefined;
  const minimized = structuredClone(data);
  delete minimized.rawText;
  delete minimized.extractionEvidence;
  delete minimized.documentAnalysis;
  return minimized;
}

function rollbackLearningStore(learning: BookingLearningStore) {
  const rollback = structuredClone(learning);
  rollback.supplierExamples = (rollback.supplierExamples ?? []).map((example) => ({
    ...example,
    originalExtractedData: extractedDataWithoutDocumentEvidence(
      example.originalExtractedData
    ),
    finalExtractedData: extractedDataWithoutDocumentEvidence(
      example.finalExtractedData
    ),
  }));
  rollback.corrections = (rollback.corrections ?? []).map((correction) => {
    const minimized = structuredClone(correction);
    delete minimized.invoiceTextContext;
    return minimized;
  });
  return rollback;
}

function legacyLearningMigrationInput(store: IntoStore, completedAt: string) {
  const source = rollbackLearningStore(store.learning);
  const rowCounts = {
    corrections: source.corrections.length,
    examples: source.supplierExamples.length,
    mappings:
      source.glAccountSelections.length +
      source.vatCodeSelections.length +
      source.costCentreSelections.length +
      source.costUnitSelections.length,
    patterns: source.supplierPatterns.length,
    selections: source.supplierSelections.length,
  };
  const migrationName = `legacy-learning:${companyId()}:${divisionCode(store)}`;
  const sourceSnapshotHash = createHash("sha256")
    .update(JSON.stringify(source))
    .digest("hex");
  const checksum = createHash("sha256")
    .update(
      JSON.stringify({
        migrationName,
        version: 1,
        sourceSnapshotRevision: store.revision,
        sourceSnapshotHash,
        rowCounts,
      })
    )
    .digest("hex");
  return {
    migrationName,
    version: 1,
    sourceSnapshotRevision: store.revision,
    sourceSnapshotHash,
    rowCounts,
    checksum,
    startedAt: completedAt,
    completedAt,
  };
}

function minimizedBookingLines(
  lines: BookingLearningStore["supplierExamples"][number]["bookingLines"] = []
) {
  return (lines ?? []).map((line) => ({
    glAccount: line.glAccount,
    suggestedGlAccount: line.suggestedGlAccount,
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
  }));
}

function runtimePatternInput(
  store: IntoStore,
  pattern: SupplierLearningPattern,
  createdAt: string,
  generation = pattern.generation
): LearningPatternInput {
  const scope = scopeFor(store, pattern.supplierAccountId);
  return {
    id: stableId("pattern", [
      scope,
      pattern.generation,
      pattern.formatCluster ?? "runtime",
      pattern.field ?? "runtime_extraction",
      pattern.key,
    ]),
    ...scope,
    generation,
    formatCluster: pattern.formatCluster ?? "runtime",
    field: pattern.field ?? "runtime_extraction",
    patternKey: pattern.key,
    label: pattern.label,
    anchor: {
      context: pattern.context,
      relativePosition: pattern.relativePosition,
    },
    dataType: pattern.dataType ?? RUNTIME_PATTERN_VERSION,
    bookingMapping: { kind: "runtime_pattern", pattern },
    supportCount: pattern.supportCount ?? pattern.attempts,
    successCount: pattern.successCount ?? pattern.successes,
    correctionCount:
      pattern.correctionCount ?? Math.max(0, pattern.attempts - pattern.successes),
    driftState: pattern.driftState ?? "none",
    modelVersion: pattern.modelVersion ?? RUNTIME_PATTERN_VERSION,
    createdAt,
  };
}

function mappingPatternInput(
  store: IntoStore,
  supplierAccountId: string,
  generation: number,
  field: string,
  patternKey: string,
  mapping: Record<string, unknown>,
  trustState: "trusted" | "legacy" = "trusted",
  createdAt = new Date().toISOString(),
  recordEvidence = true
): LearningPatternInput {
  const scope = scopeFor(store, supplierAccountId);
  const weight = recordEvidence ? (trustState === "legacy" ? 0.35 : 1) : 0;
  return {
    id: stableId("pattern", [scope, generation, field, patternKey]),
    ...scope,
    generation,
    formatCluster: "runtime",
    field,
    patternKey,
    dataType: RUNTIME_PATTERN_VERSION,
    bookingMapping: mapping,
    supportCount: weight,
    successCount: weight,
    correctionCount: 0,
    driftState: "none",
    modelVersion: RUNTIME_PATTERN_VERSION,
    createdAt,
  };
}

function patternIdentity(field: string, patternKey: string) {
  return `${field}\u0000${patternKey}`;
}

function existingPatternIdentities(rows: PatternRow[]) {
  return new Set(
    rows.map((row) =>
      patternIdentity(
        rowText(row, "field", "field"),
        rowText(row, "pattern_key", "patternKey")
      )
    )
  );
}

function exampleInput(
  store: IntoStore,
  example: BookingLearningStore["supplierExamples"][number],
  artifactId: string | undefined,
  context: LearningPersistenceContext
): LearningExampleInput {
  const scope = scopeFor(store, example.supplierAccountId);
  const invoice = store.invoices.find((item) => item.id === example.invoiceId);
  const legacy = context.requestId === "legacy-migration";
  const corrections = store.learning.corrections
    .filter(
      (correction) =>
        correction.invoiceId === example.invoiceId &&
        correction.trustState !== "pending"
    )
    .map(sanitizeCorrection);
  const format = structuralFormat(
    example.finalExtractedData?.rawText ?? invoice?.extractedData.rawText ?? ""
  );
  const formatCluster =
    example.formatCluster ??
    assignFormatCluster(
      example.formatSignature ?? format.signature,
      store.learning.supplierExamples
        .filter(
          (item) =>
            item !== example &&
            item.supplierAccountId === example.supplierAccountId &&
            item.generation === example.generation &&
            item.active !== false &&
            item.formatSignature &&
            item.formatCluster
        )
        .map((item) => ({ id: item.formatCluster!, signature: item.formatSignature! }))
    ).clusterId;
  return {
    id: example.id ?? stableId("example", [scope, example.contentHash]),
    ...scope,
    generation: legacy ? 0 : example.generation,
    invoiceId: example.invoiceId,
    artifactId,
    contentHash: example.contentHash,
    originalFilename: learnedFilenamePattern(invoice?.fileName ?? ""),
    originalPrediction: {
      extractedData: minimizedExtractedData(example.originalExtractedData),
      bookingLines: minimizedBookingLines(
        example.originalBookingLines ?? invoice?.purchaseJournal?.lines ?? []
      ),
      supplierResolution: example.originalSupplierAccountId
        ? { selectedAccountId: example.originalSupplierAccountId }
        : undefined,
    },
    finalFields: {
      extractedData: minimizedExtractedData(example.finalExtractedData),
      supplierAccountId: scope.supplierAccountId,
      corrections,
    },
    bookingLines: minimizedBookingLines(example.bookingLines),
    observationState: observationState(
      example.finalExtractedData,
      store.learning.corrections.filter(
        (correction) => correction.invoiceId === example.invoiceId
      )
    ),
    fingerprint: example.formatFingerprint,
    fingerprintVersion: "layout-v1",
    formatSignature: example.formatSignature ?? format.signature,
    formatCluster,
    validationResult:
      example.validationResult ??
      {
        valid: !(invoice?.validationErrors ?? []).some(
          (error) => error.severity === "error"
        ),
        issues: (invoice?.validationErrors ?? []).map((error) => ({
          field: error.field,
          severity: error.severity,
        })),
      },
    processingPurpose:
      example.processingPurpose ?? invoice?.processingPurpose ?? "learning_only",
    source: legacy ? "legacy" : (example.source ?? "explicit_learn"),
    trustState: legacy ? "legacy" : (example.trustState ?? "trusted"),
    trigger: legacy ? "migration" : (example.trigger ?? "learn"),
    actorId: example.learnedByUserId ?? context.actorId ?? "shared_user",
    sessionCorrelationId: context.sessionCorrelationId || "session_unavailable",
    requestId:
      context.requestId ||
      invoice?.learningMetadata?.requestFingerprint ||
      stableId("request", [example.id, example.contentHash]),
    createdAt: example.learnedAt,
  };
}

function isCorroboratedExplicitLearn(
  store: IntoStore,
  example: BookingLearningStore["supplierExamples"][number]
) {
  const invoice = store.invoices.find((item) => item.id === example.invoiceId);
  const metadata = invoice?.learningMetadata;
  if (
    invoice?.status !== "Learned" ||
    !metadata ||
    metadata.exampleId !== example.id ||
    metadata.supplierAccountId !== example.supplierAccountId ||
    metadata.generation !== example.generation ||
    metadata.contentHash !== example.contentHash
  ) {
    return false;
  }
  return store.auditEvents.some(
    (event) =>
      event.invoiceId === example.invoiceId &&
      event.type === "invoice_learned" &&
      (!event.metadata?.exampleId || event.metadata.exampleId === example.id)
  );
}

function trustedContentHash(invoice: UploadedInvoice) {
  return (
    invoice.checksum ||
    createHash("sha256")
      .update(
        invoice.extractedData.rawText ||
          `${invoice.fileSize}:${invoice.storageKey}`
      )
      .digest("hex")
  );
}

function artifactRetentionUntil(createdAt: string) {
  const configuredDays = Number(process.env.LEARNING_ARTIFACT_RETENTION_DAYS);
  const days = Number.isFinite(configuredDays)
    ? Math.max(1, Math.min(3650, Math.floor(configuredDays)))
    : 365;
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return undefined;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function hasSourceEvidence(invoice: UploadedInvoice) {
  const data = invoice.extractedData;
  return Boolean(
    data.rawText?.trim() ||
      Object.keys(data.extractionEvidence ?? {}).length ||
      data.documentAnalysis?.pages.length ||
      data.documentAnalysis?.fieldCandidates.length
  );
}

function artifactInput(
  contentHash: string,
  data: ExtractedInvoiceData | undefined,
  createdAt: string
): LearningArtifactInput {
  const provider = data?.documentAnalysis?.provider;
  return {
    companyId: companyId(),
    contentHash,
    rawText: data?.rawText ?? "",
    analysis: {
      documentTextMode: data?.documentTextMode,
      extractionEvidence: data?.extractionEvidence,
      documentAnalysis: data?.documentAnalysis,
    },
    detectedLanguage: data?.documentAnalysis?.language,
    provider: provider?.name ?? data?.documentTextMode ?? "local",
    modelVersion:
      provider?.modelVersion ?? provider?.model ?? "runtime-extraction-v1",
    retentionUntil: artifactRetentionUntil(createdAt),
    createdAt,
  };
}

function hasTrainableFields(invoice: UploadedInvoice) {
  const data = invoice.extractedData;
  return Boolean(
    data.invoiceNumber ||
      data.referenceCode ||
      data.invoiceDate ||
      data.netAmount !== null ||
      data.vatAmount !== null ||
      data.grossAmount !== null ||
      data.lineItems.length ||
      invoice.bookingLineOverrides?.length ||
      invoice.purchaseJournal?.lines.length
  );
}

function lifecycleExampleInput(
  store: IntoStore,
  invoice: UploadedInvoice,
  supplierAccountId: string,
  generation: number,
  context: LearningPersistenceContext
): LearningExampleInput | null {
  if (
    invoice.processingPurpose === "learning_only" ||
    !hasSourceEvidence(invoice) ||
    !hasTrainableFields(invoice) ||
    !supplierForAccount(store, supplierAccountId)
  ) {
    return null;
  }
  const booked = invoice.status === "Booked" && Boolean(invoice.exactBookingId);
  const occurredAt = booked ? invoice.updatedAt : invoice.intelligenceApprovedAt;
  if (!occurredAt) return null;
  const source = booked ? "booking" : "review";
  const contentHash = trustedContentHash(invoice);
  const scope = scopeFor(store, supplierAccountId);
  const corrections = store.learning.corrections
    .filter(
      (correction) =>
        correction.invoiceId === invoice.id && correction.trustState !== "pending"
    )
    .map(sanitizeCorrection);
  const originalPrediction =
    invoice.extractionHistory.find((version) => version.reason === "initial")
      ?.extractedData ?? invoice.extractionHistory[0]?.extractedData ?? invoice.extractedData;
  const originalDraft = {
    ...structuredClone(invoice),
    extractedData: structuredClone(originalPrediction),
    bookingLineOverrides: undefined,
    purchaseJournal: null,
    intelligenceApprovedAt: undefined,
  };
  const originalInvoices = store.invoices.map((item) =>
    item.id === invoice.id ? originalDraft : item
  );
  const originalBooking = generatePurchaseJournalBooking(
    originalDraft,
    originalInvoices,
    createInitialLearningStore(),
    exactCache(store) ?? null
  );
  const format = structuralFormat(invoice.extractedData.rawText ?? "");
  return {
    id: stableId("example", [scope, generation, contentHash]),
    ...scope,
    generation,
    invoiceId: invoice.id,
    contentHash,
    originalFilename: learnedFilenamePattern(invoice.fileName),
    originalPrediction: {
      extractedData: minimizedExtractedData(originalPrediction),
      bookingLines: minimizedBookingLines(originalBooking.lines),
      supplierResolution: {
        selectedAccountId: originalBooking.supplierResolution.selectedAccountId,
      },
    },
    finalFields: {
      extractedData: minimizedExtractedData(invoice.extractedData),
      supplierAccountId: scope.supplierAccountId,
      corrections,
    },
    bookingLines: minimizedBookingLines(
      invoice.bookingLineOverrides ?? invoice.purchaseJournal?.lines ?? []
    ),
    observationState: observationState(
      invoice.extractedData,
      store.learning.corrections.filter(
        (correction) => correction.invoiceId === invoice.id
      )
    ),
    fingerprint: format.fingerprint,
    fingerprintVersion: "layout-v1",
    formatSignature: format.signature,
    formatCluster: assignFormatCluster(format.signature, []).clusterId,
    validationResult: {
      valid: !invoice.validationErrors.some((error) => error.severity === "error"),
      issues: invoice.validationErrors.map((error) => ({
        field: error.field,
        severity: error.severity,
      })),
    },
    processingPurpose: "booking",
    source,
    trustState: "trusted",
    trigger: source,
    actorId: context.actorId ?? "shared_user",
    sessionCorrelationId: context.sessionCorrelationId || "session_unavailable",
    requestId:
      context.requestId || stableId("request", [source, invoice.id, contentHash]),
    createdAt: occurredAt,
  };
}

async function saveAnalysisArtifacts(
  store: IntoStore,
  repository: LearningRepository,
  createdAt: string
) {
  await repository.pruneExpiredArtifacts(createdAt);
  const artifactsByContentHash = new Map<
    string,
    Awaited<ReturnType<typeof repository.saveArtifact>>
  >();
  for (const invoice of store.invoices) {
    if (!hasSourceEvidence(invoice)) continue;
    const contentHash = trustedContentHash(invoice);
    const artifact = await repository.saveArtifact(
      artifactInput(
        contentHash,
        invoice.extractedData,
        invoice.updatedAt || invoice.createdAt
      )
    );
    invoice.analysisArtifactId = artifact.id;
    artifactsByContentHash.set(contentHash, artifact);
  }
  return artifactsByContentHash;
}

export async function persistAnalysisArtifacts(
  store: IntoStore,
  repositoryOverride?: LearningRepository
) {
  const repository = repositoryOverride ?? (await configuredLearningRepository());
  if (!repository) return false;
  await saveAnalysisArtifacts(store, repository, new Date().toISOString());
  return true;
}

export async function pruneExpiredLearningArtifacts(referenceDate = new Date()) {
  const repository = await configuredLearningRepository();
  if (!repository) return 0;
  return repository.pruneExpiredArtifacts(referenceDate.toISOString());
}

export async function persistLearningState(
  store: IntoStore,
  context: LearningPersistenceContext = {},
  repositoryOverride?: LearningRepository
) {
  const repository = repositoryOverride ?? (await configuredLearningRepository());
  if (!repository) return false;
  const createdAt = new Date().toISOString();
  const artifactsByContentHash = await saveAnalysisArtifacts(
    store,
    repository,
    createdAt
  );
  const legacyMigration = context.requestId === "legacy-migration";
  const { accountIds, identities } = learningAccountIds(store);
  const profilesByAccount = new Map<
    string,
    Awaited<ReturnType<typeof repository.ensureProfile>>
  >();
  const completedLegacyAccounts = new Set<string>();

  for (const supplierAccountId of accountIds) {
    const scope = scopeFor(store, supplierAccountId);
    const runtimeProfile = runtimeProfileForAccount(store, scope.supplierAccountId);
    const existingProfile = await repository.getProfile(scope);
    const desiredGeneration = legacyMigration
      ? 0
      : (runtimeProfile?.generation ?? existingProfile?.generation ?? 1);
    if (legacyMigration && existingProfile && existingProfile.generation > 0) {
      profilesByAccount.set(scope.supplierAccountId, existingProfile);
      completedLegacyAccounts.add(scope.supplierAccountId);
      continue;
    }
    let profile;
    if (
      existingProfile &&
      runtimeProfile?.lastResetAt &&
      desiredGeneration === existingProfile.generation + 1
    ) {
      profile = await repository.resetSupplier({
        ...scope,
        expectedGeneration: existingProfile.generation,
        actorId: context.actorId ?? "shared_user",
        sessionCorrelationId: context.sessionCorrelationId || "session_unavailable",
        requestId:
          context.requestId ||
          stableId("request", ["reset", scope, desiredGeneration]),
        createdAt: runtimeProfile.lastResetAt,
      });
    } else {
      if (
        existingProfile &&
        desiredGeneration !== existingProfile.generation &&
        !(existingProfile.generation === 0 && desiredGeneration === 1)
      ) {
        throw new Error(
          "Supplier learning generation changed. Refresh and try again."
        );
      }
      profile = await repository.ensureProfile({
        ...scope,
        generation: desiredGeneration,
        createdAt:
          runtimeProfile?.lastLearnedAt ??
          runtimeProfile?.lastResetAt ??
          existingProfile?.createdAt ??
          createdAt,
      });
    }
    if (profile.generation !== desiredGeneration) {
      throw new Error(
        "Supplier learning generation changed. Refresh and try again."
      );
    }
    profilesByAccount.set(scope.supplierAccountId, profile);

    const supplier = canonicalAccount(store, supplierAccountId).supplier;
    if (supplier) {
      for (const [kind, normalizedValue] of aliasValues(supplier)) {
        if (!normalizedValue) continue;
        await repository.saveAlias({
          id: stableId("alias", [scope, kind, normalizedValue, "exact"]),
          ...scope,
          generation: profile.generation,
          kind,
          normalizedValue,
          source: "exact",
          createdAt,
        });
      }
    }

    const existingPatterns = await repository.listPatterns(scope);
    const patternIds = existingPatternIdentities(existingPatterns);
    const saveMappingOnce = async (
      field: string,
      patternKey: string,
      mapping: Record<string, unknown>,
      trustState: "trusted" | "legacy",
      observedAt: string
    ) => {
      const identity = patternIdentity(field, patternKey);
      if (patternIds.has(identity)) return;
      await repository.savePattern(
        mappingPatternInput(
          store,
          scope.supplierAccountId,
          profile.generation,
          field,
          patternKey,
          mapping,
          trustState,
          observedAt,
          true
        )
      );
      patternIds.add(identity);
    };

    for (const decision of store.learning.supplierSelections.filter(
      (item) =>
        item.trustState !== "pending" &&
        canonicalAccount(store, item.accountId).accountId === scope.supplierAccountId
    )) {
      const alias = aliasFromDecision(
        store,
        decision,
        profile.generation,
        decision.decidedAt
      );
      if (alias) await repository.saveAlias(alias);
      await saveMappingOnce(
        "runtime_supplier_selection",
        stableId("selection", [decision]),
        { kind: "runtime_supplier_selection", decision },
        decision.trustState === "legacy" ? "legacy" : "trusted",
        decision.decidedAt
      );
    }

    for (const pattern of store.learning.supplierPatterns.filter(
      (item) =>
        item.modelVersion !== SUPPLIER_PATTERN_MODEL_VERSION &&
        canonicalAccount(store, item.supplierAccountId).accountId ===
          scope.supplierAccountId &&
        item.generation === profile.generation
    )) {
      await repository.savePattern(
        runtimePatternInput(store, pattern, createdAt, profile.generation)
      );
    }
    const derivedPatterns = rebuildSupplierPatterns(
      scope.supplierAccountId,
      profile.generation,
      store.learning.supplierExamples
    ).map((pattern) =>
      runtimePatternInput(store, pattern, createdAt, profile.generation)
    );
    await repository.replaceDerivedPatterns({
      ...scope,
      generation: profile.generation,
      modelVersion: SUPPLIER_PATTERN_MODEL_VERSION,
      patterns: derivedPatterns,
      updatedAt: createdAt,
    });

    for (const correction of store.learning.corrections.filter(
      (item) =>
        correctionAccountId(store, item, identities) === scope.supplierAccountId &&
        item.trustState !== "pending"
    )) {
      await saveMappingOnce(
        `runtime_correction:${correction.field}`,
        correction.id,
        {
          kind: "runtime_correction",
          correction: sanitizeCorrection(correction),
        },
        correction.trustState === "legacy" ? "legacy" : "trusted",
        correction.trustedAt ?? correction.correctedAt
      );
    }

    const decisionMappings = [
      ["runtime_gl_selection", store.learning.glAccountSelections],
      ["runtime_vat_selection", store.learning.vatCodeSelections],
      ["runtime_cost_centre_selection", store.learning.costCentreSelections],
      ["runtime_cost_unit_selection", store.learning.costUnitSelections],
    ] as const;
    for (const [field, decisions] of decisionMappings) {
      for (const decision of decisions.filter(
        (item) =>
          canonicalAccount(store, item.supplierAccountId).accountId ===
          scope.supplierAccountId
      )) {
        await saveMappingOnce(
          field,
          stableId("mapping", [field, decision]),
          { kind: field, decision },
          legacyMigration ? "legacy" : "trusted",
          decision.decidedAt
        );
      }
    }
  }

  for (const example of store.learning.supplierExamples) {
    if (example.active === false) continue;
    const canonicalSupplierAccountId = canonicalAccount(
      store,
      example.supplierAccountId
    ).accountId;
    const profile = profilesByAccount.get(canonicalSupplierAccountId);
    const targetGeneration = legacyMigration ? 0 : example.generation;
    if (
      !profile ||
      profile.generation !== targetGeneration ||
      (legacyMigration && isCorroboratedExplicitLearn(store, example))
    ) {
      continue;
    }
    const invoice = store.invoices.find((item) => item.id === example.invoiceId);
    const artifact =
      artifactsByContentHash.get(example.contentHash) ??
      (await repository.saveArtifact(
        artifactInput(
          example.contentHash,
          invoice?.extractedData ??
            example.finalExtractedData ??
            example.originalExtractedData,
          example.learnedAt
        )
      ));
    await repository.saveExample(
      exampleInput(store, example, artifact.id, context)
    );
  }

  if (!legacyMigration) {
    for (const invoice of store.invoices) {
      const selectedAccountId = invoice.purchaseJournal?.supplierResolution.selectedAccountId;
      if (!selectedAccountId) continue;
      const canonicalSupplierAccountId = canonicalAccount(
        store,
        selectedAccountId
      ).accountId;
      const profile = profilesByAccount.get(canonicalSupplierAccountId);
      if (!profile) continue;
      const input = lifecycleExampleInput(
        store,
        invoice,
        canonicalSupplierAccountId,
        profile.generation,
        context
      );
      if (!input) continue;
      const artifact =
        artifactsByContentHash.get(input.contentHash) ??
        (await repository.saveArtifact(
          artifactInput(input.contentHash, invoice.extractedData, input.createdAt)
        ));
      await repository.saveExample({ ...input, artifactId: artifact.id });
    }
  }

  for (const [supplierAccountId, profile] of profilesByAccount) {
    const scope: LearningScope = {
      companyId: profile.companyId,
      divisionCode: profile.divisionCode,
      supplierAccountId,
    };
    const examples = await repository.listExamples(scope);
    const runtimeProfile = runtimeProfileForAccount(store, supplierAccountId);
    const driftState = runtimeProfile?.formatDrift ?? profile.driftState;
    const confidence = supplierReliability({
      ...supplierReliabilityEvidenceFromExamples(examples),
      drift: driftState,
    });
    if (
      profile.confidenceScore !== confidence.score ||
      profile.driftState !== driftState
    ) {
      await repository.updateProfileConfidence({
        ...scope,
        generation: profile.generation,
        score: confidence.score,
        driftState,
        updatedAt: createdAt,
      });
    }
  }
  if (legacyMigration) {
    for (const [supplierAccountId, legacyProfile] of profilesByAccount) {
      const trustedExamples = store.learning.supplierExamples.filter(
        (example) =>
          canonicalAccount(store, example.supplierAccountId).accountId ===
            supplierAccountId &&
          isCorroboratedExplicitLearn(store, example)
      );
      const activeGeneration = Math.max(
        1,
        ...trustedExamples.map((example) => example.generation)
      );
      const activeProfile = completedLegacyAccounts.has(supplierAccountId)
        ? legacyProfile
        : await repository.completeLegacyMigration({
            companyId: legacyProfile.companyId,
            divisionCode: legacyProfile.divisionCode,
            supplierAccountId,
            activeGeneration,
            updatedAt: createdAt,
          });
      if (activeProfile.generation !== activeGeneration) {
        throw new Error(
          "Supplier learning generation changed during legacy migration."
        );
      }
      for (const example of trustedExamples.filter(
        (item) => item.generation === activeGeneration
      )) {
        const invoice = store.invoices.find(
          (item) => item.id === example.invoiceId
        );
        const artifact =
          artifactsByContentHash.get(example.contentHash) ??
          (await repository.saveArtifact(
            artifactInput(
              example.contentHash,
              invoice?.extractedData ??
                example.finalExtractedData ??
                example.originalExtractedData,
              example.learnedAt
            )
          ));
        await repository.saveExample(
          exampleInput(store, example, artifact.id, {
            ...context,
            requestId: stableId("migration-trusted", [example.id]),
          })
        );
      }
      const activeExamples = await repository.listExamples({
        companyId: activeProfile.companyId,
        divisionCode: activeProfile.divisionCode,
        supplierAccountId,
      });
      const confidence = supplierReliability(
        supplierReliabilityEvidenceFromExamples(activeExamples)
      );
      await repository.updateProfileConfidence({
        companyId: activeProfile.companyId,
        divisionCode: activeProfile.divisionCode,
        supplierAccountId,
        generation: activeProfile.generation,
        score: confidence.score,
        driftState: activeProfile.driftState,
        updatedAt: createdAt,
      });
      const migrationKey = stableId("legacy-migration", [
        activeProfile.companyId,
        activeProfile.divisionCode,
        supplierAccountId,
        activeGeneration,
      ]);
      await repository.saveEvent({
        id: stableId("event", [migrationKey]),
        companyId: activeProfile.companyId,
        divisionCode: activeProfile.divisionCode,
        supplierAccountId,
        generation: activeGeneration,
        type: "migration",
        idempotencyKey: migrationKey,
        actorId: "shared_user",
        sessionCorrelationId: "session_unavailable",
        requestId: "legacy-migration",
        metadata: {
          activeGeneration,
          legacyGeneration: 0,
          trustedExampleCount: trustedExamples.filter(
            (example) => example.generation === activeGeneration
          ).length,
        },
        createdAt,
      });
    }
  }
  return true;
}

function restoredPattern(row: PatternRow) {
  const mapping = rowMapping(row);
  if (mapping?.kind !== "runtime_pattern" || !mapping.pattern) return null;
  return mapping.pattern as SupplierLearningPattern;
}

function clearDocumentEvidence(invoice: UploadedInvoice) {
  delete invoice.extractedData.rawText;
  delete invoice.extractedData.extractionEvidence;
  delete invoice.extractedData.documentAnalysis;
}

export async function hydrateLearningState(
  store: IntoStore,
  hydrateNormalizedLearning = true,
  reuseHydratedArtifacts = false
) {
  const repository = await configuredLearningRepository();
  if (!repository) return false;
  const existingArtifactIds = reuseHydratedArtifacts
    ? await repository.existingArtifactIds(
        store.invoices.flatMap((invoice) =>
          invoice.analysisArtifactId ? [invoice.analysisArtifactId] : []
        )
      )
    : null;
  for (const invoice of store.invoices) {
    if (!invoice.analysisArtifactId) continue;
    if (existingArtifactIds) {
      if (!existingArtifactIds.has(invoice.analysisArtifactId)) {
        clearDocumentEvidence(invoice);
      }
      continue;
    }
    const artifact = await repository.readArtifact(invoice.analysisArtifactId);
    if (!artifact) {
      clearDocumentEvidence(invoice);
      continue;
    }
    const analysis = artifact.analysis as {
      documentTextMode?: ExtractedInvoiceData["documentTextMode"];
      extractionEvidence?: ExtractedInvoiceData["extractionEvidence"];
      documentAnalysis?: ExtractedInvoiceData["documentAnalysis"];
    };
    invoice.extractedData.rawText = artifact.rawText;
    invoice.extractedData.documentTextMode =
      analysis.documentTextMode ?? invoice.extractedData.documentTextMode;
    invoice.extractedData.extractionEvidence =
      analysis.extractionEvidence ?? invoice.extractedData.extractionEvidence;
    invoice.extractedData.documentAnalysis =
      analysis.documentAnalysis ?? invoice.extractedData.documentAnalysis;
  }
  const versioned = store as IntoStore & { learningRepositoryMigratedAt?: string };
  if (!versioned.learningRepositoryMigratedAt) {
    versioned.legacyLearningRollback ??= rollbackLearningStore(store.learning);
    const migration = legacyLearningMigrationInput(
      store,
      new Date().toISOString()
    );
    const existing = await repository.getDataMigration(
      migration.migrationName,
      migration.version
    );
    if (!existing) {
      await persistLearningState(
        store,
        { requestId: "legacy-migration" },
        repository
      );
    }
    const recorded = await repository.recordDataMigration(migration);
    versioned.learningRepositoryMigratedAt = recorded.record.completedAt;
  }
  if (!hydrateNormalizedLearning) return true;

  const pendingCorrections = store.learning.corrections.filter(
    (correction) => correction.trustState === "pending"
  );
  const pendingSelections = store.learning.supplierSelections.filter(
    (decision) => decision.trustState === "pending"
  );
  const profiles = await repository.listProfiles(companyId(), divisionCode(store));
  const learning: BookingLearningStore = {
    revision: 1,
    supplierProfiles: [],
    supplierExamples: [],
    supplierPatterns: [],
    supplierSelections: [...pendingSelections],
    glAccountSelections: [],
    vatCodeSelections: [],
    costCentreSelections: [],
    costUnitSelections: [],
    corrections: [...pendingCorrections],
  };

  for (const profile of profiles) {
    const scope: LearningScope = {
      companyId: profile.companyId,
      divisionCode: profile.divisionCode,
      supplierAccountId: profile.supplierAccountId,
    };
    const examples = await repository.listExamples(scope);
    const patterns = await repository.listPatterns(scope);
    const baselineExample = examples[0];
    learning.supplierProfiles.push({
      supplierAccountId: profile.supplierAccountId,
      generation: profile.generation,
      exampleCount: profile.learnedCount,
      lastLearnedAt: profile.lastLearnedAt,
      lastResetAt: profile.lastResetAt,
      formatFingerprint: baselineExample?.fingerprint,
      formatDrift: profile.driftState,
    });
    for (const example of examples) {
      const originalPayload = example.originalPrediction as {
        extractedData?: BookingLearningStore["supplierExamples"][number]["originalExtractedData"];
        bookingLines?: BookingLearningStore["supplierExamples"][number]["originalBookingLines"];
        supplierResolution?: { selectedAccountId?: string };
      };
      const finalPayload = example.finalFields as {
        extractedData?: BookingLearningStore["supplierExamples"][number]["finalExtractedData"];
        corrections?: LearnedCorrection[];
      };
      learning.supplierExamples.push({
        id: example.id,
        supplierAccountId: example.supplierAccountId,
        generation: example.generation,
        invoiceId: example.invoiceId,
        contentHash: example.contentHash,
        formatFingerprint: example.fingerprint,
        formatSignature: example.formatSignature,
        formatCluster: example.formatCluster,
        learnedAt: example.createdAt,
        learnedByUserId: example.actorId,
        originalExtractedData:
          originalPayload.extractedData ??
          (example.originalPrediction as BookingLearningStore["supplierExamples"][number]["originalExtractedData"]),
        finalExtractedData: finalPayload.extractedData,
        originalSupplierAccountId:
          originalPayload.supplierResolution?.selectedAccountId,
        originalBookingLines: originalPayload.bookingLines,
        bookingLines:
          example.bookingLines as BookingLearningStore["supplierExamples"][number]["bookingLines"],
        source: example.source,
        trustState: example.trustState,
        trigger: example.trigger,
        processingPurpose: example.processingPurpose,
        validationResult: example.validationResult,
        active: example.active,
      });
      for (const correction of finalPayload.corrections ?? []) {
        if (!learning.corrections.some((item) => item.id === correction.id)) {
          learning.corrections.push(correction);
        }
      }
    }
    for (const row of patterns) {
      const pattern = restoredPattern(row);
      if (pattern) {
        learning.supplierPatterns.push(pattern);
        continue;
      }
      const mapping = rowMapping(row);
      const kind = String(mapping?.kind ?? "");
      if (kind === "runtime_correction" && mapping?.correction) {
        const correction = mapping.correction as LearnedCorrection;
        if (!learning.corrections.some((item) => item.id === correction.id)) {
          learning.corrections.push(correction);
        }
      } else if (kind === "runtime_supplier_selection" && mapping?.decision) {
        const decision = mapping.decision as SupplierLearningDecision;
        if (
          !learning.supplierSelections.some(
            (item) =>
              item.accountId === decision.accountId &&
              item.supplierIdentity === decision.supplierIdentity
          )
        ) {
          learning.supplierSelections.push(decision);
        }
      } else if (mapping?.decision) {
        const decision = mapping.decision as never;
        if (kind === "runtime_gl_selection") learning.glAccountSelections.push(decision);
        if (kind === "runtime_vat_selection") learning.vatCodeSelections.push(decision);
        if (kind === "runtime_cost_centre_selection") {
          learning.costCentreSelections.push(decision);
        }
        if (kind === "runtime_cost_unit_selection") {
          learning.costUnitSelections.push(decision);
        }
      }
    }
  }
  store.learning = learning;
  return true;
}

export function snapshotWithoutDocumentEvidence(store: IntoStore): IntoStore {
  const snapshot = structuredClone(store);
  const removeDocumentEvidence = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) removeDocumentEvidence(item);
      return;
    }
    const record = value as Record<string, unknown>;
    delete record.rawText;
    delete record.extractionEvidence;
    delete record.documentAnalysis;
    for (const nested of Object.values(record)) removeDocumentEvidence(nested);
  };
  if (snapshot.legacyLearningRollback) {
    snapshot.legacyLearningRollback = rollbackLearningStore(
      snapshot.legacyLearningRollback
    );
  }
  for (const invoice of snapshot.invoices) {
    delete invoice.extractedData.rawText;
    delete invoice.extractedData.extractionEvidence;
    delete invoice.extractedData.documentAnalysis;
    for (const version of invoice.extractionHistory) {
      delete version.extractedData.rawText;
      delete version.extractedData.extractionEvidence;
      delete version.extractedData.documentAnalysis;
    }
    for (const attempt of invoice.bookingAttempts) {
      removeDocumentEvidence(attempt.requestPayload);
      removeDocumentEvidence(attempt.responsePayload);
    }
  }
  snapshot.learning = rollbackLearningStore(snapshot.learning);
  return snapshot;
}

export function snapshotWithoutActiveLearning(store: IntoStore): IntoStore {
  const snapshot = snapshotWithoutDocumentEvidence(store);
  snapshot.learning = {
    revision: 1,
    supplierProfiles: [],
    supplierExamples: [],
    supplierPatterns: [],
    supplierSelections: snapshot.learning.supplierSelections.filter(
      (decision) => decision.trustState === "pending"
    ),
    glAccountSelections: [],
    vatCodeSelections: [],
    costCentreSelections: [],
    costUnitSelections: [],
    corrections: snapshot.learning.corrections.filter(
      (correction) => correction.trustState === "pending"
    ),
  };
  return snapshot;
}
