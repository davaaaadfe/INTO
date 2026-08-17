import type {
  LearningAliasInput,
  LearningArtifactAnalysis,
  LearningArtifactInput,
  LearningArtifactRecord,
  LearningDataMigrationInput,
  LearningDataMigrationRecord,
  LearningEventRecord,
  LearningExampleInput,
  LearningExampleRecord,
  LearningPatternInput,
  LearningProfileRecord,
  ReplaceDerivedPatternsInput,
  LearningScope,
} from "./learning-repository";

export type EnsureLearningProfileInput = LearningScope & {
  fallbackSupplierCode: string;
  generation?: number;
  createdAt: string;
};

export type UpdateLearningConfidenceInput = LearningScope & {
  generation: number;
  score: number;
  driftState: LearningProfileRecord["driftState"];
  updatedAt: string;
};

export type ResetLearningSupplierInput = LearningScope & {
  expectedGeneration: number;
  actorId: string;
  sessionCorrelationId: string;
  requestId: string;
  createdAt: string;
};

export type CompleteLegacyLearningMigrationInput = LearningScope & {
  activeGeneration: number;
  updatedAt: string;
};

export interface LearningRepository {
  migrate(): Promise<void>;
  schemaVersion(): Promise<number>;
  ensureProfile(input: EnsureLearningProfileInput): Promise<LearningProfileRecord>;
  getProfile(scope: LearningScope): Promise<LearningProfileRecord | null>;
  listProfiles(companyId: string, divisionCode: string): Promise<LearningProfileRecord[]>;
  updateProfileConfidence(input: UpdateLearningConfidenceInput): Promise<void>;
  saveArtifact(input: LearningArtifactInput): Promise<LearningArtifactRecord>;
  existingArtifactIds(ids: string[]): Promise<Set<string>>;
  readArtifact(
    id: string
  ): Promise<{ rawText: string; analysis: LearningArtifactAnalysis } | null>;
  pruneExpiredArtifacts(currentTime: string): Promise<number>;
  saveExample(
    input: LearningExampleInput
  ): Promise<{ example: LearningExampleRecord; created: boolean }>;
  listExamples(
    scope: LearningScope,
    includeInactive?: boolean
  ): Promise<LearningExampleRecord[]>;
  saveAlias(input: LearningAliasInput): Promise<void>;
  findAliases(
    companyId: string,
    divisionCode: string,
    kind: LearningAliasInput["kind"],
    normalizedValue: string
  ): Promise<Array<Record<string, unknown>>>;
  savePattern(input: LearningPatternInput): Promise<void>;
  replaceDerivedPatterns(input: ReplaceDerivedPatternsInput): Promise<void>;
  listPatterns(
    scope: LearningScope,
    includeInactive?: boolean
  ): Promise<Array<Record<string, unknown>>>;
  listEvents(scope: LearningScope): Promise<LearningEventRecord[]>;
  saveEvent(input: LearningEventRecord): Promise<void>;
  getDataMigration(
    migrationName: string,
    version: number
  ): Promise<LearningDataMigrationRecord | null>;
  recordDataMigration(
    input: LearningDataMigrationInput
  ): Promise<{ record: LearningDataMigrationRecord; created: boolean }>;
  completeLegacyMigration(
    input: CompleteLegacyLearningMigrationInput
  ): Promise<LearningProfileRecord>;
  resetSupplier(input: ResetLearningSupplierInput): Promise<LearningProfileRecord>;
  close?(): void;
}
