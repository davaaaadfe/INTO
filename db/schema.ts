import { relations } from "drizzle-orm";
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name"),
    status: text("status", { enum: ["invited", "active", "disabled"] })
      .notNull()
      .default("active"),
    isSystemOwner: integer("is_system_owner", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [uniqueIndex("users_email_idx").on(table.email)]
);

export const uploadedInvoices = sqliteTable(
  "uploaded_invoices",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    uploadedByUserId: text("uploaded_by_user_id")
      .notNull()
      .references(() => users.id),
    uploadedByName: text("uploaded_by_name").notNull(),
    source: text("source", { enum: ["manual_upload"] }).notNull(),
    fileName: text("file_name").notNull(),
    fileType: text("file_type").notNull(),
    fileSize: integer("file_size").notNull(),
    checksum: text("checksum"),
    storageKey: text("storage_key").notNull(),
    status: text("status").notNull(),
    lastError: text("last_error"),
    exactBookingId: text("exact_booking_id"),
    exactBookingStatus: text("exact_booking_status"),
    duplicateDetectionJson: text("duplicate_detection_json"),
    duplicateResolutionDecision: text("duplicate_resolution_decision"),
    purchaseJournalJson: text("purchase_journal_json"),
    intelligenceApprovedAt: integer("intelligence_approved_at", {
      mode: "timestamp_ms",
    }),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
    deletedByUserId: text("deleted_by_user_id").references(() => users.id),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("uploaded_invoices_user_status_idx").on(table.userId, table.status),
    index("uploaded_invoices_uploader_idx").on(table.uploadedByUserId),
    index("uploaded_invoices_source_idx").on(table.source),
    index("uploaded_invoices_archive_status_idx").on(
      table.status,
      table.createdAt
    ),
    index("uploaded_invoices_duplicate_file_idx").on(
      table.fileName,
      table.fileSize,
      table.checksum
    ),
  ]
);

export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    invoiceId: text("invoice_id").references(() => uploadedInvoices.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    userName: text("user_name").notNull(),
    type: text("type").notNull(),
    message: text("message").notNull(),
    field: text("field"),
    oldValueJson: text("old_value_json"),
    newValueJson: text("new_value_json"),
    metadataJson: text("metadata_json"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("audit_events_invoice_idx").on(table.invoiceId, table.createdAt),
    index("audit_events_user_idx").on(table.userId, table.createdAt),
    index("audit_events_type_idx").on(table.type),
  ]
);

