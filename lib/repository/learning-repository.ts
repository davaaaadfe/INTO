import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  decryptLearningArtifact,
  encryptLearningArtifact,
} from "../services/learning-artifact-crypto";
import type {
  ExtractedInvoiceData,
} from "../domain/invoice";
import type {
  DocumentAnalysisSourceMode,
  PersistedDocumentAnalysis,
} from "../domain/document-analysis";

export const LEARNING_REPOSITORY_SCHEMA_VERSION = 3;

export class LearningGenerationConflictError extends Error {}

export type LearningScope = {
  companyId: string;
  divisionCode: string;
  supplierAccountId: string;
};

export type LearningProfileRecord = LearningScope & {
  fallbackSupplierCode: string;
  generation: number;
  state: "active" | "paused";
  confidenceScore: number;
  confidenceBreakdownVersion: number;
  driftState: "none" | "possible" | "confirmed";
  learnedCount: number;
  lastLearnedAt?: string;
  lastResetAt?: string;
  version: number;
  evidenceRevision: number;
  derivedEvidenceRevision: number;
  createdAt: string;
  updatedAt: string;
};

export type LearningArtifactAnalysis = {
  documentTextMode?: DocumentAnalysisSourceMode;
  extractionEvidence?: ExtractedInvoiceData["extractionEvidence"];
  documentAnalysis?: PersistedDocumentAnalysis;
};

export type LearningArtifactInput = {
  companyId: string;
  contentHash: string;
  rawText: string;
  analysis: LearningArtifactAnalysis;
  detectedLanguage?: string;
  provider: string;
  modelVersion: string;
  retentionUntil?: string;
  createdAt: string;
};

export type LearningArtifactRecord = Omit<
  LearningArtifactInput,
  "rawText" | "analysis"
> & {
  id: string;
  rawTextCiphertext: string;
  analysisCiphertext: string;
};

export type LearningExampleInput = LearningScope & {
  id: string;
  generation: number;
  invoiceId: string;
  artifactId?: string;
  contentHash: string;
  originalFilename: string;
  originalPrediction: unknown;
  finalFields: unknown;
  bookingLines: unknown;
  observationState?: Record<
    string,
    "observed" | "reviewed_empty" | "unknown"
  >;
  fingerprint: string;
  fingerprintVersion: string;
  formatSignature?: string;
  formatCluster?: string;
  validationResult: unknown;
  processingPurpose: "booking" | "learning_only";
  source: "explicit_learn" | "review" | "booking" | "legacy";
  trustState: "pending" | "trusted" | "legacy";
  trigger: "learn" | "review" | "booking" | "migration";
  actorId: string;
  sessionCorrelationId: string;
  requestId: string;
  createdAt: string;
};

export type LearningExampleRecord = LearningExampleInput & {
  active: boolean;
  supersededById?: string;
};

export type LearningAliasInput = LearningScope & {
  id: string;
  generation: number;
  kind: "vat" | "iban" | "bic" | "code" | "coc" | "name" | "address";
  normalizedValue: string;
  source: "exact" | "learned" | "legacy";
  createdAt: string;
};

export type LearningPatternInput = LearningScope & {
  id: string;
  generation: number;
  formatCluster: string;
  field: string;
  patternKey: string;
  label?: string;
  anchor?: unknown;
  normalizedRegion?: unknown;
  dataType?: string;
  bookingMapping?: unknown;
  supportCount: number;
  successCount: number;
  correctionCount: number;
  driftState: "none" | "possible" | "confirmed";
  modelVersion: string;
  createdAt: string;
};

export type ReplaceDerivedPatternsInput = LearningScope & {
  generation: number;
  modelVersion: string;
  patterns: LearningPatternInput[];
  updatedAt: string;
};

