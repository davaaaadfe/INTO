import type { ExtractedInvoiceData } from "../domain/invoice";
import { createId } from "../utils/id";
import { amountToMinorUnits } from "./invoice-validation";

export type ExtractionFileInput = {
  name: string;
  type: string;
  size: number;
  text?: () => Promise<string>;
};

type MockSupplierProfile = {
  name: string;
  vat: string;
  iban: string;
  chamberOfCommerceNumber: string;
  address: string;
  country: string;
  paymentTerms: string;
  expenseDescription: string;
};

const supplierProfiles: MockSupplierProfile[] = [
  {
    name: "Noordzee Office Supplies",
    vat: "NL812345678B01",
    iban: "NL91ABNA0417164300",
    chamberOfCommerceNumber: "34123456",
    address: "Keizersgracht 100, Amsterdam",
    country: "NL",
    paymentTerms: "7 days",
    expenseDescription: "Office Supplies",
  },
  {
    name: "Delta IT Services",
    vat: "NL855512340B01",
    iban: "NL39RABO0300065264",
    chamberOfCommerceNumber: "55230119",
    address: "Europalaan 21, Utrecht",
    country: "NL",
    paymentTerms: "30 days",
    expenseDescription: "Google Workspace",
  },
  {
    name: "Bright Logistics BV",
    vat: "NL001234567B90",
    iban: "NL02INGB0001234567",
    chamberOfCommerceNumber: "60234111",
    address: "Havenweg 9, Rotterdam",
    country: "NL",
    paymentTerms: "30 days",
    expenseDescription: "Freight and logistics",
  },
];

const namedProfiles: Record<string, MockSupplierProfile> = {
  google: {
    name: "Google Ireland Limited",
    vat: "IE6388047V",
    iban: "IE29AIBK93115212345678",
    chamberOfCommerceNumber: "368047",
    address: "Gordon House, Dublin",
    country: "IE",
    paymentTerms: "30 days",
    expenseDescription: "Google Workspace",
  },
  booking: {
    name: "Booking.com BV",
    vat: "NL805734958B01",
    iban: "NL44ABNA0123456789",
    chamberOfCommerceNumber: "31047344",
    address: "Herengracht 597, Amsterdam",
    country: "NL",
    paymentTerms: "7 days",
    expenseDescription: "Hotel Amsterdam",
  },
  klm: {
    name: "KLM Royal Dutch Airlines",
    vat: "NL004983269B01",
    iban: "NL20ABNA0999999999",
    chamberOfCommerceNumber: "33014286",
    address: "Amsterdamseweg 55, Amstelveen",
    country: "NL",
    paymentTerms: "7 days",
    expenseDescription: "Air travel expenses",
  },
  insurance: {
    name: "Atlas Insurance NV",
    vat: "NL009988776B01",
    iban: "NL18INGB0000111122",
    chamberOfCommerceNumber: "27118901",
    address: "Coolsingel 42, Rotterdam",
    country: "NL",
    paymentTerms: "30 days",
    expenseDescription: "Insurance policy",
  },
  inbody: {
    name: "InBody Co Ltd",
    vat: "KR1208145299",
    iban: "KR990000000000000001",
    chamberOfCommerceNumber: "1208145299",
    address: "625 Eonju-ro, Seoul",
    country: "KR",
    paymentTerms: "30 days",
    expenseDescription: "Intercompany product purchase",
  },
  us: {
    name: "US Cloud Inc",
    vat: "US123456789",
    iban: "US00000000000001",
    chamberOfCommerceNumber: "US-2231",
    address: "100 Market Street, San Francisco",
    country: "US",
    paymentTerms: "30 days",
    expenseDescription: "Cloud subscription",
  },
  ambiguous: {
    name: "Acme Supplies BV",
    vat: "NL123456789B01",
    iban: "",
    chamberOfCommerceNumber: "",
    address: "Netherlands",
    country: "NL",
    paymentTerms: "30 days",
    expenseDescription: "Office Supplies",
  },
};

function stableNumber(input: string) {
  return [...input].reduce((sum, char) => sum + char.charCodeAt(0), 0);
}

export type InvoiceReferenceDetection = {
  value: string;
  confidence: number;
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
    `(?:${invoiceReferenceLabelPattern})\\s*(?:nr\\.?|no\\.?)?\\s*[:#.-]?\\s*${invoiceReferenceValuePattern}`,
    "i"
  ).exec(input);

  if (labelledReference?.[1]) {
    const value = cleanInvoiceReferenceValue(labelledReference[1]);
    const lineStart = input.lastIndexOf("\n", labelledReference.index) + 1;
    const labelContext = input.slice(lineStart, labelledReference.index);
    if (!looksLikeForbiddenReference(value, labelContext)) {
      return { value, confidence: 0.94 };
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
      return { value, confidence: 0.78 };
    }
  }

  return null;
}

