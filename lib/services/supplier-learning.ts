import type {
  BookingLearningStore,
  SupplierConfidenceBreakdown,
  SupplierLearningExample,
  SupplierLearningPattern,
  SupplierLearningProfile,
} from "../domain/invoice";
import {
  assignFormatCluster,
  structuralFormat,
} from "./supplier-format-clustering";
import {
  rebuildSupplierPatterns,
  SUPPLIER_PATTERN_MODEL_VERSION,
} from "./supplier-pattern-derivation";
export * from "./supplier-format-clustering";
export * from "./supplier-reliability";
export * from "./supplier-reliability-evidence";

type LearningInput = Omit<SupplierLearningExample, "generation"> & {
  patterns?: Array<
    Omit<SupplierLearningPattern, "supplierAccountId" | "generation">
  >;
};

const clamp = (value: number) => Math.max(0, Math.min(1, value));

export function supplierConfidence(
  profile?: SupplierLearningProfile,
  patterns: SupplierLearningPattern[] = []
): SupplierConfidenceBreakdown {
  const exampleCount = profile?.exampleCount ?? 0;
  const volume = exampleCount / (exampleCount + 2);
  const activePatterns = profile
    ? patterns.filter(
        (pattern) =>
          pattern.supplierAccountId === profile.supplierAccountId &&
          pattern.generation === profile.generation &&
          pattern.attempts > 0 &&
          pattern.weight > 0
      )
    : [];
  const totalWeight = activePatterns.reduce(
    (total, pattern) => total + pattern.weight,
    0
  );
  const quality = totalWeight
    ? activePatterns.reduce(
        (total, pattern) =>
          total +
          pattern.weight *
            (Math.min(pattern.successes, pattern.attempts) + 1) /
            (pattern.attempts + 2),
        0
      ) / totalWeight
    : 0;
  const driftPenalty =
    profile?.formatDrift === "confirmed"
      ? 20
      : profile?.formatDrift === "possible"
        ? 10
        : 0;
  const score = Math.round(
    100 * clamp(0.35 + 0.65 * volume * quality - driftPenalty / 100)
  );

  return {
    score,
    band: score >= 85 ? "High" : score >= 65 ? "Medium" : "Low",
    baseline: 35,
    exampleCount,
    volume,
    quality,
    driftPenalty,
  };
}

export function learnSupplierInvoice(
  learning: BookingLearningStore,
  input: LearningInput
): BookingLearningStore {
  const profiles = learning.supplierProfiles ?? [];
  const examples = learning.supplierExamples ?? [];
  const patterns = learning.supplierPatterns ?? [];
  const current = profiles.find(
    (profile) => profile.supplierAccountId === input.supplierAccountId
  );
  const generation = current?.generation ?? 1;
  const duplicate = examples.find(
    (example) =>
      example.supplierAccountId === input.supplierAccountId &&
      example.generation === generation &&
      example.contentHash === input.contentHash &&
      example.active !== false
  );
  const sameTruth =
    duplicate &&
    JSON.stringify([
      duplicate.finalExtractedData,
      duplicate.bookingLines ?? [],
    ]) ===
      JSON.stringify([input.finalExtractedData, input.bookingLines ?? []]);
  if (sameTruth) {
    return learning;
  }

  const { patterns: patternObservations = [], ...exampleInput } = input;
  const knownClusters = examples
    .filter(
      (item) =>
        item.supplierAccountId === input.supplierAccountId &&
        item.generation === generation &&
        item.active !== false &&
        item.formatSignature &&
        item.formatCluster
    )
    .map((item) => ({ id: item.formatCluster!, signature: item.formatSignature! }));
  const formatCluster = input.formatSignature
    ? assignFormatCluster(input.formatSignature, knownClusters).clusterId
    : input.formatCluster ?? `fingerprint_${input.formatFingerprint}`;
  const example: SupplierLearningExample = {
    ...exampleInput,
    generation,
    formatCluster,
    active: true,
  };
  const activeExamples = examples.filter(
    (item) =>
      item.supplierAccountId === input.supplierAccountId &&
      item.generation === generation &&
      item.active !== false &&
      item !== duplicate
  );
  const nextExamples = [...activeExamples, example];
  const baselineFingerprint = current?.formatFingerprint ?? input.formatFingerprint;
  const profile: SupplierLearningProfile = {
    supplierAccountId: input.supplierAccountId,
    generation,
    exampleCount: new Set(
      [...activeExamples, example].map((item) => item.contentHash)
    ).size,
    lastLearnedAt: input.learnedAt,
    lastResetAt: current?.lastResetAt,
    formatFingerprint: baselineFingerprint,
    formatDrift: current?.formatDrift ?? "none",
  };

  const derivedPatterns = rebuildSupplierPatterns(
    input.supplierAccountId,
    generation,
    nextExamples
  );

  return {
    ...learning,
    revision: 1,
    supplierProfiles: [
      ...profiles.filter(
        (item) => item.supplierAccountId !== input.supplierAccountId
      ),
      profile,
    ],
    supplierExamples: [
      ...examples.map((item) =>
        item === duplicate
          ? { ...item, active: false, supersededById: example.id }
          : item
      ),
      example,
    ],
    supplierPatterns: [
      ...patterns.filter(
        (pattern) =>
          pattern.supplierAccountId !== input.supplierAccountId ||
          pattern.generation !== generation ||
          pattern.modelVersion !== SUPPLIER_PATTERN_MODEL_VERSION
      ),
      ...(duplicate ? [] : patternObservations).map((pattern) => ({
        ...pattern,
        supplierAccountId: input.supplierAccountId,
        generation,
      })),
      ...derivedPatterns,
    ],
  };
}

export function resetSupplierLearning(
  learning: BookingLearningStore,
  supplierAccountId: string,
  resetAt: string
): BookingLearningStore {
  const profiles = learning.supplierProfiles ?? [];
  const current = profiles.find(
    (profile) => profile.supplierAccountId === supplierAccountId
  );
  const profile: SupplierLearningProfile = {
    supplierAccountId,
    generation: (current?.generation ?? 0) + 1,
    exampleCount: 0,
    lastResetAt: resetAt,
    formatDrift: "none",
  };

  return {
    ...learning,
    revision: 1,
    supplierProfiles: [
      ...profiles.filter(
        (item) => item.supplierAccountId !== supplierAccountId
      ),
      profile,
    ],
    supplierExamples: [...(learning.supplierExamples ?? [])],
    supplierPatterns: [...(learning.supplierPatterns ?? [])],
  };
}

export function formatFingerprint(documentText: string) {
  return structuralFormat(documentText).fingerprint;
}
