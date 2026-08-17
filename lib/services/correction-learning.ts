import type {
  BookingLearningStore,
  ExtractedInvoiceData,
  IntoUser,
  LearnableCorrectionField,
  LearnedCorrection,
  PurchaseJournalLine,
  UploadedInvoice,
} from "../domain/invoice";
import type { FieldCandidate } from "../domain/document-analysis";
import { createId } from "../utils/id";
import { detectInvoiceReference } from "./invoice-extraction-service";
import { amountToMinorUnits, normalizeText } from "./invoice-validation";
import {
  normalizeSupplierChamberOfCommerce,
  normalizeSupplierIban,
  normalizeSupplierName,
  normalizeSupplierVat,
  supplierIdentityKeys,
} from "./supplier-identity";
import { supplierLearningMode } from "./learning-feature-flags";
import {
  applySupplierCandidateEvidence,
  supplierExtractionContext,
} from "./supplier-specific-extraction";

export const LEARNED_CORRECTION_NOTE =
  "Applied from previous user correction.";

const highConfidenceThreshold = 0.92;
const referenceLabels = [
  "factuurnummer",
  "factuur nr",
  "factuurnr",
  "referentie",
  "kenmerk",
  "invoice number",
  "invoice no",
  "invoice #",
  "reference",
  "ref",
  "document number",
  "bill number",
  "rechnungsnummer",
  "rechnung nr",
  "belegnummer",
  "referenz",
  "numero de facture",
  "n facture",
  "reference",
  "numero de factura",
  "n factura",
  "referencia",
  "numero fattura",
  "n fattura",
  "riferimento",
];

const learnedFieldLabels: Partial<
  Record<LearnableCorrectionField, string[]>
> = {
  invoiceDate: [
    "invoice date",
    "factuurdatum",
    "rechnungsdatum",
    "date de facture",
    "fecha de factura",
    "data fattura",
  ],
  netAmount: [
    "net amount",
    "netto bedrag",
    "subtotal",
    "subtotaal",
    "net amount excl vat",
  ],
  vatAmount: [
    "vat amount",
    "btw bedrag",
    "tax amount",
    "mwst betrag",
    "montant tva",
  ],
  totalAmount: [
    "total amount",
    "invoice total",
    "factuurtotaal",
    "totaal te betalen",
    "amount due",
  ],
};

type CorrectionUser = Pick<IntoUser, "id" | "name">;

type CaptureInput = {
  invoice: UploadedInvoice;
  nextExtractedData: ExtractedInvoiceData;
  nextBookingLines: PurchaseJournalLine[];
  learning: BookingLearningStore;
  user: CorrectionUser;
  correctedAt?: string;
};

function normalizedValue(value: unknown) {
  return normalizeText(String(value ?? "")).replace(/[^a-z0-9]+/g, "-");
}

export function canonicalSupplierIdentityKeys(
  data: Pick<
    ExtractedInvoiceData,
    | "supplierVatNumber"
    | "iban"
    | "supplierChamberOfCommerceNumber"
    | "supplierName"
  >
) {
  return supplierIdentityKeys({ ...data, supplierAddress: "" });
}

export function canonicalSupplierIdentityKey(identity: string) {
  const separator = identity.indexOf(":");
  if (separator < 0) return identity;
  const kind = identity.slice(0, separator).toLowerCase();
  const value = identity.slice(separator + 1);
  if (kind === "vat") return `vat:${normalizeSupplierVat(value)}`;
  if (kind === "iban") return `iban:${normalizeSupplierIban(value).toLowerCase()}`;
  if (kind === "coc") {
    return `coc:${normalizeSupplierChamberOfCommerce(value).toLowerCase()}`;
  }
  if (kind === "name") {
    return `name:${normalizeSupplierName(value).replace(/\s/g, "-")}`;
  }
  return identity;
}

function primarySupplierIdentity(data: ExtractedInvoiceData) {
  return (
    canonicalSupplierIdentityKeys(data)[0] ??
    `name:${normalizedValue(data.supplierName)}`
  );
}

export function learningDescriptionKey(value: string) {
  return normalizedValue(value)
    .replace(/^\d{4}-\d{2}-/, "")
    .replace(/^\d{4}-\d{2}/, "")
    .replace(/^\d{4}\d{2}/, "")
    .replace(/^-|-$/g, "");
}

