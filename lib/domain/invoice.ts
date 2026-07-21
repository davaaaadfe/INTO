export const INVOICE_STATUSES = [
  "Uploaded",
  "Reading",
  "Validation Failed",
  "Attachment Missing",
  "Payment Condition Review Required",
  "Booking Intelligence Review Required",
  "Possible Duplicate",
  "Ready to Book",
  "Learned",
  "Booked",
  "Booking Failed",
] as const;

export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
export type InvoiceSource = "manual_upload";
export const LEARNING_ONLY_BOOKING_MESSAGE =
  "Learning-only invoices cannot be booked to Exact Online.";
export type LocalInvoiceFileStatus =
  | "available"
  | "deleted_after_booking"
  | "deleted_by_cleanup"
  | "missing";
export type ValidationSeverity = "error" | "warning";
export type UserStatus = "invited" | "active" | "disabled";
export type PermissionAction =
  | "view"
  | "search_archive"
  | "upload"
  | "edit"
  | "review"
  | "approve"
  | "book"
  | "delete"
  | "manage_connections"
  | "manage_users"
  | "manage_settings"
  | "train"
  | "manage_learning";

export const SHARED_ACCESS_PERMISSIONS = [
  "view",
  "search_archive",
  "upload",
  "edit",
  "review",
  "approve",
  "book",
  "manage_connections",
  "manage_users",
  "manage_settings",
  "train",
  "manage_learning",
] as const satisfies readonly PermissionAction[];

