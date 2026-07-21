import type {
  ExtractedInvoiceData,
  ExtractionFieldEvidence,
} from "../domain/invoice";
import { createId } from "../utils/id";
import {
  extractDocumentText,
  type DocumentTextPage,
} from "./invoice-document-text";
import { amountToMinorUnits } from "./invoice-validation";
import {
  normalizeSupplierChamberOfCommerce,
  normalizeSupplierIban,
  normalizeSupplierVat,
} from "./supplier-identity";

export type ExtractionFileInput = {
  name: string;
  type: string;
  size: number;
  text?: () => Promise<string>;
  arrayBuffer?: () => Promise<ArrayBuffer>;
};

export type InvoiceReferenceDetection = {
  value: string;
  confidence: number;
  sourceLabel: string;
  rawValue: string;
  context: string;
};

const invoiceReferenceLabelPattern = [
  "invoice\\s*(?:number|no\\.?|#)",
  "reference",
  "ref\\.?",
  "document\\s*number",
  "bill\\s*number",
  "factuurnummer",
  "factuur\\s*nr\\.?",
  "factuurnr",
  "referentie",
  "kenmerk",
  "rechnungsnummer",
  "rechnung\\s*nr\\.?",
  "belegnummer",
  "referenz",
  "num[eé]ro\\s*de\\s*facture",
  "n[°º]?\\s*facture",
  "r[eé]f[eé]rence",
  "n[uú]mero\\s*de\\s*factura",
  "n[°º]?\\s*factura",
  "referencia",
  "numero\\s*fattura",
  "n\\.?\\s*fattura",
  "riferimento",
].join("|");

const invoiceReferenceValuePattern =
  "([a-z0-9]{1,12}[-_/ ]?\\d[a-z0-9._/ -]{1,30}|\\d{4}[-_/]\\d{2,8}|\\d{5,})";

function normalizeInvoiceReferenceText(input: string) {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[°º]/g, " ")
    .toLowerCase();
}

