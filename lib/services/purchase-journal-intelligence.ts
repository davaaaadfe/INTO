import type {
  BookingLearningStore,
  ExactHistoricalPurchaseBooking,
  ExactMasterDataCache,
  ExactSupplierAccount,
  ExtractedInvoiceData,
  InvoiceStatus,
  PurchaseJournalBooking,
  PurchaseJournalLine,
  SupplierMatchCandidate,
  UploadedInvoice,
  ValidationError,
} from "../domain/invoice";
import {
  INTO_PURCHASE_VAT_CODES,
  UNSUPPORTED_VAT_CODE_WARNING,
  intoPurchaseVatCodeOrFallback,
  isIntoPurchaseVatCode,
} from "../domain/invoice";
import { createId } from "../utils/id";
import {
  BOOKING_TOTAL_MISMATCH_MESSAGE,
  DUPLICATE_INVOICE_REFERENCE_MESSAGE,
  calculateBookingTotals,
  isValidIsoDate,
  normalizeText,
} from "./invoice-validation";
import {
  getBookingLineDataIssues,
  requiredBookingDataValidationErrors,
} from "./required-booking-data";
import {
  LEARNED_CORRECTION_NOTE,
  learnedBookingLinesForInvoice,
  learningDescriptionKey,
} from "./correction-learning";

type VatCode = PurchaseJournalLine["vatCode"];

type GlSuggestion = {
  account: string;
  name: string;
  confidence: number;
  reason: string;
};

type VatSuggestion = {
  code: VatCode;
  name: string;
  confidence: number;
  percentage: number;
  amountMode: "vat_excluded" | "vat_inclusive";
  reasoning: string[];
};

type ExactHistorySuggestion = {
  entryId: string;
  lines: ExactHistoricalPurchaseBooking[];
  confidence: number;
  score: number;
  reasoning: string[];
  suggestedDescription?: string;
};

const companyConfig = {
  confidenceThreshold: 0.86,
  companyVatNumber: "NL857017263B01",
  defaultJournal: "60" as const,
  intercompanyJournal: "61" as const,
  defaultDescriptionTemplate: "yyyy.mm.[expense description]",
  lineDescriptionTemplate: "yyyy.mm [expense description]_[beneficiary]",
  currentMockOpenYear: 2026,
  firstMockOpenPeriod: 6,
};

export const SUPPLIER_NOT_MATCHED_MESSAGE =
  "Supplier could not be matched to Exact Online master data. Please select the supplier manually.";
export const MULTIPLE_EXACT_SUPPLIERS_MESSAGE =
  "Multiple Exact suppliers match this invoice. Please choose the correct supplier.";
export const EXACT_HISTORY_SUGGESTION_NOTE =
  "Suggested from previous Exact bookings.";

const glRuleCodes = {
  office: "4400",
  software: "4420",
  hotel: "4510",
  airTravel: "4520",
  insurance: "4610",
  bank: "4690",
  services: "4800",
};

const euVatCountries = new Set([
  "AT",
  "BE",
  "BG",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "ES",
  "FI",
  "FR",
  "GR",
  "HR",
  "HU",
  "IE",
  "IT",
  "LT",
  "LU",
  "LV",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SE",
  "SI",
  "SK",
]);
const supportedHistoricalVatCodes = new Set<VatCode>(INTO_PURCHASE_VAT_CODES);

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function normalizedVat(value: string | null | undefined) {
  return (value ?? "").replace(/[^a-z0-9]/gi, "").toUpperCase();
}

function normalizedIban(value: string | null | undefined) {
  return (value ?? "").replace(/[^a-z0-9]/gi, "").toUpperCase();
}

function supplierIdentityKeys(data: ExtractedInvoiceData) {
  return [
    data.supplierVatNumber ? `vat:${normalizedVat(data.supplierVatNumber)}` : "",
    data.iban ? `iban:${normalizedIban(data.iban).toLowerCase()}` : "",
    data.supplierChamberOfCommerceNumber
      ? `coc:${normalizeText(data.supplierChamberOfCommerceNumber)}`
      : "",
    data.supplierAddress ? `address:${normalizeText(data.supplierAddress)}` : "",
    data.supplierName ? `name:${normalizeText(data.supplierName)}` : "",
  ].filter(Boolean);
}

function primarySupplierIdentity(data: ExtractedInvoiceData) {
  return supplierIdentityKeys(data)[0] ?? `name:${normalizeText(data.supplierName)}`;
}

function descriptionKey(value: string) {
  return learningDescriptionKey(value);
}

function mergeCandidate(
  candidates: Map<string, SupplierMatchCandidate>,
  account: ExactSupplierAccount,
  confidence: number,
  method: SupplierMatchCandidate["method"],
  reasoning: string
) {
  const current = candidates.get(account.id);
  if (!current || confidence > current.confidence) {
    candidates.set(account.id, {
      account,
      confidence,
      method,
      reasoning: [reasoning],
    });
    return;
  }

  current.reasoning.push(reasoning);
}

function nameSimilarity(left: string, right: string) {
  const legalSuffixes = new Set([
    "ag",
    "bv",
    "b",
    "v",
    "co",
    "corp",
    "corporation",
    "gmbh",
    "inc",
    "incorporated",
    "limited",
    "llc",
    "ltd",
    "nv",
    "plc",
    "sa",
    "sas",
    "spa",
    "srl",
  ]);
  const words = (value: string) =>
    normalizeText(value)
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter((word) => word && !legalSuffixes.has(word));
  const leftList = words(left);
  const rightList = words(right);
  const leftWords = new Set(leftList);
  const rightWords = new Set(rightList);

  if (!leftWords.size || !rightWords.size) {
    return 0;
  }

  if (leftList.join(" ") === rightList.join(" ")) {
    return 1;
  }

  const overlap = [...leftWords].filter((word) => rightWords.has(word)).length;
  return overlap / Math.max(leftWords.size, rightWords.size);
}

function exactSuppliers(exactMasterData: ExactMasterDataCache | null) {
  return exactMasterData?.suppliers.filter((supplier) => supplier.name) ?? [];
}

function exactGlAccount(
  exactMasterData: ExactMasterDataCache | null,
  code: string | undefined
) {
  return exactMasterData?.glAccounts.find(
    (account) => account.code === code && account.isActive
  );
}

function exactVatCode(
  exactMasterData: ExactMasterDataCache | null,
  code: VatCode
) {
  return exactMasterData?.vatCodes.find(
    (vatCode) => vatCode.code === code && vatCode.type === "purchase" && vatCode.isActive
  );
}

function exactCostCenter(
  exactMasterData: ExactMasterDataCache | null,
  code: string | undefined
) {
  if (!code) {
    return undefined;
  }

  return exactMasterData?.costCenters.find(
    (costCenter) => costCenter.code === code && costCenter.isActive
  );
}

function exactCostUnit(
  exactMasterData: ExactMasterDataCache | null,
  code: string | undefined
) {
  if (!code) {
    return undefined;
  }

  return exactMasterData?.costUnits.find(
    (costUnit) => costUnit.code === code && costUnit.isActive
  );
}

function similarityTokens(value: string) {
  const ignored = new Set([
    "and",
    "charge",
    "expenses",
    "invoice",
    "monthly",
    "the",
  ]);
  return new Set(
    descriptionKey(value)
      .split("-")
      .filter((token) => token.length > 1 && !ignored.has(token))
  );
}

function textSimilarity(left: string, right: string) {
  const leftKey = descriptionKey(left);
  const rightKey = descriptionKey(right);
  if (!leftKey || !rightKey) {
    return 0;
  }
  if (leftKey === rightKey) {
    return 1;
  }
  if (leftKey.includes(rightKey) || rightKey.includes(leftKey)) {
    return 0.94;
  }

  const leftTokens = similarityTokens(left);
  const rightTokens = similarityTokens(right);
  if (!leftTokens.size || !rightTokens.size) {
    return 0;
  }

  const overlap = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  if (!overlap) {
    return 0;
  }

  const jaccard = overlap / (leftTokens.size + rightTokens.size - overlap);
  const smallerCoverage = overlap / Math.min(leftTokens.size, rightTokens.size);
  return Math.max(jaccard, smallerCoverage * 0.88);
}

function amountSimilarity(current: number | null, historical: number | undefined) {
  if (!current || !historical) {
    return 0.5;
  }

  return Math.min(Math.abs(current), Math.abs(historical)) /
    Math.max(Math.abs(current), Math.abs(historical));
}

function historicalGroupTotal(lines: ExactHistoricalPurchaseBooking[]) {
  const explicit = lines.find((line) => typeof line.totalAmount === "number")
    ?.totalAmount;
  if (typeof explicit === "number") {
    return explicit;
  }

  const total = lines.reduce(
    (sum, line) => sum + (line.lineAmount ?? 0) + (line.vatAmount ?? 0),
    0
  );
  return total || undefined;
}

