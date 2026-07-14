import type {
  BookingLearningStore,
  ExtractedInvoiceData,
  IntoUser,
  LearnableCorrectionField,
  LearnedCorrection,
  PurchaseJournalLine,
  UploadedInvoice,
} from "../domain/invoice";
import { createId } from "../utils/id";
import { detectInvoiceReference } from "./invoice-extraction-service";
import { normalizeText } from "./invoice-validation";

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

function normalizedVat(value: string) {
  return value.replace(/[^a-z0-9]/gi, "").toUpperCase();
}

function supplierIdentities(data: ExtractedInvoiceData) {
  return [
    data.supplierVatNumber ? `vat:${normalizedVat(data.supplierVatNumber)}` : "",
    data.iban ? `iban:${normalizedValue(data.iban)}` : "",
    data.supplierChamberOfCommerceNumber
      ? `coc:${normalizedValue(data.supplierChamberOfCommerceNumber)}`
      : "",
    data.supplierName ? `name:${normalizedValue(data.supplierName)}` : "",
  ].filter(Boolean);
}

function primarySupplierIdentity(data: ExtractedInvoiceData) {
  return supplierIdentities(data)[0] ?? `name:${normalizedValue(data.supplierName)}`;
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
  return baseName
    .toLowerCase()
    .replace(/\d+/g, "#")
    .replace(/[^a-z0-9#._-]+/g, "-");
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
  const text = data.rawText ?? "";
  const value = correctedValue.toLowerCase();
  const relevantLine = text
    .split(/\r?\n/)
    .find((line) => line.toLowerCase().includes(value));
  const normalizedLine = normalizeText(relevantLine ?? text);
  return referenceLabels.find((label) => normalizedLine.includes(label));
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

function lineValuesEqual(left: PurchaseJournalLine[], right: PurchaseJournalLine[]) {
  return JSON.stringify(left.map(lineComparable)) === JSON.stringify(right.map(lineComparable));
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

  return upsertCorrection(input.learning, {
    field,
    supplierIdentity: primarySupplierIdentity(originalData),
    supplierName: input.nextExtractedData.supplierName || originalData.supplierName,
    supplierAccountId,
    matchKey: invoiceMatchKey(originalData),
    originalValue,
    correctedValue,
    invoiceTextContext: contextAround(originalData, [correctedValue, originalValue]),
    filenamePattern: learnedFilenamePattern(input.invoice.fileName),
    confidence: supplierAccountId ? 0.99 : 0.95,
    correctedAt: decidedAt,
    correctedByUserId: input.user.id,
    correctedByUserName: input.user.name,
    metadata,
  });
}

function upsertDecision<T>(items: T[], predicate: (item: T) => boolean, value: T) {
  const index = items.findIndex(predicate);
  if (index >= 0) {
    items.splice(index, 1);
  }
  items.unshift(value);
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

  const previousLines =
    input.invoice.bookingLineOverrides ?? input.invoice.purchaseJournal?.lines ?? [];
  const supplierAccountId =
    input.invoice.purchaseJournal?.supplierResolution.selectedAccountId;
  const decidedAt = input.correctedAt ?? new Date().toISOString();

  input.nextBookingLines.forEach((nextLine, index) => {
    const previousLine = previousLines[index];
    if (!previousLine) {
      return;
    }

    const metadata = {
      lineIndex: index,
      sourceLineItemId: nextLine.sourceLineItemId,
    };
    const descriptionKey = learningDescriptionKey(
      previousLine.description || nextLine.description
    );
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
    add(
      record(
        input,
        "accrualPeriod",
        { from: previousLine.from, to: previousLine.to },
        { from: nextLine.from, to: nextLine.to },
        metadata
      )
    );

    if (supplierAccountId && previousGl !== nextGl) {
      upsertDecision(
        input.learning.glAccountSelections,
        (item) =>
          item.supplierAccountId === supplierAccountId &&
          item.descriptionKey === descriptionKey,
        {
          supplierAccountId,
          descriptionKey,
          glAccount: nextGl,
          decidedAt,
        }
      );
    }
    if (supplierAccountId && previousLine.vatCode !== nextLine.vatCode) {
      upsertDecision(
        input.learning.vatCodeSelections,
        (item) =>
          item.supplierAccountId === supplierAccountId &&
          item.descriptionKey === descriptionKey,
        {
          supplierAccountId,
          descriptionKey,
          vatCode: nextLine.vatCode,
          decidedAt,
        }
      );
    }
    if (supplierAccountId && previousLine.costCentre !== nextLine.costCentre) {
      const items = input.learning.costCentreSelections;
      const index = items.findIndex(
        (item) =>
          item.supplierAccountId === supplierAccountId && item.glAccount === nextGl
      );
      if (index >= 0) {
        items.splice(index, 1);
      }
      if (nextLine.costCentre) {
        items.unshift({
          supplierAccountId,
          glAccount: nextGl,
          costCentre: nextLine.costCentre,
          decidedAt,
        });
      }
    }
    if (supplierAccountId && previousLine.costUnit !== nextLine.costUnit) {
      const items = input.learning.costUnitSelections;
      const index = items.findIndex(
        (item) =>
          item.supplierAccountId === supplierAccountId && item.glAccount === nextGl
      );
      if (index >= 0) {
        items.splice(index, 1);
      }
      if (nextLine.costUnit) {
        items.unshift({
          supplierAccountId,
          glAccount: nextGl,
          costUnit: nextLine.costUnit,
          decidedAt,
        });
      }
    }
  });

  if (!lineValuesEqual(previousLines, input.nextBookingLines)) {
    add(
      record(
        input,
        "bookingLineSplit",
        previousLines.map(lineComparable),
        input.nextBookingLines.map((line) => ({ ...line })),
        { lineCount: input.nextBookingLines.length }
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
    correctedAt: input.correctedAt ?? new Date().toISOString(),
    correctedByUserId: input.user.id,
    correctedByUserName: input.user.name,
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
  if (supplierIdentities(data).includes(correction.supplierIdentity)) {
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
  const filePattern = learnedFilenamePattern(invoice.fileName);
  return corrections(learning).filter((item) => {
    const supplierConfidence = supplierMatchConfidence(item, data);
    const contextualMatch =
      item.matchKey === matchKey || item.filenamePattern === filePattern;
    return (
      item.field === field &&
      item.confidence >= highConfidenceThreshold &&
      supplierConfidence >= highConfidenceThreshold &&
      (field === "supplier" || field === "yourRefPattern" || contextualMatch)
    );
  });
}

function referenceFromLearnedLabel(rawText: string, label: string) {
  const line = rawText
    .split(/\r?\n/)
    .find((item) => normalizeText(item).includes(label));
  return line ? detectInvoiceReference(line)?.value ?? "" : "";
}

export function applyLearnedExtractedData(
  invoice: UploadedInvoice,
  extractedData: ExtractedInvoiceData,
  learning: BookingLearningStore
) {
  const data = { ...extractedData };
  const appliedFields: LearnableCorrectionField[] = [];
  const apply = (field: LearnableCorrectionField) => {
    if (!appliedFields.includes(field)) {
      appliedFields.push(field);
    }
  };

  const supplier = matchingCorrections(invoice, data, learning, "supplier").find(
    (item) => item.metadata?.correctionKind !== "exactAccount"
  );
  if (supplier && typeof supplier.correctedValue === "string") {
    data.supplierName = supplier.correctedValue;
    apply("supplier");
  }

  const reference = matchingCorrections(
    invoice,
    extractedData,
    learning,
    "yourRefPattern"
  )[0];
  const learnedLabel = String(reference?.metadata?.referenceLabel ?? "");
  const learnedReference =
    reference && learnedLabel && extractedData.rawText
      ? referenceFromLearnedLabel(extractedData.rawText, learnedLabel)
      : "";
  if (learnedReference) {
    data.referenceCode = learnedReference;
    data.invoiceNumber = learnedReference;
    data.referenceCodeConfidence = Math.max(data.referenceCodeConfidence ?? 0, 0.97);
    apply("yourRefPattern");
  }

  const description = matchingCorrections(
    invoice,
    extractedData,
    learning,
    "expenseDescription"
  ).find((item) => item.metadata?.lineIndex === undefined);
  if (description && typeof description.correctedValue === "string") {
    data.expenseDescription = description.correctedValue;
    apply("expenseDescription");
  }

  const payment = matchingCorrections(
    invoice,
    extractedData,
    learning,
    "paymentCondition"
  )[0];
  if (payment && typeof payment.correctedValue === "string") {
    data.paymentTerms = payment.correctedValue;
    apply("paymentCondition");
  }

  return { data, appliedFields };
}

export function learnedBookingLinesForInvoice(
  invoice: UploadedInvoice,
  supplierAccountId: string | undefined,
  learning: BookingLearningStore
) {
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
  const learnedTotal = lines.reduce(
    (sum, line) => sum + line.amount + line.vatAmount,
    0
  );
  const targetTotal = invoice.extractedData.grossAmount ?? learnedTotal;

  if (learnedTotal && Math.abs(targetTotal - learnedTotal) > 0.005) {
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
