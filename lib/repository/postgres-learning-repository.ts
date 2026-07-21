import { neon } from "@neondatabase/serverless";
import { randomUUID } from "node:crypto";
import {
  LearningGenerationConflictError,
  LEARNING_REPOSITORY_SCHEMA_VERSION,
  type LearningAliasInput,
  type LearningArtifactInput,
  type LearningArtifactRecord,
  type LearningEventRecord,
  type LearningExampleInput,
  type LearningExampleRecord,
  type LearningPatternInput,
  type LearningProfileRecord,
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
    fingerprint: String(row.fingerprint),
    fingerprintVersion: String(row.fingerprint_version),
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
    if (current < LEARNING_REPOSITORY_SCHEMA_VERSION) {
      await this.transaction([
        ...POSTGRES_LEARNING_MIGRATIONS.slice(1).map((query) => ({ query })),
        {
          query: `INSERT INTO supplier_learning_schema_migrations (version, applied_at)
                  VALUES ($1, $2) ON CONFLICT(version) DO NOTHING`,
          parameters: [
            LEARNING_REPOSITORY_SCHEMA_VERSION,
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
    input: LearningScope & { fallbackSupplierCode: string; createdAt: string }
  ) {
    const rows = await this.query(
      `INSERT INTO supplier_learning_profiles (
        company_id, division_code, supplier_account_id,
        fallback_supplier_code, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $5)
      ON CONFLICT(company_id, division_code, supplier_account_id)
      DO UPDATE SET fallback_supplier_code = CASE
        WHEN supplier_learning_profiles.fallback_supplier_code = ''
          THEN EXCLUDED.fallback_supplier_code
        ELSE supplier_learning_profiles.fallback_supplier_code
      END
      RETURNING *`,
      [
        input.companyId,
        input.divisionCode,
        input.supplierAccountId,
        input.fallbackSupplierCode,
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
      `SELECT * FROM supplier_learning_profiles
       WHERE company_id = $1 AND division_code = $2
       ORDER BY supplier_account_id`,
      [companyId, divisionCode]
    );
    return rows.map(profileFromRow);
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
      ) as unknown,
    };
  }

  async saveAlias(input: LearningAliasInput) {
    const rows = await this.query(
      `INSERT INTO supplier_identity_aliases (
        id, company_id, division_code, supplier_account_id, generation,
        kind, normalized_value, source, active, first_seen_at, last_seen_at
      )
      SELECT $1,$2,$3,$4,$5,$6,$7,$8,true,$9,$9
      FROM supplier_learning_profiles
      WHERE company_id=$2 AND division_code=$3 AND supplier_account_id=$4
        AND generation=$5
      ON CONFLICT(id) DO UPDATE SET
        last_seen_at = EXCLUDED.last_seen_at,
        active = true
      WHERE supplier_identity_aliases.generation = EXCLUDED.generation
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
      `INSERT INTO supplier_learning_patterns (
        id, company_id, division_code, supplier_account_id, generation,
        format_cluster, field, pattern_key, label, anchor_json,
        normalized_region_json, data_type, booking_mapping_json,
        support_count, success_count, correction_count, confidence,
        drift_state, model_version, active, created_at, updated_at
      )
      SELECT
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13::jsonb,
        $14,$15,$16,$17,$18,$19,true,$20,$20
      FROM supplier_learning_profiles
      WHERE company_id=$2 AND division_code=$3 AND supplier_account_id=$4
        AND generation=$5
      ON CONFLICT(
        company_id, division_code, supplier_account_id, generation,
        format_cluster, field, pattern_key
      ) DO UPDATE SET
        support_count = supplier_learning_patterns.support_count + EXCLUDED.support_count,
        success_count = supplier_learning_patterns.success_count + EXCLUDED.success_count,
        correction_count = supplier_learning_patterns.correction_count + EXCLUDED.correction_count,
        confidence = (
          supplier_learning_patterns.success_count + EXCLUDED.success_count + 1.0
        ) / (
          supplier_learning_patterns.support_count + EXCLUDED.support_count + 2.0
        ),
        drift_state = EXCLUDED.drift_state,
        model_version = EXCLUDED.model_version,
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

  async saveExample(input: LearningExampleInput) {
    const eventId = `event_${randomUUID()}`;
    const rows = await this.query(
      `WITH profile_ok AS (
        SELECT 1 FROM supplier_learning_profiles
        WHERE company_id=$2 AND division_code=$3 AND supplier_account_id=$4
          AND generation=$5
      ), inserted AS (
        INSERT INTO supplier_learning_examples (
          id, company_id, division_code, supplier_account_id, generation,
          invoice_id, artifact_id, content_hash, original_filename,
          original_prediction_json, final_fields_json, booking_lines_json,
          fingerprint, fingerprint_version, validation_result_json,
          processing_purpose, source, trust_state, trigger, actor_id,
          session_correlation_id, request_id, active, created_at
        )
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,
          $13,$14,$15::jsonb,$16,$17,$18,$19,$20,$21,$22,true,$23
        FROM profile_ok
        ON CONFLICT(company_id, division_code, supplier_account_id, generation, content_hash)
          DO NOTHING
        RETURNING *
      ), updated AS (
        UPDATE supplier_learning_profiles
        SET learned_count = learned_count + 1,
            last_learned_at = $23, updated_at = $23, version = version + 1
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
      ) SELECT * FROM inserted`,
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
        `learn:${input.supplierAccountId}:${input.generation}:${input.contentHash}`,
        JSON.stringify({
          invoiceId: input.invoiceId,
          exampleId: input.id,
          trigger: input.trigger,
        }),
      ]
    );
    if (rows[0]) {
      return { example: exampleFromRow(rows[0]), created: true };
    }
    const existing = await this.query(
      `SELECT * FROM supplier_learning_examples
       WHERE company_id=$1 AND division_code=$2 AND supplier_account_id=$3
         AND generation=$4 AND content_hash=$5`,
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
}
