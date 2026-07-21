import { createHash } from "node:crypto";
import type {
  BookingLearningStore,
  SupplierConfidenceBreakdown,
  SupplierLearningExample,
  SupplierLearningPattern,
  SupplierLearningProfile,
} from "../domain/invoice";

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
    : exampleCount
      ? (exampleCount + 1) / (exampleCount + 2)
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
  const duplicate = examples.some(
    (example) =>
      example.supplierAccountId === input.supplierAccountId &&
      example.generation === generation &&
      example.contentHash === input.contentHash
  );
  if (duplicate) {
    return learning;
  }

  const { patterns: patternObservations = [], ...exampleInput } = input;
  const example: SupplierLearningExample = { ...exampleInput, generation };
  const activeExamples = examples.filter(
    (item) =>
      item.supplierAccountId === input.supplierAccountId &&
      item.generation === generation
  );
  const baselineFingerprint =
    current?.formatFingerprint ?? input.formatFingerprint;
  const driftCount = [...activeExamples, example].filter(
    (item) => item.formatFingerprint !== baselineFingerprint
  ).length;
  const profile: SupplierLearningProfile = {
    supplierAccountId: input.supplierAccountId,
    generation,
    exampleCount: activeExamples.length + 1,
    lastLearnedAt: input.learnedAt,
    lastResetAt: current?.lastResetAt,
    formatFingerprint: baselineFingerprint,
    formatDrift:
      driftCount >= 2 ? "confirmed" : driftCount === 1 ? "possible" : "none",
  };

  return {
    ...learning,
    revision: 1,
    supplierProfiles: [
      ...profiles.filter(
        (item) => item.supplierAccountId !== input.supplierAccountId
      ),
      profile,
    ],
    supplierExamples: [...examples, example],
    supplierPatterns: [
      ...patterns,
      ...patternObservations.map((pattern) => ({
        ...pattern,
        supplierAccountId: input.supplierAccountId,
        generation,
      })),
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
  const normalized = documentText
    .normalize("NFKC")
    .toLowerCase()
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\s+/g, " ").replace(/\d+/g, "#"))
    .filter(Boolean)
    .join("\n");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}
