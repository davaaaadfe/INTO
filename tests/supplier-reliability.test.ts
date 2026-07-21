import assert from "node:assert/strict";
import test from "node:test";
import {
  SUPPLIER_RELIABILITY_METRICS,
  SUPPLIER_RELIABILITY_POLICY,
  supplierReliability,
  type SupplierReliabilityExample,
  type SupplierReliabilityOutcome,
} from "../lib/services/supplier-reliability";
import { supplierReliability as exportedSupplierReliability } from "../lib/services/supplier-learning";

const now = "2026-07-21T00:00:00.000Z";

function examples(count: number): SupplierReliabilityExample[] {
  return Array.from({ length: count }, (_, index) => ({
    contentHash: `hash-${index}`,
    trustState: "trusted",
  }));
}

function outcome(
  metric: SupplierReliabilityOutcome["metric"],
  success: boolean,
  overrides: Partial<SupplierReliabilityOutcome> = {}
): SupplierReliabilityOutcome {
  return {
    metric,
    success,
    occurredAt: now,
    evidence: "trusted",
    ...overrides,
  };
}

test("starts at the 35% baseline with explainable low-reliability copy", () => {
  assert.equal(exportedSupplierReliability, supplierReliability);
  assert.deepEqual(supplierReliability({ now }), {
    score: 35,
    band: "Low",
    copy: "No trusted supplier evidence yet.",
    baseline: 35,
    distinctExampleCount: 0,
    effectiveExampleCount: 0,
    volume: 0,
    quality: 0,
    driftPenalty: 0,
    metrics: [],
  });
});

test("uses the approved metric families and renormalizes around missing outcomes", () => {
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(SUPPLIER_RELIABILITY_METRICS).map(([key, value]) => [
        key,
        value.weight,
      ])
    ),
    {
      supplier_match: 0.15,
      your_ref: 0.1,
      invoice_date: 0.08,
      amounts: 0.17,
      vat: 0.1,
      booking_split: 0.15,
      accounting: 0.1,
      validation: 0.08,
      inverse_correction: 0.05,
      duplicate_decision: 0.02,
    }
  );
  assert.equal(
    SUPPLIER_RELIABILITY_METRICS.accounting.label,
    "G/L, dimensions, payment condition, due date, description and accrual"
  );

  const result = supplierReliability({
    now,
    examples: examples(2),
    outcomes: [
      outcome("supplier_match", true),
      outcome("validation", false),
      outcome("amounts", false, { status: "missing" }),
      outcome("vat", false, { status: "infrastructure" }),
    ],
  });

  assert.equal(result.metrics.length, 2);
  assert.deepEqual(
    result.metrics.map(({ metric, attempts, successes, quality }) => ({
      metric,
      attempts,
      successes,
      quality,
    })),
    [
      {
        metric: "supplier_match",
        attempts: 1,
        successes: 1,
        quality: 2 / 3,
      },
      {
        metric: "validation",
        attempts: 1,
        successes: 0,
        quality: 1 / 3,
      },
    ]
  );
  assert.ok(Math.abs(result.metrics[0].normalizedWeight - 15 / 23) < 1e-12);
  assert.ok(Math.abs(result.metrics[1].normalizedWeight - 8 / 23) < 1e-12);
  assert.ok(Math.abs(result.quality - 38 / 69) < 1e-12);
  assert.equal(result.metrics.reduce((sum, item) => sum + item.contribution, 0), result.quality);
});

test("deduplicates trusted example volume and reduces legacy evidence", () => {
  const result = supplierReliability({
    now,
    examples: [
      { contentHash: "same", trustState: "legacy" },
      { contentHash: "same", trustState: "trusted" },
      { contentHash: "legacy-only", trustState: "legacy" },
    ],
    outcomes: [
      outcome("supplier_match", true),
      outcome("supplier_match", false, { evidence: "legacy" }),
    ],
  });

  assert.equal(result.distinctExampleCount, 2);
  assert.equal(result.effectiveExampleCount, 1.35);
  assert.ok(Math.abs(result.volume - 1.35 / 3.35) < 1e-12);
  assert.equal(result.metrics[0].attempts, 1.35);
  assert.equal(result.metrics[0].successes, 1);
  assert.ok(Math.abs(result.metrics[0].quality - 2 / 3.35) < 1e-12);
});

test("weights recent outcomes above old outcomes with a conservative floor", () => {
  assert.deepEqual(SUPPLIER_RELIABILITY_POLICY, {
    outcomeHalfLifeDays: 180,
    recencyFloor: 0.25,
    legacyEvidenceMultiplier: 0.35,
  });
  const result = supplierReliability({
    now,
    examples: examples(3),
    outcomes: [
      outcome("your_ref", true),
      outcome("your_ref", false, {
        occurredAt: "2025-07-26T00:00:00.000Z",
      }),
    ],
  });

  assert.equal(result.metrics[0].attempts, 1.25);
  assert.equal(result.metrics[0].successes, 1);
  assert.ok(Math.abs(result.metrics[0].quality - 2 / 3.25) < 1e-12);
});

test("applies drift penalties after scoring and returns stable band copy", () => {
  const strongOutcomes = Array.from({ length: 100 }, () =>
    outcome("supplier_match", true)
  );
  const high = supplierReliability({
    now,
    examples: examples(100),
    outcomes: strongOutcomes,
  });
  const possible = supplierReliability({
    now,
    examples: examples(100),
    outcomes: strongOutcomes,
    drift: "possible",
  });
  const confirmed = supplierReliability({
    now,
    examples: examples(100),
    outcomes: strongOutcomes,
    drift: "confirmed",
  });

  assert.deepEqual(
    [high.score, high.band, high.copy],
    [98, "High", "Strong supplier evidence across trusted outcomes."]
  );
  assert.deepEqual(
    [possible.score, possible.band, possible.driftPenalty],
    [88, "High", 10]
  );
  assert.deepEqual(
    [confirmed.score, confirmed.band, confirmed.copy, confirmed.driftPenalty],
    [78, "Medium", "Useful supplier evidence; keep review safeguards active.", 20]
  );
});
