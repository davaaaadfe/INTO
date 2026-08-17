import type {
  LearningAliasInput,
  LearningArtifactAnalysis,
  LearningArtifactInput,
  LearningArtifactRecord,
  LearningEventRecord,
  LearningExampleInput,
  LearningExampleRecord,
  LearningPatternInput,
  LearningProfileRecord,
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
  listPatterns(
    scope: LearningScope,
    includeInactive?: boolean
  ): Promise<Array<Record<string, unknown>>>;
  listEvents(scope: LearningScope): Promise<LearningEventRecord[]>;
  resetSupplier(input: ResetLearningSupplierInput): Promise<LearningProfileRecord>;
  close?(): void;
}