function invoiceMatchKey(data: ExtractedInvoiceData) {
  const lineDescriptions = data.lineItems
    .map((line) => learningDescriptionKey(line.description))
    .filter(Boolean)
    .join("+");
  return lineDescriptions || learningDescriptionKey(data.expenseDescription);
}

export function learnedFilenamePattern(fileName: string) {
  const baseName = fileName.split(/[\\/]/).pop() ?? fileName;
  const extension = /\.[a-z0-9]{1,10}$/i.exec(baseName)?.[0].toLowerCase();
  return extension ? `*${extension}` : "unknown";
}

function contextAround(data: ExtractedInvoiceData, values: unknown[]) {
  const text = data.rawText?.trim() ?? "";
  if (!text) {
    return undefined;
  }

  const needle = values
    .map((value) => String(value ?? "").trim())
    .find((value) => value && text.toLowerCase().includes(value.toLowerCase()));
  if (!needle) {
    return text.slice(0, 240);
  }

  const index = text.toLowerCase().indexOf(needle.toLowerCase());
  return text.slice(Math.max(0, index - 100), Math.min(text.length, index + needle.length + 100));
}

function referenceLabel(data: ExtractedInvoiceData, correctedValue: string) {
  const evidenceLabel = data.extractionEvidence?.referenceCode?.sourceLabel;
  if (evidenceLabel) {
    return evidenceLabel;
  }
  const text = data.rawText ?? "";
  const value = correctedValue.toLowerCase();
  const relevantLine = text
    .split(/\r?\n/)
    .find((line) => line.toLowerCase().includes(value));
  const normalizedLine = normalizeText(relevantLine ?? text);
  return referenceLabels.find((label) => normalizedLine.includes(label));
}