async function invoiceText(file: ExtractionFileInput) {
  if (!file.text) {
    return "";
  }

  try {
    return await file.text();
  } catch {
    return "";
  }
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function profileForFile(fileName: string, seed: number) {
  if (/google|workspace|reverse|eu-acquisition|saas|subscription/i.test(fileName)) {
    return namedProfiles.google;
  }

  if (/booking|hotel|restaurant/i.test(fileName)) {
    return namedProfiles.booking;
  }

  if (/klm|flight|airline|eurostar/i.test(fileName)) {
    return namedProfiles.klm;
  }

  if (/insurance|policy/i.test(fileName)) {
    return namedProfiles.insurance;
  }

  if (/inbody|intercompany|internal/i.test(fileName)) {
    return namedProfiles.inbody;
  }

  if (/ambiguous|acme|multiple-supplier/i.test(fileName)) {
    return namedProfiles.ambiguous;
  }

  if (/non-eu|outside-eu|us-cloud|(^|[^a-z])us([^a-z]|$)/i.test(fileName)) {
    return namedProfiles.us;
  }

  return supplierProfiles[seed % supplierProfiles.length];
}

function vatRateForFile(fileName: string, profile: MockSupplierProfile) {
  if (/reverse|eu-acquisition|non-eu|outside-eu|flight|klm|hotel|booking|insurance|restaurant|zero-vat/i.test(fileName)) {
    return 0;
  }

  if (/nine|9-vat|restaurant-vat/i.test(fileName)) {
    return 0.09;
  }

  if (profile.country !== "NL") {
    return 0;
  }

  return 0.21;
}

function servicePeriodFor(fileName: string, invoiceDate: Date) {
  if (/subscription|saas|google|insurance|maintenance/i.test(fileName)) {
    return {
      start: "2026-01-15",
      end: "2026-06-30",
    };
  }

  if (/flight|hotel|booking|event/i.test(fileName)) {
    const start = addDays(invoiceDate, 55);
    const end = addDays(start, /hotel|booking/i.test(fileName) ? 2 : 0);

    return {
      start: isoDate(start),
      end: isoDate(end),
    };
  }

  return { start: "", end: "" };
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

export async function extractInvoiceData(
  file: ExtractionFileInput
): Promise<ExtractedInvoiceData> {
  const seed = stableNumber(file.name);
  const profile = profileForFile(file.name, seed);
  const forcedClosedPeriod = /closed-period|january|february/i.test(file.name);
  const invoiceDate = forcedClosedPeriod
    ? new Date(Date.UTC(2026, 0, (seed % 24) + 1))
    : new Date(Date.UTC(2026, 5 + (seed % 2), (seed % 24) + 1));
  const vatRate = vatRateForFile(file.name, profile);
  const invalidByName = /invalid|missing|check/i.test(file.name);
  const paymentMismatch = /payment-mismatch|immediate|already-paid|paid/i.test(file.name);
  const reverseCharge =
    /reverse|eu-acquisition|intra-community/i.test(file.name) ||
    profile.name === "Google Ireland Limited";
  const servicePeriod = servicePeriodFor(file.name, invoiceDate);
  const beneficiary = /david|kwon|flight|hotel|booking/i.test(file.name)
    ? "David Kwon"
    : "";
  const documentText = await invoiceText(file);
  const { netAmount, vatAmount, grossAmount } = extractInvoiceAmounts(documentText);
  const detectedReference =
    detectInvoiceReference(documentText) ?? detectInvoiceReference(file.name);
  const confidentReference =
    !invalidByName && detectedReference && detectedReference.confidence >= 0.8
      ? detectedReference
      : null;
  const invoiceNumber = confidentReference?.value ?? "";
  const referenceCode = invoiceNumber;

  return {
    supplierName: profile.name,
    supplierVatNumber: profile.vat,
    supplierChamberOfCommerceNumber: profile.chamberOfCommerceNumber,
    supplierAddress: profile.address,
    supplierCountry: profile.country,
    invoiceNumber,
    referenceCode,
    referenceCodeConfidence: confidentReference?.confidence ?? 0,
    invoiceDate: isoDate(invoiceDate),
    dueDate: invalidByName ? "" : isoDate(addDays(invoiceDate, 30)),
    paymentTerms: paymentMismatch ? "immediately" : profile.paymentTerms,
    currency: "EUR",
    netAmount,
    vatAmount,
    grossAmount,
    iban: profile.iban,
    expenseDescription: profile.expenseDescription,
    beneficiary,
    serviceStartDate: servicePeriod.start,
    serviceEndDate: servicePeriod.end,
    companyVatNumber: "NL857017263B01",
    reverseChargeMentioned: reverseCharge,
    intraCommunityMentioned: reverseCharge,
    confidence: invalidByName ? 0.72 : 0.94,
    rawText: [
      `Mock extraction for ${file.name}.`,
      reverseCharge ? "Reverse charge intra-community acquisition." : "",
      profile.country === "US" ? "0% VAT outside EU supplier." : "",
      servicePeriod.start ? `Service period ${servicePeriod.start} to ${servicePeriod.end}.` : "",
    ]
      .filter(Boolean)
      .join(" "),
    lineItems:
      netAmount !== null && vatAmount !== null && grossAmount !== null
        ? [
            {
              id: createId("line"),
              description: profile.expenseDescription,
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
