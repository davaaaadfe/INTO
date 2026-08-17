import type { FieldCandidate } from "../domain/document-analysis";
import type {
  BookingLearningStore,
  ExtractedInvoiceData,
} from "../domain/invoice";
import { assignFormatCluster, structuralFormat } from "./supplier-format-clustering";
import type { SupplierLearningMode } from "./learning-feature-flags";

export function supplierExtractionContext(
  learning: BookingLearningStore,
  supplierAccountId: string,
  documentText: string
) {
  const profile = learning.supplierProfiles.find(
    (item) => item.supplierAccountId === supplierAccountId
  );
  if (!profile || profile.formatDrift === "confirmed") return null;
  const examples = learning.supplierExamples.filter(
    (item) =>
      item.supplierAccountId === supplierAccountId &&
      item.generation === profile.generation &&
      item.active !== false &&
      item.trustState !== "pending" &&
      item.formatSignature &&
      item.formatCluster
  );
  const format = structuralFormat(documentText);
  const assignment = assignFormatCluster(
    format.signature,
    examples.map((item) => ({
      id: item.formatCluster!,
      signature: item.formatSignature!,
    }))
  );
  if (!assignment.recognized) return null;
  return {
    generation: profile.generation,
    clusterId: assignment.clusterId,
    distance: assignment.distance,
    patterns: learning.supplierPatterns.filter(
      (pattern) =>
        pattern.supplierAccountId === supplierAccountId &&
        pattern.generation === profile.generation &&
        pattern.formatCluster === assignment.clusterId &&
        pattern.active !== false
    ),
  };
}

export function applySupplierCandidateEvidence(
  extractedData: ExtractedInvoiceData,
  candidates: readonly FieldCandidate[],
  mode: SupplierLearningMode
) {
  const data = structuredClone(extractedData);
  const appliedFields: string[] = [];
  if (data.documentAnalysis) {
    data.documentAnalysis = {
      ...data.documentAnalysis,
      fieldCandidates: [...data.documentAnalysis.fieldCandidates, ...candidates],
    };
  }
  if (mode !== "apply") return { data, appliedFields };

  for (const candidate of candidates) {
    if (candidate.confidence < 0.9 || candidate.value === null) continue;
    const value = candidate.value;
    if (candidate.field === "referenceCode" && typeof value === "string") {
      data.referenceCode = value;
      data.invoiceNumber = value;
      data.referenceCodeConfidence = Math.max(
        data.referenceCodeConfidence ?? 0,
        candidate.confidence
      );
    } else if (
      [
        "supplierName",
        "invoiceNumber",
        "invoiceDate",
        "dueDate",
        "paymentTerms",
        "currency",
        "expenseDescription",
      ].includes(candidate.field) &&
      typeof value === "string"
    ) {
      (data as unknown as Record<string, unknown>)[candidate.field] = value;
    } else if (
      ["netAmount", "vatAmount", "grossAmount"].includes(candidate.field) &&
      typeof value === "number"
    ) {
      (data as unknown as Record<string, unknown>)[candidate.field] = value;
    } else {
      continue;
    }
    if (!appliedFields.includes(candidate.field)) appliedFields.push(candidate.field);
  }
  return { data, appliedFields };
}