function containsLearnedLabel(line: string, label: string) {
  const escaped = normalizeText(label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`).test(
    normalizeText(line)
  );
}

function learnedFieldLabel(
  data: ExtractedInvoiceData,
  field: LearnableCorrectionField
) {
  const evidenceField =
    field === "invoiceDate"
      ? "invoiceDate"
      : field === "netAmount"
        ? "netAmount"
        : field === "vatAmount"
          ? "vatAmount"
          : field === "totalAmount"
            ? "grossAmount"
            : null;
  const evidenceLabel = evidenceField
    ? data.extractionEvidence?.[evidenceField]?.sourceLabel
    : undefined;
  if (evidenceLabel) {
    return evidenceLabel;
  }
  const labels = learnedFieldLabels[field] ?? [];
  const normalizedLines = (data.rawText ?? "")
    .split(/\r?\n/);
  return labels.find((label) =>
    normalizedLines.some((line) => containsLearnedLabel(line, label))
  );
}

function correctionKey(correction: Pick<LearnedCorrection, "field" | "supplierIdentity" | "matchKey" | "metadata">) {
  return [
    correction.field,
    correction.supplierIdentity,
    correction.matchKey,
    String(correction.metadata?.lineIndex ?? "invoice"),
  ].join(":");
}

function corrections(learning: BookingLearningStore) {
  if (!Array.isArray(learning.corrections)) {
    learning.corrections = [];
  }
  return learning.corrections;
}

function upsertCorrection(
  learning: BookingLearningStore,
  correction: Omit<LearnedCorrection, "id">
) {
  const items = corrections(learning);
  const key = correctionKey(correction);
  const existingIndex = items.findIndex((item) => correctionKey(item) === key);
  const item: LearnedCorrection = {
    ...correction,
    id: existingIndex >= 0 ? items[existingIndex].id : createId("learned"),
    originalValue:
      existingIndex >= 0 ? items[existingIndex].originalValue : correction.originalValue,
  };

  if (existingIndex >= 0) {
    items.splice(existingIndex, 1);
  }
  items.unshift(item);
  return item;
}

function lineComparable(line: PurchaseJournalLine) {
  return {
    glAccount: line.finalSelectedAccount || line.glAccount,
    description: line.description,
    from: line.from,
    to: line.to,
    costCentre: line.costCentre,
    costUnit: line.costUnit,
    vatCode: line.vatCode,
    amount: line.amount,
    vatAmount: line.vatAmount,
  };
}

function learnedSplitLine(
  line: PurchaseJournalLine,
  previousLine: PurchaseJournalLine | undefined
) {
  if (!previousLine) {
    return {
      ...line,
      glConfidence: 1,
      vatConfidence: 1,
      costCentreConfidence: 1,
      costUnitConfidence: 1,
    };
  }

  const previousGl =
    previousLine.finalSelectedAccount || previousLine.glAccount;
  const nextGl = line.finalSelectedAccount || line.glAccount;
  return {
    ...line,
    glConfidence:
      previousGl === nextGl ? previousLine.glConfidence : 1,
    vatConfidence:
      previousLine.vatCode === line.vatCode ? previousLine.vatConfidence : 1,
    costCentreConfidence:
      previousLine.costCentre === line.costCentre
        ? previousLine.costCentreConfidence
        : 1,
    costUnitConfidence:
      previousLine.costUnit === line.costUnit
        ? previousLine.costUnitConfidence
        : 1,
  };
}

function lineValuesEqual(left: PurchaseJournalLine[], right: PurchaseJournalLine[]) {
  return JSON.stringify(left.map(lineComparable)) === JSON.stringify(right.map(lineComparable));
}

function correctionConfidenceBefore(
  input: CaptureInput,
  field: LearnableCorrectionField,
  metadata?: Record<string, unknown>
) {
  const lineIndex =
    typeof metadata?.lineIndex === "number" ? metadata.lineIndex : undefined;
  const line =
    lineIndex === undefined
      ? undefined
      : (input.invoice.bookingLineOverrides ??
          input.invoice.purchaseJournal?.lines ??
          [])[lineIndex];
  const scores = input.invoice.purchaseJournal?.confidenceScores;

  switch (field) {
    case "supplier":
      return scores?.supplierMatch ?? input.invoice.extractedData.confidence ?? 0;
    case "yourRefPattern":
      return (
        input.invoice.extractedData.referenceCodeConfidence ??
        input.invoice.extractedData.confidence ??
        0
      );
    case "paymentCondition":
      return scores?.paymentCondition ?? input.invoice.extractedData.confidence ?? 0;
    case "glAccount":
      return line?.glConfidence ?? scores?.glAccount ?? 0;
    case "vatCode":
      return line?.vatConfidence ?? scores?.vatCode ?? 0;
    case "costCentre":
      return line?.costCentreConfidence ?? scores?.costCentre ?? 0;
    case "costUnit":
      return line?.costUnitConfidence ?? scores?.costUnit ?? 0;
    case "bookingLineSplit":
      return scores?.overall ?? input.invoice.extractedData.confidence ?? 0;
    default:
      return input.invoice.extractedData.confidence ?? 0;
  }
}

function record(
  input: CaptureInput,
  field: LearnableCorrectionField,
  originalValue: unknown,
  correctedValue: unknown,
  metadata?: Record<string, unknown>
) {
  if (JSON.stringify(originalValue) === JSON.stringify(correctedValue)) {
    return null;
  }

  const originalData = input.invoice.extractedData;
  const decidedAt = input.correctedAt ?? new Date().toISOString();
  const supplierAccountId =
    input.invoice.purchaseJournal?.supplierResolution.selectedAccountId;
  const extractionContext = supplierAccountId
    ? supplierExtractionContext(
        input.learning,
        supplierAccountId,
        originalData.rawText ?? ""
      )
    : null;
  const priorRule = matchingCorrections(
    input.invoice,
    originalData,
    input.learning,
    field
  ).find((item) => {
    const sameLine =
      String(item.metadata?.lineIndex ?? "invoice") ===
      String(metadata?.lineIndex ?? "invoice");
    const sameKind =
      field !== "supplier" ||
      item.metadata?.correctionKind === metadata?.correctionKind;
    return sameLine && sameKind;
  }) ?? corrections(input.learning).find((item) => {
    const sameLine =
      String(item.metadata?.lineIndex ?? "invoice") ===
      String(metadata?.lineIndex ?? "invoice");
    const sameKind =
      field !== "supplier" ||
      item.metadata?.correctionKind === metadata?.correctionKind;
    return item.invoiceId === input.invoice.id && item.field === field && sameLine && sameKind;
  });
  const resolvedMetadata = { ...(priorRule?.metadata ?? {}) };
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (value !== undefined) {
      resolvedMetadata[key] = value;
    }
  }

  return upsertCorrection(input.learning, {
    invoiceId: input.invoice.id,
    field,
    supplierIdentity:
      priorRule?.supplierIdentity ?? primarySupplierIdentity(originalData),
    supplierName: input.nextExtractedData.supplierName || originalData.supplierName,
    supplierAccountId: supplierAccountId ?? priorRule?.supplierAccountId,
    generation: extractionContext?.generation ?? priorRule?.generation,
    formatCluster: extractionContext?.clusterId ?? priorRule?.formatCluster,
    matchKey: priorRule?.matchKey ?? invoiceMatchKey(originalData),
    originalValue: priorRule?.originalValue ?? originalValue,
    correctedValue,
    invoiceTextContext: contextAround(originalData, [correctedValue, originalValue]),
    filenamePattern:
      priorRule?.filenamePattern ?? learnedFilenamePattern(input.invoice.fileName),
    confidence: supplierAccountId ? 0.99 : 0.95,
    confidenceBefore: correctionConfidenceBefore(input, field, metadata),
    confidenceAfter: 1,
    correctedAt: decidedAt,
    correctedByUserId: input.user.id,
    correctedByUserName: input.user.name,
    trustState: "pending",
    metadata:
      Object.keys(resolvedMetadata).length > 0 ? resolvedMetadata : undefined,
  });
}

export function captureUserCorrections(input: CaptureInput) {
  const captured: LearnedCorrection[] = [];
  const add = (item: LearnedCorrection | null) => {
    if (item) {
      captured.push(item);
    }
  };
  const previousData = input.invoice.extractedData;
  const nextData = input.nextExtractedData;

  add(
    record(input, "supplier", previousData.supplierName, nextData.supplierName, {
      correctionKind: "extractedValue",
    })
  );
  add(
    record(input, "yourRefPattern", previousData.referenceCode, nextData.referenceCode, {
      referenceLabel: referenceLabel(previousData, nextData.referenceCode),
    })
  );
  add(
    record(
      input,
      "expenseDescription",
      previousData.expenseDescription,
      nextData.expenseDescription
    )
  );
  add(
    record(
      input,
      "paymentCondition",
      previousData.paymentTerms,
      nextData.paymentTerms
    )
  );
  add(
    record(input, "invoiceDate", previousData.invoiceDate, nextData.invoiceDate, {
      sourceLabel: learnedFieldLabel(previousData, "invoiceDate"),
    })
  );
  add(
    record(input, "netAmount", previousData.netAmount, nextData.netAmount, {
      sourceLabel: learnedFieldLabel(previousData, "netAmount"),
    })
  );
  add(
    record(input, "vatAmount", previousData.vatAmount, nextData.vatAmount, {
      sourceLabel: learnedFieldLabel(previousData, "vatAmount"),
    })
  );
  add(
    record(input, "totalAmount", previousData.grossAmount, nextData.grossAmount, {
      sourceLabel: learnedFieldLabel(previousData, "totalAmount"),
    })
  );

  const previousLines =
    input.invoice.bookingLineOverrides ?? input.invoice.purchaseJournal?.lines ?? [];
  input.nextBookingLines.forEach((nextLine, index) => {
    const previousLine = previousLines[index];
    if (!previousLine) {
      return;
    }

    const metadata = {
      lineIndex: index,
      sourceLineItemId: nextLine.sourceLineItemId,
    };
    const nextGl = nextLine.finalSelectedAccount || nextLine.glAccount;
    const previousGl = previousLine.finalSelectedAccount || previousLine.glAccount;

    add(record(input, "glAccount", previousGl, nextGl, metadata));
    add(record(input, "vatCode", previousLine.vatCode, nextLine.vatCode, metadata));
    add(
      record(
        input,
        "costCentre",
        previousLine.costCentre,
        nextLine.costCentre,
        metadata
      )
    );
    add(
      record(input, "costUnit", previousLine.costUnit, nextLine.costUnit, metadata)
    );
    add(
      record(
        input,
        "expenseDescription",
        previousLine.description,
        nextLine.description,
        metadata
      )
    );
    add(record(input, "accrualFrom", previousLine.from, nextLine.from, metadata));
    add(record(input, "accrualTo", previousLine.to, nextLine.to, metadata));
  });

  if (!lineValuesEqual(previousLines, input.nextBookingLines)) {
    add(
      record(
        input,
        "bookingLineSplit",
        previousLines.map(lineComparable),
        input.nextBookingLines.map((line, index) =>
          learnedSplitLine(line, previousLines[index])
        ),
        {
          lineCount: input.nextBookingLines.length,
          invoiceDate: nextData.invoiceDate || previousData.invoiceDate,
        }
      )
    );
  }

  return captured;
}

export function captureSupplierAccountCorrection(input: {
  invoice: UploadedInvoice;
  learning: BookingLearningStore;
  accountId: string;
  accountName: string;
  user: CorrectionUser;
  correctedAt?: string;
}) {
  return upsertCorrection(input.learning, {
    invoiceId: input.invoice.id,
    field: "supplier",
    supplierIdentity: primarySupplierIdentity(input.invoice.extractedData),
    supplierName: input.invoice.extractedData.supplierName,
    supplierAccountId: input.accountId,
    matchKey: invoiceMatchKey(input.invoice.extractedData),
    originalValue:
      input.invoice.purchaseJournal?.supplierResolution.selectedAccountId ??
      input.invoice.extractedData.supplierName,
    correctedValue: input.accountId,
    invoiceTextContext: contextAround(input.invoice.extractedData, [
      input.accountName,
      input.invoice.extractedData.supplierName,
    ]),
    filenamePattern: learnedFilenamePattern(input.invoice.fileName),
    confidence: 1,
    confidenceBefore:
      input.invoice.purchaseJournal?.confidenceScores.supplierMatch ??
      input.invoice.extractedData.confidence ??
      0,
    confidenceAfter: 1,
    correctedAt: input.correctedAt ?? new Date().toISOString(),
    correctedByUserId: input.user.id,
    correctedByUserName: input.user.name,
    trustState: "pending",
    metadata: {
      correctionKind: "exactAccount",
      accountName: input.accountName,
    },
  });
}

function supplierMatchConfidence(
  correction: LearnedCorrection,
  data: ExtractedInvoiceData
) {
  if (
    canonicalSupplierIdentityKeys(data).includes(
      canonicalSupplierIdentityKey(correction.supplierIdentity)
    )
  ) {
    return correction.supplierIdentity.startsWith("name:") ? 0.95 : 0.99;
  }
  if (normalizedValue(correction.supplierName) === normalizedValue(data.supplierName)) {
    return 0.94;
  }
  if (normalizedValue(correction.originalValue) === normalizedValue(data.supplierName)) {
    return 0.94;
  }
  return 0;
}

function matchingCorrections(
  invoice: UploadedInvoice,
  data: ExtractedInvoiceData,
  learning: BookingLearningStore,
  field: LearnableCorrectionField
) {
  const matchKey = invoiceMatchKey(data);
  return corrections(learning).filter((item) => {
    if (item.generation !== undefined) {
      const profile = item.supplierAccountId
        ? learning.supplierProfiles.find(
            (candidate) => candidate.supplierAccountId === item.supplierAccountId
          )
        : undefined;
      if (profile?.generation !== item.generation) return false;
    }
    if (item.formatCluster) {
      if (!item.supplierAccountId) return false;
      const context = supplierExtractionContext(
        learning,
        item.supplierAccountId,
        data.rawText ?? ""
      );
      if (context?.clusterId !== item.formatCluster) return false;
    }
    const supplierConfidence = supplierMatchConfidence(item, data);
    const contextualMatch =
      Boolean(item.matchKey && matchKey && item.matchKey === matchKey);
    return (
      item.field === field &&
      item.trustState === "trusted" &&
      item.confidence >= highConfidenceThreshold &&
      supplierConfidence >= highConfidenceThreshold &&
      (field === "supplier" || field === "yourRefPattern" || contextualMatch)
    );
  });
}

export function promoteInvoiceCorrections(
  learning: BookingLearningStore,
  invoiceId: string,
  reason: "learn" | "approval" | "booking",
  trustedAt = new Date().toISOString()
) {
  let promoted = 0;
  for (const correction of corrections(learning)) {
    if (correction.invoiceId !== invoiceId || correction.trustState === "trusted") {
      continue;
    }
    correction.trustState = "trusted";
    correction.trustedAt = trustedAt;
    correction.trustReason = reason;
    promoted += 1;
  }
  return promoted;
}

function referenceFromLearnedLabel(rawText: string, label: string) {
  const normalizedLabel = normalizeText(label);
  const line = rawText
    .split(/\r?\n/)
    .find((item) => normalizeText(item).includes(normalizedLabel));
  return line ? detectInvoiceReference(line)?.value ?? "" : "";
}

function lineFromLearnedLabel(rawText: string, label: string) {
  return rawText
    .split(/\r?\n/)
    .find((line) => containsLearnedLabel(line, label));
}

function validIsoDate(year: number, month: number, day: number) {
  const value = `${String(year).padStart(4, "0")}-${String(month).padStart(
    2,
    "0"
  )}-${String(day).padStart(2, "0")}`;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
    ? value
    : "";
}

function dateFromLearnedLabel(rawText: string, label: string) {
  const line = lineFromLearnedLabel(rawText, label);
  if (!line) {
    return "";
  }

  const yearFirst = line.match(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (yearFirst) {
    return validIsoDate(
      Number(yearFirst[1]),
      Number(yearFirst[2]),
      Number(yearFirst[3])
    );
  }

  const dayFirst = line.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/);
  return dayFirst
    ? validIsoDate(
        Number(dayFirst[3]),
        Number(dayFirst[2]),
        Number(dayFirst[1])
      )
    : "";
}

function amountFromLearnedLabel(rawText: string, label: string) {
  const line = lineFromLearnedLabel(rawText, label);
  if (!line) {
    return null;
  }

  const labelIndex = line.toLowerCase().indexOf(label.toLowerCase());
  const amountText =
    labelIndex >= 0 ? line.slice(labelIndex + label.length) : line;
  const candidates = [
    ...amountText.matchAll(
      /-?(?:\d{1,3}(?:[.\s,']\d{3})+|\d+)(?:[.,]\d{1,2})?/g
    ),
  ].filter(
    (match) =>
      amountText
        .slice((match.index ?? 0) + match[0].length)
        .trimStart()[0] !== "%"
  );

  for (const candidate of candidates) {
    const minorUnits = amountToMinorUnits(candidate[0]);
    if (minorUnits !== null) {
      return minorUnits / 100;
    }
  }
  return null;
}

function learnedOcrCorrection(
  invoice: UploadedInvoice,
  data: ExtractedInvoiceData,
  learning: BookingLearningStore,
  field: "invoiceDate" | "netAmount" | "vatAmount" | "totalAmount"
) {
  const correction = matchingCorrections(invoice, data, learning, field)[0];
  const label = String(correction?.metadata?.sourceLabel ?? "");
  return correction && label && data.rawText
    ? { label, rawText: data.rawText }
    : null;
}

function supplierSpecificCandidates(
  invoice: UploadedInvoice,
  data: ExtractedInvoiceData,
  learning: BookingLearningStore
) {
  const candidates: FieldCandidate[] = [];
  const add = (
    correction: LearnedCorrection | undefined,
    field: string,
    value: string | number,
    label?: string
  ) => {
    if (!correction) return;
    candidates.push({
      id: `learned_${correction.id}_${field}`,
      field,
      value,
      rawValue: String(value),
      normalizedValue: value,
      label,
      polygon: [],
      confidence: correction.confidence,
      source: "supplier_learning",
      rule: correction.id,
      model: "correction-candidate-v1",
      supportingText: label,
      clusterContext:
        correction.supplierAccountId &&
        correction.generation !== undefined &&
        correction.formatCluster
          ? {
              supplierAccountId: correction.supplierAccountId,
              generation: correction.generation,
              clusterId: correction.formatCluster,
            }
          : undefined,
    });
  };

  const supplier = matchingCorrections(invoice, data, learning, "supplier").find(
    (item) => item.metadata?.correctionKind !== "exactAccount"
  );
  if (supplier && typeof supplier.correctedValue === "string") {
    add(supplier, "supplierName", supplier.correctedValue);
  }

  const reference = matchingCorrections(invoice, data, learning, "yourRefPattern")[0];
  const referenceLabel = String(reference?.metadata?.referenceLabel ?? "");
  const referenceValue = reference && referenceLabel && data.rawText
    ? referenceFromLearnedLabel(data.rawText, referenceLabel)
    : "";
  if (referenceValue) add(reference, "referenceCode", referenceValue, referenceLabel);

  const description = matchingCorrections(
    invoice,
    data,
    learning,
    "expenseDescription"
  ).find((item) => item.metadata?.lineIndex === undefined);
  if (description && typeof description.correctedValue === "string") {
    add(description, "expenseDescription", description.correctedValue);
  }
  const payment = matchingCorrections(invoice, data, learning, "paymentCondition")[0];
  if (payment && typeof payment.correctedValue === "string") {
    add(payment, "paymentTerms", payment.correctedValue);
  }

  const learnedDate = learnedOcrCorrection(invoice, data, learning, "invoiceDate");
  const date = learnedDate
    ? dateFromLearnedLabel(learnedDate.rawText, learnedDate.label)
    : "";
  if (date) {
    add(
      matchingCorrections(invoice, data, learning, "invoiceDate")[0],
      "invoiceDate",
      date,
      learnedDate?.label
    );
  }
  for (const [correctionField, candidateField] of [
    ["netAmount", "netAmount"],
    ["vatAmount", "vatAmount"],
    ["totalAmount", "grossAmount"],
  ] as const) {
    const learnedAmount = learnedOcrCorrection(invoice, data, learning, correctionField);
    const amount = learnedAmount
      ? amountFromLearnedLabel(learnedAmount.rawText, learnedAmount.label)
      : null;
    if (amount !== null) {
      add(
        matchingCorrections(invoice, data, learning, correctionField)[0],
        candidateField,
        amount,
        learnedAmount?.label
      );
    }
  }
  return candidates;
}

export function applyLearnedExtractedData(
  invoice: UploadedInvoice,
  extractedData: ExtractedInvoiceData,
  learning: BookingLearningStore
) {
  const data = { ...extractedData };
  const appliedFields: LearnableCorrectionField[] = [];
  const mode = supplierLearningMode();
  const candidates = mode === "off"
    ? []
    : supplierSpecificCandidates(invoice, extractedData, learning);
  if (mode !== "apply") {
    const evidence = applySupplierCandidateEvidence(data, candidates, "observe");
    return {
      data: evidence.data,
      appliedFields,
      candidates,
    };
  }
  const evidence = applySupplierCandidateEvidence(data, candidates, "apply");
  const correctionField = {
    supplierName: "supplier",
    referenceCode: "yourRefPattern",
    expenseDescription: "expenseDescription",
    paymentTerms: "paymentCondition",
    invoiceDate: "invoiceDate",
    netAmount: "netAmount",
    vatAmount: "vatAmount",
    grossAmount: "totalAmount",
  } as const;
  for (const field of evidence.appliedFields) {
    const learnedField = correctionField[field as keyof typeof correctionField];
    if (learnedField && !appliedFields.includes(learnedField)) {
      appliedFields.push(learnedField);
    }
  }
  return {
    data: evidence.data,
    appliedFields,
    candidates,
  };
}

function allocateAmount(total: number, weights: number[]) {
  const target = amountToMinorUnits(total) ?? 0;
  const signedWeights = weights.map(
    (weight) => amountToMinorUnits(weight) ?? 0
  );
  const totalWeight = signedWeights.reduce((sum, weight) => sum + weight, 0);
  if (!totalWeight) {
    return target === 0
      ? signedWeights.map((weight) => weight / 100)
      : null;
  }

  const raw = signedWeights.map((weight) => (target * weight) / totalWeight);
  const allocated = raw.map(Math.trunc);
  let remainder = target - allocated.reduce((sum, value) => sum + value, 0);
  const byFraction = raw
    .map((value, index) => ({ index, fraction: value - allocated[index] }))
    .sort((left, right) =>
      remainder > 0
        ? right.fraction - left.fraction
        : left.fraction - right.fraction
    );

  for (let index = 0; remainder !== 0; index += 1) {
    const adjustment = remainder > 0 ? 1 : -1;
    allocated[byFraction[index % byFraction.length].index] += adjustment;
    remainder -= adjustment;
  }
  return allocated.map((value) => value / 100);
}

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function shiftDateByInvoiceMonth(
  value: string,
  sourceInvoiceDate: string,
  targetInvoiceDate: string
) {
  const valueMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const sourceMatch = sourceInvoiceDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const targetMatch = targetInvoiceDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!valueMatch || !sourceMatch || !targetMatch) {
    return value;
  }

  const monthDelta =
    (Number(targetMatch[1]) - Number(sourceMatch[1])) * 12 +
    Number(targetMatch[2]) -
    Number(sourceMatch[2]);
  const sourceYear = Number(valueMatch[1]);
  const sourceMonth = Number(valueMatch[2]);
  const sourceDay = Number(valueMatch[3]);
  const shiftedMonthIndex = sourceYear * 12 + sourceMonth - 1 + monthDelta;
  const shiftedYear = Math.floor(shiftedMonthIndex / 12);
  const shiftedMonth = (shiftedMonthIndex % 12) + 1;
  const sourceWasMonthEnd =
    sourceDay === daysInMonth(sourceYear, sourceMonth);
  const shiftedDay = sourceWasMonthEnd
    ? daysInMonth(shiftedYear, shiftedMonth)
    : Math.min(sourceDay, daysInMonth(shiftedYear, shiftedMonth));
  return validIsoDate(shiftedYear, shiftedMonth, shiftedDay) || value;
}

export function learnedBookingLinesForInvoice(
  invoice: UploadedInvoice,
  supplierAccountId: string | undefined,
  learning: BookingLearningStore
) {
  if (supplierLearningMode() !== "apply") {
    return null;
  }
  const match = matchingCorrections(
    invoice,
    invoice.extractedData,
    learning,
    "bookingLineSplit"
  ).find(
    (item) =>
      !item.supplierAccountId ||
      !supplierAccountId ||
      item.supplierAccountId === supplierAccountId
  );

  if (!match || !Array.isArray(match.correctedValue)) {
    return null;
  }

  const lines = (match.correctedValue as PurchaseJournalLine[]).map((line) => ({
    ...line,
    reasoning: [...(line.reasoning ?? [])],
    vatReasoning: [...(line.vatReasoning ?? [])],
  }));
  const sourceInvoiceDate = String(match.metadata?.invoiceDate ?? "");
  const targetInvoiceDate = invoice.extractedData.invoiceDate;
  for (const line of lines) {
    line.from = line.from
      ? shiftDateByInvoiceMonth(line.from, sourceInvoiceDate, targetInvoiceDate)
      : "";
    line.to = line.to
      ? shiftDateByInvoiceMonth(line.to, sourceInvoiceDate, targetInvoiceDate)
      : "";
  }

  const targetNetAmount = invoice.extractedData.netAmount;
  const targetVatAmount = invoice.extractedData.vatAmount;
  if (targetNetAmount !== null && targetVatAmount !== null && lines.length) {
    const amountWeights = lines.map((line) => line.amount);
    const vatWeights = lines.some((line) => line.vatAmount)
      ? lines.map((line) => line.vatAmount)
      : amountWeights;
    const amounts = allocateAmount(targetNetAmount, amountWeights);
    const vatAmounts = allocateAmount(targetVatAmount, vatWeights);
    if (!amounts || !vatAmounts) {
      return null;
    }
    lines.forEach((line, index) => {
      line.amount = amounts[index];
      line.vatAmount = vatAmounts[index];
    });
  }

  const learnedTotal = lines.reduce(
    (sum, line) => sum + line.amount + line.vatAmount,
    0
  );
  const targetTotal = invoice.extractedData.grossAmount ?? learnedTotal;

  if (
    (targetNetAmount === null || targetVatAmount === null) &&
    learnedTotal &&
    Math.abs(targetTotal - learnedTotal) > 0.005
  ) {
    const ratio = targetTotal / learnedTotal;
    for (const line of lines) {
      line.amount = Math.round(line.amount * ratio * 100) / 100;
      line.vatAmount = Math.round(line.vatAmount * ratio * 100) / 100;
    }
    const scaledTotal = lines.reduce(
      (sum, line) => sum + line.amount + line.vatAmount,
      0
    );
    const difference = Math.round((targetTotal - scaledTotal) * 100) / 100;
    if (lines.length && difference) {
      lines[lines.length - 1].amount =
        Math.round((lines[lines.length - 1].amount + difference) * 100) / 100;
    }
  }

  return {
    lines,
    confidence: Math.min(match.confidence, 0.99),
  };
}
