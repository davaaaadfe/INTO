import type {
  ExtractedInvoiceData,
  SupplierLearningExample,
  SupplierLearningPattern,
} from "../domain/invoice";

export const SUPPLIER_PATTERN_MODEL_VERSION = "cluster-pattern-v1";

const learnedFields: Array<keyof ExtractedInvoiceData> = [
  "supplierName",
  "supplierVatNumber",
  "iban",
  "invoiceNumber",
  "referenceCode",
  "invoiceDate",
  "dueDate",
  "paymentTerms",
  "currency",
  "netAmount",
  "vatAmount",
  "grossAmount",
  "expenseDescription",
];

function observed(value: unknown) {
  return value !== undefined && value !== null && value !== "";
}

export function rebuildSupplierPatterns(
  supplierAccountId: string,
  generation: number,
  examples: SupplierLearningExample[]
): SupplierLearningPattern[] {
  const counts = new Map<string, { cluster: string; field: string; attempts: number; corrections: number }>();
  for (const example of examples) {
    if (
      example.supplierAccountId !== supplierAccountId ||
      example.generation !== generation ||
      example.active === false ||
      example.trustState === "pending" ||
      !example.finalExtractedData
    ) continue;
    const cluster = example.formatCluster ?? `fingerprint_${example.formatFingerprint}`;
    for (const field of learnedFields) {
      const finalValue = example.finalExtractedData[field];
      if (!observed(finalValue)) continue;
      const identity = `${cluster}\u0000${field}`;
      const count = counts.get(identity) ?? { cluster, field, attempts: 0, corrections: 0 };
      count.attempts += 1;
      const originalValue = example.originalExtractedData?.[field];
      if (observed(originalValue) && JSON.stringify(originalValue) !== JSON.stringify(finalValue)) {
        count.corrections += 1;
      }
      counts.set(identity, count);
    }
  }
  return [...counts.values()]
    .sort((left, right) => left.cluster.localeCompare(right.cluster) || left.field.localeCompare(right.field))
    .map((count) => ({
      supplierAccountId,
      generation,
      key: `field:${count.field}`,
      field: count.field,
      formatCluster: count.cluster,
      successes: count.attempts - count.corrections,
      attempts: count.attempts,
      weight: count.attempts,
      supportCount: count.attempts,
      successCount: count.attempts - count.corrections,
      correctionCount: count.corrections,
      confidence: (count.attempts - count.corrections + 1) / (count.attempts + 2),
      driftState: "none",
      modelVersion: SUPPLIER_PATTERN_MODEL_VERSION,
      active: true,
    }));
}
