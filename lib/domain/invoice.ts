export const INVOICE_STATUSES = [
  "Uploaded",
  "Reading",
  "Validation Failed",
  "Attachment Missing",
  "Supplier Review Required",
  "Payment Condition Review Required",
  "Booking Intelligence Review Required",
  "Possible Duplicate",
  "Ready to Book",
  "Booked",
  "Booking Failed",
] as const;

export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
export type InvoiceSource = "manual" | "outlook";
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
  | "manage_settings";

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
  | "outlook_categorized"
  | "duplicate_decision"
  | "invoice_reread"
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

export type ExtractedInvoiceData = {
  supplierName: string;
  supplierVatNumber: string;
  supplierChamberOfCommerceNumber: string;
  supplierAddress: string;
  supplierCountry: string;
  invoiceNumber: string;
  referenceCode: string;
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
  chamberOfCommerceNumber: string;
  address: string;
  country: string;
  paymentConditionCode: string;
  paymentConditionLabel: string;
  defaultGlAccount: string;
  defaultGlAccountName: string;
  defaultCostCentre?: string;
  defaultCostUnit?: string;
  isInBodyEntity: boolean;
};

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

export type ExactVatCode = {
  code: "4" | "5" | "6" | "7" | "8" | string;
  description: string;
  percentage: number;
  type: "purchase" | "sales";
  isActive: boolean;
};

export type ExactHistoricalPurchaseBooking = {
  id: string;
  supplierAccountId: string;
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
  method: "VAT number" | "IBAN" | "Learned decision" | "Exact history" | "Name similarity";
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
  candidates: SupplierMatchCandidate[];
  reasoning: string[];
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
  vatCode: "4" | "5" | "6" | "7" | "8";
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
  storageKey: string;
  outlookMessageId?: string;
  status: InvoiceStatus;
  lastError?: string;
  exactBookingId?: string;
  exactBookingStatus?: "not_booked" | "booked" | "failed" | string;
  intelligenceApprovedAt?: string;
  duplicateDetection?: DuplicateDetectionResult;
  duplicateResolutionDecision?: DuplicateResolutionDecision;
  extractedData: ExtractedInvoiceData;
  extractionHistory: ExtractionVersion[];
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

export type OutlookConnection = {
  id: string;
  userId: string;
  mailboxAddress: string;
  status: "connected" | "needs_reconnect";
  accessTokenCiphertext: string;
  refreshTokenCiphertext: string;
  expiresAt: string;
  lastSyncAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type PublicOutlookConnection = Omit<
  OutlookConnection,
  "accessTokenCiphertext" | "refreshTokenCiphertext"
>;

export type OutlookIngestionLog = {
  id: string;
  connectionId: string;
  messageId: string;
  subject: string;
  sender: string;
  category: "INTOed" | "INTO Needs Review" | "No Invoice";
  detectedAttachmentCount: number;
  processedInvoiceId?: string;
  createdAt: string;
};

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
};

export type SupplierLearningDecision = {
  supplierIdentity: string;
  accountId: string;
  decidedAt: string;
};

export type GlAccountLearningDecision = {
  supplierAccountId: string;
  descriptionKey: string;
  glAccount: string;
  decidedAt: string;
};

export type BookingLearningStore = {
  supplierSelections: SupplierLearningDecision[];
  glAccountSelections: GlAccountLearningDecision[];
  vatCodeSelections: Array<{
    supplierAccountId: string;
    descriptionKey: string;
    vatCode: "4" | "5" | "6" | "7" | "8";
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
