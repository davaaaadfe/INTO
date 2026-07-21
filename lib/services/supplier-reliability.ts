export type SupplierReliabilityMetric =
  | "supplier_match"
  | "your_ref"
  | "invoice_date"
  | "amounts"
  | "vat"
  | "booking_split"
  | "accounting"
  | "validation"
  | "inverse_correction"
  | "duplicate_decision";

export type SupplierReliabilityTrigger =
  | "learn"
  | "review"
  | "booking"
  | "migration";

export const SUPPLIER_RELIABILITY_METRICS: Record<
  SupplierReliabilityMetric,
  { label: string; weight: number }
> = {
  supplier_match: { label: "Supplier match", weight: 0.15 },
  your_ref: { label: "Your ref", weight: 0.1 },
  invoice_date: { label: "Invoice date", weight: 0.08 },
  amounts: { label: "Net, VAT and total extraction", weight: 0.17 },
  vat: { label: "VAT extraction and VAT code", weight: 0.1 },
  booking_split: { label: "Booking-line split", weight: 0.15 },
  accounting: {
    label: "G/L, dimensions, payment condition, due date, description and accrual",
    weight: 0.1,
  },
  validation: { label: "Validation success", weight: 0.08 },
  inverse_correction: { label: "Inverse user-correction rate", weight: 0.05 },
  duplicate_decision: { label: "Duplicate and suspicious decisions", weight: 0.02 },
};

export type SupplierReliabilityExample = {
  contentHash: string;
  trustState?: "trusted" | "legacy";
  trigger?: SupplierReliabilityTrigger;
};

export type SupplierReliabilityOutcome = {
  metric: SupplierReliabilityMetric;
  success: boolean;
  occurredAt: string;
  evidence?: "trusted" | "legacy";
  status?: "observed" | "missing" | "infrastructure";
  trigger?: SupplierReliabilityTrigger;
};

export type SupplierReliabilityMetricBreakdown = {
  metric: SupplierReliabilityMetric;
  label: string;
  weight: number;
  normalizedWeight: number;
  outcomeCount: number;
  attempts: number;
  successes: number;
  quality: number;
  contribution: number;
};

export type SupplierReliabilityResult = {
  score: number;
  band: "Low" | "Medium" | "High";
  copy: string;
  baseline: 35;
  distinctExampleCount: number;
  effectiveExampleCount: number;
  volume: number;
  quality: number;
  driftPenalty: 0 | 10 | 20;
  metrics: SupplierReliabilityMetricBreakdown[];
};

export type SupplierReliabilityInput = {
  now?: string | Date;
  examples?: SupplierReliabilityExample[];
  outcomes?: SupplierReliabilityOutcome[];
  drift?: "none" | "possible" | "confirmed";
};

export const SUPPLIER_RELIABILITY_POLICY = {
  outcomeHalfLifeDays: 180,
  recencyFloor: 0.25,
  legacyEvidenceMultiplier: 0.35,
} as const;

const DAY_MS = 24 * 60 * 60 * 1_000;
const clamp = (value: number) => Math.max(0, Math.min(1, value));

function recencyWeight(occurredAt: string, now: number) {
  const occurred = Date.parse(occurredAt);
  const ageDays = Number.isFinite(occurred)
    ? Math.max(0, (now - occurred) / DAY_MS)
    : SUPPLIER_RELIABILITY_POLICY.outcomeHalfLifeDays * 2;
  return Math.max(
    SUPPLIER_RELIABILITY_POLICY.recencyFloor,
    2 ** (-ageDays / SUPPLIER_RELIABILITY_POLICY.outcomeHalfLifeDays)
  );
}

function evidenceWeight(evidence: "trusted" | "legacy" | undefined) {
  return evidence === "legacy"
    ? SUPPLIER_RELIABILITY_POLICY.legacyEvidenceMultiplier
    : 1;
}

function bandCopy(
  band: SupplierReliabilityResult["band"],
  distinctExampleCount: number
) {
  if (band === "High") {
    return "Strong supplier evidence across trusted outcomes.";
  }
  if (band === "Medium") {
    return "Useful supplier evidence; keep review safeguards active.";
  }
  return distinctExampleCount
    ? "Limited supplier evidence; review every suggested decision."
    : "No trusted supplier evidence yet.";
}

export function supplierReliability({
  now = new Date(),
  examples = [],
  outcomes = [],
  drift = "none",
}: SupplierReliabilityInput = {}): SupplierReliabilityResult {
  const distinctExamples = new Map<string, number>();
  for (const example of examples) {
    if (!example.contentHash) continue;
    distinctExamples.set(
      example.contentHash,
      Math.max(
        distinctExamples.get(example.contentHash) ?? 0,
        evidenceWeight(example.trustState)
      )
    );
  }
  const effectiveExampleCount = [...distinctExamples.values()].reduce(
    (sum, weight) => sum + weight,
    0
  );
  const volume = effectiveExampleCount / (effectiveExampleCount + 2);
  const nowMs = new Date(now).getTime();

  const observed = outcomes.filter(
    (outcome) => (outcome.status ?? "observed") === "observed"
  );
  const presentMetrics = Object.entries(SUPPLIER_RELIABILITY_METRICS).filter(
    ([metric]) => observed.some((outcome) => outcome.metric === metric)
  ) as Array<[
    SupplierReliabilityMetric,
    { label: string; weight: number },
  ]>;
  const presentWeight = presentMetrics.reduce(
    (sum, [, definition]) => sum + definition.weight,
    0
  );
  const metrics = presentMetrics.map(([metric, definition]) => {
    const metricOutcomes = observed.filter((outcome) => outcome.metric === metric);
    let attempts = 0;
    let successes = 0;
    for (const item of metricOutcomes) {
      const weight =
        recencyWeight(item.occurredAt, nowMs) * evidenceWeight(item.evidence);
      attempts += weight;
      if (item.success) successes += weight;
    }
    const quality = (successes + 1) / (attempts + 2);
    const normalizedWeight = definition.weight / presentWeight;
    return {
      metric,
      label: definition.label,
      weight: definition.weight,
      normalizedWeight,
      outcomeCount: metricOutcomes.length,
      attempts,
      successes,
      quality,
      contribution: normalizedWeight * quality,
    };
  });
  const quality = metrics.reduce((sum, metric) => sum + metric.contribution, 0);
  const driftPenalty = drift === "confirmed" ? 20 : drift === "possible" ? 10 : 0;
  const score = Math.round(
    100 * clamp(0.35 + 0.65 * volume * quality - driftPenalty / 100)
  );
  const band = score >= 85 ? "High" : score >= 65 ? "Medium" : "Low";

  return {
    score,
    band,
    copy: bandCopy(band, distinctExamples.size),
    baseline: 35,
    distinctExampleCount: distinctExamples.size,
    effectiveExampleCount,
    volume,
    quality,
    driftPenalty,
    metrics,
  };
}
