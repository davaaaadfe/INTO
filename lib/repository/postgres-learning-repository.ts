import { neon } from "@neondatabase/serverless";
import { randomUUID } from "node:crypto";
import {
  LearningGenerationConflictError,
  LEARNING_REPOSITORY_SCHEMA_VERSION,
  type LearningAliasInput,
  type LearningArtifactAnalysis,
  type LearningArtifactInput,
  type LearningArtifactRecord,
  type LearningDataMigrationInput,
  type LearningDataMigrationRecord,
  type LearningEventRecord,
  type LearningExampleInput,
  type LearningExampleRecord,
  type LearningPatternInput,
  type LearningProfileRecord,
  type ReplaceDerivedPatternsInput,
  type LearningScope,
} from "./learning-repository";
import {
  decryptLearningArtifact,
  encryptLearningArtifact,
} from "../services/learning-artifact-crypto";

export const POSTGRES_LEARNING_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS supplier_learning_schema_migrations (
    version integer PRIMARY KEY,
    applied_at timestamptz NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS supplier_learning_profiles (
    company_id text NOT NULL,
    division_code text NOT NULL,
    supplier_account_id text NOT NULL,
    fallback_supplier_code text NOT NULL DEFAULT '',
    generation integer NOT NULL DEFAULT 0,
    state text NOT NULL DEFAULT 'active',
    confidence_score integer NOT NULL DEFAULT 35,
    confidence_breakdown_version integer NOT NULL DEFAULT 1,
    drift_state text NOT NULL DEFAULT 'none',
    learned_count integer NOT NULL DEFAULT 0,
    last_learned_at timestamptz,
    last_reset_at timestamptz,
    version integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (company_id, division_code, supplier_account_id)
  )`,
  `CREATE TABLE IF NOT EXISTS supplier_identity_aliases (
    id text PRIMARY KEY,
    company_id text NOT NULL,
    division_code text NOT NULL,
    supplier_account_id text NOT NULL,
    generation integer NOT NULL,
    kind text NOT NULL,
    normalized_value text NOT NULL,
    source text NOT NULL,
    active boolean NOT NULL DEFAULT true,
    first_seen_at timestamptz NOT NULL,
    last_seen_at timestamptz NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS supplier_identity_alias_lookup_idx
    ON supplier_identity_aliases (
      company_id, division_code, kind, normalized_value, active
    )`,
  `CREATE TABLE IF NOT EXISTS document_analysis_artifacts (
    id text PRIMARY KEY,
    company_id text NOT NULL,
    content_hash text NOT NULL,
    raw_text_ciphertext text NOT NULL,
    analysis_ciphertext text NOT NULL,
    detected_language text,
    provider text NOT NULL,
    model_version text NOT NULL,
    retention_until timestamptz,
    created_at timestamptz NOT NULL,
    UNIQUE (company_id, content_hash)
  )`,
  `CREATE TABLE IF NOT EXISTS supplier_learning_examples (
    id text PRIMARY KEY,
    company_id text NOT NULL,
    division_code text NOT NULL,
    supplier_account_id text NOT NULL,
    generation integer NOT NULL,
    invoice_id text NOT NULL,
    artifact_id text REFERENCES document_analysis_artifacts(id),
    content_hash text NOT NULL,
    original_filename text NOT NULL,
    original_prediction_json jsonb NOT NULL,
    final_fields_json jsonb NOT NULL,
    booking_lines_json jsonb NOT NULL,
    fingerprint text NOT NULL,
    fingerprint_version text NOT NULL,
    validation_result_json jsonb NOT NULL,
    processing_purpose text NOT NULL,
    source text NOT NULL,
    trust_state text NOT NULL,
    trigger text NOT NULL,
    actor_id text NOT NULL,
    session_correlation_id text NOT NULL,
    request_id text NOT NULL,
    active boolean NOT NULL DEFAULT true,
    superseded_by_id text,
    created_at timestamptz NOT NULL,
    UNIQUE (
      company_id, division_code, supplier_account_id, generation, content_hash
    )
  )`,
  `CREATE INDEX IF NOT EXISTS supplier_learning_examples_active_idx
    ON supplier_learning_examples (
      company_id, division_code, supplier_account_id, generation, active
    )`,
  `CREATE TABLE IF NOT EXISTS supplier_learning_patterns (
    id text PRIMARY KEY,
    company_id text NOT NULL,
    division_code text NOT NULL,
    supplier_account_id text NOT NULL,
    generation integer NOT NULL,
    format_cluster text NOT NULL,
    field text NOT NULL,
    pattern_key text NOT NULL,
    label text,
    anchor_json jsonb,
    normalized_region_json jsonb,
    data_type text,
    booking_mapping_json jsonb,
    support_count double precision NOT NULL DEFAULT 0,
    success_count double precision NOT NULL DEFAULT 0,
    correction_count double precision NOT NULL DEFAULT 0,
    confidence double precision NOT NULL DEFAULT 0,
    drift_state text NOT NULL DEFAULT 'none',
    model_version text NOT NULL,
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    UNIQUE (
      company_id, division_code, supplier_account_id, generation,
      format_cluster, field, pattern_key
    )
  )`,
  `CREATE TABLE IF NOT EXISTS supplier_learning_events (
    id text PRIMARY KEY,
    company_id text NOT NULL,
    division_code text NOT NULL,
    supplier_account_id text NOT NULL,
    generation integer NOT NULL,
    type text NOT NULL,
    idempotency_key text NOT NULL,
    actor_id text NOT NULL,
    session_correlation_id text NOT NULL,
    request_id text NOT NULL,
    metadata_json jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    UNIQUE (company_id, idempotency_key)
  )`,
  `CREATE INDEX IF NOT EXISTS supplier_learning_events_supplier_idx
    ON supplier_learning_events (
      company_id, division_code, supplier_account_id, generation, created_at
    )`,
  `ALTER TABLE supplier_learning_profiles
    ADD COLUMN IF NOT EXISTS evidence_revision integer NOT NULL DEFAULT 0`,
  `ALTER TABLE supplier_learning_profiles
    ADD COLUMN IF NOT EXISTS derived_evidence_revision integer NOT NULL DEFAULT 0`,
  `ALTER TABLE supplier_learning_examples
    ADD COLUMN IF NOT EXISTS observation_state_json jsonb NOT NULL DEFAULT '{}'::jsonb`,
  `ALTER TABLE supplier_learning_examples
    ADD COLUMN IF NOT EXISTS request_fingerprint text NOT NULL DEFAULT ''`,
  `ALTER TABLE supplier_learning_examples
    ADD COLUMN IF NOT EXISTS deactivated_at timestamptz`,
  `DO $$
    DECLARE legacy_constraint text;
    BEGIN
      SELECT constraint_name INTO legacy_constraint
      FROM information_schema.table_constraints
      WHERE table_schema = current_schema()
        AND table_name = 'supplier_learning_examples'
        AND constraint_type = 'UNIQUE'
      LIMIT 1;
      IF legacy_constraint IS NOT NULL THEN
        EXECUTE format(
          'ALTER TABLE supplier_learning_examples DROP CONSTRAINT %I',
          legacy_constraint
        );
      END IF;
    END $$`,
  `CREATE UNIQUE INDEX IF NOT EXISTS supplier_learning_examples_active_hash_uidx
    ON supplier_learning_examples (
      company_id, division_code, supplier_account_id, generation, content_hash
    ) WHERE active = true`,
  `ALTER TABLE supplier_learning_patterns
    ADD COLUMN IF NOT EXISTS evidence_revision integer NOT NULL DEFAULT 0`,
  `ALTER TABLE supplier_learning_events
    ADD COLUMN IF NOT EXISTS payload_fingerprint text NOT NULL DEFAULT ''`,
  `CREATE TABLE IF NOT EXISTS supplier_learning_corrections (
    id text PRIMARY KEY,
    company_id text NOT NULL,
    division_code text NOT NULL,
    supplier_account_id text NOT NULL,
    generation integer NOT NULL,
    invoice_id text NOT NULL,
    invoice_revision integer NOT NULL,
    artifact_id text REFERENCES document_analysis_artifacts(id),
    format_cluster text,
    field text NOT NULL,
    slot_key text NOT NULL DEFAULT '',
    before_ciphertext text NOT NULL,
    after_ciphertext text NOT NULL,
    evidence_ciphertext text NOT NULL,
    after_value_fingerprint text NOT NULL,
    trust_state text NOT NULL,
    reason text NOT NULL,
    actor_id text NOT NULL,
    session_correlation_id text NOT NULL,
    request_id text NOT NULL,
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL,
    promoted_at timestamptz,
    deactivated_at timestamptz,
    UNIQUE (
      company_id, division_code, supplier_account_id, invoice_id,
      invoice_revision, field, slot_key, after_value_fingerprint
    )
  )`,
  `CREATE INDEX IF NOT EXISTS supplier_learning_corrections_scope_idx
    ON supplier_learning_corrections (
      company_id, division_code, supplier_account_id, generation, active
    )`,
  `CREATE TABLE IF NOT EXISTS supplier_learning_data_migrations (
    migration_name text NOT NULL,
    version integer NOT NULL,
    source_snapshot_revision bigint,
    source_snapshot_hash text,
    status text NOT NULL,
    row_counts_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    checksum text NOT NULL,
    error_code text,
    started_at timestamptz NOT NULL,
    completed_at timestamptz,
    PRIMARY KEY (migration_name, version)
  )`,
  `ALTER TABLE supplier_learning_examples
    ADD COLUMN IF NOT EXISTS format_signature text NOT NULL DEFAULT ''`,
  `ALTER TABLE supplier_learning_examples
    ADD COLUMN IF NOT EXISTS format_cluster text NOT NULL DEFAULT ''`,
] as const;

export const POSTGRES_LEARNING_MIGRATION_STEPS = [
  { version: 1, statements: POSTGRES_LEARNING_MIGRATIONS.slice(1, 10) },
  { version: 2, statements: POSTGRES_LEARNING_MIGRATIONS.slice(10, -2) },
  { version: 3, statements: POSTGRES_LEARNING_MIGRATIONS.slice(-2) },
] as const;

type PostgresRows = Array<Record<string, unknown>>;
type PostgresQuery = (
  query: string,
  parameters?: unknown[]
) => Promise<PostgresRows>;

type PostgresStatement = {
  query: string;
  parameters?: unknown[];
};

type PostgresTransaction = (statements: PostgresStatement[]) => Promise<void>;

function iso(value: unknown) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function nullableIso(value: unknown) {
  return value === null || value === undefined ? undefined : iso(value);
}

function dataMigrationFromRow(
  row: Record<string, unknown>
): LearningDataMigrationRecord {
  const rowCounts = row.row_counts_json;
  return {
    migrationName: String(row.migration_name),
    version: Number(row.version),
    sourceSnapshotRevision:
      row.source_snapshot_revision === null ||
      row.source_snapshot_revision === undefined
        ? undefined
        : Number(row.source_snapshot_revision),
    sourceSnapshotHash: row.source_snapshot_hash
      ? String(row.source_snapshot_hash)
      : undefined,
    rowCounts:
      typeof rowCounts === "string"
        ? (JSON.parse(rowCounts) as Record<string, number>)
        : (rowCounts as Record<string, number>),
    checksum: String(row.checksum),
    status: "completed",
    startedAt: iso(row.started_at),
    completedAt: nullableIso(row.completed_at) ?? iso(row.started_at),
  };
}

function profileFromRow(row: Record<string, unknown>): LearningProfileRecord {
  return {
    companyId: String(row.company_id),
    divisionCode: String(row.division_code),
    supplierAccountId: String(row.supplier_account_id),
    fallbackSupplierCode: String(row.fallback_supplier_code ?? ""),
    generation: Number(row.generation),
    state: row.state === "paused" ? "paused" : "active",
    confidenceScore: Number(row.confidence_score),
    confidenceBreakdownVersion: Number(row.confidence_breakdown_version),
    driftState:
      row.drift_state === "possible" || row.drift_state === "confirmed"
        ? row.drift_state
        : "none",
    learnedCount: Number(row.learned_count),
    lastLearnedAt: nullableIso(row.last_learned_at),
    lastResetAt: nullableIso(row.last_reset_at),
    version: Number(row.version),
    evidenceRevision: Number(row.evidence_revision ?? 0),
    derivedEvidenceRevision: Number(row.derived_evidence_revision ?? 0),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function exampleFromRow(row: Record<string, unknown>): LearningExampleRecord {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    divisionCode: String(row.division_code),
    supplierAccountId: String(row.supplier_account_id),
    generation: Number(row.generation),
    invoiceId: String(row.invoice_id),
    artifactId: row.artifact_id ? String(row.artifact_id) : undefined,
    contentHash: String(row.content_hash),
    originalFilename: String(row.original_filename),
    originalPrediction: row.original_prediction_json,
    finalFields: row.final_fields_json,
    bookingLines: row.booking_lines_json,
    observationState:
      (row.observation_state_json as LearningExampleRecord["observationState"]) ??
      {},
    fingerprint: String(row.fingerprint),
    fingerprintVersion: String(row.fingerprint_version),
    formatSignature: row.format_signature ? String(row.format_signature) : undefined,
    formatCluster: row.format_cluster
      ? String(row.format_cluster)
      : `fingerprint_${String(row.fingerprint)}`,
    validationResult: row.validation_result_json,
    processingPurpose:
      row.processing_purpose === "learning_only" ? "learning_only" : "booking",
    source: row.source as LearningExampleInput["source"],
    trustState: row.trust_state as LearningExampleInput["trustState"],
    trigger: row.trigger as LearningExampleInput["trigger"],
    actorId: String(row.actor_id),
    sessionCorrelationId: String(row.session_correlation_id),
    requestId: String(row.request_id),
    active: Boolean(row.active),
    supersededById: row.superseded_by_id
      ? String(row.superseded_by_id)
      : undefined,
    createdAt: iso(row.created_at),
  };
}

export class PostgresLearningRepository {
  private readonly query: PostgresQuery;
  private readonly transaction: PostgresTransaction;

  constructor(databaseUrl = process.env.DATABASE_URL?.trim() ?? "") {
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required for PostgreSQL supplier learning.");
    }
    const sql = neon(databaseUrl);
    this.query = (query, parameters = []) =>
      sql.query(query, parameters) as Promise<PostgresRows>;
    this.transaction = async (statements) => {
      await sql.transaction(
        statements.map(({ query, parameters = [] }) =>
          sql.query(query, parameters)
        )
      );
    };
  }

  static fromQuery(
    query: PostgresQuery,
    transaction: PostgresTransaction = async (statements) => {
      for (const statement of statements) {
        await query(statement.query, statement.parameters);
      }
    }
  ) {
    const repository = Object.create(
      PostgresLearningRepository.prototype
    ) as PostgresLearningRepository;
    Object.assign(repository, { query, transaction });
    return repository;
  }

  async migrate() {
    await this.query(POSTGRES_LEARNING_MIGRATIONS[0]);
    const current = await this.schemaVersion();
    if (current > LEARNING_REPOSITORY_SCHEMA_VERSION) {
      throw new Error(
        `Learning database schema ${current} is newer than supported schema ${LEARNING_REPOSITORY_SCHEMA_VERSION}.`
      );
    }
    for (const migration of POSTGRES_LEARNING_MIGRATION_STEPS) {
      if (migration.version <= current) continue;
      await this.transaction([
        ...migration.statements.map((query) => ({ query })),
        {
          query: `INSERT INTO supplier_learning_schema_migrations (version, applied_at)
                  VALUES ($1, $2) ON CONFLICT(version) DO NOTHING`,
          parameters: [
            migration.version,
            new Date().toISOString(),
          ],
        },
      ]);
    }
  }

  async schemaVersion() {
    const rows = await this.query(
      "SELECT MAX(version) AS version FROM supplier_learning_schema_migrations"
    );
    return Number(rows[0]?.version ?? 0);
  }

  async ensureProfile(
    input: LearningScope & {
      fallbackSupplierCode: string;
      generation?: number;
      createdAt: string;
    }
  ) {
    const rows = await this.query(
      `INSERT INTO supplier_learning_profiles (
        company_id, division_code, supplier_account_id,
        fallback_supplier_code, generation, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $6)
      ON CONFLICT(company_id, division_code, supplier_account_id)
      DO UPDATE SET fallback_supplier_code = CASE
        WHEN supplier_learning_profiles.fallback_supplier_code = ''
          THEN EXCLUDED.fallback_supplier_code
        ELSE supplier_learning_profiles.fallback_supplier_code
      END,
      generation = CASE
        WHEN supplier_learning_profiles.learned_count = 0
          AND supplier_learning_profiles.generation < EXCLUDED.generation
          THEN EXCLUDED.generation
        ELSE supplier_learning_profiles.generation
      END
      RETURNING *`,
      [
        input.companyId,
        input.divisionCode,
        input.supplierAccountId,
        input.fallbackSupplierCode,
        input.generation ?? 0,
        input.createdAt,
      ]
    );
    return profileFromRow(rows[0]!);
  }

  async getProfile(scope: LearningScope) {
    const rows = await this.query(
      `SELECT * FROM supplier_learning_profiles
       WHERE company_id = $1 AND division_code = $2 AND supplier_account_id = $3`,
      [scope.companyId, scope.divisionCode, scope.supplierAccountId]
    );
    return rows[0] ? profileFromRow(rows[0]) : null;
  }

  async listProfiles(companyId: string, divisionCode: string) {
    const rows = await this.query(
      `SELECT profiles.* FROM supplier_learning_profiles AS profiles
       WHERE profiles.company_id = $1 AND profiles.division_code = $2
         AND (
           profiles.learned_count > 0
           OR profiles.last_reset_at IS NOT NULL
           OR EXISTS (
             SELECT 1 FROM supplier_learning_examples AS examples
             WHERE examples.company_id = profiles.company_id
               AND examples.division_code = profiles.division_code
               AND examples.supplier_account_id = profiles.supplier_account_id
               AND examples.generation = profiles.generation
               AND examples.active = true
           )
           OR EXISTS (
             SELECT 1 FROM supplier_learning_patterns AS patterns
             WHERE patterns.company_id = profiles.company_id
               AND patterns.division_code = profiles.division_code
               AND patterns.supplier_account_id = profiles.supplier_account_id
               AND patterns.generation = profiles.generation
               AND patterns.active = true
           )
           OR EXISTS (
             SELECT 1 FROM supplier_identity_aliases AS aliases
             WHERE aliases.company_id = profiles.company_id
               AND aliases.division_code = profiles.division_code
               AND aliases.supplier_account_id = profiles.supplier_account_id
               AND aliases.source <> 'exact'
               AND aliases.active = true
           )
         )
       ORDER BY profiles.supplier_account_id`,
      [companyId, divisionCode]
    );
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
    const rows = await this.query(
      `UPDATE supplier_learning_profiles
       SET confidence_score = $1, confidence_breakdown_version = 1,
           drift_state = $2, updated_at = $3, version = version + 1
       WHERE company_id = $4 AND division_code = $5
         AND supplier_account_id = $6 AND generation = $7
       RETURNING supplier_account_id`,
      [
        input.score,
        input.driftState,
        input.updatedAt,
        input.companyId,
        input.divisionCode,
        input.supplierAccountId,
        input.generation,
      ]
    );
    if (!rows[0]) {
      throw new LearningGenerationConflictError(
        "Supplier learning generation changed. Refresh and try again."
      );
    }
  }

  async completeLegacyMigration(
    input: LearningScope & { activeGeneration: number; updatedAt: string }
  ) {
    const rows = await this.query(
      `WITH profile AS (
         UPDATE supplier_learning_profiles
         SET generation=$4, learned_count=0, confidence_score=35,
             drift_state='none', last_learned_at=NULL,
             updated_at=$5, version=version+1
         WHERE company_id=$1 AND division_code=$2
           AND supplier_account_id=$3 AND generation=0
         RETURNING *
       ), deactivate_examples AS (
         UPDATE supplier_learning_examples SET active=false
         WHERE company_id=$1 AND division_code=$2 AND supplier_account_id=$3
           AND generation=0 AND EXISTS (SELECT 1 FROM profile)
       ), deactivate_patterns AS (
         UPDATE supplier_learning_patterns SET active=false
         WHERE company_id=$1 AND division_code=$2 AND supplier_account_id=$3
           AND generation=0 AND EXISTS (SELECT 1 FROM profile)
       ), deactivate_aliases AS (
         UPDATE supplier_identity_aliases SET active=false
         WHERE company_id=$1 AND division_code=$2 AND supplier_account_id=$3
           AND generation=0 AND source <> 'exact'
           AND EXISTS (SELECT 1 FROM profile)
       )
       SELECT * FROM profile`,
      [
        input.companyId,
        input.divisionCode,
        input.supplierAccountId,
        input.activeGeneration,
        input.updatedAt,
      ]
    );
    if (!rows[0]) {
      throw new LearningGenerationConflictError(
        "Supplier learning generation changed during legacy migration."
      );
    }
    return profileFromRow(rows[0]);
  }

  async saveArtifact(input: LearningArtifactInput) {
    const existing = await this.query(
      `SELECT * FROM document_analysis_artifacts
       WHERE company_id = $1 AND content_hash = $2`,
      [input.companyId, input.contentHash]
    );
    if (existing[0]) {
      return this.artifactFromRow(existing[0]);
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
    const rows = await this.query(
      `INSERT INTO document_analysis_artifacts (
        id, company_id, content_hash, raw_text_ciphertext,
        analysis_ciphertext, detected_language, provider, model_version,
        retention_until, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT(company_id, content_hash) DO NOTHING RETURNING *`,
      [
        record.id,
        record.companyId,
        record.contentHash,
        record.rawTextCiphertext,
        record.analysisCiphertext,
        record.detectedLanguage ?? null,
        record.provider,
        record.modelVersion,
        record.retentionUntil ?? null,
        record.createdAt,
      ]
    );
    if (rows[0]) {
      return this.artifactFromRow(rows[0]);
    }
    const raced = await this.query(
      `SELECT * FROM document_analysis_artifacts
       WHERE company_id = $1 AND content_hash = $2`,
      [input.companyId, input.contentHash]
    );
    return this.artifactFromRow(raced[0]!);
  }

  private artifactFromRow(row: Record<string, unknown>): LearningArtifactRecord {
    return {
      id: String(row.id),
      companyId: String(row.company_id),
      contentHash: String(row.content_hash),
      rawTextCiphertext: String(row.raw_text_ciphertext),
      analysisCiphertext: String(row.analysis_ciphertext),
      detectedLanguage: row.detected_language
        ? String(row.detected_language)
        : undefined,
      provider: String(row.provider),
      modelVersion: String(row.model_version),
      retentionUntil: nullableIso(row.retention_until),
      createdAt: iso(row.created_at),
    };
  }

  async existingArtifactIds(ids: string[]) {
    if (!ids.length) return new Set<string>();
    const rows = await this.query(
      "SELECT id FROM document_analysis_artifacts WHERE id = ANY($1::text[])",
      [ids]
    );
    return new Set(rows.map((row) => String(row.id)));
  }

  async readArtifact(id: string) {
    const rows = await this.query(
      "SELECT * FROM document_analysis_artifacts WHERE id = $1",
      [id]
    );
    if (!rows[0]) return null;
    const artifact = this.artifactFromRow(rows[0]);
    return {
      rawText: await decryptLearningArtifact(
        artifact.rawTextCiphertext,
        artifact.contentHash
      ),
      analysis: JSON.parse(
        await decryptLearningArtifact(
          artifact.analysisCiphertext,
          artifact.contentHash
        )
      ) as LearningArtifactAnalysis,
    };
  }

  async pruneExpiredArtifacts(currentTime: string) {
    const rows = await this.query(
      `WITH expired AS (
         SELECT id FROM document_analysis_artifacts
         WHERE retention_until IS NOT NULL AND retention_until <= $1
         FOR UPDATE
       ), unlinked AS (
         UPDATE supplier_learning_examples SET artifact_id = NULL
         WHERE artifact_id IN (SELECT id FROM expired)
       ), deleted AS (
         DELETE FROM document_analysis_artifacts
         WHERE id IN (SELECT id FROM expired)
         RETURNING id
       )
       SELECT COUNT(*)::integer AS count FROM deleted`,
      [currentTime]
    );
    return Number(rows[0]?.count ?? 0);
  }

  async saveAlias(input: LearningAliasInput) {
    const rows = await this.query(
      `WITH profile_lock AS (
        SELECT 1 FROM supplier_learning_profiles
        WHERE company_id=$2 AND division_code=$3 AND supplier_account_id=$4
          AND generation=$5
        FOR UPDATE
      )
      INSERT INTO supplier_identity_aliases (
        id, company_id, division_code, supplier_account_id, generation,
        kind, normalized_value, source, active, first_seen_at, last_seen_at
      )
      SELECT $1,$2,$3,$4,$5,$6,$7,$8,true,$9,$9
      FROM profile_lock
      ON CONFLICT(id) DO UPDATE SET
        last_seen_at = EXCLUDED.last_seen_at,
        active = true
      WHERE supplier_identity_aliases.generation = EXCLUDED.generation
         OR (
           supplier_identity_aliases.source = 'exact'
           AND EXCLUDED.source = 'exact'
         )
      RETURNING id`,
      [
        input.id,
        input.companyId,
        input.divisionCode,
        input.supplierAccountId,
        input.generation,
        input.kind,
        input.normalizedValue,
        input.source,
        input.createdAt,
      ]
    );
    if (!rows[0]) {
      throw new LearningGenerationConflictError(
        "Supplier learning generation changed. Refresh and try again."
      );
    }
  }

  async findAliases(
    companyId: string,
    divisionCode: string,
    kind: LearningAliasInput["kind"],
    normalizedValue: string
  ) {
    return this.query(
      `SELECT aliases.* FROM supplier_identity_aliases AS aliases
       JOIN supplier_learning_profiles AS profiles
         ON profiles.company_id = aliases.company_id
        AND profiles.division_code = aliases.division_code
        AND profiles.supplier_account_id = aliases.supplier_account_id
       WHERE aliases.company_id=$1 AND aliases.division_code=$2
         AND aliases.kind=$3 AND aliases.normalized_value=$4
         AND aliases.active=true
         AND (aliases.source='exact' OR aliases.generation=profiles.generation)
       ORDER BY aliases.supplier_account_id, aliases.id`,
      [companyId, divisionCode, kind, normalizedValue]
    );
  }

  async savePattern(input: LearningPatternInput) {
    const rows = await this.query(
      `WITH profile_lock AS (
        SELECT 1 FROM supplier_learning_profiles
        WHERE company_id=$2 AND division_code=$3 AND supplier_account_id=$4
          AND generation=$5
        FOR UPDATE
      )
      INSERT INTO supplier_learning_patterns (
        id, company_id, division_code, supplier_account_id, generation,
        format_cluster, field, pattern_key, label, anchor_json,
        normalized_region_json, data_type, booking_mapping_json,
        support_count, success_count, correction_count, confidence,
        drift_state, model_version, active, created_at, updated_at
      )
      SELECT
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13::jsonb,
        $14,$15,$16,$17,$18,$19,true,$20,$20
      FROM profile_lock
      ON CONFLICT(
        company_id, division_code, supplier_account_id, generation,
        format_cluster, field, pattern_key
      ) DO UPDATE SET
        support_count = EXCLUDED.support_count,
        success_count = EXCLUDED.success_count,
        correction_count = EXCLUDED.correction_count,
        confidence = (EXCLUDED.success_count + 1.0) /
          (EXCLUDED.support_count + 2.0),
        drift_state = EXCLUDED.drift_state,
        model_version = EXCLUDED.model_version,
        label = EXCLUDED.label,
        anchor_json = EXCLUDED.anchor_json,
        normalized_region_json = EXCLUDED.normalized_region_json,
        data_type = EXCLUDED.data_type,
        booking_mapping_json = EXCLUDED.booking_mapping_json,
        active = true,
        updated_at = EXCLUDED.updated_at
      RETURNING id`,
      [
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
      ]
    );
    if (!rows[0]) {
      throw new LearningGenerationConflictError(
        "Supplier learning generation changed. Refresh and try again."
      );
    }
  }

  async listPatterns(scope: LearningScope, includeInactive = false) {
    return this.query(
      `SELECT patterns.* FROM supplier_learning_patterns AS patterns
       JOIN supplier_learning_profiles AS profiles
         ON profiles.company_id = patterns.company_id
        AND profiles.division_code = patterns.division_code
        AND profiles.supplier_account_id = patterns.supplier_account_id
       WHERE patterns.company_id=$1 AND patterns.division_code=$2
         AND patterns.supplier_account_id=$3
         ${
           includeInactive
             ? ""
             : "AND patterns.active=true AND patterns.generation=profiles.generation"
         }
       ORDER BY patterns.format_cluster, patterns.field, patterns.pattern_key`,
      [scope.companyId, scope.divisionCode, scope.supplierAccountId]
    );
  }

  async replaceDerivedPatterns(input: ReplaceDerivedPatternsInput) {
    const patterns = input.patterns.map((pattern) => ({
      id: pattern.id,
      format_cluster: pattern.formatCluster,
      field: pattern.field,
      pattern_key: pattern.patternKey,
      label: pattern.label ?? null,
      anchor_json: pattern.anchor ?? null,
      normalized_region_json: pattern.normalizedRegion ?? null,
      data_type: pattern.dataType ?? null,
      booking_mapping_json: pattern.bookingMapping ?? null,
      support_count: pattern.supportCount,
      success_count: pattern.successCount,
      correction_count: pattern.correctionCount,
      drift_state: pattern.driftState,
      created_at: pattern.createdAt,
    }));
    const rows = await this.query(
      `WITH profile_ok AS (
        SELECT evidence_revision FROM supplier_learning_profiles
        WHERE company_id=$1 AND division_code=$2 AND supplier_account_id=$3
          AND generation=$4
        FOR UPDATE
      ), deactivated AS (
        UPDATE supplier_learning_patterns SET active=false, updated_at=$6
        WHERE company_id=$1 AND division_code=$2 AND supplier_account_id=$3
          AND generation=$4 AND model_version=$5
          AND EXISTS (SELECT 1 FROM profile_ok)
        RETURNING id
      ), upserted AS (
        INSERT INTO supplier_learning_patterns (
          id, company_id, division_code, supplier_account_id, generation,
          format_cluster, field, pattern_key, label, anchor_json,
          normalized_region_json, data_type, booking_mapping_json,
          support_count, success_count, correction_count, confidence,
          drift_state, model_version, active, created_at, updated_at
        )
        SELECT pattern.id,$1,$2,$3,$4,pattern.format_cluster,pattern.field,
          pattern.pattern_key,pattern.label,pattern.anchor_json,
          pattern.normalized_region_json,pattern.data_type,pattern.booking_mapping_json,
          pattern.support_count,pattern.success_count,pattern.correction_count,
          (pattern.success_count + 1.0) / (pattern.support_count + 2.0),
          pattern.drift_state,$5,true,pattern.created_at,$6
        FROM jsonb_to_recordset($7::jsonb) AS pattern(
          id text, format_cluster text, field text, pattern_key text, label text,
          anchor_json jsonb, normalized_region_json jsonb, data_type text,
          booking_mapping_json jsonb, support_count double precision,
          success_count double precision, correction_count double precision,
          drift_state text, created_at timestamptz
        ), profile_ok
        ON CONFLICT(
          company_id, division_code, supplier_account_id, generation,
          format_cluster, field, pattern_key
        ) DO UPDATE SET
          support_count = EXCLUDED.support_count,
          success_count = EXCLUDED.success_count,
          correction_count = EXCLUDED.correction_count,
          confidence = EXCLUDED.confidence,
          drift_state = EXCLUDED.drift_state,
          model_version = EXCLUDED.model_version,
          label = EXCLUDED.label,
          anchor_json = EXCLUDED.anchor_json,
          normalized_region_json = EXCLUDED.normalized_region_json,
          data_type = EXCLUDED.data_type,
          booking_mapping_json = EXCLUDED.booking_mapping_json,
          active = true,
          updated_at = EXCLUDED.updated_at
        RETURNING id
      ), updated AS (
        UPDATE supplier_learning_profiles AS profiles
        SET derived_evidence_revision = profile_ok.evidence_revision,
            updated_at=$6
        FROM profile_ok
        WHERE profiles.company_id=$1 AND profiles.division_code=$2
          AND profiles.supplier_account_id=$3 AND profiles.generation=$4
        RETURNING profiles.derived_evidence_revision
      ) SELECT derived_evidence_revision FROM updated`,
      [
        input.companyId,
        input.divisionCode,
        input.supplierAccountId,
        input.generation,
        input.modelVersion,
        input.updatedAt,
        JSON.stringify(patterns),
      ]
    );
    if (!rows[0]) {
      throw new LearningGenerationConflictError(
        "Supplier learning generation changed. Refresh and try again."
      );
    }
  }

  async saveExample(input: LearningExampleInput) {
    const eventId = `event_${randomUUID()}`;
    const rows = await this.query(
      `WITH profile_ok AS (
        SELECT 1 FROM supplier_learning_profiles
        WHERE company_id=$2 AND division_code=$3 AND supplier_account_id=$4
          AND generation=$5
        FOR UPDATE
      ), existing AS (
        SELECT * FROM supplier_learning_examples
        WHERE company_id=$2 AND division_code=$3 AND supplier_account_id=$4
          AND generation=$5 AND content_hash=$8 AND active=true
        FOR UPDATE
      ), same_truth AS (
        SELECT 1 FROM existing
        WHERE final_fields_json=$11::jsonb AND booking_lines_json=$12::jsonb
      ), deactivated AS (
        UPDATE supplier_learning_examples
        SET active=false, superseded_by_id=$1, deactivated_at=$23
        WHERE id IN (SELECT id FROM existing)
          AND NOT EXISTS (SELECT 1 FROM same_truth)
        RETURNING id
      ), inserted AS (
        INSERT INTO supplier_learning_examples (
          id, company_id, division_code, supplier_account_id, generation,
          invoice_id, artifact_id, content_hash, original_filename,
          original_prediction_json, final_fields_json, booking_lines_json,
          fingerprint, fingerprint_version, validation_result_json,
          processing_purpose, source, trust_state, trigger, actor_id,
          session_correlation_id, request_id, active, created_at,
          observation_state_json, format_signature, format_cluster
        )
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,
          $13,$14,$15::jsonb,$16,$17,$18,$19,$20,$21,$22,true,$23,$27::jsonb,
          $28,$29
        FROM profile_ok
        WHERE NOT EXISTS (SELECT 1 FROM same_truth)
          AND (
            NOT EXISTS (SELECT 1 FROM existing) OR
            EXISTS (SELECT 1 FROM deactivated)
          )
        ON CONFLICT(company_id, division_code, supplier_account_id, generation, content_hash)
          WHERE active = true
          DO NOTHING
        RETURNING *
      ), updated AS (
        UPDATE supplier_learning_profiles
        SET learned_count = learned_count + CASE
              WHEN EXISTS (SELECT 1 FROM existing) THEN 0 ELSE 1 END,
            last_learned_at = $23, updated_at = $23, version = version + 1
            , evidence_revision = evidence_revision + 1
        WHERE company_id=$2 AND division_code=$3 AND supplier_account_id=$4
          AND generation=$5 AND EXISTS (SELECT 1 FROM inserted)
      ), event_insert AS (
        INSERT INTO supplier_learning_events (
          id, company_id, division_code, supplier_account_id, generation,
          type, idempotency_key, actor_id, session_correlation_id, request_id,
          metadata_json, created_at
        )
        SELECT $24,$2,$3,$4,$5,'learn',$25,$20,$21,$22,$26::jsonb,$23
        FROM inserted
        ON CONFLICT(company_id, idempotency_key) DO NOTHING
      )
      SELECT inserted.*, true AS command_created FROM inserted
      UNION ALL
      SELECT existing.*, false AS command_created FROM existing
      WHERE EXISTS (SELECT 1 FROM same_truth)`,
      [
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
        eventId,
        `learn:${input.supplierAccountId}:${input.generation}:${input.contentHash}:${input.id}`,
        JSON.stringify({
          invoiceId: input.invoiceId,
          exampleId: input.id,
          trigger: input.trigger,
        }),
        JSON.stringify(input.observationState ?? {}),
        input.formatSignature ?? "",
        input.formatCluster ?? `fingerprint_${input.fingerprint}`,
      ]
    );
    if (rows[0]) {
      return {
        example: exampleFromRow(rows[0]),
        created: Boolean(rows[0].command_created),
      };
    }
    const existing = await this.query(
      `SELECT * FROM supplier_learning_examples
       WHERE company_id=$1 AND division_code=$2 AND supplier_account_id=$3
         AND generation=$4 AND content_hash=$5 AND active=true`,
      [
        input.companyId,
        input.divisionCode,
        input.supplierAccountId,
        input.generation,
        input.contentHash,
      ]
    );
    if (existing[0]) {
      return { example: exampleFromRow(existing[0]), created: false };
    }
    throw new LearningGenerationConflictError(
      "Supplier learning generation changed. Refresh and try again."
    );
  }

  async listExamples(scope: LearningScope, includeInactive = false) {
    const rows = await this.query(
      `SELECT examples.* FROM supplier_learning_examples AS examples
       JOIN supplier_learning_profiles AS profiles
         ON profiles.company_id = examples.company_id
        AND profiles.division_code = examples.division_code
        AND profiles.supplier_account_id = examples.supplier_account_id
       WHERE examples.company_id=$1 AND examples.division_code=$2
         AND examples.supplier_account_id=$3
         ${
           includeInactive
             ? ""
             : "AND examples.active=true AND examples.generation=profiles.generation"
         }
       ORDER BY examples.created_at, examples.id`,
      [scope.companyId, scope.divisionCode, scope.supplierAccountId]
    );
    return rows.map(exampleFromRow);
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
    const generation = input.expectedGeneration + 1;
    const rows = await this.query(
      `WITH updated_profile AS (
        UPDATE supplier_learning_profiles SET
          generation=$4, learned_count=0, confidence_score=35,
          drift_state='none', last_learned_at=NULL,
          evidence_revision=0, derived_evidence_revision=0,
          last_reset_at=$5, updated_at=$5,
          version=version+1
        WHERE company_id=$1 AND division_code=$2 AND supplier_account_id=$3
          AND generation=$6
        RETURNING *
      ), examples AS (
        UPDATE supplier_learning_examples SET active=false
        WHERE company_id=$1 AND division_code=$2 AND supplier_account_id=$3
          AND generation=$6 AND EXISTS (SELECT 1 FROM updated_profile)
      ), patterns AS (
        UPDATE supplier_learning_patterns SET active=false
        WHERE company_id=$1 AND division_code=$2 AND supplier_account_id=$3
          AND generation=$6 AND EXISTS (SELECT 1 FROM updated_profile)
      ), aliases AS (
        UPDATE supplier_identity_aliases SET active=false
        WHERE company_id=$1 AND division_code=$2 AND supplier_account_id=$3
          AND generation=$6 AND source <> 'exact'
          AND EXISTS (SELECT 1 FROM updated_profile)
      ), event_insert AS (
        INSERT INTO supplier_learning_events (
          id, company_id, division_code, supplier_account_id, generation,
          type, idempotency_key, actor_id, session_correlation_id, request_id,
          metadata_json, created_at
        ) SELECT $7,$1,$2,$3,$4,'reset',$8,$9,$10,$11,$12::jsonb,$5
          FROM updated_profile
        ON CONFLICT(company_id, idempotency_key) DO NOTHING
      ) SELECT * FROM updated_profile`,
      [
        input.companyId,
        input.divisionCode,
        input.supplierAccountId,
        generation,
        input.createdAt,
        input.expectedGeneration,
        `event_${randomUUID()}`,
        `reset:${input.requestId}`,
        input.actorId,
        input.sessionCorrelationId,
        input.requestId,
        JSON.stringify({
          previousGeneration: input.expectedGeneration,
          generation,
        }),
      ]
    );
    if (!rows[0]) {
      throw new LearningGenerationConflictError(
        "Supplier learning generation changed. Refresh and try again."
      );
    }
    return profileFromRow(rows[0]);
  }

  async listEvents(scope: LearningScope) {
    const rows = await this.query(
      `SELECT * FROM supplier_learning_events
       WHERE company_id=$1 AND division_code=$2 AND supplier_account_id=$3
       ORDER BY created_at, id`,
      [scope.companyId, scope.divisionCode, scope.supplierAccountId]
    );
    return rows.map(
      (row): LearningEventRecord => ({
        id: String(row.id),
        companyId: String(row.company_id),
        divisionCode: String(row.division_code),
        supplierAccountId: String(row.supplier_account_id),
        generation: Number(row.generation),
        type: row.type as LearningEventRecord["type"],
        idempotencyKey: String(row.idempotency_key),
        actorId: String(row.actor_id),
        sessionCorrelationId: String(row.session_correlation_id),
        requestId: String(row.request_id),
        metadata: row.metadata_json as Record<string, unknown>,
        createdAt: iso(row.created_at),
      })
    );
  }

  async saveEvent(input: LearningEventRecord) {
    await this.query(
      `INSERT INTO supplier_learning_events (
         id, company_id, division_code, supplier_account_id, generation,
         type, idempotency_key, actor_id, session_correlation_id, request_id,
         metadata_json, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
       ON CONFLICT (company_id, idempotency_key) DO NOTHING`,
      [
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
        input.createdAt,
      ]
    );
  }

  async getDataMigration(migrationName: string, version: number) {
    const rows = await this.query(
      `SELECT * FROM supplier_learning_data_migrations
       WHERE migration_name=$1 AND version=$2`,
      [migrationName, version]
    );
    return rows[0] ? dataMigrationFromRow(rows[0]) : null;
  }

  async recordDataMigration(input: LearningDataMigrationInput) {
    const rows = await this.query(
      `INSERT INTO supplier_learning_data_migrations (
         migration_name, version, source_snapshot_revision,
         source_snapshot_hash, status, row_counts_json, checksum,
         started_at, completed_at
       ) VALUES ($1, $2, $3, $4, 'completed', $5::jsonb, $6, $7, $8)
       ON CONFLICT (migration_name, version) DO UPDATE SET
         migration_name = EXCLUDED.migration_name
       WHERE supplier_learning_data_migrations.checksum = EXCLUDED.checksum
       RETURNING *, (xmax = 0) AS inserted`,
      [
        input.migrationName,
        input.version,
        input.sourceSnapshotRevision ?? null,
        input.sourceSnapshotHash ?? null,
        JSON.stringify(input.rowCounts),
        input.checksum,
        input.startedAt,
        input.completedAt,
      ]
    );
    if (!rows[0]) {
      throw new Error(
        "Learning data migration checksum does not match the recorded input."
      );
    }
    return {
      record: dataMigrationFromRow(rows[0]),
      created: Boolean(rows[0].inserted),
    };
  }
}