function currentVatRate(data: ExtractedInvoiceData) {
  if (!data.netAmount || data.vatAmount === null) {
    return undefined;
  }
  return roundMoney((data.vatAmount / data.netAmount) * 100);
}

function historicalVatSimilarity(
  lines: ExactHistoricalPurchaseBooking[],
  data: ExtractedInvoiceData
) {
  const currentRate = currentVatRate(data);
  const historicalRates = lines
    .map((line) => line.vatPercentage)
    .filter((rate): rate is number => typeof rate === "number");
  if (typeof currentRate === "number" && historicalRates.length) {
    const closest = Math.min(
      ...historicalRates.map((rate) => Math.abs(rate - currentRate))
    );
    return closest < 0.01 ? 1 : closest <= 1 ? 0.8 : 0;
  }

  const currentHasVat = Math.abs(data.vatAmount ?? 0) >= 0.005;
  const historyHasVat = lines.some((line) => Math.abs(line.vatAmount ?? 0) >= 0.005);
  return currentHasVat === historyHasVat ? 0.8 : 0;
}

function cleanHistoricalDescription(line: ExactHistoricalPurchaseBooking) {
  const source = line.description || line.descriptionKey.replace(/-/g, " ");
  return source
    .replace(/^\d{4}[.-]\d{2}[ ._-]*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function exactHistoricalSuggestion(
  invoice: UploadedInvoice,
  exactMasterData: ExactMasterDataCache | null,
  supplier: ExactSupplierAccount | undefined,
  data: ExtractedInvoiceData
): ExactHistorySuggestion | undefined {
  if (!supplier || !exactMasterData) {
    return undefined;
  }

  const supplierHistory = exactMasterData.historicalPurchaseBookings.filter(
    (booking) => booking.supplierAccountId === supplier.id
  );
  const groups = new Map<string, ExactHistoricalPurchaseBooking[]>();
  for (const booking of supplierHistory) {
    const entryId = booking.entryId || booking.id;
    const group = groups.get(entryId) ?? [];
    group.push(booking);
    groups.set(entryId, group);
  }

  const primaryText = [
    humanDescription(data),
    ...data.lineItems.map((line) => line.description),
  ]
    .filter(Boolean)
    .join(" ");
  const contextText = [invoice.fileName, data.rawText ?? ""].join(" ");
  const scored = [...groups.entries()].map(([entryId, lines]) => {
    const historicalText = lines
      .flatMap((line) => [line.description ?? "", line.descriptionKey])
      .filter(Boolean)
      .join(" ");
    const descriptionScore = textSimilarity(primaryText, historicalText);
    const contextScore = textSimilarity(contextText, historicalText);
    const textScore = Math.max(descriptionScore, contextScore * 0.9);
    const amountScore = amountSimilarity(
      data.grossAmount,
      historicalGroupTotal(lines)
    );
    const vatScore = historicalVatSimilarity(lines, data);
    const recurringCount = [...groups.values()].filter((candidateLines) => {
      const candidateText = candidateLines
        .flatMap((line) => [line.description ?? "", line.descriptionKey])
        .filter(Boolean)
        .join(" ");
      return textSimilarity(historicalText, candidateText) >= 0.8;
    }).length;
    const recurringScore = recurringCount >= 2 ? 1 : 0;
    const score =
      descriptionScore * 0.5 +
      contextScore * 0.2 +
      amountScore * 0.15 +
      vatScore * 0.1 +
      recurringScore * 0.05;
    const confidence = Math.min(0.98, 0.78 + score * 0.22);
    const reasoning = [
      "Same supplier in Exact Online history.",
      descriptionScore >= 0.5 || contextScore >= 0.5
        ? "Similar invoice description, line text, filename, or OCR text."
        : "",
      amountScore >= 0.75 ? "Similar invoice amount range." : "",
      vatScore >= 0.8 ? "Similar VAT treatment." : "",
      recurringScore ? "Recurring expense pattern found in Exact history." : "",
    ].filter(Boolean);

    return {
      entryId,
      lines,
      confidence,
      score,
      textScore,
      reasoning,
      suggestedDescription: cleanHistoricalDescription(lines[0]),
    };
  });

  const best = scored
    .filter(
      (candidate) =>
        candidate.textScore >= 0.4 &&
        candidate.confidence >= companyConfig.confidenceThreshold
    )
    .sort((left, right) => right.score - left.score)[0];

  if (!best) {
    return undefined;
  }

  return {
    entryId: best.entryId,
    lines: best.lines,
    confidence: roundMoney(best.confidence),
    score: roundMoney(best.score),
    reasoning: best.reasoning,
    suggestedDescription: best.suggestedDescription,
  };
}

function historicalLineFor(
  suggestion: ExactHistorySuggestion | undefined,
  lineDescriptionText: string,
  fallbackIndex = 0
) {
  if (!suggestion?.lines.length) {
    return undefined;
  }

  return [...suggestion.lines]
    .map((line, index) => ({
      line,
      index,
      score: textSimilarity(
        lineDescriptionText,
        line.description || line.descriptionKey
      ),
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        Math.abs(left.index - fallbackIndex) - Math.abs(right.index - fallbackIndex)
    )[0]?.line;
}

function selectedSupplierFromBooking(
  invoice: UploadedInvoice,
  exactMasterData: ExactMasterDataCache | null
) {
  const selectedId = invoice.purchaseJournal?.supplierResolution.selectedAccountId;
  return exactSuppliers(exactMasterData).find((account) => account.id === selectedId);
}

function resolveSupplier(
  invoice: UploadedInvoice,
  allInvoices: UploadedInvoice[],
  learning: BookingLearningStore,
  exactMasterData: ExactMasterDataCache | null
) {
  const data = invoice.extractedData;
  const candidates = new Map<string, SupplierMatchCandidate>();
  const identities = supplierIdentityKeys(data);
  const suppliers = exactSuppliers(exactMasterData);

  if (!exactMasterData) {
    return {
      selectedAccountId: undefined,
      selectedAccountCode: undefined,
      selectedAccountName: undefined,
      matchConfidence: 0,
      threshold: companyConfig.confidenceThreshold,
      method: "Exact master data missing",
      reviewRequired: true,
      candidates: [],
      reasoning: ["Sync Exact Online master data before supplier matching."],
    };
  }

  const uniqueAccounts = (accounts: ExactSupplierAccount[]) => [
    ...new Map(accounts.map((account) => [account.id, account])).values(),
  ];
  const sortedCandidates = (accountScope?: ExactSupplierAccount[]) => {
    const allowedIds = accountScope
      ? new Set(accountScope.map((account) => account.id))
      : null;
    return [...candidates.values()]
      .filter((candidate) => !allowedIds || allowedIds.has(candidate.account.id))
      .sort((left, right) => right.confidence - left.confidence);
  };
  const resolved = (
    account: ExactSupplierAccount,
    confidence: number,
    method: SupplierMatchCandidate["method"],
    reasoning: string
  ) => {
    mergeCandidate(candidates, account, confidence, method, reasoning);
    return {
      selectedAccountId: account.id,
      selectedAccountCode: account.code,
      selectedAccountName: account.name,
      matchConfidence: confidence,
      threshold: companyConfig.confidenceThreshold,
      method,
      reviewRequired: false,
      candidates: sortedCandidates(),
      reasoning: [...new Set(candidates.get(account.id)?.reasoning ?? [reasoning])],
    };
  };
  const matchState: { unresolvedPool: ExactSupplierAccount[] | null } = {
    unresolvedPool: null,
  };
  const considerTier = (
    matches: ExactSupplierAccount[],
    confidence: number | ((account: ExactSupplierAccount) => number),
    method: SupplierMatchCandidate["method"],
    reasoning: string
  ) => {
    const allowedIds = matchState.unresolvedPool
      ? new Set(matchState.unresolvedPool.map((account) => account.id))
      : null;
    const scoped = uniqueAccounts(
      matches.filter((account) => !allowedIds || allowedIds.has(account.id))
    );
    if (!scoped.length) {
      return null;
    }

    for (const account of scoped) {
      mergeCandidate(
        candidates,
        account,
        typeof confidence === "function" ? confidence(account) : confidence,
        method,
        reasoning
      );
    }
    matchState.unresolvedPool = scoped;

    if (scoped.length !== 1) {
      return null;
    }

    const account = scoped[0];
    return resolved(
      account,
      typeof confidence === "function" ? confidence(account) : confidence,
      method,
      reasoning
    );
  };

  const dataVat = normalizedVat(data.supplierVatNumber);
  if (dataVat) {
    const vatResolution = considerTier(
      suppliers.filter((account) => normalizedVat(account.vatNumber) === dataVat),
      0.99,
      "VAT number",
      "VAT number matched Exact supplier master data."
    );
    if (vatResolution) {
      return vatResolution;
    }
  }

  const dataIban = normalizedIban(data.iban);
  if (dataIban) {
    const ibanResolution = considerTier(
      suppliers.filter((account) => normalizedIban(account.iban) === dataIban),
      0.98,
      "IBAN",
      "IBAN matched Exact supplier master data."
    );
    if (ibanResolution) {
      return ibanResolution;
    }
  }

  const learnedAccounts = learning.supplierSelections
    .filter((decision) => identities.includes(decision.supplierIdentity))
    .map((decision) => suppliers.find((supplier) => supplier.id === decision.accountId))
    .filter((account): account is ExactSupplierAccount => Boolean(account));
  const learnedResolution = considerTier(
    learnedAccounts,
    0.97,
    "Learned decision",
    "Matched a previously approved supplier resolution."
  );
  if (learnedResolution) {
    return learnedResolution;
  }

  const historicalAccounts: ExactSupplierAccount[] = [];
  for (const previous of allInvoices) {
    if (previous.id === invoice.id || !previous.purchaseJournal) {
      continue;
    }

    const previousSupplier = selectedSupplierFromBooking(previous, exactMasterData);
    if (
      previousSupplier &&
      nameSimilarity(previous.extractedData.supplierName, data.supplierName) >=
        companyConfig.confidenceThreshold
    ) {
      historicalAccounts.push(previousSupplier);
    }
  }

  const invoiceDescriptionKey = descriptionKey(humanDescription(data));
  for (const historical of exactMasterData.historicalPurchaseBookings) {
    if (
      historical.descriptionKey &&
      invoiceDescriptionKey &&
      (invoiceDescriptionKey === historical.descriptionKey ||
        invoiceDescriptionKey.includes(historical.descriptionKey))
    ) {
      const account = suppliers.find(
        (supplier) => supplier.id === historical.supplierAccountId
      );
      if (account) {
        historicalAccounts.push(account);
      }
    }
  }
  const historyResolution = considerTier(
    historicalAccounts,
    0.93,
    "Exact history",
    "Matched historical Exact purchase bookings for this supplier."
  );
  if (historyResolution) {
    return historyResolution;
  }

  const nameScores = new Map(
    suppliers.map((account) => [account.id, nameSimilarity(data.supplierName, account.name)])
  );
  const nameResolution = considerTier(
    suppliers.filter(
      (account) =>
        (nameScores.get(account.id) ?? 0) >= companyConfig.confidenceThreshold
    ),
    (account) => roundMoney(nameScores.get(account.id) ?? 0),
    "Name similarity",
    "Supplier name is similar to the Exact account name."
  );
  if (nameResolution) {
    return nameResolution;
  }

  if (matchState.unresolvedPool && matchState.unresolvedPool.length > 1) {
    const sorted = sortedCandidates(matchState.unresolvedPool);
    return {
      selectedAccountId: undefined,
      selectedAccountCode: undefined,
      selectedAccountName: undefined,
      matchConfidence: sorted[0]?.confidence ?? 0,
      threshold: companyConfig.confidenceThreshold,
      method: "Multiple matches",
      reviewRequired: true,
      candidates: sorted,
      reasoning: [
        MULTIPLE_EXACT_SUPPLIERS_MESSAGE,
        ...sorted.flatMap((candidate) => candidate.reasoning),
      ],
    };
  }

  for (const account of suppliers) {
    const score = nameScores.get(account.id) ?? 0;
    if (score >= 0.55) {
      mergeCandidate(
        candidates,
        account,
        roundMoney(score),
        "Name similarity",
        "Supplier name is similar to the Exact account name."
      );
    }
  }
  const sorted = sortedCandidates();
  return {
    selectedAccountId: undefined,
    selectedAccountCode: undefined,
    selectedAccountName: undefined,
    matchConfidence: sorted[0]?.confidence ?? 0,
    threshold: companyConfig.confidenceThreshold,
    method: "No match",
    reviewRequired: true,
    candidates: sorted,
    reasoning: [SUPPLIER_NOT_MATCHED_MESSAGE],
  };
}

function yearMonth(dateValue: string) {
  if (!isValidIsoDate(dateValue)) {
    return { year: companyConfig.currentMockOpenYear, month: companyConfig.firstMockOpenPeriod };
  }

  const date = new Date(`${dateValue}T00:00:00.000Z`);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
}

function monthLabel(dateValue: string) {
  const { year, month } = yearMonth(dateValue);
  return `${year}.${String(month).padStart(2, "0")}`;
}

function humanDescription(data: ExtractedInvoiceData) {
  const source =
    data.expenseDescription ||
    data.lineItems[0]?.description ||
    data.rawText?.match(/(?:for|description)\s+([a-z0-9 ]{4,50})/i)?.[1] ||
    "Invoice expenses";

  return source.trim().replace(/\s+/g, " ");
}

function headerDescription(
  data: ExtractedInvoiceData,
  suggestedDescription?: string
) {
  const current = humanDescription(data);
  const useHistorical =
    Boolean(suggestedDescription) &&
    /^(invoice expenses?|service charge)$/i.test(current);
  return `${monthLabel(data.invoiceDate)}.${
    useHistorical ? suggestedDescription : current
  }`;
}

function lineDescription(data: ExtractedInvoiceData, lineDescriptionText: string) {
  const base = `${monthLabel(data.invoiceDate)} ${lineDescriptionText || humanDescription(data)}`;
  return data.beneficiary ? `${base}_${data.beneficiary}` : base;
}

function paymentConditionFor(
  supplier: ExactSupplierAccount | undefined,
  data: ExtractedInvoiceData,
  exactMasterData: ExactMasterDataCache | null,
  historicalSuggestion?: ExactHistorySuggestion
) {
  const extracted = (data.paymentTerms ?? "").trim();
  const historicalCode = historicalSuggestion?.lines.find(
    (line) => line.paymentConditionCode
  )?.paymentConditionCode;
  const preferredCode = supplier?.paymentConditionCode || historicalCode || "";
  const condition = exactMasterData?.paymentConditions.find(
    (item) => item.code === preferredCode && item.isActive
  );
  const conditionCode = condition?.code ?? preferredCode;
  const conditionLabel =
    condition?.label ??
    supplier?.paymentConditionLabel ??
    "Unknown Exact payment condition";
  const mismatch =
    Boolean(extracted) && normalizeText(extracted) !== normalizeText(conditionLabel);
  const missing = Boolean(preferredCode && !condition);
  const historyApplied = Boolean(
    historicalCode && !supplier?.paymentConditionCode && condition
  );

  return {
    conditionCode,
    conditionLabel,
    invoicePaymentTerms: extracted || conditionLabel,
    mismatch,
    missing,
    confidence: missing
      ? 0
      : mismatch
        ? 0.52
        : historyApplied
          ? historicalSuggestion?.confidence ?? 0.9
          : extracted
            ? 0.94
            : 0.78,
    historyApplied,
  };
}

function isOpenPeriod(year: number, period: number) {
  if (year > companyConfig.currentMockOpenYear) {
    return true;
  }

  if (year < companyConfig.currentMockOpenYear) {
    return false;
  }

  return period >= companyConfig.firstMockOpenPeriod;
}

function firstOpenPeriodOnOrAfter(year: number, period: number) {
  let nextYear = year;
  let nextPeriod = period;

  for (let index = 0; index < 36; index += 1) {
    if (isOpenPeriod(nextYear, nextPeriod)) {
      return { year: nextYear, period: nextPeriod };
    }

    nextPeriod += 1;
    if (nextPeriod > 12) {
      nextPeriod = 1;
      nextYear += 1;
    }
  }

  return {
    year: companyConfig.currentMockOpenYear,
    period: companyConfig.firstMockOpenPeriod,
  };
}

function determineFinancialPeriod(data: ExtractedInvoiceData) {
  const invoiceMonth = yearMonth(data.invoiceDate);
  const open = firstOpenPeriodOnOrAfter(invoiceMonth.year, invoiceMonth.month);
  const adjusted =
    open.year !== invoiceMonth.year || open.period !== invoiceMonth.month;

  return {
    financialYear: open.year,
    period: open.period,
    adjusted,
    log: adjusted
      ? `Invoice period ${invoiceMonth.year}/${invoiceMonth.month} is closed in mock Exact, so INTO moved the booking to ${open.year}/${open.period}.`
      : "Invoice date maps to an open Exact period.",
  };
}

function daysBetween(left: string, right: string) {
  if (!isValidIsoDate(left) || !isValidIsoDate(right)) {
    return 0;
  }

  return Math.round(
    (new Date(`${right}T00:00:00.000Z`).getTime() -
      new Date(`${left}T00:00:00.000Z`).getTime()) /
      86_400_000
  );
}

function monthSpan(start: string, end: string) {
  if (!isValidIsoDate(start) || !isValidIsoDate(end)) {
    return 0;
  }

  const startDate = new Date(`${start}T00:00:00.000Z`);
  const endDate = new Date(`${end}T00:00:00.000Z`);
  return (
    (endDate.getUTCFullYear() - startDate.getUTCFullYear()) * 12 +
    (endDate.getUTCMonth() - startDate.getUTCMonth()) +
    1
  );
}

function firstDayOfMonth(dateValue: string) {
  const date = new Date(`${dateValue}T00:00:00.000Z`);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(
    2,
    "0"
  )}-01`;
}

function lastDayOfMonth(dateValue: string) {
  const date = new Date(`${dateValue}T00:00:00.000Z`);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
  return last.toISOString().slice(0, 10);
}

function firstDayOfPeriod(year: number, period: number) {
  return `${year}-${String(period).padStart(2, "0")}-01`;
}

function determineAccrual(data: ExtractedInvoiceData) {
  const accrualKeyword = /subscription|insurance|maintenance|flight|hotel|event/i.test(
    `${humanDescription(data)} ${data.rawText ?? ""}`
  );

  if (!isValidIsoDate(data.serviceStartDate) || !isValidIsoDate(data.serviceEndDate)) {
    if (accrualKeyword) {
      return {
        from: "",
        to: "",
        benefitStartDate: undefined,
        benefitEndDate: undefined,
        reason: "Accrual period is unclear. Confirm benefit period.",
      };
    }

    return {
      from: "",
      to: "",
      benefitStartDate: undefined,
      benefitEndDate: undefined,
      reason: undefined,
    };
  }

  const periodMonths = monthSpan(data.serviceStartDate, data.serviceEndDate);
  const paidBeforeBenefit = daysBetween(data.invoiceDate, data.serviceStartDate) > 30;

  if (periodMonths <= 3 && !paidBeforeBenefit && !accrualKeyword) {
    return {
      from: "",
      to: "",
      benefitStartDate: undefined,
      benefitEndDate: undefined,
      reason: undefined,
    };
  }

  let from = firstDayOfMonth(data.serviceStartDate);
  const to = lastDayOfMonth(data.serviceEndDate);
  const fromPeriod = yearMonth(from);

  if (!isOpenPeriod(fromPeriod.year, fromPeriod.month)) {
    const nextOpen = firstOpenPeriodOnOrAfter(fromPeriod.year, fromPeriod.month);
    from = firstDayOfPeriod(nextOpen.year, nextOpen.period);
  }

  const reason = periodMonths > 3
    ? `Service period spans ${periodMonths} months.`
    : paidBeforeBenefit
      ? "Expense is paid before the benefit period."
      : "Expense category normally requires accrual review.";

  return {
    from,
    to,
    benefitStartDate: data.serviceStartDate,
    benefitEndDate: data.serviceEndDate,
    reason,
  };
}

function accrualFor(
  data: ExtractedInvoiceData,
  historicalSuggestion?: ExactHistorySuggestion,
  preferredHistoricalLine?: ExactHistoricalPurchaseBooking
) {
  const extracted = determineAccrual(data);
  if (extracted.from && extracted.to) {
    return { ...extracted, historyApplied: false };
  }

  const historical =
    preferredHistoricalLine &&
    isValidIsoDate(preferredHistoricalLine.accrualFrom) &&
    isValidIsoDate(preferredHistoricalLine.accrualTo)
      ? preferredHistoricalLine
      : historicalSuggestion?.lines.find(
          (line) =>
            isValidIsoDate(line.accrualFrom) && isValidIsoDate(line.accrualTo)
        );
  if (!historical?.accrualFrom || !historical.accrualTo) {
    return { ...extracted, historyApplied: false };
  }

  const historicalMonths = monthSpan(
    historical.accrualFrom,
    historical.accrualTo
  );
  if (historicalMonths <= 0 || !isValidIsoDate(data.invoiceDate)) {
    return { ...extracted, historyApplied: false };
  }

  let from = firstDayOfMonth(data.invoiceDate);
  const fromPeriod = yearMonth(from);
  if (!isOpenPeriod(fromPeriod.year, fromPeriod.month)) {
    const nextOpen = firstOpenPeriodOnOrAfter(fromPeriod.year, fromPeriod.month);
    from = firstDayOfPeriod(nextOpen.year, nextOpen.period);
  }
  const start = new Date(`${from}T00:00:00.000Z`);
  const to = new Date(
    Date.UTC(
      start.getUTCFullYear(),
      start.getUTCMonth() + historicalMonths,
      0
    )
  )
    .toISOString()
    .slice(0, 10);

  return {
    from,
    to,
    benefitStartDate: undefined,
    benefitEndDate: undefined,
    reason: `Previous Exact bookings use a ${historicalMonths}-month accrual period.`,
    historyApplied: true,
  };
}

function selectedSupplierAccount(
  candidates: ReturnType<typeof resolveSupplier>,
  exactMasterData: ExactMasterDataCache | null
) {
  return exactSuppliers(exactMasterData).find(
    (account) => account.id === candidates.selectedAccountId
  );
}

function suggestGlAccount(
  supplier: ExactSupplierAccount | undefined,
  data: ExtractedInvoiceData,
  lineDescriptionText: string,
  learning: BookingLearningStore,
  exactMasterData: ExactMasterDataCache | null,
  historicalSuggestion?: ExactHistorySuggestion,
  preferredHistoricalLine?: ExactHistoricalPurchaseBooking,
  preferHistoricalPattern = false
): GlSuggestion {
  const text = normalizeText(
    `${supplier?.name ?? ""} ${data.expenseDescription} ${lineDescriptionText} ${
      data.rawText ?? ""
    }`
  );
  const key = descriptionKey(lineDescriptionText || humanDescription(data));
  const suggestionForCode = (code: string, confidence: number, reason: string) => {
    const account = exactGlAccount(exactMasterData, code);
    if (!account) {
      return {
        account: code,
        name: "Missing Exact G/L account",
        confidence: 0,
        reason: `Expected G/L account ${code} is missing or inactive in Exact.`,
      };
    }

    return {
      account: account.code,
      name: account.name,
      confidence,
      reason,
    };
  };

  const learned = supplier
    ? learning.glAccountSelections.find(
        (decision) =>
          decision.supplierAccountId === supplier.id &&
          decision.descriptionKey === key
      )
    : undefined;

  if (learned) {
    return suggestionForCode(
      learned.glAccount,
      0.97,
      "User-approved mapping from a previous invoice."
    );
  }

  const historical =
    preferredHistoricalLine ||
    historicalLineFor(
      historicalSuggestion,
      lineDescriptionText || humanDescription(data)
    );
  if (preferHistoricalPattern && historical) {
    return suggestionForCode(
      historical.glAccount,
      historicalSuggestion?.confidence ?? 0.9,
      EXACT_HISTORY_SUGGESTION_NOTE
    );
  }

  if (supplier?.defaultGlAccount) {
    return suggestionForCode(
      supplier.defaultGlAccount,
      supplier.isInBodyEntity ? 0.95 : 0.9,
      "Supplier default G/L account from Exact master data."
    );
  }

  if (historical) {
    return suggestionForCode(
      historical.glAccount,
      historicalSuggestion?.confidence ?? 0.9,
      EXACT_HISTORY_SUGGESTION_NOTE
    );
  }

  if (/google|workspace|software|saas|subscription/.test(text)) {
    return suggestionForCode(
      glRuleCodes.software,
      0.89,
      "Matched software subscription pattern."
    );
  }
  if (/booking|hotel|restaurant|lodging/.test(text)) {
    return suggestionForCode(
      glRuleCodes.hotel,
      0.89,
      "Matched travel hotel pattern."
    );
  }
  if (/klm|flight|airline|air travel/.test(text)) {
    return suggestionForCode(
      glRuleCodes.airTravel,
      0.9,
      "Matched air travel pattern."
    );
  }
  if (/insurance|policy/.test(text)) {
    return suggestionForCode(
      glRuleCodes.insurance,
      0.9,
      "Matched insurance pattern."
    );
  }
  if (/bank fee|payment fee|stripe/.test(text)) {
    return suggestionForCode(glRuleCodes.bank, 0.88, "Matched bank fee pattern.");
  }
  if (/office|supplies|furniture/.test(text)) {
    return suggestionForCode(
      glRuleCodes.office,
      0.88,
      "Matched office supplies pattern."
    );
  }

  return suggestionForCode(
    glRuleCodes.services,
    0.62,
    "Fallback to professional services because no strong pattern matched."
  );
}

function isDutchSupplier(supplier: ExactSupplierAccount | undefined, data: ExtractedInvoiceData) {
  return (supplier?.country || data.supplierCountry || "").toUpperCase() === "NL";
}

function supplierCountry(supplier: ExactSupplierAccount | undefined, data: ExtractedInvoiceData) {
  return (supplier?.country || data.supplierCountry || "").toUpperCase();
}

function vatRateFor(line: { netAmount: number; vatAmount: number }) {
  if (!line.netAmount) {
    return 0;
  }

  return roundMoney(line.vatAmount / line.netAmount);
}

function suggestVatCode(
  supplier: ExactSupplierAccount | undefined,
  data: ExtractedInvoiceData,
  lineDescriptionText: string,
  line: { netAmount: number; vatAmount: number; grossAmount: number; vatRate?: number },
  learning: BookingLearningStore,
  exactMasterData: ExactMasterDataCache | null,
  historicalSuggestion?: ExactHistorySuggestion,
  preferredHistoricalLine?: ExactHistoricalPurchaseBooking
): VatSuggestion {
  const country = supplierCountry(supplier, data);
  const supplierVat = normalizedVat(data.supplierVatNumber || supplier?.vatNumber || "");
  const companyVatPresent =
    normalizedVat(data.companyVatNumber) === normalizedVat(companyConfig.companyVatNumber);
  const supplierNonDutch = country !== "NL" || !supplierVat.startsWith("NL");
  const supplierOutsideEu = Boolean(country) && !euVatCountries.has(country);
  const rate = typeof line.vatRate === "number" ? line.vatRate : vatRateFor(line);
  const text = normalizeText(
    `${supplier?.name ?? data.supplierName} ${data.expenseDescription} ${lineDescriptionText} ${
      data.rawText ?? ""
    }`
  );
  const safeFallbackPattern =
    /flight|airline|eurostar|bank fee|insurance|stamp|postnl|hotel|restaurant|exempt|non-deductible/.test(
      text
    );
  const zeroVat = Math.abs(line.vatAmount) < 0.005 || Math.abs(rate) < 0.005;
  const suggestionForCode = (
    code: VatCode,
    confidence: number,
    percentage: number,
    amountMode: "vat_excluded" | "vat_inclusive",
    reasoning: string[]
  ): VatSuggestion => {
    const exactCode = exactVatCode(exactMasterData, code);
    if (!exactCode) {
      return {
        code,
        name: "Missing Exact VAT code",
        confidence: 0,
        percentage,
        amountMode,
        reasoning: [
          ...reasoning,
          `Expected purchase VAT code ${code} is missing or inactive in Exact.`,
        ],
      };
    }

    return {
      code,
      name: exactCode.description,
      confidence,
      percentage: exactCode.percentage,
      amountMode,
      reasoning,
    };
  };

  const key = descriptionKey(lineDescriptionText || humanDescription(data));
  const learned = supplier
    ? learning.vatCodeSelections.find(
        (decision) =>
          decision.supplierAccountId === supplier.id &&
          decision.descriptionKey === key
      )
    : undefined;

  if (learned) {
    const vatInclusive =
      learned.vatCode === "7" ||
      learned.vatCode === "8" ||
      (learned.vatCode === "6" && Math.abs(line.vatAmount) < 0.005);
    return suggestionForCode(
      learned.vatCode,
      0.97,
      0,
      vatInclusive ? "vat_inclusive" : "vat_excluded",
      [LEARNED_CORRECTION_NOTE]
    );
  }

  const historical =
    preferredHistoricalLine ||
    historicalLineFor(
      historicalSuggestion,
      lineDescriptionText || humanDescription(data)
    );
  if (historical && !isIntoPurchaseVatCode(historical.vatCode)) {
    return suggestionForCode("6", 0, 0, "vat_inclusive", [
      UNSUPPORTED_VAT_CODE_WARNING,
    ]);
  }
  if (
    historical &&
    supportedHistoricalVatCodes.has(historical.vatCode as VatCode) &&
    historicalVatSimilarity([historical], data) >= 0.8
  ) {
    const historicalCode = historical.vatCode as VatCode;
    const vatInclusive = ["6", "7", "8"].includes(historicalCode);
    return suggestionForCode(
      historicalCode,
      historicalSuggestion?.confidence ?? 0.9,
      historical.vatPercentage ?? 0,
      vatInclusive ? "vat_inclusive" : "vat_excluded",
      [
        EXACT_HISTORY_SUGGESTION_NOTE,
        ...(historicalSuggestion?.reasoning ?? []),
      ]
    );
  }

  if (
    companyVatPresent &&
    supplierNonDutch &&
    euVatCountries.has(country) &&
    (data.reverseChargeMentioned || data.intraCommunityMentioned)
  ) {
    return suggestionForCode(
      "7",
      0.95,
      0,
      "vat_inclusive",
      [
        "Company VAT number is present.",
        "Supplier is non-Dutch but inside EU VAT regions.",
        "Invoice wording indicates reverse charge or intra-community acquisition.",
      ]
    );
  }

  if (companyVatPresent && supplierOutsideEu && zeroVat) {
    return suggestionForCode(
      "8",
      0.93,
      0,
      "vat_inclusive",
      [
        "Company VAT number is present.",
        "Supplier is outside EU VAT regions.",
        "Invoice shows 0% VAT and no reverse-charge wording was detected.",
      ]
    );
  }

  if (safeFallbackPattern) {
    return suggestionForCode(
      "6",
      0.9,
      0,
      "vat_inclusive",
      [
        "Expense category belongs to the safe VAT code 6 fallback list.",
      ]
    );
  }

  if (isDutchSupplier(supplier, data) && Math.abs(rate - 0.21) < 0.001) {
    return suggestionForCode("4", 0.94, 21, "vat_excluded", [
      "Dutch supplier with VAT amount at 21%.",
    ]);
  }

  if (isDutchSupplier(supplier, data) && Math.abs(rate - 0.09) < 0.001) {
    return suggestionForCode("5", 0.94, 9, "vat_excluded", [
      "Dutch supplier with VAT amount at 9%.",
    ]);
  }

  return suggestionForCode(
    "6",
    zeroVat ? 0.88 : 0.68,
    0,
    "vat_inclusive",
    [
      zeroVat
        ? "Invoice shows 0% VAT, so code 6 is the safe fallback."
        : "VAT classification confidence is low, so INTO selected safe fallback code 6.",
    ]
  );
}

function yourRefValue(data: ExtractedInvoiceData) {
  return (data.referenceCode ?? "").trim() || (data.invoiceNumber ?? "").trim();
}

function isYourRefUnique(
  invoice: UploadedInvoice,
  allInvoices: UploadedInvoice[],
  supplier: ExactSupplierAccount | undefined
) {
  const reference = normalizeText(yourRefValue(invoice.extractedData));

  if (!reference) {
    return false;
  }

  return !allInvoices.some((candidate) => {
    if (candidate.id === invoice.id) {
      return false;
    }

    const sameSupplierAccount =
      supplier &&
      candidate.purchaseJournal?.supplierResolution.selectedAccountId === supplier.id;
    const sameSupplierName =
      normalizeText(candidate.extractedData.supplierName) ===
      normalizeText(invoice.extractedData.supplierName);
    const candidateReference = normalizeText(yourRefValue(candidate.extractedData));

    return candidateReference === reference && (sameSupplierAccount || sameSupplierName);
  });
}

function sourceLines(data: ExtractedInvoiceData) {
  if (data.lineItems.length > 0) {
    return data.lineItems.map((item) => ({
      id: item.id,
      description: item.description || humanDescription(data),
      netAmount: item.netAmount,
      vatAmount: item.vatAmount,
      grossAmount: item.grossAmount,
      vatRate: item.vatRate,
    }));
  }

  return [
    {
      id: createId("line"),
      description: humanDescription(data),
      netAmount: data.netAmount ?? data.grossAmount ?? 0,
      vatAmount: data.vatAmount ?? 0,
      grossAmount: data.grossAmount ?? data.netAmount ?? 0,
      vatRate:
        data.netAmount && data.vatAmount
          ? roundMoney(data.vatAmount / data.netAmount)
          : 0,
    },
  ];
}

function costSelection(
  supplier: ExactSupplierAccount | undefined,
  glAccount: string,
  learning: BookingLearningStore,
  exactMasterData: ExactMasterDataCache | null,
  lineDescriptionText: string,
  historicalSuggestion?: ExactHistorySuggestion,
  preferredHistoricalLine?: ExactHistoricalPurchaseBooking
) {
  const historical =
    preferredHistoricalLine ||
    historicalLineFor(historicalSuggestion, lineDescriptionText);
  const learnedCentre = supplier
    ? learning.costCentreSelections.find(
        (decision) =>
          decision.supplierAccountId === supplier.id &&
          decision.glAccount === glAccount
      )
    : undefined;
  const learnedUnit = supplier
    ? learning.costUnitSelections.find(
        (decision) =>
          decision.supplierAccountId === supplier.id &&
          decision.glAccount === glAccount
    )
    : undefined;
  const centreCode =
    learnedCentre?.costCentre ??
    historical?.costCentre ??
    supplier?.defaultCostCentre ??
    "";
  const unitCode =
    learnedUnit?.costUnit ?? historical?.costUnit ?? supplier?.defaultCostUnit ?? "";
  const centre = exactCostCenter(exactMasterData, centreCode);
  const unit = exactCostUnit(exactMasterData, unitCode);

  return {
    costCentre: centre?.code ?? "",
    costCentreConfidence: learnedCentre
      ? centre
        ? 0.96
        : 0
      : historical?.costCentre
        ? centre
          ? historicalSuggestion?.confidence ?? 0.9
          : 0
        : supplier?.defaultCostCentre
          ? centre
            ? 0.88
            : 0
          : 0.9,
    costUnit: unit?.code ?? "",
    costUnitConfidence: learnedUnit
      ? unit
        ? 0.96
        : 0
      : historical?.costUnit
        ? unit
          ? historicalSuggestion?.confidence ?? 0.9
          : 0
        : supplier?.defaultCostUnit
          ? unit
            ? 0.88
            : 0
          : 0.9,
    learnedApplied: Boolean(learnedCentre || learnedUnit),
    historyApplied: Boolean(
      historical && (historical.costCentre || historical.costUnit)
    ),
  };
}

function allocateMoneyByWeights(total: number, weights: number[]) {
  const totalCents = Math.round(total * 100);
  const safeWeights = weights.map((weight) => Math.max(0, Math.abs(weight)));
  const weightTotal = safeWeights.reduce((sum, weight) => sum + weight, 0);
  if (!safeWeights.length || weightTotal <= 0) {
    return [];
  }

  const rawShares = safeWeights.map((weight) => (totalCents * weight) / weightTotal);
  const cents = rawShares.map((share) => Math.floor(share));
  let remainder = totalCents - cents.reduce((sum, share) => sum + share, 0);
  const order = rawShares
    .map((share, index) => ({ index, fraction: share - Math.floor(share) }))
    .sort((left, right) => right.fraction - left.fraction);
  let cursor = 0;
  while (remainder > 0 && order.length) {
    cents[order[cursor % order.length].index] += 1;
    remainder -= 1;
    cursor += 1;
  }

  return cents.map((share) => share / 100);
}

function historicalSplitSourceLines(
  data: ExtractedInvoiceData,
  historicalSuggestion?: ExactHistorySuggestion
) {
  const historyLines = historicalSuggestion?.lines ?? [];
  if (
    data.lineItems.length > 1 ||
    historyLines.length < 2 ||
    typeof data.netAmount !== "number" ||
    typeof data.vatAmount !== "number" ||
    historyLines.some((line) => typeof line.lineAmount !== "number")
  ) {
    return undefined;
  }

  const amountWeights = historyLines.map((line) => line.lineAmount ?? 0);
  const vatWeights = historyLines.map((line) => line.vatAmount ?? 0);
  const amounts = allocateMoneyByWeights(data.netAmount, amountWeights);
  const vatAmounts = allocateMoneyByWeights(
    data.vatAmount,
    vatWeights.some((amount) => Math.abs(amount) >= 0.005)
      ? vatWeights
      : amountWeights
  );
  if (
    amounts.length !== historyLines.length ||
    vatAmounts.length !== historyLines.length
  ) {
    return undefined;
  }

  return historyLines.map((historical, index) => ({
    id: historical.lineId || historical.id,
    description: cleanHistoricalDescription(historical),
    netAmount: amounts[index],
    vatAmount: vatAmounts[index],
    grossAmount: roundMoney(amounts[index] + vatAmounts[index]),
    vatRate:
      typeof historical.vatPercentage === "number"
        ? historical.vatPercentage / 100
        : amounts[index]
          ? roundMoney(vatAmounts[index] / amounts[index])
          : 0,
    historical,
  }));
}

function buildLines(
  invoice: UploadedInvoice,
  supplier: ExactSupplierAccount | undefined,
  data: ExtractedInvoiceData,
  learning: BookingLearningStore,
  exactMasterData: ExactMasterDataCache | null,
  historicalSuggestion?: ExactHistorySuggestion
) {
  const learnedLines = learnedBookingLinesForInvoice(
    invoice,
    supplier?.id,
    learning
  );
  const overrideLines = invoice.bookingLineOverrides?.length
    ? { lines: invoice.bookingLineOverrides, confidence: 1, learned: false }
    : learnedLines
      ? { ...learnedLines, learned: true }
      : null;

  if (overrideLines) {
    return overrideLines.lines.map((source) => {
      const vatCode = intoPurchaseVatCodeOrFallback(source.vatCode);
      const unsupportedVatCode = !isIntoPurchaseVatCode(source.vatCode);
      const gl = exactGlAccount(
        exactMasterData,
        source.finalSelectedAccount || source.glAccount
      );
      const vat = exactVatCode(exactMasterData, vatCode);
      const centre = source.costCentre
        ? exactCostCenter(exactMasterData, source.costCentre)
        : undefined;
      const unit = source.costUnit
        ? exactCostUnit(exactMasterData, source.costUnit)
        : undefined;
      const exactValuesReady = Boolean(
        gl && vat && (!source.costCentre || centre) && (!source.costUnit || unit)
      );
      const reasoning = [
        ...(source.reasoning ?? []),
        ...(overrideLines.learned ? [LEARNED_CORRECTION_NOTE] : []),
      ];
      const glConfidence = gl
        ? overrideLines.learned
          ? source.glConfidence
          : overrideLines.confidence
        : 0;
      const costCentreConfidence = source.costCentre
        ? centre
          ? overrideLines.learned
            ? source.costCentreConfidence
            : overrideLines.confidence
          : 0
        : 1;
      const costUnitConfidence = source.costUnit
        ? unit
          ? overrideLines.learned
            ? source.costUnitConfidence
            : overrideLines.confidence
          : 0
        : 1;
      const vatConfidence = vat && !unsupportedVatCode
        ? overrideLines.learned
          ? source.vatConfidence
          : overrideLines.confidence
        : 0;
      const reviewRequired =
        !exactValuesReady ||
        glConfidence < companyConfig.confidenceThreshold ||
        vatConfidence < companyConfig.confidenceThreshold ||
        costCentreConfidence < companyConfig.confidenceThreshold ||
        costUnitConfidence < companyConfig.confidenceThreshold;

      return {
        ...source,
        id: createId("pj_line"),
        glAccount: source.finalSelectedAccount || source.glAccount,
        glAccountName: gl?.name ?? source.glAccountName,
        suggestedGlAccount: source.finalSelectedAccount || source.glAccount,
        finalSelectedAccount: source.finalSelectedAccount || source.glAccount,
        glConfidence,
        costCentreConfidence,
        costUnitConfidence,
        vatCode,
        vatCodeName: vat?.description ?? (unsupportedVatCode ? "0% VAT" : source.vatCodeName),
        vatConfidence,
        vatReasoning: [
          ...(source.vatReasoning ?? []),
          ...(unsupportedVatCode ? [UNSUPPORTED_VAT_CODE_WARNING] : []),
          ...(overrideLines.learned ? [LEARNED_CORRECTION_NOTE] : []),
        ],
        reviewRequired: reviewRequired || unsupportedVatCode,
        reasoning: [...new Set(reasoning)],
      };
    });
  }

  const historicalSplit = historicalSplitSourceLines(data, historicalSuggestion);
  const source = historicalSplit ?? sourceLines(data);
  const lines: PurchaseJournalLine[] = source.map((line, lineIndex) => {
    const historicalLine =
      "historical" in line
        ? (line.historical as ExactHistoricalPurchaseBooking)
        : historicalLineFor(historicalSuggestion, line.description, lineIndex);
    const gl = suggestGlAccount(
      supplier,
      data,
      line.description,
      learning,
      exactMasterData,
      historicalSuggestion,
      historicalLine,
      Boolean(historicalSplit)
    );
    const vat = suggestVatCode(
      supplier,
      data,
      line.description,
      line,
      learning,
      exactMasterData,
      historicalSuggestion,
      historicalLine
    );
    const costs = costSelection(
      supplier,
      gl.account,
      learning,
      exactMasterData,
      line.description,
      historicalSuggestion,
      historicalLine
    );
    const accrual = accrualFor(data, historicalSuggestion, historicalLine);
    const amount =
      vat.amountMode === "vat_inclusive" ? line.grossAmount : line.netAmount;
    const vatAmount = vat.amountMode === "vat_inclusive" ? 0 : line.vatAmount;
    const reviewRequired =
      gl.confidence < companyConfig.confidenceThreshold ||
      vat.confidence < companyConfig.confidenceThreshold ||
      costs.costCentreConfidence < companyConfig.confidenceThreshold ||
      costs.costUnitConfidence < companyConfig.confidenceThreshold;

    return {
      id: createId("pj_line"),
      sourceLineItemId: line.id,
      glAccount: gl.account,
      glAccountName: gl.name,
      suggestedGlAccount: gl.account,
      finalSelectedAccount: gl.account,
      glConfidence: gl.confidence,
      description: lineDescription(data, line.description),
      from: accrual.from,
      to: accrual.to,
      benefitStartDate: accrual.benefitStartDate,
      benefitEndDate: accrual.benefitEndDate,
      accrualReason: accrual.reason,
      costCentre: costs.costCentre,
      costCentreConfidence: costs.costCentreConfidence,
      costUnit: costs.costUnit,
      costUnitConfidence: costs.costUnitConfidence,
      vatCode: vat.code,
      vatCodeName: vat.name,
      vatConfidence: vat.confidence,
      vatReasoning: vat.reasoning,
      percentage: vat.percentage,
      amount: roundMoney(amount),
      vatAmount: roundMoney(vatAmount),
      country: supplierCountry(supplier, data),
      intercompany: supplier?.isInBodyEntity ? "Yes" : "",
      roundingAdjustment: 0,
      reviewRequired,
      reasoning: [
        gl.reason,
        ...vat.reasoning,
        ...(costs.learnedApplied ? [LEARNED_CORRECTION_NOTE] : []),
        ...(costs.historyApplied || accrual.historyApplied
          ? [EXACT_HISTORY_SUGGESTION_NOTE]
          : []),
      ],
    };
  });

  return lines;
}

function confidenceScores(
  supplierConfidence: number,
  paymentConfidence: number,
  lines: PurchaseJournalLine[]
) {
  const glAccount =
    lines.length > 0
      ? Math.min(...lines.map((line) => line.glConfidence))
      : 0;
  const vatCode =
    lines.length > 0
      ? Math.min(...lines.map((line) => line.vatConfidence))
      : 0;
  const costCentre =
    lines.length > 0
      ? Math.min(...lines.map((line) => line.costCentreConfidence))
      : 0.9;
  const costUnit =
    lines.length > 0 ? Math.min(...lines.map((line) => line.costUnitConfidence)) : 0.9;
  const overall = Math.min(
    supplierConfidence || 0,
    glAccount || 0,
    vatCode || 0,
    costCentre || 0,
    costUnit || 0,
    paymentConfidence || 0
  );

  return {
    supplierMatch: roundMoney(supplierConfidence),
    glAccount: roundMoney(glAccount),
    vatCode: roundMoney(vatCode),
    costCentre: roundMoney(costCentre),
    costUnit: roundMoney(costUnit),
    paymentCondition: roundMoney(paymentConfidence),
    overall: roundMoney(overall),
  };
}

function totalsFor(lines: PurchaseJournalLine[], invoiceGross: number | null) {
  return calculateBookingTotals(lines, invoiceGross);
}

function exactMasterDataIssues(
  exactMasterData: ExactMasterDataCache | null,
  supplier: ExactSupplierAccount | undefined,
  journal: "60" | "61",
  lines: PurchaseJournalLine[],
  paymentMissing: boolean
) {
  if (!exactMasterData) {
    return ["Exact master data has not been synced."];
  }

  const issues: string[] = [];
  const requiredJournals = [
    companyConfig.defaultJournal,
    companyConfig.intercompanyJournal,
  ];

  for (const journalCode of requiredJournals) {
    const exactJournal = exactMasterData.journals.find(
      (item) =>
        item.code === journalCode && item.type === "purchase" && item.isActive
    );
    if (!exactJournal) {
      issues.push(`Exact purchase journal ${journalCode} is missing or inactive.`);
    }
  }

  if (
    !exactMasterData.journals.some(
      (item) => item.code === journal && item.type === "purchase" && item.isActive
    )
  ) {
    issues.push(`Selected Exact purchase journal ${journal} is not available.`);
  }

  if (
    supplier &&
    !exactMasterData.suppliers.some((item) => item.id === supplier.id)
  ) {
    issues.push("Selected supplier is not present in the synced Exact supplier data.");
  }

  if (paymentMissing) {
    issues.push("Supplier default payment condition is missing in Exact.");
  }

  for (const line of lines) {
    if (!exactGlAccount(exactMasterData, line.finalSelectedAccount)) {
      issues.push(`G/L account ${line.finalSelectedAccount} is missing in Exact.`);
    }
    if (!exactVatCode(exactMasterData, line.vatCode)) {
      issues.push(`Purchase VAT code ${line.vatCode} is missing in Exact.`);
    }
    if (line.costCentre && !exactCostCenter(exactMasterData, line.costCentre)) {
      issues.push(`Cost center ${line.costCentre} is missing in Exact.`);
    }
    if (line.costUnit && !exactCostUnit(exactMasterData, line.costUnit)) {
      issues.push(`Cost unit ${line.costUnit} is missing in Exact.`);
    }
  }

  return [...new Set(issues)];
}

export function createInitialLearningStore(): BookingLearningStore {
  return {
    supplierSelections: [],
    glAccountSelections: [],
    vatCodeSelections: [],
    costCentreSelections: [],
    costUnitSelections: [],
    corrections: [],
  };
}

export function generatePurchaseJournalBooking(
  invoice: UploadedInvoice,
  allInvoices: UploadedInvoice[],
  learning: BookingLearningStore,
  exactMasterData: ExactMasterDataCache | null
): PurchaseJournalBooking {
  const data = invoice.extractedData;
  const supplierResolution = resolveSupplier(
    invoice,
    allInvoices,
    learning,
    exactMasterData
  );
  const supplier = selectedSupplierAccount(supplierResolution, exactMasterData);
  const historicalSuggestion = exactHistoricalSuggestion(
    invoice,
    exactMasterData,
    supplier,
    data
  );
  const payment = paymentConditionFor(
    supplier,
    data,
    exactMasterData,
    historicalSuggestion
  );
  const period = determineFinancialPeriod(data);
  const lines = buildLines(
    invoice,
    supplier,
    data,
    learning,
    exactMasterData,
    historicalSuggestion
  );
  const totals = totalsFor(lines, data.grossAmount);
  const yourRef = yourRefValue(data);
  const yourRefUnique = isYourRefUnique(invoice, allInvoices, supplier);
  const journal = supplier?.isInBodyEntity
    ? companyConfig.intercompanyJournal
    : companyConfig.defaultJournal;
  const confidence = confidenceScores(
    supplierResolution.matchConfidence,
    payment.confidence,
    lines
  );
  const masterDataIssues = exactMasterDataIssues(
    exactMasterData,
    supplier,
    journal,
    lines,
    payment.missing
  );
  const attachmentPresent = Boolean(invoice.storageKey && invoice.fileSize > 0);
  const userApproved = Boolean(invoice.intelligenceApprovedAt);
  const criticalReasons = [
    ...masterDataIssues,
    !attachmentPresent ? "Original invoice attachment is required before booking." : "",
    supplierResolution.reviewRequired
      ? supplierResolution.reasoning[0] ??
        "Supplier review required before automation can continue."
      : "",
    !yourRef ? "Your ref. must contain the invoice number or invoice reference." : "",
    yourRef && !yourRefUnique ? DUPLICATE_INVOICE_REFERENCE_MESSAGE : "",
    totals.difference !== 0 ? BOOKING_TOTAL_MISMATCH_MESSAGE : "",
  ].filter(Boolean);
  const reviewableReasons = [
    payment.mismatch
      ? "Invoice payment terms do not match the Exact supplier default payment condition."
      : "",
    lines.some((line) => line.reviewRequired)
      ? "One or more G/L or VAT decisions are below the configured confidence threshold."
      : "",
    confidence.overall < companyConfig.confidenceThreshold
      ? "Overall booking confidence is below the configured threshold."
      : "",
  ].filter(Boolean);
  const reviewReasons = [
    ...criticalReasons,
    ...(userApproved ? [] : reviewableReasons),
  ];
  const learnedCorrectionApplied = Boolean(
    invoice.learnedFieldsApplied?.length ||
      supplierResolution.method === "Learned decision" ||
      lines.some((line) =>
        line.reasoning.some((reason) => reason === LEARNED_CORRECTION_NOTE)
      )
  );
  const exactHistoryApplied = Boolean(
    historicalSuggestion &&
      (payment.historyApplied ||
        lines.some((line) =>
          line.reasoning.includes(EXACT_HISTORY_SUGGESTION_NOTE)
        ) ||
        /^(invoice expenses?|service charge)$/i.test(humanDescription(data)))
  );

  return {
    attachmentRequired: true,
    attachmentPresent,
    attachmentStorageKey: invoice.storageKey || undefined,
    description: headerDescription(
      data,
      exactHistoryApplied ? historicalSuggestion?.suggestedDescription : undefined
    ),
    descriptionTemplate: companyConfig.defaultDescriptionTemplate,
    paymentConditionCode: payment.conditionCode,
    paymentConditionLabel: payment.conditionLabel,
    invoicePaymentTerms: payment.invoicePaymentTerms,
    paymentConditionMismatch: payment.mismatch,
    yourRef,
    yourRefUnique,
    invoiceDateOriginal: data.invoiceDate,
    totalAmount: data.grossAmount,
    currency: data.currency || "EUR",
    journal,
    journalReason: supplier?.isInBodyEntity
      ? "Supplier is configured as an InBody group company."
      : "Default purchase journal.",
    financialYear: period.financialYear,
    period: period.period,
    periodAdjusted: period.adjusted,
    periodAdjustmentLog: period.log,
    entryNumber: `MOCK-${invoice.id.slice(-8).toUpperCase()}`,
    supplierResolution,
    lines,
    totals,
    confidenceScores: confidence,
    confidenceThreshold: companyConfig.confidenceThreshold,
    autoBookAllowed:
      attachmentPresent &&
      criticalReasons.length === 0 &&
      (!reviewableReasons.length || userApproved),
    userApproved,
    reviewRequired: reviewReasons.length > 0,
    reviewReasons,
    reasoningLog: [
      `Supplier match method: ${supplierResolution.method}.`,
      `Journal ${journal} selected: ${
        supplier?.isInBodyEntity
          ? "InBody group company exception."
          : "standard purchase booking."
      }`,
      period.log,
      exactMasterData
        ? `Exact master data synced at ${exactMasterData.lastSyncedAt}.`
        : "Exact master data is not synced.",
      ...lines.flatMap((line) => line.reasoning),
      ...(exactHistoryApplied ? [EXACT_HISTORY_SUGGESTION_NOTE] : []),
      ...(learnedCorrectionApplied ? [LEARNED_CORRECTION_NOTE] : []),
    ],
    learningSummary: [
      "User corrections are saved for future similar invoices and reinforced when the invoice is approved or booked.",
      ...(exactHistoryApplied ? [EXACT_HISTORY_SUGGESTION_NOTE] : []),
      ...(learnedCorrectionApplied ? [LEARNED_CORRECTION_NOTE] : []),
    ],
  };
}

function purchaseError(
  field: ValidationError["field"],
  message: string,
  severity: ValidationError["severity"] = "error"
): ValidationError {
  return {
    id: createId("val"),
    field,
    message,
    severity,
  };
}

function isExactMasterDataReason(reason: string) {
  return (
    reason.startsWith("Exact master data") ||
    reason.startsWith("Exact purchase journal") ||
    reason.startsWith("Selected Exact") ||
    reason.includes("missing in Exact") ||
    reason.includes("missing or inactive in Exact") ||
    reason.includes("not present in the synced Exact")
  );
}

export function purchaseJournalValidationErrors(
  booking: PurchaseJournalBooking,
  data?: ExtractedInvoiceData
): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!booking.attachmentPresent) {
    errors.push(
      purchaseError(
        "attachment",
        "Original invoice attachment is required and must be uploaded to Exact with the booking."
      )
    );
  }

  if (booking.supplierResolution.reviewRequired) {
    errors.push(
      purchaseError(
        "supplier",
        booking.supplierResolution.reasoning[0] ??
          "Supplier Review Required: select an Exact supplier account."
      )
    );
  }

  if (!booking.yourRef) {
    errors.push(
      purchaseError(
        "yourRef",
        "Your ref. is required and must contain the invoice number or invoice reference."
      )
    );
  }

  if (booking.yourRef && !booking.yourRefUnique) {
    errors.push(
      purchaseError(
        "yourRef",
        DUPLICATE_INVOICE_REFERENCE_MESSAGE
      )
    );
  }

  if (booking.paymentConditionMismatch && !booking.userApproved) {
    errors.push(
      purchaseError(
        "paymentCondition",
        "Payment Condition Review Required: invoice payment terms differ from the Exact supplier default."
      )
    );
  }

  for (const issue of getBookingLineDataIssues(booking.lines)) {
    const field =
      issue.field === "glAccount"
        ? "glAccount"
        : issue.field === "from"
          ? "accrualFrom"
          : issue.field === "to"
            ? "accrualTo"
            : issue.field === "vatCode"
              ? "vatCode"
              : "purchaseJournal";
    errors.push(purchaseError(field, issue.message));
  }

  if (booking.reviewRequired) {
    for (const reason of booking.reviewReasons) {
      if (reason === DUPLICATE_INVOICE_REFERENCE_MESSAGE) {
        continue;
      }
      errors.push(
        purchaseError(
          isExactMasterDataReason(reason) ? "exactMasterData" : "purchaseJournal",
          reason
        )
      );
    }
  }

  return [
    ...errors,
    ...(data ? requiredBookingDataValidationErrors(data, booking) : []),
  ];
}

export function statusFromPurchaseJournal(
  baseValidationErrors: ValidationError[],
  booking: PurchaseJournalBooking,
  data?: ExtractedInvoiceData
): InvoiceStatus {
  if (!booking.attachmentPresent) {
    return "Attachment Missing";
  }

  if (baseValidationErrors.some((item) => item.severity === "error")) {
    return "Validation Failed";
  }

  if (booking.reviewReasons.some(isExactMasterDataReason)) {
    return "Booking Intelligence Review Required";
  }

  if (booking.supplierResolution.reviewRequired) {
    return "Supplier Review Required";
  }

  if (booking.paymentConditionMismatch && !booking.userApproved) {
    return "Payment Condition Review Required";
  }

  if (data && requiredBookingDataValidationErrors(data, booking).length > 0) {
    return "Validation Failed";
  }

  if (booking.reviewRequired) {
    return "Booking Intelligence Review Required";
  }

  return "Ready to Book";
}

export function rememberDecisionsFromInvoice(
  invoice: UploadedInvoice,
  learning: BookingLearningStore
) {
  const booking = invoice.purchaseJournal;

  if (!booking?.supplierResolution.selectedAccountId) {
    return;
  }

  const decidedAt = new Date().toISOString();
  const supplierIdentity = primarySupplierIdentity(invoice.extractedData);
  const supplierAccountId = booking.supplierResolution.selectedAccountId;
  learning.supplierSelections = learning.supplierSelections.filter(
    (decision) => decision.supplierIdentity !== supplierIdentity
  );
  learning.supplierSelections.unshift({
    supplierIdentity,
    accountId: supplierAccountId,
    decidedAt,
  });

  for (const line of booking.lines) {
    const key = descriptionKey(line.description);

    learning.glAccountSelections = learning.glAccountSelections.filter(
      (decision) =>
        decision.supplierAccountId !== supplierAccountId ||
        decision.descriptionKey !== key
    );
    learning.glAccountSelections.unshift({
      supplierAccountId,
      descriptionKey: key,
      glAccount: line.finalSelectedAccount,
      decidedAt,
    });

    learning.vatCodeSelections = learning.vatCodeSelections.filter(
      (decision) =>
        decision.supplierAccountId !== supplierAccountId ||
        decision.descriptionKey !== key
    );
    learning.vatCodeSelections.unshift({
      supplierAccountId,
      descriptionKey: key,
      vatCode: line.vatCode,
      decidedAt,
    });

    learning.costCentreSelections = learning.costCentreSelections.filter(
      (decision) =>
        decision.supplierAccountId !== supplierAccountId ||
        decision.glAccount !== line.finalSelectedAccount
    );
    if (line.costCentre) {
      learning.costCentreSelections.unshift({
        supplierAccountId,
        glAccount: line.finalSelectedAccount,
        costCentre: line.costCentre,
        decidedAt,
      });
    }

    learning.costUnitSelections = learning.costUnitSelections.filter(
      (decision) =>
        decision.supplierAccountId !== supplierAccountId ||
        decision.glAccount !== line.finalSelectedAccount
    );
    if (line.costUnit) {
      learning.costUnitSelections.unshift({
        supplierAccountId,
        glAccount: line.finalSelectedAccount,
        costUnit: line.costUnit,
        decidedAt,
      });
    }
  }
}

export function supplierIdentityForInvoice(invoice: UploadedInvoice) {
  return primarySupplierIdentity(invoice.extractedData);
}
