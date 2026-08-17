import { createHash } from "node:crypto";
import type { FieldCandidate } from "../domain/document-analysis";
import type {
  BookingLearningStore,
  ExtractedInvoiceData,
  SupplierLearningApplication,
  SupplierLearningOutcomeEvent,
  UploadedInvoice,
} from "../domain/invoice";
import { assignFormatCluster, structuralFormat } from "./supplier-format-clustering";
import type { SupplierLearningMode } from "./learning-feature-flags";

const OUTCOME_QUEUE_LIMIT = 512;

function outcomeId(values: unknown[]) {
  return `supplier_outcome_${createHash("sha256")
    .update(JSON.stringify(values))
    .digest("hex")
    .slice(0, 24)}`;
}

function enqueueOutcome(
  learning: BookingLearningStore,
  event: Omit<SupplierLearningOutcomeEvent, "id">
) {
  const events = (learning.supplierOutcomeEvents ??= []);
  const item = {
    ...event,
    id: outcomeId([
      event.supplierAccountId,
      event.generation,
      event.invoiceId,
      event.invoiceRevision,
      event.type,
      event.candidateIds,
      event.fields,
      event.validation,
    ]),
  };
  if (!events.some((candidate) => candidate.id === item.id)) events.push(item);
  if (events.length > OUTCOME_QUEUE_LIMIT) {
    events.splice(0, events.length - OUTCOME_QUEUE_LIMIT);
  }
}

export function recordSupplierCandidateApplication(
  learning: BookingLearningStore,
  invoice: Pick<UploadedInvoice, "id" | "revision" | "supplierLearningApplication">,
  candidates: readonly Pick<FieldCandidate, "id" | "field" | "clusterContext">[],
  createdAt = new Date().toISOString()
) {
  const scoped = candidates.filter(
    (candidate): candidate is typeof candidate & { id: string } =>
      Boolean(candidate.id && candidate.clusterContext)
  );
  const context = scoped[0]?.clusterContext;
  if (!context) return;
  const matching = scoped.filter(
    (candidate) =>
      candidate.clusterContext?.supplierAccountId === context.supplierAccountId &&
      candidate.clusterContext.generation === context.generation &&
      candidate.clusterContext.clusterId === context.clusterId
  );
  const application: SupplierLearningApplication = {
    id: outcomeId([
      "application",
      invoice.id,
      invoice.revision,
      matching.map((candidate) => candidate.id).sort(),
    ]),
    supplierAccountId: context.supplierAccountId,
    generation: context.generation,
    clusterId: context.clusterId,
    invoiceRevision: invoice.revision,
    candidates: matching.map(({ id, field }) => ({ id, field })),
    createdAt,
  };
  invoice.supplierLearningApplication = application;
  enqueueOutcome(learning, {
    supplierAccountId: application.supplierAccountId,
    generation: application.generation,
    invoiceId: invoice.id,
    invoiceRevision: application.invoiceRevision,
    type: "application",
    candidateIds: application.candidates.map((candidate) => candidate.id).sort(),
    fields: [...new Set(application.candidates.map((candidate) => candidate.field))].sort(),
    createdAt,
  });
}

export function recordSupplierCandidateOutcome(
  learning: BookingLearningStore,
  invoice: Pick<UploadedInvoice, "id" | "revision" | "supplierLearningApplication">,
  correctedFields: readonly string[] | "rejection",
  createdAt = new Date().toISOString()
) {
  const application = invoice.supplierLearningApplication;
  if (!application) return;
  const add = (
    type: "acceptance" | "correction" | "rejection",
    candidates: SupplierLearningApplication["candidates"]
  ) => {
    if (!candidates.length) return;
    enqueueOutcome(learning, {
      supplierAccountId: application.supplierAccountId,
      generation: application.generation,
      invoiceId: invoice.id,
      invoiceRevision: invoice.revision,
      type,
      candidateIds: candidates.map((candidate) => candidate.id).sort(),
      fields: [...new Set(candidates.map((candidate) => candidate.field))].sort(),
      createdAt,
    });
  };
  if (correctedFields === "rejection") {
    add("rejection", application.candidates);
  } else {
    const corrected = new Set(correctedFields);
    add("correction", application.candidates.filter(({ field }) => corrected.has(field)));
    add("acceptance", application.candidates.filter(({ field }) => !corrected.has(field)));
  }
  delete invoice.supplierLearningApplication;
}

export function recordSupplierValidationOutcome(
  learning: BookingLearningStore,
  invoice: Pick<UploadedInvoice, "id" | "revision" | "supplierLearningApplication">,
  passed: boolean,
  issueCount: number,
  createdAt = new Date().toISOString()
) {
  const application = invoice.supplierLearningApplication;
  if (!application) return;
  enqueueOutcome(learning, {
    supplierAccountId: application.supplierAccountId,
    generation: application.generation,
    invoiceId: invoice.id,
    invoiceRevision: invoice.revision,
    type: "validation",
    candidateIds: application.candidates.map((candidate) => candidate.id).sort(),
    fields: [...new Set(application.candidates.map((candidate) => candidate.field))].sort(),
    validation: { passed, issueCount: Math.max(0, Math.trunc(issueCount)) },
    createdAt,
  });
}

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