export type IntoUser = {
  id: string;
  email: string;
  name: string;
  status: UserStatus;
  isSystemOwner: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CurrentUserContext = {
  user: IntoUser;
  permissions: PermissionAction[];
};

export type AuditEventType =
  | "invoice_uploaded"
  | "invoice_imported"
  | "invoice_extracted"
  | "invoice_validated"
  | "invoice_field_edited"
  | "invoice_approved"
  | "invoice_booked"
  | "invoice_booking_failed"
  | "invoice_file_deleted"
  | "invoice_file_cleanup"
  | "duplicate_decision"
  | "invoice_reread"
  | "invoice_learned"
  | "supplier_learning_reset"
  | "connection_connected"
  | "connection_disconnected"
  | "token_refresh_success"
  | "token_refresh_failure"
  | "sync_operation";

export type AuditEvent = {
  id: string;
  invoiceId?: string;
  userId: string;
  userName: string;
  type: AuditEventType;
  message: string;
  field?: string;
  oldValue?: unknown;
  newValue?: unknown;
  metadata?: Record<string, unknown>;
  createdAt: string;
};

export type InvoiceLineItem = {
  id: string;
  description: string;
  quantity: number;
  unitPrice: number;
  netAmount: number;
  vatRate: number;
  vatAmount: number;
  grossAmount: number;
};

export type DocumentTextMode =
  | "embedded_pdf_text"
  | "xml_text"
  | "plain_text"
  | "unavailable";

export type ExtractionEvidenceField =
  | "supplierName"
  | "supplierVatNumber"
  | "supplierAddress"
  | "referenceCode"
  | "invoiceDate"
  | "dueDate"
  | "paymentTerms"
  | "currency"
  | "companyVatNumber"
  | "netAmount"
  | "vatAmount"
  | "grossAmount";

export type ExtractionEvidencePoint = {
  readonly x: number;
  readonly y: number;
};

export type ExtractionFieldEvidence = {
  sourceLabel: string;
  rawValue: string;
  confidence: number;
  page?: number;
  context?: string;
  polygon?: readonly ExtractionEvidencePoint[];
};

export type DocumentAnalysisArtifact = {
  readonly pages: readonly {
    readonly pageNumber: number;
    readonly width: number;
    readonly height: number;
    readonly unit: "pixel" | "inch" | "normalized";
    readonly text: string;
    readonly tokens: readonly {
      readonly text: string;
      readonly polygon: readonly ExtractionEvidencePoint[];
      readonly confidence: number;
    }[];
    readonly language?: string;
    readonly tables: readonly {
      readonly rowCount: number;
      readonly columnCount: number;
      readonly cells: readonly {
        readonly rowIndex: number;
        readonly columnIndex: number;
        readonly rowSpan: number;
        readonly columnSpan: number;
        readonly text: string;
        readonly polygon: readonly ExtractionEvidencePoint[];
        readonly confidence: number;
      }[];
    }[];
  }[];
  readonly fieldCandidates: readonly {
    readonly value: string | number | boolean | null;
    readonly field: string;
    readonly label?: string;
    readonly page?: number;
    readonly polygon: readonly ExtractionEvidencePoint[];
    readonly confidence: number;
    readonly source: string;
  }[];
  readonly confidence: number;
  readonly language?: string;
  readonly provider: {
    readonly name: string;
    readonly model?: string;
    readonly modelVersion?: string;
  };
  readonly sourceMode:
    | "embedded_pdf_text"
    | "xml_text"
    | "plain_text"
    | "ocr"
    | "unavailable";
};

export type ExtractedInvoiceData = {
  supplierName: string;
  supplierVatNumber: string;
  supplierChamberOfCommerceNumber: string;
  supplierAddress: string;
  supplierCountry: string;
  invoiceNumber: string;
  referenceCode: string;
  referenceCodeConfidence?: number;
  invoiceDate: string;
  dueDate: string;
  paymentTerms: string;
  currency: string;
  netAmount: number | null;
  vatAmount: number | null;
  grossAmount: number | null;
  iban: string;
  expenseDescription: string;
  beneficiary: string;
  serviceStartDate: string;
  serviceEndDate: string;
  companyVatNumber: string;
  reverseChargeMentioned: boolean;
  intraCommunityMentioned: boolean;
  lineItems: InvoiceLineItem[];
  rawText?: string;
  documentTextMode?: DocumentTextMode;
  extractionEvidence?: Partial<
    Record<ExtractionEvidenceField, ExtractionFieldEvidence>
  >;
  documentAnalysis?: DocumentAnalysisArtifact;
  confidence?: number;
};

export type ValidationError = {
  id: string;
  field:
    | keyof ExtractedInvoiceData
    | "attachment"
    | "duplicate"
    | "file"
    | "supplier"
    | "paymentCondition"
    | "purchaseJournal"
    | "yourRef"
    | "glAccount"
    | "accrualFrom"
    | "accrualTo"
    | "vatCode"
    | "exactMasterData";
  message: string;
  severity: ValidationSeverity;
};

export type ExactSupplierAccount = {
  id: string;
  code: string;
  name: string;
  vatNumber: string;
  iban: string;
  bicCode?: string;
  chamberOfCommerceNumber: string;
  address: string;
  city?: string;
  country: string;
  isSupplier?: boolean;
  paymentConditionCode: string;
  paymentConditionLabel: string;
  defaultGlAccount: string;
  defaultGlAccountName: string;
  defaultCostCentre?: string;
  defaultCostUnit?: string;
  isInBodyEntity: boolean;
};

export type SupplierOverviewRecord = {
  code: string;
  name: string;
  city: string;
  country: string;
  supplier: boolean;
  bankAccount: string;
  bicCode: string;
  address: string;
};

export type SupplierOverviewImport = {
  sourceFileName: string;
  importedAt: string;
  supplierCount: number;
  suppliers: SupplierOverviewRecord[];
};

export type SupplierOverviewImportStatus = Omit<
  SupplierOverviewImport,
  "suppliers"
>;

export type ExactPaymentCondition = {
  code: string;
  label: string;
  days?: number;
  isActive: boolean;
};

export type ExactJournal = {
  code: "60" | "61" | string;
  description: string;
  type: "purchase" | "sales" | "bank" | "general";
  isActive: boolean;
};

export type ExactGlAccount = {
  id?: string;
  code: string;
  name: string;
  isActive: boolean;
};

export type ExactCostCenter = {
  code: string;
  description: string;
  isActive: boolean;
};

export type ExactCostUnit = {
  code: string;
  description: string;
  isActive: boolean;
};

export const INTO_PURCHASE_VAT_CODES = ["4", "5", "6", "7", "8"] as const;

export type IntoPurchaseVatCode = (typeof INTO_PURCHASE_VAT_CODES)[number];

export const INTO_PURCHASE_VAT_CODE_LABELS: Record<IntoPurchaseVatCode, string> = {
  "4": "Domestic_High (21%)",
  "5": "Domestic_Low (9%)",
  "6": "0% VAT",
  "7": "Reverse Charge_INSIDE EU",
  "8": "Reverse Charge_OUTSIDE EU",
};

export const UNSUPPORTED_VAT_CODE_WARNING =
  "Unsupported VAT code detected. VAT code 6 was selected as the safe fallback.";

export function isIntoPurchaseVatCode(value: unknown): value is IntoPurchaseVatCode {
  return (
    typeof value === "string" &&
    (INTO_PURCHASE_VAT_CODES as readonly string[]).includes(value)
  );
}

export function intoPurchaseVatCodeOrFallback(value: unknown): IntoPurchaseVatCode {
  return isIntoPurchaseVatCode(value) ? value : "6";
}

export type ExactVatCode = {
  code: IntoPurchaseVatCode | string;
  description: string;
  percentage: number;
  type: "purchase" | "sales";
  isActive: boolean;
};

export type ExactHistoricalPurchaseBooking = {
  id: string;
  entryId?: string;
  lineId?: string;
  supplierAccountId: string;
  yourRef?: string;
  invoiceNumber?: string;
  invoiceDate?: string;
  description?: string;
  totalAmount?: number;
  lineAmount?: number;
  vatAmount?: number;
  vatPercentage?: number;
  currency?: string;
  paymentConditionCode?: string;
  descriptionKey: string;
  glAccount: string;
  vatCode: "4" | "5" | "6" | "7" | "8" | string;
  costCentre?: string;
  costUnit?: string;
  accrualFrom?: string;
  accrualTo?: string;
};

export type ExactMasterDataCache = {
  source: "exact-online";
  divisionCode: string;
  lastSyncedAt: string;
  staleAfter: string;
  suppliers: ExactSupplierAccount[];
  paymentConditions: ExactPaymentCondition[];
  journals: ExactJournal[];
  glAccounts: ExactGlAccount[];
  costCenters: ExactCostCenter[];
  costUnits: ExactCostUnit[];
  vatCodes: ExactVatCode[];
  historicalPurchaseBookings: ExactHistoricalPurchaseBooking[];
};

export type SupplierMatchCandidate = {
  account: ExactSupplierAccount;
  confidence: number;
  method:
    | "VAT number"
    | "IBAN"
    | "BIC"
    | "Supplier code"
    | "Learned decision"
    | "Exact history"
    | "Name similarity"
    | "Address"
    | "City and country"
    | "Evidence fusion";
  reasoning: string[];
};

export type SupplierResolution = {
  selectedAccountId?: string;
  selectedAccountCode?: string;
  selectedAccountName?: string;
  matchConfidence: number;
  threshold: number;
  method: string;
  reviewRequired: boolean;
  reasonCode?: "supplier_ambiguous" | "supplier_low_confidence";
  candidates: SupplierMatchCandidate[];
  reasoning: string[];
  shadowEvaluation?: {
    selectedAccountId?: string;
    matchConfidence: number;
    reviewRequired: boolean;
    reasonCode?: "supplier_ambiguous" | "supplier_low_confidence";
  };
};

export type BookingDecisionConfidence = {
  supplierMatch: number;
  glAccount: number;
  vatCode: number;
  costCentre: number;
  costUnit: number;
  paymentCondition: number;
  overall: number;
};

export type PurchaseJournalLine = {
  id: string;
  sourceLineItemId?: string;
  glAccount: string;
  glAccountName: string;
  suggestedGlAccount: string;
  finalSelectedAccount: string;
  glConfidence: number;
  description: string;
  from: string;
  to: string;
  benefitStartDate?: string;
  benefitEndDate?: string;
  accrualReason?: string;
  costCentre: string;
  costCentreConfidence: number;
  costUnit: string;
  costUnitConfidence: number;
  vatCode: IntoPurchaseVatCode;
  vatCodeName: string;
  vatConfidence: number;
  vatReasoning: string[];
  percentage: number;
  amount: number;
  vatAmount: number;
  country: string;
  intercompany: string;
  roundingAdjustment: number;
  reviewRequired: boolean;
  reasoning: string[];
};

export type PurchaseJournalBooking = {
  attachmentRequired: boolean;
  attachmentPresent: boolean;
  attachmentStorageKey?: string;
  description: string;
  descriptionTemplate: string;
  paymentConditionCode: string;
  paymentConditionLabel: string;
  invoicePaymentTerms: string;
  paymentConditionMismatch: boolean;
  yourRef: string;
  yourRefUnique: boolean;
  invoiceDateOriginal: string;
  totalAmount: number | null;
  currency: string;
  journal: "60" | "61";
  journalReason: string;
  financialYear: number;
  period: number;
  periodAdjusted: boolean;
  periodAdjustmentLog: string;
  entryNumber: string;
  supplierResolution: SupplierResolution;
  lines: PurchaseJournalLine[];
  totals: {
    lineAmount: number;
    vatAmount: number;
    grossAmount: number;
    difference: number;
  };
  confidenceScores: BookingDecisionConfidence;
  confidenceThreshold: number;
  autoBookAllowed: boolean;
  userApproved: boolean;
  reviewRequired: boolean;
  reviewReasons: string[];
  reasoningLog: string[];
  learningSummary: string[];
};

export type BookingAttempt = {
  id: string;
  invoiceId: string;
  status: "success" | "failed";
  exactBookingId?: string;
  errorMessage?: string;
  requestPayload?: unknown;
  responsePayload?: unknown;
  createdAt: string;
};

export type DuplicateDetectionOutcome =
  | "none"
  | "already_booked"
  | "processed_unbooked"
  | "possible_duplicate";

export type DuplicateResolutionDecision =
  | "blocked_already_booked"
  | "re_read"
  | "keep_existing"
  | "cancel_upload"
  | "continue_anyway";

export type DuplicateInvoiceCandidate = {
  invoiceId: string;
  fileName: string;
  supplierName: string;
  invoiceNumber: string;
  yourRef: string;
  invoiceDate: string;
  totalAmount: number | null;
  status: InvoiceStatus;
  exactBookingId?: string;
  matchScore: number;
  matchReasons: string[];
};

export type DuplicateDetectionResult = {
  id: string;
  outcome: DuplicateDetectionOutcome;
  message: string;
  checkedAt: string;
  checksum?: string;
  candidates: DuplicateInvoiceCandidate[];
};

export type DuplicateDecisionLog = {
  id: string;
  invoiceId?: string;
  duplicateInvoiceId?: string;
  source: InvoiceSource;
  fileName: string;
  checksum?: string;
  detectionOutcome: DuplicateDetectionOutcome;
  decision: DuplicateResolutionDecision;
  message: string;
  exactBookingId?: string;
  createdAt: string;
};

export type ExtractionVersion = {
  id: string;
  version: number;
  reason: "initial" | "manual_edit" | "duplicate_re_read";
  decision?: DuplicateResolutionDecision;
  extractedData: ExtractedInvoiceData;
  createdAt: string;
};

export type UploadedInvoice = {
  id: string;
  userId: string;
  uploadedByUserId: string;
  uploadedByName: string;
  source: InvoiceSource;
  fileName: string;
  fileType: string;
  fileSize: number;
  checksum?: string;
  analysisArtifactId?: string;
  storageKey: string;
  localFileStatus: LocalInvoiceFileStatus;
  status: InvoiceStatus;
  processingPurpose?: "booking" | "learning_only";
  learningState?: "not_saved" | "saving" | "saved" | "failed";
  revision?: number;
  learningMetadata?: {
    exampleId: string;
    supplierAccountId: string;
    generation: number;
    contentHash: string;
    requestFingerprint?: string;
    learnedAt: string;
    learnedByUserId: string;
  };
  lastError?: string;
  exactBookingId?: string;
  exactBookingStatus?: "not_booked" | "booked" | "failed" | string;
  intelligenceApprovedAt?: string;
  duplicateDetection?: DuplicateDetectionResult;
  duplicateResolutionDecision?: DuplicateResolutionDecision;
  extractedData: ExtractedInvoiceData;
  extractionHistory: ExtractionVersion[];
  bookingLineOverrides?: PurchaseJournalLine[];
  learnedFieldsApplied?: LearnableCorrectionField[];
  purchaseJournal: PurchaseJournalBooking | null;
  validationErrors: ValidationError[];
  bookingAttempts: BookingAttempt[];
  deletedAt?: string;
  deletedByUserId?: string;
  createdAt: string;
  updatedAt: string;
};

export type ExactConnection = {
  id: string;
  userId: string;
  divisionCode: string;
  status: "connected" | "needs_reconnect";
  accessTokenCiphertext: string;
  refreshTokenCiphertext: string;
  expiresAt: string;
  scopes: string[];
  createdAt: string;
  updatedAt: string;
};

export type PublicExactConnection = Omit<
  ExactConnection,
  "accessTokenCiphertext" | "refreshTokenCiphertext"
>;

export type InvoiceArchiveSortField =
  | "invoiceDate"
  | "supplier"
  | "amount"
  | "status"
  | "uploader"
  | "uploadedAt";

export type InvoiceArchiveFilters = {
  keyword?: string;
  invoiceDateFrom?: string;
  invoiceDateTo?: string;
  uploadedAtFrom?: string;
  uploadedAtTo?: string;
  supplier?: string;
  amountMin?: number;
  amountMax?: number;
  currency?: string;
  invoiceNumber?: string;
  bookingStatus?: string;
  validationStatus?: string;
  source?: InvoiceSource | "";
  uploadedByUserId?: string;
  exactBookingReference?: string;
  journal?: string;
  glAccount?: string;
  vatCode?: string;
  costCenter?: string;
  costUnit?: string;
  country?: string;
  duplicateStatus?: string;
  sortBy?: InvoiceArchiveSortField;
  sortDirection?: "asc" | "desc";
  page?: number;
  pageSize?: number;
};

export type InvoiceArchiveResult = {
  invoices: UploadedInvoice[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

export type DuplicateCandidate = {
  id: string;
  supplierName: string;
  invoiceNumber: string;
  referenceCode?: string;
};

export type SupplierLearningDecision = {
  supplierIdentity: string;
  accountId: string;
  decidedAt: string;
  invoiceId?: string;
  trustState?: "pending" | "trusted" | "legacy";
};

export type GlAccountLearningDecision = {
  supplierAccountId: string;
  descriptionKey: string;
  glAccount: string;
  decidedAt: string;
};

export type LearnableCorrectionField =
  | "supplier"
  | "yourRefPattern"
  | "invoiceDate"
  | "netAmount"
  | "vatAmount"
  | "totalAmount"
  | "glAccount"
  | "vatCode"
  | "costCentre"
  | "costUnit"
  | "expenseDescription"
  | "paymentCondition"
  | "accrualFrom"
  | "accrualTo"
  | "accrualPeriod"
  | "bookingLineSplit";

export type LearnedCorrection = {
  id: string;
  invoiceId: string;
  field: LearnableCorrectionField;
  supplierIdentity: string;
  supplierName: string;
  supplierAccountId?: string;
  matchKey: string;
  originalValue: unknown;
  correctedValue: unknown;
  invoiceTextContext?: string;
  filenamePattern?: string;
  confidence: number;
  confidenceBefore: number;
  confidenceAfter: number;
  correctedAt: string;
  correctedByUserId: string;
  correctedByUserName: string;
  trustState?: "pending" | "trusted" | "legacy";
  trustedAt?: string;
  trustReason?: "learn" | "approval" | "booking";
  metadata?: Record<string, unknown>;
};

export type SupplierLearningFormatDrift =
  | "none"
  | "possible"
  | "confirmed";

export type SupplierLearningProfile = {
  supplierAccountId: string;
  generation: number;
  exampleCount: number;
  lastLearnedAt?: string;
  lastResetAt?: string;
  formatFingerprint?: string;
  formatDrift: SupplierLearningFormatDrift;
};

export type SupplierLearningExample = {
  id?: string;
  supplierAccountId: string;
  generation: number;
  invoiceId: string;
  contentHash: string;
  formatFingerprint: string;
  learnedAt: string;
  learnedByUserId?: string;
  originalExtractedData?: ExtractedInvoiceData;
  finalExtractedData?: ExtractedInvoiceData;
  originalSupplierAccountId?: string;
  originalBookingLines?: PurchaseJournalLine[];
  bookingLines?: PurchaseJournalLine[];
  source?: "explicit_learn" | "review" | "booking" | "legacy";
  trustState?: "pending" | "trusted" | "legacy";
  trigger?: "learn" | "review" | "booking" | "migration";
  processingPurpose?: "booking" | "learning_only";
  validationResult?: unknown;
  active?: boolean;
};

export type SupplierLearningPattern = {
  supplierAccountId: string;
  generation: number;
  key: string;
  label?: string;
  context?: string;
  dataType?: string;
  relativePosition?: number;
  successes: number;
  attempts: number;
  weight: number;
  formatCluster?: string;
  field?: string;
  anchor?: unknown;
  normalizedRegion?: unknown;
  bookingMapping?: unknown;
  supportCount?: number;
  successCount?: number;
  correctionCount?: number;
  confidence?: number;
  driftState?: SupplierLearningFormatDrift;
  modelVersion?: string;
  active?: boolean;
};

export type SupplierConfidenceBreakdown = {
  score: number;
  band: "Low" | "Medium" | "High";
  copy?: string;
  baseline: 35;
  exampleCount: number;
  distinctExampleCount?: number;
  effectiveExampleCount?: number;
  volume: number;
  quality: number;
  driftPenalty: 0 | 10 | 20;
  metrics?: Array<{
    metric: string;
    label: string;
    weight: number;
    normalizedWeight: number;
    outcomeCount: number;
    attempts: number;
    successes: number;
    quality: number;
    contribution: number;
  }>;
};

export type SupplierLearningSummary = SupplierLearningProfile & {
  confidence: SupplierConfidenceBreakdown;
  supplierCode: string;
  supplierName: string;
};

export function assertInvoiceBookingAllowed(
  invoice: Pick<UploadedInvoice, "processingPurpose" | "status">
) {
  if (invoice.processingPurpose === "learning_only" || invoice.status === "Learned") {
    throw new Error(LEARNING_ONLY_BOOKING_MESSAGE);
  }
}

export type BookingLearningStore = {
  revision: 1;
  supplierProfiles: SupplierLearningProfile[];
  supplierExamples: SupplierLearningExample[];
  supplierPatterns: SupplierLearningPattern[];
  supplierSelections: SupplierLearningDecision[];
  glAccountSelections: GlAccountLearningDecision[];
  vatCodeSelections: Array<{
    supplierAccountId: string;
    descriptionKey: string;
    vatCode: IntoPurchaseVatCode;
    decidedAt: string;
  }>;
  costCentreSelections: Array<{
    supplierAccountId: string;
    glAccount: string;
    costCentre: string;
    decidedAt: string;
  }>;
  costUnitSelections: Array<{
    supplierAccountId: string;
    glAccount: string;
    costUnit: string;
    decidedAt: string;
  }>;
  corrections: LearnedCorrection[];
};

export const emptyExtractedInvoiceData = (): ExtractedInvoiceData => ({
  supplierName: "",
  supplierVatNumber: "",
  supplierChamberOfCommerceNumber: "",
  supplierAddress: "",
  supplierCountry: "",
  invoiceNumber: "",
  referenceCode: "",
  invoiceDate: "",
  dueDate: "",
  paymentTerms: "",
  currency: "EUR",
  netAmount: null,
  vatAmount: null,
  grossAmount: null,
  iban: "",
  expenseDescription: "",
  beneficiary: "",
  serviceStartDate: "",
  serviceEndDate: "",
  companyVatNumber: "",
  reverseChargeMentioned: false,
  intraCommunityMentioned: false,
  lineItems: [],
});
