import { createHash } from "node:crypto";
import type {
  BookingLearningStore,
  SupplierConfidenceBreakdown,
  SupplierLearningExample,
  SupplierLearningPattern,
  SupplierLearningProfile,
} from "../domain/invoice";
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

const stableLabel = new RegExp(
  "^(invoice number|invoice date|document reference|amount due|due date|" +
    "net amount|vat amount|tax amount|invoice|reference|date|issued|" +
    "description|total|net|vat|tax|supplier|customer|iban|bic|currency)\\b"
);
const numericCell = /^(?:(?:[$€£¥]|eur|usd|gbp|chf|cad|aud|jpy|cny|sek|nok|dkk|pln)\s*)?[+-]?\d[\d\s.,'/-]*(?:\s*(?:%|x|pcs?|pieces?|units?|hours?|days?|[$€£¥]|eur|usd|gbp|chf|cad|aud|jpy|cny|sek|nok|dkk|pln))?$/i;

function fingerprintLine(rawLine: string) {
  const line = rawLine.normalize("NFKC").trim().toLowerCase();
  const field = line.match(/^([^:=]{1,80})([:=]).+$/);
  if (field) {
    return `${field[1].trim().replace(/\s+/g, " ")}${field[2]}<value>`;
  }

  if (/[|\t]/.test(line)) {
    const columns = line.split(/[|\t]/).map((column) => column.trim());
    return columns.some((column) => numericCell.test(column))
      ? `<row>${columns
          .map((column) => (numericCell.test(column) ? "<number>" : "<text>"))
          .join("|")}`
      : columns.join("|");
  }

  const label = line.match(stableLabel)?.[0];
  if (label) {
    return line === label ? label : `${label}:<value>`;
  }
  return line ? "<text>" : "";
}

export function formatFingerprint(documentText: string) {
  const lines = documentText
    .split(/\r?\n/)
    .map(fingerprintLine)
    .filter(Boolean);
  const normalized = lines
    .filter(
      (line, index) =>
        !line.startsWith("<row>") || line !== lines[index - 1]
    )
    .join("\n");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}
