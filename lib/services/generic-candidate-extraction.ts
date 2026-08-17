import { createHash } from "node:crypto";
import type {
  ExtractedInvoiceData,
  ExtractionEvidenceField,
} from "../domain/invoice";
import type { FieldCandidate } from "../domain/document-analysis";

const fields = [
  "supplierName",
  "supplierVatNumber",
  "supplierAddress",
  "referenceCode",
  "invoiceDate",
  "dueDate",
  "paymentTerms",
  "currency",
  "companyVatNumber",
  "netAmount",
  "vatAmount",
  "grossAmount",
] as const satisfies readonly ExtractionEvidenceField[];

function candidateRule(field: ExtractionEvidenceField) {
  if (field === "referenceCode") return "invoice-reference-label";
  if (field === "invoiceDate" || field === "dueDate") return "invoice-date-label";
  if (field === "netAmount" || field === "vatAmount" || field === "grossAmount") {
    return "invoice-amount-label";
  }
  if (field.startsWith("supplier")) return "supplier-identity-label";
  return "invoice-field-label";
}

function candidateId(candidate: Omit<FieldCandidate, "id">) {
  const fingerprint = JSON.stringify([
    candidate.field,
    candidate.rawValue ?? String(candidate.value ?? ""),
    candidate.normalizedValue ?? candidate.value,
    candidate.source,
    candidate.rule ?? "",
    candidate.model ?? "",
    candidate.page ?? null,
    candidate.polygon,
  ]);
  return `candidate_${createHash("sha256").update(fingerprint).digest("hex").slice(0, 24)}`;
}

function withProvenance(candidate: FieldCandidate, providerModel: string): FieldCandidate {
  const enriched = {
    ...candidate,
    rawValue: candidate.rawValue ?? String(candidate.value ?? ""),
    normalizedValue: candidate.normalizedValue ?? candidate.value,
    rule: candidate.rule ?? "provider-field-candidate",
    model: candidate.model ?? providerModel,
    supportingText:
      candidate.supportingText ?? candidate.label ?? String(candidate.value ?? ""),
  };
  return { ...enriched, id: candidate.id ?? candidateId(enriched) };
}

export function genericFieldCandidates(
  data: Pick<ExtractedInvoiceData, (typeof fields)[number] | "extractionEvidence">,
  providerCandidates: readonly FieldCandidate[],
  providerModel: string
) {
  const candidates = providerCandidates.map((candidate) =>
    withProvenance(candidate, providerModel)
  );
  for (const field of fields) {
    const value = data[field];
    if (value === "" || value === null || value === undefined) continue;
    if (
      candidates.some(
        (candidate) =>
          candidate.field === field &&
          String(candidate.normalizedValue ?? candidate.value) === String(value)
      )
    ) {
      continue;
    }
    const evidence = data.extractionEvidence?.[field];
    const candidate = {
      value,
      rawValue: evidence?.rawValue ?? String(value),
      normalizedValue: value,
      field,
      label: evidence?.sourceLabel,
      page: evidence?.page,
      polygon: evidence?.polygon ?? [],
      confidence: evidence?.confidence ?? 0.75,
      source: "deterministic-rule",
      rule: candidateRule(field),
      model: "generic-deterministic-v1",
      supportingText: evidence?.context ?? evidence?.rawValue ?? String(value),
    } satisfies Omit<FieldCandidate, "id">;
    candidates.push({ ...candidate, id: candidateId(candidate) });
  }
  return [...new Map(candidates.map((candidate) => [candidate.id, candidate])).values()];
}