export const duplicateDecisionLogs = sqliteTable(
  "duplicate_decision_logs",
  {
    id: text("id").primaryKey(),
    invoiceId: text("invoice_id").references(() => uploadedInvoices.id),
    duplicateInvoiceId: text("duplicate_invoice_id").references(
      () => uploadedInvoices.id
    ),
    source: text("source", { enum: ["manual_upload"] }).notNull(),
    fileName: text("file_name").notNull(),
    checksum: text("checksum"),
    detectionOutcome: text("detection_outcome").notNull(),
    decision: text("decision").notNull(),
    message: text("message").notNull(),
    exactBookingId: text("exact_booking_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("duplicate_decision_logs_invoice_idx").on(table.invoiceId),
    index("duplicate_decision_logs_duplicate_idx").on(table.duplicateInvoiceId),
    index("duplicate_decision_logs_checksum_idx").on(table.checksum),
  ]
);

export const extractionVersionHistories = sqliteTable(
  "extraction_version_histories",
  {
    id: text("id").primaryKey(),
    invoiceId: text("invoice_id")
      .notNull()
      .references(() => uploadedInvoices.id),
    version: integer("version").notNull(),
    reason: text("reason", {
      enum: ["initial", "manual_edit", "duplicate_re_read"],
    }).notNull(),
    decision: text("decision"),
    extractedDataJson: text("extracted_data_json").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("extraction_version_histories_invoice_idx").on(table.invoiceId),
    uniqueIndex("extraction_version_histories_invoice_version_idx").on(
      table.invoiceId,
      table.version
    ),
  ]
);

export const extractedInvoiceData = sqliteTable(
  "extracted_invoice_data",
  {
    id: text("id").primaryKey(),
    invoiceId: text("invoice_id")
      .notNull()
      .references(() => uploadedInvoices.id),
    supplierName: text("supplier_name"),
    supplierVatNumber: text("supplier_vat_number"),
    supplierChamberOfCommerceNumber: text("supplier_chamber_of_commerce_number"),
    supplierAddress: text("supplier_address"),
    supplierCountry: text("supplier_country"),
    invoiceNumber: text("invoice_number"),
    referenceCode: text("reference_code"),
    invoiceDate: text("invoice_date"),
    dueDate: text("due_date"),
    paymentTerms: text("payment_terms"),
    currency: text("currency"),
    netAmount: real("net_amount"),
    vatAmount: real("vat_amount"),
    grossAmount: real("gross_amount"),
    iban: text("iban"),
    expenseDescription: text("expense_description"),
    beneficiary: text("beneficiary"),
    serviceStartDate: text("service_start_date"),
    serviceEndDate: text("service_end_date"),
    companyVatNumber: text("company_vat_number"),
    reverseChargeMentioned: integer("reverse_charge_mentioned", {
      mode: "boolean",
    }),
    intraCommunityMentioned: integer("intra_community_mentioned", {
      mode: "boolean",
    }),
    rawText: text("raw_text"),
    confidence: real("confidence"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("extracted_invoice_data_invoice_idx").on(table.invoiceId),
    index("extracted_invoice_data_duplicate_idx").on(
      table.supplierName,
      table.invoiceNumber
    ),
  ]
);

export const invoiceLineItems = sqliteTable(
  "invoice_line_items",
  {
    id: text("id").primaryKey(),
    extractedDataId: text("extracted_data_id")
      .notNull()
      .references(() => extractedInvoiceData.id),
    description: text("description").notNull(),
    quantity: real("quantity").notNull(),
    unitPrice: real("unit_price").notNull(),
    netAmount: real("net_amount").notNull(),
    vatRate: real("vat_rate").notNull(),
    vatAmount: real("vat_amount").notNull(),
    grossAmount: real("gross_amount").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("invoice_line_items_data_idx").on(table.extractedDataId)]
);

export const validationErrors = sqliteTable(
  "validation_errors",
  {
    id: text("id").primaryKey(),
    invoiceId: text("invoice_id")
      .notNull()
      .references(() => uploadedInvoices.id),
    field: text("field").notNull(),
    message: text("message").notNull(),
    severity: text("severity", { enum: ["error", "warning"] }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("validation_errors_invoice_idx").on(table.invoiceId)]
);

export const exactOnlineConnections = sqliteTable(
  "exact_online_connections",
  {
    id: text("id").primaryKey(),
    connectionScope: text("connection_scope").notNull().default("company"),
    connectionOwnerId: text("connection_owner_id")
      .notNull()
      .default("company_connection"),
    divisionCode: text("division_code"),
    accessTokenCiphertext: text("access_token_ciphertext").notNull(),
    refreshTokenCiphertext: text("refresh_token_ciphertext").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    scopes: text("scopes"),
    status: text("status").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("exact_online_connections_scope_idx").on(table.connectionScope),
  ]
);

export const exactMasterDataCaches = sqliteTable(
  "exact_master_data_caches",
  {
    id: text("id").primaryKey(),
    connectionScope: text("connection_scope").notNull().default("company"),
    connectionOwnerId: text("connection_owner_id")
      .notNull()
      .default("company_connection"),
    exactConnectionId: text("exact_connection_id").references(
      () => exactOnlineConnections.id
    ),
    divisionCode: text("division_code").notNull(),
    payloadJson: text("payload_json").notNull(),
    lastSyncedAt: integer("last_synced_at", { mode: "timestamp_ms" }).notNull(),
    staleAfter: integer("stale_after", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("exact_master_data_caches_scope_division_idx").on(
      table.connectionScope,
      table.divisionCode
    ),
    index("exact_master_data_caches_freshness_idx").on(table.staleAfter),
  ]
);

export const bookingAttempts = sqliteTable(
  "booking_attempts",
  {
    id: text("id").primaryKey(),
    invoiceId: text("invoice_id")
      .notNull()
      .references(() => uploadedInvoices.id),
    exactConnectionId: text("exact_connection_id").references(
      () => exactOnlineConnections.id
    ),
    status: text("status", { enum: ["success", "failed"] }).notNull(),
    requestPayload: text("request_payload"),
    responsePayload: text("response_payload"),
    errorMessage: text("error_message"),
    exactBookingId: text("exact_booking_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("booking_attempts_invoice_idx").on(table.invoiceId)]
);

export const supplierResolutionDecisions = sqliteTable(
  "supplier_resolution_decisions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    supplierIdentity: text("supplier_identity").notNull(),
    exactSupplierAccountId: text("exact_supplier_account_id").notNull(),
    confidence: real("confidence"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("supplier_resolution_decisions_identity_idx").on(
      table.userId,
      table.supplierIdentity
    ),
  ]
);

export const accountMappingDecisions = sqliteTable(
  "account_mapping_decisions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    supplierAccountId: text("supplier_account_id").notNull(),
    descriptionKey: text("description_key").notNull(),
    glAccount: text("gl_account").notNull(),
    vatCode: text("vat_code"),
    costCentre: text("cost_centre"),
    costUnit: text("cost_unit"),
    accrualJson: text("accrual_json"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("account_mapping_decisions_lookup_idx").on(
      table.userId,
      table.supplierAccountId,
      table.descriptionKey
    ),
  ]
);

export const usersRelations = relations(users, ({ many }) => ({
  invoices: many(uploadedInvoices),
  auditEvents: many(auditEvents),
}));

export const uploadedInvoicesRelations = relations(
  uploadedInvoices,
  ({ one, many }) => ({
    user: one(users, {
      fields: [uploadedInvoices.userId],
      references: [users.id],
    }),
    extractedData: one(extractedInvoiceData),
    validationErrors: many(validationErrors),
    bookingAttempts: many(bookingAttempts),
    duplicateDecisionLogs: many(duplicateDecisionLogs, {
      relationName: "invoiceDuplicateDecisionLogs",
    }),
    duplicateMatches: many(duplicateDecisionLogs, {
      relationName: "duplicateInvoiceDecisionLogs",
    }),
    extractionHistory: many(extractionVersionHistories),
    auditEvents: many(auditEvents),
  })
);

export const auditEventsRelations = relations(auditEvents, ({ one }) => ({
  invoice: one(uploadedInvoices, {
    fields: [auditEvents.invoiceId],
    references: [uploadedInvoices.id],
  }),
  user: one(users, {
    fields: [auditEvents.userId],
    references: [users.id],
  }),
}));

export const duplicateDecisionLogsRelations = relations(
  duplicateDecisionLogs,
  ({ one }) => ({
    invoice: one(uploadedInvoices, {
      fields: [duplicateDecisionLogs.invoiceId],
      references: [uploadedInvoices.id],
      relationName: "invoiceDuplicateDecisionLogs",
    }),
    duplicateInvoice: one(uploadedInvoices, {
      fields: [duplicateDecisionLogs.duplicateInvoiceId],
      references: [uploadedInvoices.id],
      relationName: "duplicateInvoiceDecisionLogs",
    }),
  })
);

export const extractionVersionHistoriesRelations = relations(
  extractionVersionHistories,
  ({ one }) => ({
    invoice: one(uploadedInvoices, {
      fields: [extractionVersionHistories.invoiceId],
      references: [uploadedInvoices.id],
    }),
  })
);