function cleanInvoiceReferenceValue(value: string) {
  return value
    .trim()
    .replace(/^[#:\-.\s]+/, "")
    .replace(/[.,;:\s]+$/, "");
}

function looksLikeForbiddenReference(value: string, context = "") {
  const normalizedValue = value.replace(/\s+/g, "").toUpperCase();
  const normalizedContext = normalizeInvoiceReferenceText(context);

  if (/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(normalizedValue)) {
    return true;
  }

  if (/^(NL|DE|FR|ES|IT|BE|IE|KR|US)\d{6,}[A-Z0-9]*$/.test(normalizedValue)) {
    return true;
  }

  return /\b(vat|btw|iban|supplier|customer|debtor|creditor|order|po|payment)\b/.test(
    normalizedContext
  );
}

export function detectInvoiceReference(
  input: string
): InvoiceReferenceDetection | null {
  const labelledReference = new RegExp(
    `(${invoiceReferenceLabelPattern})\\s*(?:nr\\.?|no\\.?)?\\s*[:#.-]?\\s*${invoiceReferenceValuePattern}`,
    "i"
  ).exec(input);

  if (labelledReference?.[2]) {
    const value = cleanInvoiceReferenceValue(labelledReference[2]);
    const lineStart = input.lastIndexOf("\n", labelledReference.index) + 1;
    const lineEnd = input.indexOf("\n", labelledReference.index);
    const labelContext = input.slice(
      lineStart,
      lineEnd < 0 ? input.length : lineEnd
    );
    if (!looksLikeForbiddenReference(value, labelContext)) {
      return {
        value,
        confidence: 0.94,
        sourceLabel: labelledReference[1],
        rawValue: labelledReference[2],
        context: labelContext.trim(),
      };
    }
  }

  const generalReference = /\b(?:inv|fac|rf)[-_/ ]?\d[a-z0-9._/-]{2,24}\b|\b20\d{2}[-_/]\d{3,8}\b/i.exec(
    input
  );
  if (generalReference?.[0]) {
    const start = Math.max(0, generalReference.index - 24);
    const end = Math.min(input.length, generalReference.index + generalReference[0].length + 24);
    const context = input.slice(start, end);
    const value = cleanInvoiceReferenceValue(generalReference[0]);
    if (!looksLikeForbiddenReference(value, context)) {
      return {
        value,
        confidence: 0.78,
        sourceLabel: "unlabelled reference",
        rawValue: generalReference[0],
        context: context.trim(),
      };
    }
  }

  return null;
}

export type InvoiceDateDetection = {
  value: string;
  confidence: number;
  sourceLabel: string;
  rawValue: string;
  context: string;
};

const invoiceDateLabels = [
  /factuurdatum/i,
  /invoice\s+date/i,
  /rechnungsdatum/i,
  /date\s+de\s+facture/i,
  /fecha\s+de\s+factura/i,
  /data\s+fattura/i,
];

const excludedDateContext =
  /\b(?:due|verval|delivery|lever|payment|betaal|service|period|periode|shipping|order|bestel|verzend)\b/i;

const englishMonths: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

function validIsoDate(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? `${year.toString().padStart(4, "0")}-${month
        .toString()
        .padStart(2, "0")}-${day.toString().padStart(2, "0")}`
    : "";
}

function normalizedDateValue(value: string, dayFirst: boolean) {
  const numeric = /(\d{1,4})[./-](\d{1,2})[./-](\d{1,4})/.exec(value);
  if (numeric) {
    const first = Number(numeric[1]);
    const second = Number(numeric[2]);
    const third = Number(numeric[3]);
    let year = third;
    let month = dayFirst ? second : first;
    let day = dayFirst ? first : second;
    if (first >= 1000) {
      year = first;
      month = second;
      day = third;
    }
    return validIsoDate(year < 100 ? 2000 + year : year, month, day);
  }

  const words = new RegExp(
    `(january|february|march|april|may|june|july|august|september|october|november|december)\\s+(\\d{1,2})(?:st|nd|rd|th)?[,]?\\s+(\\d{4})`,
    "i"
  ).exec(value);
  return words
    ? validIsoDate(
        Number(words[3]),
        englishMonths[words[1].toLowerCase()],
        Number(words[2])
      )
    : "";
}

export function detectInvoiceDate(input: string): InvoiceDateDetection | null {
  const lines = input.replace(/\r/g, "").split("\n");
  for (const line of lines) {
    if (excludedDateContext.test(line)) {
      continue;
    }
    for (const label of invoiceDateLabels) {
      const labelMatch = label.exec(line);
      if (!labelMatch) {
        continue;
      }
      const valueText = line.slice(labelMatch.index + labelMatch[0].length);
      const rawValue =
        /\d{1,4}[./-]\d{1,2}[./-]\d{1,4}/.exec(valueText)?.[0] ??
        new RegExp(
          `(?:${Object.keys(englishMonths).join("|")})\\s+\\d{1,2}(?:st|nd|rd|th)?[,]?\\s+\\d{4}`,
          "i"
        ).exec(valueText)?.[0] ??
        "";
      const dayFirst = !/^invoice\s+date$/i.test(labelMatch[0]);
      const value = normalizedDateValue(rawValue, dayFirst);
      if (value) {
        return {
          value,
          confidence: 0.96,
          sourceLabel: labelMatch[0],
          rawValue,
          context: line.trim(),
        };
      }
    }
  }
  return null;
}

function parsedAmount(value: string | undefined) {
  const minorUnits = amountToMinorUnits(value);
  return minorUnits === null ? null : minorUnits / 100;
}

function xmlAmount(input: string, names: string[]) {
  for (const name of names) {
    const match = new RegExp(
      `<(?:[a-z0-9_.-]+:)?${name}\\b[^>]*>\\s*([^<]+)`,
      "i"
    ).exec(input);
    const amount = parsedAmount(match?.[1]);
    if (amount !== null) {
      return amount;
    }
  }

  return null;
}

function amountsOnLine(value: string) {
  return [
    ...value.matchAll(
      /(?:-\s*)?(?:(?:EUR|USD|GBP|CHF|AUD|CAD|PLN|SEK|NOK|DKK|CZK|HUF|RON|BGN)|\u20ac|\$|\u00a3)?\s*-?(?:\d{1,3}(?:[.,' \u00a0]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?:\s*(?:EUR|USD|GBP|CHF|AUD|CAD|PLN|SEK|NOK|DKK|CZK|HUF|RON|BGN))?/gi
    ),
  ].flatMap((match) => {
    const index = match.index ?? 0;
    const suffix = value.slice(index + match[0].length).trimStart();
    const amount = suffix.startsWith("%") ? null : parsedAmount(match[0]);
    return amount === null
      ? []
      : [{ amount, index, end: index + match[0].length }];
  });
}

function amountOnlyLine(value: string) {
  const matches = amountsOnLine(value);
  if (matches.length !== 1) {
    return null;
  }

  const match = matches[0];
  const remainder = `${value.slice(0, match.index)} ${value.slice(match.end)}`
    .replace(/\b[A-Z]{3}\b/gi, "")
    .replace(/[()[\]:-]/g, "")
    .trim();
  return remainder ? null : match.amount;
}

function labelledAmount(
  input: string,
  labels: RegExp[],
  excludedLine?: RegExp
) {
  const lines = input.replace(/\r/g, "").split("\n");

  for (const label of labels) {
    const candidates: number[] = [];
    for (const [lineIndex, line] of lines.entries()) {
      if (excludedLine?.test(line)) {
        continue;
      }
      const match = label.exec(line);
      if (!match) {
        continue;
      }

      const afterLabel = amountsOnLine(
        line.slice(match.index + match[0].length)
      )[0]?.amount;
      if (afterLabel !== undefined) {
        candidates.push(afterLabel);
        continue;
      }

      const nextLineAmount = amountOnlyLine(lines[lineIndex + 1] ?? "");
      if (nextLineAmount !== null) {
        candidates.push(nextLineAmount);
        continue;
      }

      const beforeLabel = amountsOnLine(line.slice(0, match.index)).at(-1)?.amount;
      if (beforeLabel !== undefined) {
        candidates.push(beforeLabel);
      }
    }

    if (candidates.length) {
      return candidates.at(-1) ?? null;
    }
  }

  return null;
}

function summaryRowAmounts(input: string) {
  const lines = input.replace(/\r/g, "").split("\n");

  for (const [lineIndex, line] of lines.entries()) {
    const isTotalRow = /^\s*(?:total|totaal)\b/i.test(line);
    const isSummaryHeader =
      /\b(?:sub\s*total|subtotaal)\b/i.test(line) &&
      /\b(?:vat|btw)\b/i.test(line) &&
      /\b(?:total|totaal)\b/i.test(line);
    const values = amountsOnLine(
      isSummaryHeader ? lines[lineIndex + 1] ?? "" : line
    ).map(({ amount }) => amount);

    if ((isTotalRow || isSummaryHeader) && values.length >= 3) {
      const [netAmount, vatAmount, grossAmount] = values.slice(-3);
      return { netAmount, vatAmount, grossAmount };
    }
  }

  return null;
}

function extractInvoiceAmountsFromSection(input: string) {
  const taxTotal = /<(?:[a-z0-9_.-]+:)?TaxTotal\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9_.-]+:)?TaxTotal>/i.exec(
    input
  )?.[1];
  const summary = summaryRowAmounts(input);
  const netAmount =
    xmlAmount(input, ["TaxExclusiveAmount"]) ??
    summary?.netAmount ??
    labelledAmount(input, [
      /\b(?:total|totaal)\s*\(?(?:excl\.?|excluding|exclusief)\s*(?:vat|tax|btw)\)?\b/i,
      /\btotal\s+excl\.?\s*(?:vat|tax)\b/i,
      /\btotal\s+excluding\s+(?:vat|tax)\b/i,
      /\bamount\s*\(?(?:excl\.?|excluding)\s+(?:vat|tax)\)?\b/i,
      /\bnet amount\b/i,
      /\bsub\s*total\b/i,
      /\bnetto(?:\s+bedrag)?\b/i,
      /\bsubtotaal\b/i,
      /\bbedrag\s+excl\.?\s*(?:btw|vat)\b/i,
      /\btax\s+exclusive\s+amount\b/i,
      /\bnetto\s*betrag\b/i,
      /\bsous-total\b/i,
      /\bimponibile\b/i,
    ], /\b(?:tax|vat|btw)\s+sub\s*total\b/i);
  const vatAmount =
    (taxTotal ? xmlAmount(taxTotal, ["TaxAmount"]) : null) ??
    summary?.vatAmount ??
    labelledAmount(
      input,
      [
        /\bvat\s+(?:amount|total)\b/i,
        /\btotal\s+vat\b/i,
        /\btax\s+(?:amount|total|subtotal)\b/i,
        /\bbtw(?:\s+(?:bedrag|totaal))?\b/i,
        /\bbelasting(?:\s*\([^)]*\))?\b/i,
        /\bmwst\b/i,
        /\bust\b/i,
        /\btva\b/i,
        /\biva\b/i,
        /\bvat\b/i,
      ],
      /\b(?:vat|btw)\s*(?:reg(?:istration)?|number|no\.?|nr\.?|nummer)|\b(?:customer|client|supplier)\s+(?:vat|btw)\b|\b(?:incl\.?|excl\.?|inclusief|exclusief)\s*(?:vat|btw)\b/i
    );
  const grossAmount =
    xmlAmount(input, ["PayableAmount", "TaxInclusiveAmount"]) ??
    summary?.grossAmount ??
    labelledAmount(
      input,
      [
        /\binvoice\s+amount\s+due\b/i,
        /\binvoice\s+amount\b/i,
        /\binvoice\s+total\b/i,
        /\btotal\s+amount\s+due\b/i,
        /\btotal\s+amount\b/i,
        /\bgrand\s+total\b/i,
        /\b(?:amount|total)\s+payable\b/i,
        /\bpayable\s+amount\b/i,
        /\bamount\s+due\b/i,
        /\bbalance\s+due\b/i,
        /\bto\s+receive\b/i,
        /\bfactuurtotaal\b/i,
        /\bfactuurbedrag\b/i,
        /\btotaalbedrag\b/i,
        /\btotaal(?:\s+factuur|\s+te\s+betalen)?\b/i,
        /\bte\s+betalen\b/i,
        /\bgesamtbetrag\b/i,
        /\brechnungsbetrag\b/i,
        /\bmontant\s+total\b/i,
        /\btotal\s+(?:facture|a\s+pagar|factura)\b/i,
        /\btotale(?:\s+fattura|\s+da\s+pagare)?\b/i,
        /(?:^|(?<!vat)(?<!tax)(?<!btw)(?<!net)(?<!line)\s)total\b(?!\s+(?:vat|tax|btw)\b)/i,
      ]
    );

  return { netAmount, vatAmount, grossAmount };
}

function invoicePages(input: string) {
  const pages = input
    .split(
      /\f|(?:^|\n)\s*(?:[-=]{2,}\s*)?(?:page|pagina)\s+\d+(?:\s+(?:of|van)\s+\d+)?(?:\s*[-=]{2,})?\s*(?=\n|$)/gim
    )
    .map((page) => page.trim())
    .filter(Boolean);
  return pages.length ? pages : [input];
}

function amountPageSignals(page: string, index: number, pageCount: number) {
  const hasFinalTotal =
    /\b(?:total\s+amount|invoice\s+total|amount\s+due|balance\s+due|total\s+due|totaalbedrag|te\s+betalen|factuurbedrag|factuurtotaal|to\s+receive)\b/i.test(
      page
    ) || /(?:^|\n)\s*(?:total|totaal)\b/im.test(page);
  const hasNetTotal =
    /\b(?:sub\s*total|subtotaal|net\s+amount)\b/i.test(page) ||
    /\bexcl\.?\s*(?:vat|btw)\b/i.test(page);
  const hasVatTotal = /\b(?:vat(?:\s+amount)?|btw)\b/i.test(page);
  const hasSummaryRow = summaryRowAmounts(page) !== null;
  const edgePriority = index === pageCount - 1 ? 3 : index === 0 ? 2 : 0;
  const score =
    (hasSummaryRow ? 30 : 0) +
    (hasFinalTotal ? 20 : 0) +
    (hasNetTotal ? 8 : 0) +
    (hasVatTotal ? 8 : 0) +
    edgePriority;

  return {
    clear: hasSummaryRow || (hasFinalTotal && (hasNetTotal || hasVatTotal)),
    score,
  };
}

function extractInvoiceAmounts(input: string) {
  const pages = invoicePages(input);
  if (pages.length === 1) {
    return extractInvoiceAmountsFromSection(input);
  }

  const rankedPages = pages
    .map((page, index) => ({
      page,
      ...amountPageSignals(page, index, pages.length),
    }))
    .sort((left, right) => right.score - left.score);
  const clearSummary = rankedPages.find(({ clear }) => clear);
  if (clearSummary) {
    return extractInvoiceAmountsFromSection(clearSummary.page);
  }

  const merged: ReturnType<typeof extractInvoiceAmountsFromSection> = {
    netAmount: null,
    vatAmount: null,
    grossAmount: null,
  };
  for (const { page } of rankedPages) {
    const candidate = extractInvoiceAmountsFromSection(page);
    merged.netAmount ??= candidate.netAmount;
    merged.vatAmount ??= candidate.vatAmount;
    merged.grossAmount ??= candidate.grossAmount;
    if (
      merged.netAmount !== null &&
      merged.vatAmount !== null &&
      merged.grossAmount !== null
    ) {
      break;
    }
  }

  return merged;
}

const amountEvidenceLabels: Record<
  "netAmount" | "vatAmount" | "grossAmount",
  RegExp[]
> = {
  netAmount: [
    /\b(?:total|totaal)\s*\(?(?:excl\.?|excluding|exclusief)\s*(?:vat|btw)\)?\b/i,
    /\b(?:net amount|netto bedrag|subtotal|subtotaal)\b/i,
  ],
  vatAmount: [
    /\b(?:vat amount|vat total|btw bedrag|btw|tax amount|belasting)\b/i,
  ],
  grossAmount: [
    /\b(?:invoice total|total amount|amount due|balance due|total due|totaalbedrag|factuurbedrag|factuurtotaal|totaal te betalen|te betalen|to receive)\b/i,
    /(?:^|\s)(?:total|totaal)\b/i,
  ],
};

function pageContainingContext(
  pages: DocumentTextPage[],
  context: string
) {
  return pages.find((page) => page.text.includes(context))?.pageNumber;
}

function amountEvidence(
  pages: DocumentTextPage[],
  field: "netAmount" | "vatAmount" | "grossAmount",
  value: number | null
): ExtractionFieldEvidence | undefined {
  if (value === null) {
    return undefined;
  }

  const expectedMinorUnits = amountToMinorUnits(value);
  for (const page of pages) {
    for (const line of page.text.replace(/\r/g, "").split("\n")) {
      for (const label of amountEvidenceLabels[field]) {
        const labelMatch = label.exec(line);
        if (!labelMatch) {
          continue;
        }
        const match = amountsOnLine(line).find(
          (candidate) =>
            amountToMinorUnits(candidate.amount) === expectedMinorUnits
        );
        if (!match) {
          continue;
        }
        return {
          sourceLabel: labelMatch[0],
          rawValue: line.slice(match.index, match.end).trim(),
          confidence: 0.96,
          page: page.pageNumber,
          context: line.trim(),
        };
      }
    }
  }
  return undefined;
}

function labelledText(input: string, labels: string[]) {
  for (const label of labels) {
    const match = new RegExp(
      `(?:^|\\n)\\s*(?:${label})\\s*[:#-]\\s*([^\\n<]{1,160})`,
      "i"
    ).exec(input);
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return "";
}

function labelledDate(input: string, labels: string[]) {
  const line = labelledText(input, labels);
  if (!line) return "";
  const raw =
    /\d{1,4}[./-]\d{1,2}[./-]\d{1,4}/.exec(line)?.[0] ??
    new RegExp(
      `(?:${Object.keys(englishMonths).join("|")})\\s+\\d{1,2}(?:st|nd|rd|th)?[,]?\\s+\\d{4}`,
      "i"
    ).exec(line)?.[0] ??
    "";
  return normalizedDateValue(raw, true) || normalizedDateValue(raw, false);
}

function documentSupplierIdentity(input: string) {
  const supplierName = labelledText(input, [
    "supplier(?:\\s+name)?",
    "vendor(?:\\s+name)?",
    "leverancier(?:snaam)?",
    "crediteur(?:snaam)?",
  ]);
  const supplierVat = labelledText(input, [
    "supplier\\s+(?:vat|btw)(?:\\s+(?:number|no\\.?|nr\\.?))?",
    "vendor\\s+(?:vat|tax)(?:\\s+(?:number|no\\.?|nr\\.?))?",
    "vat\\s+(?:number|no\\.?|nr\\.?)",
    "btw[- ]?(?:nummer|nr\\.?)",
  ]);
  const iban = /(?:^|\n)\s*IBAN\s*[:#-]?\s*([A-Z]{2}\d{2}(?:[ \t]?[A-Z0-9]){10,30})/im.exec(
    input
  )?.[1];
  const chamberOfCommerce = labelledText(input, [
    "chamber\\s+of\\s+commerce(?:\\s+(?:number|no\\.?))?",
    "coc(?:\\s+(?:number|no\\.?))?",
    "kvk(?:[- ]?(?:nummer|nr\\.?))?",
  ]);
  return {
    supplierName,
    supplierVatNumber: normalizeSupplierVat(supplierVat),
    iban: normalizeSupplierIban(iban),
    chamberOfCommerceNumber:
      normalizeSupplierChamberOfCommerce(chamberOfCommerce),
    address: labelledText(input, [
      "supplier\\s+address",
      "vendor\\s+address",
      "leveranciersadres",
      "address",
    ]),
    country: labelledText(input, ["supplier\\s+country", "vendor\\s+country", "country"]),
  };
}

function documentCurrency(input: string) {
  return /\b(EUR|USD|GBP|CHF|AUD|CAD|PLN|SEK|NOK|DKK|CZK|HUF|RON|BGN)\b/i.exec(
    input
  )?.[1]?.toUpperCase() ?? (input.includes("€") ? "EUR" : "");
}

export async function extractInvoiceData(
  file: ExtractionFileInput
): Promise<ExtractedInvoiceData> {
  const document = await extractDocumentText(file);
  const documentText = document.text;
  const supplier = documentSupplierIdentity(documentText);
  const reverseCharge = /\b(?:reverse\s+charge|intra[- ]community)\b/i.test(
    documentText
  );
  const detectedDate = detectInvoiceDate(documentText);
  const invoiceDate = detectedDate?.value ?? "";
  const { netAmount, vatAmount, grossAmount } = extractInvoiceAmounts(documentText);
  const vatRate = netAmount ? Math.round(((vatAmount ?? 0) / netAmount) * 10_000) / 10_000 : 0;
  const detectedReference = detectInvoiceReference(documentText);
  const confidentReference =
    detectedReference && detectedReference.confidence >= 0.8
      ? detectedReference
      : null;
  const invoiceNumber = confidentReference?.value ?? "";
  const referenceCode = invoiceNumber;
  const extractionEvidence: ExtractedInvoiceData["extractionEvidence"] = {
    referenceCode: confidentReference
      ? {
          sourceLabel: confidentReference.sourceLabel,
          rawValue: confidentReference.rawValue,
          confidence: confidentReference.confidence,
          page: pageContainingContext(document.pages, confidentReference.context),
          context: confidentReference.context,
        }
      : undefined,
    invoiceDate: detectedDate
      ? {
          sourceLabel: detectedDate.sourceLabel,
          rawValue: detectedDate.rawValue,
          confidence: detectedDate.confidence,
          page: pageContainingContext(document.pages, detectedDate.context),
          context: detectedDate.context,
        }
      : undefined,
    netAmount: amountEvidence(document.pages, "netAmount", netAmount),
    vatAmount: amountEvidence(document.pages, "vatAmount", vatAmount),
    grossAmount: amountEvidence(document.pages, "grossAmount", grossAmount),
  };
  const expenseDescription = labelledText(documentText, [
    "expense\\s+description",
    "description",
    "omschrijving",
    "service",
  ]);

  return {
    supplierName: supplier.supplierName,
    supplierVatNumber: supplier.supplierVatNumber,
    supplierChamberOfCommerceNumber: supplier.chamberOfCommerceNumber,
    supplierAddress: supplier.address,
    supplierCountry: supplier.country,
    invoiceNumber,
    referenceCode,
    referenceCodeConfidence: confidentReference?.confidence ?? 0,
    invoiceDate,
    dueDate: labelledDate(documentText, ["due\\s+date", "vervaldatum", "betaaldatum"]),
    paymentTerms: labelledText(documentText, [
      "payment\\s+terms?",
      "betalingsvoorwaarden?",
      "payment\\s+condition",
    ]),
    currency: documentCurrency(documentText),
    netAmount,
    vatAmount,
    grossAmount,
    iban: supplier.iban,
    expenseDescription,
    beneficiary: labelledText(documentText, ["beneficiary", "begunstigde", "traveller"]),
    serviceStartDate: labelledDate(documentText, ["service\\s+(?:start|from)", "period\\s+from"]),
    serviceEndDate: labelledDate(documentText, ["service\\s+(?:end|to)", "period\\s+to"]),
    companyVatNumber: normalizeSupplierVat(
      labelledText(documentText, [
        "customer\\s+(?:vat|btw)(?:\\s+(?:number|no\\.?|nr\\.?))?",
        "company\\s+(?:vat|btw)(?:\\s+(?:number|no\\.?|nr\\.?))?",
      ])
    ),
    reverseChargeMentioned: reverseCharge,
    intraCommunityMentioned: reverseCharge,
    confidence:
      document.mode === "unavailable"
        ? 0.4
        : Math.min(
            0.98,
            0.62 +
              (confidentReference ? 0.09 : 0) +
              (detectedDate ? 0.09 : 0) +
              (netAmount !== null ? 0.06 : 0) +
              (vatAmount !== null ? 0.06 : 0) +
              (grossAmount !== null ? 0.06 : 0)
          ),
    rawText: documentText,
    documentTextMode: document.mode,
    extractionEvidence,
    lineItems:
      netAmount !== null && vatAmount !== null && grossAmount !== null
        ? [
            {
              id: createId("line"),
              description: expenseDescription,
              quantity: 1,
              unitPrice: netAmount,
              netAmount,
              vatRate,
              vatAmount,
              grossAmount,
            },
          ]
        : [],
  };
}