export type LearningEventRecord = LearningScope & {
  id: string;
  generation: number;
  type:
    | "learn"
    | "correction"
    | "confirmation"
    | "application"
    | "acceptance"
    | "rejection"
    | "validation"
    | "migration"
    | "drift"
    | "reset";
  idempotencyKey: string;
  actorId: string;
  sessionCorrelationId: string;
  requestId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type LearningDataMigrationInput = {
  migrationName: string;
  version: number;
  sourceSnapshotRevision?: number;
  sourceSnapshotHash?: string;
  rowCounts: Record<string, number>;
  checksum: string;
  startedAt: string;
  completedAt: string;
};

export type LearningDataMigrationRecord = LearningDataMigrationInput & {
  status: "completed";
};

type ProfileRow = {
  company_id: string;
  division_code: string;
  supplier_account_id: string;
  fallback_supplier_code: string;
  generation: number;
  state: "active" | "paused";
  confidence_score: number;
  confidence_breakdown_version: number;
  drift_state: "none" | "possible" | "confirmed";
  learned_count: number;
  last_learned_at: string | null;
  last_reset_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  evidence_revision: number;
  derived_evidence_revision: number;
};

type ExampleRow = {
  id: string;
  company_id: string;
  division_code: string;
  supplier_account_id: string;
  generation: number;
  invoice_id: string;
  artifact_id: string | null;
  content_hash: string;
  original_filename: string;
  original_prediction_json: string;
  final_fields_json: string;
  booking_lines_json: string;
  observation_state_json: string;
  fingerprint: string;
  fingerprint_version: string;
  format_signature: string;
  format_cluster: string;
  validation_result_json: string;
  processing_purpose: "booking" | "learning_only";
  source: LearningExampleInput["source"];
  trust_state: LearningExampleInput["trustState"];
  trigger: LearningExampleInput["trigger"];
  actor_id: string;
  session_correlation_id: string;
  request_id: string;
  active: number;
  superseded_by_id: string | null;
  created_at: string;
};

const migrationTable = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS supplier_learning_schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );
`;

const migration = `
  CREATE TABLE IF NOT EXISTS supplier_learning_profiles (
    company_id TEXT NOT NULL,
    division_code TEXT NOT NULL,
    supplier_account_id TEXT NOT NULL,
    fallback_supplier_code TEXT NOT NULL DEFAULT '',
    generation INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'active',
    confidence_score INTEGER NOT NULL DEFAULT 35,
    confidence_breakdown_version INTEGER NOT NULL DEFAULT 1,
    drift_state TEXT NOT NULL DEFAULT 'none',
    learned_count INTEGER NOT NULL DEFAULT 0,
    last_learned_at TEXT,
    last_reset_at TEXT,
    version INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (company_id, division_code, supplier_account_id)
  );
  CREATE TABLE IF NOT EXISTS supplier_identity_aliases (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL,
    division_code TEXT NOT NULL,
    supplier_account_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    kind TEXT NOT NULL,
    normalized_value TEXT NOT NULL,
    source TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS supplier_identity_alias_lookup_idx
    ON supplier_identity_aliases (
      company_id, division_code, kind, normalized_value, active
    );
  CREATE TABLE IF NOT EXISTS document_analysis_artifacts (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    raw_text_ciphertext TEXT NOT NULL,
    analysis_ciphertext TEXT NOT NULL,
    detected_language TEXT,
    provider TEXT NOT NULL,
    model_version TEXT NOT NULL,
    retention_until TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (company_id, content_hash)
  );
  CREATE TABLE IF NOT EXISTS supplier_learning_examples (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL,
    division_code TEXT NOT NULL,
    supplier_account_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    invoice_id TEXT NOT NULL,
    artifact_id TEXT REFERENCES document_analysis_artifacts(id),
    content_hash TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    original_prediction_json TEXT NOT NULL,
    final_fields_json TEXT NOT NULL,
    booking_lines_json TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    fingerprint_version TEXT NOT NULL,
    validation_result_json TEXT NOT NULL,
    processing_purpose TEXT NOT NULL,
    source TEXT NOT NULL,
    trust_state TEXT NOT NULL,
    trigger TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    session_correlation_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    superseded_by_id TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (
      company_id, division_code, supplier_account_id, generation, content_hash
    )
  );
  CREATE INDEX IF NOT EXISTS supplier_learning_examples_active_idx
    ON supplier_learning_examples (
      company_id, division_code, supplier_account_id, generation, active
    );
  CREATE TABLE IF NOT EXISTS supplier_learning_patterns (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL,
    division_code TEXT NOT NULL,
    supplier_account_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    format_cluster TEXT NOT NULL,
    field TEXT NOT NULL,
    pattern_key TEXT NOT NULL,
    label TEXT,
    anchor_json TEXT,
    normalized_region_json TEXT,
    data_type TEXT,
    booking_mapping_json TEXT,
    support_count REAL NOT NULL DEFAULT 0,
    success_count REAL NOT NULL DEFAULT 0,
    correction_count REAL NOT NULL DEFAULT 0,
    confidence REAL NOT NULL DEFAULT 0,
    drift_state TEXT NOT NULL DEFAULT 'none',
    model_version TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (
      company_id, division_code, supplier_account_id, generation,
      format_cluster, field, pattern_key
    )
  );
  CREATE TABLE IF NOT EXISTS supplier_learning_events (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL,
    division_code TEXT NOT NULL,
    supplier_account_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    type TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    session_correlation_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (company_id, idempotency_key)
  );
  CREATE INDEX IF NOT EXISTS supplier_learning_events_supplier_idx
    ON supplier_learning_events (
      company_id, division_code, supplier_account_id, generation, created_at
    );
`;

const migrationV2 = `
  ALTER TABLE supplier_learning_profiles
    ADD COLUMN evidence_revision INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE supplier_learning_profiles
    ADD COLUMN derived_evidence_revision INTEGER NOT NULL DEFAULT 0;
  DROP INDEX IF EXISTS supplier_learning_examples_active_idx;
  ALTER TABLE supplier_learning_examples RENAME TO supplier_learning_examples_v1;
  CREATE TABLE supplier_learning_examples (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL,
    division_code TEXT NOT NULL,
    supplier_account_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    invoice_id TEXT NOT NULL,
    artifact_id TEXT REFERENCES document_analysis_artifacts(id),
    content_hash TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    original_prediction_json TEXT NOT NULL,
    final_fields_json TEXT NOT NULL,
    booking_lines_json TEXT NOT NULL,
    observation_state_json TEXT NOT NULL DEFAULT '{}',
    fingerprint TEXT NOT NULL,
    fingerprint_version TEXT NOT NULL,
    validation_result_json TEXT NOT NULL,
    processing_purpose TEXT NOT NULL,
    source TEXT NOT NULL,
    trust_state TEXT NOT NULL,
    trigger TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    session_correlation_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    superseded_by_id TEXT,
    deactivated_at TEXT,
    created_at TEXT NOT NULL
  );
  INSERT INTO supplier_learning_examples (
    id, company_id, division_code, supplier_account_id, generation,
    invoice_id, artifact_id, content_hash, original_filename,
    original_prediction_json, final_fields_json, booking_lines_json,
    fingerprint, fingerprint_version, validation_result_json,
    processing_purpose, source, trust_state, trigger, actor_id,
    session_correlation_id, request_id, active, superseded_by_id, created_at
  )
  SELECT
    id, company_id, division_code, supplier_account_id, generation,
    invoice_id, artifact_id, content_hash, original_filename,
    original_prediction_json, final_fields_json, booking_lines_json,
    fingerprint, fingerprint_version, validation_result_json,
    processing_purpose, source, trust_state, trigger, actor_id,
    session_correlation_id, request_id, active, superseded_by_id, created_at
  FROM supplier_learning_examples_v1;
  DROP TABLE supplier_learning_examples_v1;
  CREATE INDEX supplier_learning_examples_active_idx
    ON supplier_learning_examples (
      company_id, division_code, supplier_account_id, generation, active
    );
  CREATE UNIQUE INDEX supplier_learning_examples_active_hash_uidx
    ON supplier_learning_examples (
      company_id, division_code, supplier_account_id, generation, content_hash
    ) WHERE active = 1;
  ALTER TABLE supplier_learning_patterns
    ADD COLUMN evidence_revision INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE supplier_learning_events
    ADD COLUMN payload_fingerprint TEXT NOT NULL DEFAULT '';
  CREATE TABLE IF NOT EXISTS supplier_learning_corrections (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL,
    division_code TEXT NOT NULL,
    supplier_account_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    invoice_id TEXT NOT NULL,
    invoice_revision INTEGER NOT NULL,
    artifact_id TEXT REFERENCES document_analysis_artifacts(id),
    format_cluster TEXT,
    field TEXT NOT NULL,
    slot_key TEXT NOT NULL DEFAULT '',
    before_ciphertext TEXT NOT NULL,
    after_ciphertext TEXT NOT NULL,
    evidence_ciphertext TEXT NOT NULL,
    after_value_fingerprint TEXT NOT NULL,
    trust_state TEXT NOT NULL,
    reason TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    session_correlation_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    promoted_at TEXT,
    deactivated_at TEXT,
    UNIQUE (
      company_id, division_code, supplier_account_id, invoice_id,
      invoice_revision, field, slot_key, after_value_fingerprint
    )
  );
  CREATE INDEX IF NOT EXISTS supplier_learning_corrections_scope_idx
    ON supplier_learning_corrections (
      company_id, division_code, supplier_account_id, generation, active
    );
  CREATE TABLE IF NOT EXISTS supplier_learning_data_migrations (
    migration_name TEXT NOT NULL,
    version INTEGER NOT NULL,
    source_snapshot_revision INTEGER,
    source_snapshot_hash TEXT,
    status TEXT NOT NULL,
    row_counts_json TEXT NOT NULL DEFAULT '{}',
    checksum TEXT NOT NULL,
    error_code TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    PRIMARY KEY (migration_name, version)
  );
`;

const migrationV3 = `
  ALTER TABLE supplier_learning_examples
    ADD COLUMN format_signature TEXT NOT NULL DEFAULT '';
  ALTER TABLE supplier_learning_examples
    ADD COLUMN format_cluster TEXT NOT NULL DEFAULT '';
`;

export const SQLITE_LEARNING_MIGRATIONS = [
  { version: 1, sql: migration },
  { version: 2, sql: migrationV2 },
  { version: 3, sql: migrationV3 },
] as const;

function profileFromRow(row: ProfileRow): LearningProfileRecord {
  return {
    companyId: row.company_id,
    divisionCode: row.division_code,
    supplierAccountId: row.supplier_account_id,
    fallbackSupplierCode: row.fallback_supplier_code,
    generation: row.generation,
    state: row.state,
    confidenceScore: row.confidence_score,
    confidenceBreakdownVersion: row.confidence_breakdown_version,
    driftState: row.drift_state,
    learnedCount: row.learned_count,
    lastLearnedAt: row.last_learned_at ?? undefined,
    lastResetAt: row.last_reset_at ?? undefined,
    version: row.version,
    evidenceRevision: row.evidence_revision,
    derivedEvidenceRevision: row.derived_evidence_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function exampleFromRow(row: ExampleRow): LearningExampleRecord {
  return {
    id: row.id,
    companyId: row.company_id,
    divisionCode: row.division_code,
    supplierAccountId: row.supplier_account_id,
    generation: row.generation,
    invoiceId: row.invoice_id,
    artifactId: row.artifact_id ?? undefined,
    contentHash: row.content_hash,
    originalFilename: row.original_filename,
    originalPrediction: JSON.parse(row.original_prediction_json),
    finalFields: JSON.parse(row.final_fields_json),
    bookingLines: JSON.parse(row.booking_lines_json),
    observationState: JSON.parse(row.observation_state_json || "{}"),
    fingerprint: row.fingerprint,
    fingerprintVersion: row.fingerprint_version,
    formatSignature: row.format_signature || undefined,
    formatCluster: row.format_cluster || `fingerprint_${row.fingerprint}`,
    validationResult: JSON.parse(row.validation_result_json),
    processingPurpose: row.processing_purpose,
    source: row.source,
    trustState: row.trust_state,
    trigger: row.trigger,
    actorId: row.actor_id,
    sessionCorrelationId: row.session_correlation_id,
    requestId: row.request_id,
    active: Boolean(row.active),
    supersededById: row.superseded_by_id ?? undefined,
    createdAt: row.created_at,
  };
}

export class SqliteLearningRepository {
  private readonly database: DatabaseSync;
  private readonly ownsDatabase: boolean;

  constructor(databasePath: string) {
    const resolvedPath = resolve(databasePath);
    mkdirSync(dirname(resolvedPath), { recursive: true });
    this.database = new DatabaseSync(resolvedPath);
    this.ownsDatabase = true;
    this.database.exec("PRAGMA journal_mode = WAL;");
  }

  static fromDatabase(database: DatabaseSync) {
    const repository = Object.create(
      SqliteLearningRepository.prototype
    ) as SqliteLearningRepository;
    Object.assign(repository, { database, ownsDatabase: false });
    return repository;
  }

  private async inTransaction<T>(operation: () => T | Promise<T>) {
    const ownsTransaction = !this.database.isTransaction;
    if (ownsTransaction) this.database.exec("BEGIN IMMEDIATE;");
    try {
      const result = await operation();
      if (ownsTransaction) this.database.exec("COMMIT;");
      return result;
    } catch (error) {
      if (ownsTransaction && this.database.isTransaction) {
        this.database.exec("ROLLBACK;");
      }
      throw error;
    }
  }

  async migrate() {
    this.database.exec(migrationTable);
    const current = this.database
      .prepare(
        "SELECT MAX(version) AS version FROM supplier_learning_schema_migrations"
      )
      .get() as { version: number | null };
    if ((current.version ?? 0) > LEARNING_REPOSITORY_SCHEMA_VERSION) {
      throw new Error(
        `Learning database schema ${current.version} is newer than supported schema ${LEARNING_REPOSITORY_SCHEMA_VERSION}.`
      );
    }
    if ((current.version ?? 0) === LEARNING_REPOSITORY_SCHEMA_VERSION) {
      return;
    }

    for (const migrationStep of SQLITE_LEARNING_MIGRATIONS) {
      if (migrationStep.version <= (current.version ?? 0)) continue;
      this.database.exec("BEGIN IMMEDIATE;");
      try {
        this.database.exec(migrationStep.sql);
        this.database
          .prepare(
            "INSERT OR IGNORE INTO supplier_learning_schema_migrations (version, applied_at) VALUES (?, ?)"
          )
          .run(migrationStep.version, new Date().toISOString());
        this.database.exec("COMMIT;");
      } catch (error) {
        this.database.exec("ROLLBACK;");
        throw error;
      }
    }
  }

  async schemaVersion() {
    const row = this.database
      .prepare("SELECT MAX(version) AS version FROM supplier_learning_schema_migrations")
      .get() as { version: number | null };
    return row.version ?? 0;
  }

  async tableNames() {
    const rows = this.database
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN (
           'document_analysis_artifacts',
           'supplier_identity_aliases',
           'supplier_learning_corrections',
           'supplier_learning_data_migrations',
           'supplier_learning_events',
           'supplier_learning_examples',
           'supplier_learning_patterns',
           'supplier_learning_profiles',
           'supplier_learning_schema_migrations'
         ) ORDER BY name`
      )
      .all() as Array<{ name: string }>;
    return rows.map((row) => row.name);
  }

  async ensureProfile(
    input: LearningScope & {
      fallbackSupplierCode: string;
      generation?: number;
      createdAt: string;
    }
  ) {
    this.database
      .prepare(
        `INSERT INTO supplier_learning_profiles (
          company_id, division_code, supplier_account_id, generation,
          fallback_supplier_code, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(company_id, division_code, supplier_account_id) DO UPDATE SET
          fallback_supplier_code = CASE
            WHEN supplier_learning_profiles.fallback_supplier_code = ''
              THEN excluded.fallback_supplier_code
            ELSE supplier_learning_profiles.fallback_supplier_code
          END,
          generation = CASE
            WHEN supplier_learning_profiles.learned_count = 0
              AND supplier_learning_profiles.generation < excluded.generation
              THEN excluded.generation
            ELSE supplier_learning_profiles.generation
          END`
      )
      .run(
        input.companyId,
        input.divisionCode,
        input.supplierAccountId,
        input.generation ?? 0,
        input.fallbackSupplierCode,
        input.createdAt,
        input.createdAt
      );
    const profile = await this.getProfile(input);
    if (!profile) {
      throw new Error("Supplier learning profile could not be created.");
    }
    return profile;
  }

  async getProfile(scope: LearningScope) {
    const row = this.database
      .prepare(
        `SELECT * FROM supplier_learning_profiles
         WHERE company_id = ? AND division_code = ? AND supplier_account_id = ?`
      )
      .get(
        scope.companyId,
        scope.divisionCode,
        scope.supplierAccountId
      ) as ProfileRow | undefined;
    return row ? profileFromRow(row) : null;
  }

  async listProfiles(companyId: string, divisionCode: string) {
    const rows = this.database
      .prepare(
        `SELECT profiles.* FROM supplier_learning_profiles AS profiles
         WHERE profiles.company_id = ? AND profiles.division_code = ?
           AND (
             profiles.learned_count > 0
             OR profiles.last_reset_at IS NOT NULL
             OR EXISTS (
               SELECT 1 FROM supplier_learning_examples AS examples
               WHERE examples.company_id = profiles.company_id
                 AND examples.division_code = profiles.division_code
                 AND examples.supplier_account_id = profiles.supplier_account_id
                 AND examples.generation = profiles.generation
                 AND examples.active = 1
             )
             OR EXISTS (
               SELECT 1 FROM supplier_learning_patterns AS patterns
               WHERE patterns.company_id = profiles.company_id
                 AND patterns.division_code = profiles.division_code
                 AND patterns.supplier_account_id = profiles.supplier_account_id
                 AND patterns.generation = profiles.generation
                 AND patterns.active = 1
             )
             OR EXISTS (
               SELECT 1 FROM supplier_identity_aliases AS aliases
               WHERE aliases.company_id = profiles.company_id
                 AND aliases.division_code = profiles.division_code
                 AND aliases.supplier_account_id = profiles.supplier_account_id
                 AND aliases.source <> 'exact'
                 AND aliases.active = 1
             )
           )
         ORDER BY profiles.supplier_account_id`
      )
      .all(companyId, divisionCode) as ProfileRow[];
    return rows.map(profileFromRow);
  }

  async updateProfileConfidence(
    input: LearningScope & {
      generation: number;
      score: number;
      driftState: LearningProfileRecord["driftState"];
      updatedAt: string;
    }
  ) {
    await this.inTransaction(() => {
      this.requireCurrentGeneration(input);
      this.database
        .prepare(
          `UPDATE supplier_learning_profiles
           SET confidence_score = ?, confidence_breakdown_version = 1,
               drift_state = ?, updated_at = ?, version = version + 1
           WHERE company_id = ? AND division_code = ?
             AND supplier_account_id = ? AND generation = ?`
        )
        .run(
          input.score,
          input.driftState,
          input.updatedAt,
          input.companyId,
          input.divisionCode,
          input.supplierAccountId,
          input.generation
        );
    });
  }

  private requireCurrentGeneration(input: LearningScope & { generation: number }) {
    const row = this.database
      .prepare(
        `SELECT generation FROM supplier_learning_profiles
         WHERE company_id = ? AND division_code = ? AND supplier_account_id = ?`
      )
      .get(input.companyId, input.divisionCode, input.supplierAccountId) as
      | { generation: number }
      | undefined;
    if (!row || row.generation !== input.generation) {
      throw new LearningGenerationConflictError(
        "Supplier learning generation changed. Refresh and try again."
      );
    }
  }

  async saveArtifact(input: LearningArtifactInput) {
    const existing = this.database
      .prepare(
        `SELECT * FROM document_analysis_artifacts
         WHERE company_id = ? AND content_hash = ?`
      )
      .get(input.companyId, input.contentHash) as
      | {
          id: string;
          company_id: string;
          content_hash: string;
          raw_text_ciphertext: string;
          analysis_ciphertext: string;
          detected_language: string | null;
          provider: string;
          model_version: string;
          retention_until: string | null;
          created_at: string;
        }
      | undefined;
    if (existing) {
      return {
        id: existing.id,
        companyId: existing.company_id,
        contentHash: existing.content_hash,
        rawTextCiphertext: existing.raw_text_ciphertext,
        analysisCiphertext: existing.analysis_ciphertext,
        detectedLanguage: existing.detected_language ?? undefined,
        provider: existing.provider,
        modelVersion: existing.model_version,
        retentionUntil: existing.retention_until ?? undefined,
        createdAt: existing.created_at,
      } satisfies LearningArtifactRecord;
    }

    const record: LearningArtifactRecord = {
      id: `artifact_${randomUUID()}`,
      companyId: input.companyId,
      contentHash: input.contentHash,
      rawTextCiphertext: await encryptLearningArtifact(
        input.rawText,
        input.contentHash
      ),
      analysisCiphertext: await encryptLearningArtifact(
        JSON.stringify(input.analysis),
        input.contentHash
      ),
      detectedLanguage: input.detectedLanguage,
      provider: input.provider,
      modelVersion: input.modelVersion,
      retentionUntil: input.retentionUntil,
      createdAt: input.createdAt,
    };
    this.database
      .prepare(
        `INSERT OR IGNORE INTO document_analysis_artifacts (
          id, company_id, content_hash, raw_text_ciphertext,
          analysis_ciphertext, detected_language, provider, model_version,
          retention_until, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.companyId,
        record.contentHash,
        record.rawTextCiphertext,
        record.analysisCiphertext,
        record.detectedLanguage ?? null,
        record.provider,
        record.modelVersion,
        record.retentionUntil ?? null,
        record.createdAt
      );
    const stored = this.database
      .prepare(
        `SELECT * FROM document_analysis_artifacts
         WHERE company_id = ? AND content_hash = ?`
      )
      .get(input.companyId, input.contentHash) as {
        id: string;
        company_id: string;
        content_hash: string;
        raw_text_ciphertext: string;
        analysis_ciphertext: string;
        detected_language: string | null;
        provider: string;
        model_version: string;
        retention_until: string | null;
        created_at: string;
      };
    return {
      id: stored.id,
      companyId: stored.company_id,
      contentHash: stored.content_hash,
      rawTextCiphertext: stored.raw_text_ciphertext,
      analysisCiphertext: stored.analysis_ciphertext,
      detectedLanguage: stored.detected_language ?? undefined,
      provider: stored.provider,
      modelVersion: stored.model_version,
      retentionUntil: stored.retention_until ?? undefined,
      createdAt: stored.created_at,
    } satisfies LearningArtifactRecord;
  }

  async rawArtifact(id: string) {
    const row = this.database
      .prepare(
        `SELECT raw_text_ciphertext, analysis_ciphertext
         FROM document_analysis_artifacts WHERE id = ?`
      )
      .get(id) as
      | { raw_text_ciphertext: string; analysis_ciphertext: string }
      | undefined;
    return row
      ? {
          rawTextCiphertext: row.raw_text_ciphertext,
          analysisCiphertext: row.analysis_ciphertext,
        }
      : null;
  }

  async existingArtifactIds(ids: string[]) {
    const uniqueIds = [...new Set(ids)];
    if (!uniqueIds.length) return new Set<string>();
    const placeholders = uniqueIds.map(() => "?").join(",");
    const rows = this.database
      .prepare(
        `SELECT id FROM document_analysis_artifacts WHERE id IN (${placeholders})`
      )
      .all(...uniqueIds) as Array<{ id: string }>;
    return new Set(rows.map((row) => row.id));
  }

  async readArtifact(id: string) {
    const row = this.database
      .prepare(
        `SELECT content_hash, raw_text_ciphertext, analysis_ciphertext
         FROM document_analysis_artifacts WHERE id = ?`
      )
      .get(id) as
      | {
          content_hash: string;
          raw_text_ciphertext: string;
          analysis_ciphertext: string;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      rawText: await decryptLearningArtifact(
        row.raw_text_ciphertext,
        row.content_hash
      ),
      analysis: JSON.parse(
        await decryptLearningArtifact(
          row.analysis_ciphertext,
          row.content_hash
        )
      ) as LearningArtifactAnalysis,
    };
  }

  async pruneExpiredArtifacts(currentTime: string) {
    return this.inTransaction(() => {
      this.database
        .prepare(
          `UPDATE supplier_learning_examples SET artifact_id = NULL
           WHERE artifact_id IN (
             SELECT id FROM document_analysis_artifacts
             WHERE retention_until IS NOT NULL AND retention_until <= ?
           )`
        )
        .run(currentTime);
      const result = this.database
        .prepare(
          `DELETE FROM document_analysis_artifacts
           WHERE retention_until IS NOT NULL AND retention_until <= ?`
        )
        .run(currentTime);
      return Number(result.changes);
    });
  }

  async saveExample(input: LearningExampleInput) {
    return this.inTransaction(() => {
      this.requireCurrentGeneration(input);
      const existing = this.database
        .prepare(
          `SELECT * FROM supplier_learning_examples
           WHERE company_id = ? AND division_code = ?
             AND supplier_account_id = ? AND generation = ? AND content_hash = ?
             AND active = 1`
        )
        .get(
          input.companyId,
          input.divisionCode,
          input.supplierAccountId,
          input.generation,
          input.contentHash
        ) as ExampleRow | undefined;
      const sameTruth =
        existing &&
        JSON.stringify(JSON.parse(existing.final_fields_json)) ===
          JSON.stringify(input.finalFields) &&
        JSON.stringify(JSON.parse(existing.booking_lines_json)) ===
          JSON.stringify(input.bookingLines);
      if (sameTruth) {
        return { example: exampleFromRow(existing), created: false };
      }
      if (existing) {
        this.database
          .prepare(
            `UPDATE supplier_learning_examples
             SET active = 0, superseded_by_id = ?, deactivated_at = ?
             WHERE id = ? AND active = 1`
          )
          .run(input.id, input.createdAt, existing.id);
      }

      this.database
        .prepare(
          `INSERT INTO supplier_learning_examples (
            id, company_id, division_code, supplier_account_id, generation,
            invoice_id, artifact_id, content_hash, original_filename,
            original_prediction_json, final_fields_json, booking_lines_json,
            fingerprint, fingerprint_version, validation_result_json,
            processing_purpose, source, trust_state, trigger, actor_id,
            session_correlation_id, request_id, active, created_at,
            observation_state_json, format_signature, format_cluster
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?
          )`
        )
        .run(
          input.id,
          input.companyId,
          input.divisionCode,
          input.supplierAccountId,
          input.generation,
          input.invoiceId,
          input.artifactId ?? null,
          input.contentHash,
          input.originalFilename,
          JSON.stringify(input.originalPrediction),
          JSON.stringify(input.finalFields),
          JSON.stringify(input.bookingLines),
          input.fingerprint,
          input.fingerprintVersion,
          JSON.stringify(input.validationResult),
          input.processingPurpose,
          input.source,
          input.trustState,
          input.trigger,
          input.actorId,
          input.sessionCorrelationId,
          input.requestId,
          input.createdAt,
          JSON.stringify(input.observationState ?? {}),
          input.formatSignature ?? "",
          input.formatCluster ?? `fingerprint_${input.fingerprint}`
        );
      this.database
        .prepare(
          `UPDATE supplier_learning_profiles
           SET learned_count = learned_count + ?,
               last_learned_at = ?, updated_at = ?, version = version + 1,
               evidence_revision = evidence_revision + 1
           WHERE company_id = ? AND division_code = ?
             AND supplier_account_id = ? AND generation = ?`
        )
        .run(
          existing ? 0 : 1,
          input.createdAt,
          input.createdAt,
          input.companyId,
          input.divisionCode,
          input.supplierAccountId,
          input.generation
        );
      this.insertEvent({
        ...input,
        id: `event_${randomUUID()}`,
        type: "learn",
        idempotencyKey: `learn:${input.supplierAccountId}:${input.generation}:${input.contentHash}:${input.id}`,
        metadata: {
          invoiceId: input.invoiceId,
          exampleId: input.id,
          trigger: input.trigger,
        },
      });
      const inserted = this.database
        .prepare("SELECT * FROM supplier_learning_examples WHERE id = ?")
        .get(input.id) as ExampleRow;
      return { example: exampleFromRow(inserted), created: true };
    });
  }

  async listExamples(scope: LearningScope, includeInactive = false) {
    const rows = this.database
      .prepare(
        `SELECT examples.* FROM supplier_learning_examples AS examples
         JOIN supplier_learning_profiles AS profiles
           ON profiles.company_id = examples.company_id
          AND profiles.division_code = examples.division_code
          AND profiles.supplier_account_id = examples.supplier_account_id
         WHERE examples.company_id = ? AND examples.division_code = ?
           AND examples.supplier_account_id = ?
           ${
             includeInactive
               ? ""
               : "AND examples.active = 1 AND examples.generation = profiles.generation"
           }
         ORDER BY examples.created_at, examples.id`
      )
      .all(
        scope.companyId,
        scope.divisionCode,
        scope.supplierAccountId
      ) as ExampleRow[];
    return rows.map(exampleFromRow);
  }

  async saveAlias(input: LearningAliasInput) {
    await this.inTransaction(() => {
      this.requireCurrentGeneration(input);
      this.database
        .prepare(
          `INSERT INTO supplier_identity_aliases (
            id, company_id, division_code, supplier_account_id, generation,
            kind, normalized_value, source, active, first_seen_at, last_seen_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            last_seen_at = excluded.last_seen_at,
            active = 1`
        )
        .run(
          input.id,
          input.companyId,
          input.divisionCode,
          input.supplierAccountId,
          input.generation,
          input.kind,
          input.normalizedValue,
          input.source,
          input.createdAt,
          input.createdAt
        );
    });
  }

  async findAliases(
    companyId: string,
    divisionCode: string,
    kind: LearningAliasInput["kind"],
    normalizedValue: string
  ) {
    return this.database
      .prepare(
        `SELECT aliases.* FROM supplier_identity_aliases AS aliases
         JOIN supplier_learning_profiles AS profiles
           ON profiles.company_id = aliases.company_id
          AND profiles.division_code = aliases.division_code
          AND profiles.supplier_account_id = aliases.supplier_account_id
         WHERE aliases.company_id = ? AND aliases.division_code = ?
           AND aliases.kind = ? AND aliases.normalized_value = ?
           AND aliases.active = 1
           AND (aliases.source = 'exact' OR aliases.generation = profiles.generation)
         ORDER BY aliases.supplier_account_id, aliases.id`
      )
      .all(companyId, divisionCode, kind, normalizedValue);
  }

  async savePattern(input: LearningPatternInput) {
    await this.inTransaction(() => {
      this.requireCurrentGeneration(input);
      this.database
        .prepare(
        `INSERT INTO supplier_learning_patterns (
          id, company_id, division_code, supplier_account_id, generation,
          format_cluster, field, pattern_key, label, anchor_json,
          normalized_region_json, data_type, booking_mapping_json,
          support_count, success_count, correction_count, confidence,
          drift_state, model_version, active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT(
          company_id, division_code, supplier_account_id, generation,
          format_cluster, field, pattern_key
        ) DO UPDATE SET
          support_count = excluded.support_count,
          success_count = excluded.success_count,
          correction_count = excluded.correction_count,
          confidence = (excluded.success_count + 1.0) /
            (excluded.support_count + 2.0),
          drift_state = excluded.drift_state,
          model_version = excluded.model_version,
          label = excluded.label,
          anchor_json = excluded.anchor_json,
          normalized_region_json = excluded.normalized_region_json,
          data_type = excluded.data_type,
          booking_mapping_json = excluded.booking_mapping_json,
          active = 1,
          updated_at = excluded.updated_at`
        )
        .run(
        input.id,
        input.companyId,
        input.divisionCode,
        input.supplierAccountId,
        input.generation,
        input.formatCluster,
        input.field,
        input.patternKey,
        input.label ?? null,
        input.anchor === undefined ? null : JSON.stringify(input.anchor),
        input.normalizedRegion === undefined
          ? null
          : JSON.stringify(input.normalizedRegion),
        input.dataType ?? null,
        input.bookingMapping === undefined
          ? null
          : JSON.stringify(input.bookingMapping),
        input.supportCount,
        input.successCount,
        input.correctionCount,
        (input.successCount + 1) / (input.supportCount + 2),
        input.driftState,
        input.modelVersion,
        input.createdAt,
          input.createdAt
        );
    });
  }

  async listPatterns(scope: LearningScope, includeInactive = false) {
    return this.database
      .prepare(
        `SELECT patterns.* FROM supplier_learning_patterns AS patterns
         JOIN supplier_learning_profiles AS profiles
           ON profiles.company_id = patterns.company_id
          AND profiles.division_code = patterns.division_code
          AND profiles.supplier_account_id = patterns.supplier_account_id
         WHERE patterns.company_id = ? AND patterns.division_code = ?
           AND patterns.supplier_account_id = ?
           ${
             includeInactive
               ? ""
               : "AND patterns.active = 1 AND patterns.generation = profiles.generation"
           }
         ORDER BY patterns.format_cluster, patterns.field, patterns.pattern_key`
      )
      .all(
        scope.companyId,
        scope.divisionCode,
        scope.supplierAccountId
      ) as Array<Record<string, unknown>>;
  }

  async replaceDerivedPatterns(input: ReplaceDerivedPatternsInput) {
    await this.inTransaction(async () => {
      this.requireCurrentGeneration(input);
      this.database
        .prepare(
          `UPDATE supplier_learning_patterns SET active = 0, updated_at = ?
           WHERE company_id = ? AND division_code = ? AND supplier_account_id = ?
             AND generation = ? AND model_version = ?`
        )
        .run(
          input.updatedAt,
          input.companyId,
          input.divisionCode,
          input.supplierAccountId,
          input.generation,
          input.modelVersion
        );
      for (const pattern of input.patterns) await this.savePattern(pattern);
      this.database
        .prepare(
          `UPDATE supplier_learning_profiles
           SET derived_evidence_revision = evidence_revision, updated_at = ?
           WHERE company_id = ? AND division_code = ? AND supplier_account_id = ?
             AND generation = ?`
        )
        .run(
          input.updatedAt,
          input.companyId,
          input.divisionCode,
          input.supplierAccountId,
          input.generation
        );
    });
  }

  private insertEvent(input: LearningEventRecord) {
    this.database
      .prepare(
        `INSERT OR IGNORE INTO supplier_learning_events (
          id, company_id, division_code, supplier_account_id, generation,
          type, idempotency_key, actor_id, session_correlation_id, request_id,
          metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.id,
        input.companyId,
        input.divisionCode,
        input.supplierAccountId,
        input.generation,
        input.type,
        input.idempotencyKey,
        input.actorId,
        input.sessionCorrelationId,
        input.requestId,
        JSON.stringify(input.metadata),
        input.createdAt
      );
  }

  async listEvents(scope: LearningScope) {
    const rows = this.database
      .prepare(
        `SELECT * FROM supplier_learning_events
         WHERE company_id = ? AND division_code = ? AND supplier_account_id = ?
         ORDER BY created_at, id`
      )
      .all(
        scope.companyId,
        scope.divisionCode,
        scope.supplierAccountId
      ) as Array<{
      id: string;
      company_id: string;
      division_code: string;
      supplier_account_id: string;
      generation: number;
      type: LearningEventRecord["type"];
      idempotency_key: string;
      actor_id: string;
      session_correlation_id: string;
      request_id: string;
      metadata_json: string;
      created_at: string;
    }>;
    return rows.map(
      (row): LearningEventRecord => ({
        id: row.id,
        companyId: row.company_id,
        divisionCode: row.division_code,
        supplierAccountId: row.supplier_account_id,
        generation: row.generation,
        type: row.type,
        idempotencyKey: row.idempotency_key,
        actorId: row.actor_id,
        sessionCorrelationId: row.session_correlation_id,
        requestId: row.request_id,
        metadata: JSON.parse(row.metadata_json),
        createdAt: row.created_at,
      })
    );
  }

  async saveEvent(input: LearningEventRecord) {
    this.insertEvent(input);
  }

  async getDataMigration(migrationName: string, version: number) {
    const row = this.database
      .prepare(
        `SELECT * FROM supplier_learning_data_migrations
         WHERE migration_name = ? AND version = ?`
      )
      .get(migrationName, version) as
      | {
          migration_name: string;
          version: number;
          source_snapshot_revision: number | null;
          source_snapshot_hash: string | null;
          row_counts_json: string;
          checksum: string;
          started_at: string;
          completed_at: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      migrationName: row.migration_name,
      version: row.version,
      sourceSnapshotRevision: row.source_snapshot_revision ?? undefined,
      sourceSnapshotHash: row.source_snapshot_hash ?? undefined,
      rowCounts: JSON.parse(row.row_counts_json) as Record<string, number>,
      checksum: row.checksum,
      status: "completed" as const,
      startedAt: row.started_at,
      completedAt: row.completed_at ?? row.started_at,
    };
  }

  async recordDataMigration(input: LearningDataMigrationInput) {
    return this.inTransaction(async () => {
      const existing = await this.getDataMigration(
        input.migrationName,
        input.version
      );
      if (existing) {
        if (existing.checksum !== input.checksum) {
          throw new Error(
            "Learning data migration checksum does not match the recorded input."
          );
        }
        return { record: existing, created: false };
      }
      this.database
        .prepare(
          `INSERT INTO supplier_learning_data_migrations (
            migration_name, version, source_snapshot_revision,
            source_snapshot_hash, status, row_counts_json, checksum,
            started_at, completed_at
          ) VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?)`
        )
        .run(
          input.migrationName,
          input.version,
          input.sourceSnapshotRevision ?? null,
          input.sourceSnapshotHash ?? null,
          JSON.stringify(input.rowCounts),
          input.checksum,
          input.startedAt,
          input.completedAt
        );
      return {
        record: { ...input, status: "completed" as const },
        created: true,
      };
    });
  }

  async completeLegacyMigration(
    input: LearningScope & { activeGeneration: number; updatedAt: string }
  ) {
    return this.inTransaction(() => {
      const update = this.database
        .prepare(
          `UPDATE supplier_learning_profiles
           SET generation = ?, learned_count = 0, confidence_score = 35,
               drift_state = 'none', last_learned_at = NULL,
               updated_at = ?, version = version + 1
           WHERE company_id = ? AND division_code = ?
             AND supplier_account_id = ? AND generation = 0`
        )
        .run(
          input.activeGeneration,
          input.updatedAt,
          input.companyId,
          input.divisionCode,
          input.supplierAccountId
        );
      if (update.changes !== 1) {
        throw new LearningGenerationConflictError(
          "Supplier learning generation changed during legacy migration."
        );
      }
      for (const table of [
        "supplier_learning_examples",
        "supplier_learning_patterns",
      ]) {
        this.database
          .prepare(
            `UPDATE ${table} SET active = 0
             WHERE company_id = ? AND division_code = ?
               AND supplier_account_id = ? AND generation = 0`
          )
          .run(input.companyId, input.divisionCode, input.supplierAccountId);
      }
      this.database
        .prepare(
          `UPDATE supplier_identity_aliases SET active = 0
           WHERE company_id = ? AND division_code = ?
             AND supplier_account_id = ? AND generation = 0
             AND source <> 'exact'`
        )
        .run(input.companyId, input.divisionCode, input.supplierAccountId);
      const row = this.database
        .prepare(
          `SELECT * FROM supplier_learning_profiles
           WHERE company_id = ? AND division_code = ? AND supplier_account_id = ?`
        )
        .get(
          input.companyId,
          input.divisionCode,
          input.supplierAccountId
        ) as ProfileRow;
      return profileFromRow(row);
    });
  }

  async resetSupplier(
    input: LearningScope & {
      expectedGeneration: number;
      actorId: string;
      sessionCorrelationId: string;
      requestId: string;
      createdAt: string;
    }
  ) {
    return this.inTransaction(() => {
      this.requireCurrentGeneration({
        ...input,
        generation: input.expectedGeneration,
      });
      const generation = input.expectedGeneration + 1;
      const update = this.database
        .prepare(
          `UPDATE supplier_learning_profiles
           SET generation = ?, learned_count = 0, confidence_score = 35,
                drift_state = 'none', last_learned_at = NULL,
                evidence_revision = 0, derived_evidence_revision = 0,
                last_reset_at = ?, updated_at = ?,
               version = version + 1
           WHERE company_id = ? AND division_code = ?
             AND supplier_account_id = ? AND generation = ?`
        )
        .run(
          generation,
          input.createdAt,
          input.createdAt,
          input.companyId,
          input.divisionCode,
          input.supplierAccountId,
          input.expectedGeneration
        );
      if (update.changes !== 1) {
        throw new LearningGenerationConflictError(
          "Supplier learning generation changed. Refresh and try again."
        );
      }
      for (const table of [
        "supplier_learning_examples",
        "supplier_learning_patterns",
      ]) {
        this.database
          .prepare(
            `UPDATE ${table} SET active = 0
             WHERE company_id = ? AND division_code = ?
               AND supplier_account_id = ? AND generation = ?`
          )
          .run(
            input.companyId,
            input.divisionCode,
            input.supplierAccountId,
            input.expectedGeneration
          );
      }
      this.database
        .prepare(
          `UPDATE supplier_identity_aliases SET active = 0
           WHERE company_id = ? AND division_code = ? AND supplier_account_id = ?
             AND generation = ? AND source <> 'exact'`
        )
        .run(
          input.companyId,
          input.divisionCode,
          input.supplierAccountId,
          input.expectedGeneration
        );
      this.insertEvent({
        id: `event_${randomUUID()}`,
        ...input,
        generation,
        type: "reset",
        idempotencyKey: `reset:${input.requestId}`,
        metadata: {
          previousGeneration: input.expectedGeneration,
          generation,
        },
      });
      const resetRow = this.database
        .prepare(
          `SELECT * FROM supplier_learning_profiles
           WHERE company_id = ? AND division_code = ? AND supplier_account_id = ?`
        )
        .get(
          input.companyId,
          input.divisionCode,
          input.supplierAccountId
        ) as ProfileRow | undefined;
      if (!resetRow) {
        throw new Error("Supplier learning profile disappeared during reset.");
      }
      return profileFromRow(resetRow);
    });
  }

  close() {
    if (this.ownsDatabase) this.database.close();
  }
}
