import type { ExtractedInvoiceData } from "../domain/invoice";
import { createId } from "../utils/id";

export type ExtractionFileInput = {
  name: string;
  type: string;
  size: number;
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

function invoiceNumberFromFile(fileName: string) {
  const baseName = fileName.replace(/\.[^.]+$/, "").replace(/[^a-z0-9]+/gi, "-");
  return `INV-${baseName.slice(0, 14).toUpperCase() || "UPLOAD"}`;
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
  "numero\\s*de\\s*facture",
  "n\\s*facture",
  "reference",
  "numero\\s*de\\s*factura",
  "n\\s*factura",
  "referencia",
  "numero\\s*fattura",
  "n\\s*fattura",
  "riferimento",
].join("|");

const invoiceReferenceValuePattern =
  "([a-z]{1,8}[-_/ ]?\\d[a-z0-9._/-]{1,24}|\\d{4}[-_/]\\d{2,8}|\\d{5,})";

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
    .replace(/[.,;:\s]+$/, "")
    .replace(/\s+/g, "-")
    .toUpperCase();
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

  return /\b(vat|btw|iban|supplier|customer|debtor|creditor|order|po)\b/.test(
    normalizedContext
  );
}

export function detectInvoiceReference(
  input: string
): InvoiceReferenceDetection | null {
  const normalized = normalizeInvoiceReferenceText(input);
  const labelledReference = new RegExp(
    `(?:${invoiceReferenceLabelPattern})\\s*(?:nr\\.?|no\\.?)?\\s*[:#.-]?\\s*${invoiceReferenceValuePattern}`,
    "i"
  ).exec(normalized);

  if (labelledReference?.[1]) {
    const value = cleanInvoiceReferenceValue(labelledReference[1]);
    if (!looksLikeForbiddenReference(value)) {
      return { value, confidence: 0.94 };
    }
  }

  const generalReference = /\b(?:inv|fac|rf)[-_/ ]?\d[a-z0-9._/-]{2,24}\b|\b20\d{2}[-_/]\d{3,8}\b/i.exec(
    normalized
  );
  if (generalReference?.[0]) {
    const start = Math.max(0, generalReference.index - 24);
    const end = Math.min(normalized.length, generalReference.index + generalReference[0].length + 24);
    const context = normalized.slice(start, end);
    const value = cleanInvoiceReferenceValue(generalReference[0]);
    if (!looksLikeForbiddenReference(value, context)) {
      return { value, confidence: 0.78 };
    }
  }

  return null;
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

export async function extractInvoiceData(
  file: ExtractionFileInput
): Promise<ExtractedInvoiceData> {
  const seed = stableNumber(file.name);
  const profile = profileForFile(file.name, seed);
  const forcedClosedPeriod = /closed-period|january|february/i.test(file.name);
  const invoiceDate = forcedClosedPeriod
    ? new Date(Date.UTC(2026, 0, (seed % 24) + 1))
    : new Date(Date.UTC(2026, 5 + (seed % 2), (seed % 24) + 1));
  const netAmount = 100 + (seed % 840);
  const vatRate = vatRateForFile(file.name, profile);
  const vatAmount = Number((netAmount * vatRate).toFixed(2));
  const grossAmount = Number((netAmount + vatAmount).toFixed(2));
  const invalidByName = /invalid|missing|check/i.test(file.name);
  const mismatchByName = /mismatch|round/i.test(file.name);
  const paymentMismatch = /payment-mismatch|immediate|already-paid|paid/i.test(file.name);
  const reverseCharge =
    /reverse|eu-acquisition|intra-community/i.test(file.name) ||
    profile.name === "Google Ireland Limited";
  const servicePeriod = servicePeriodFor(file.name, invoiceDate);
  const beneficiary = /david|kwon|flight|hotel|booking/i.test(file.name)
    ? "David Kwon"
    : "";
  const detectedReference = detectInvoiceReference(file.name);
  const invoiceNumber = detectedReference?.value ?? invoiceNumberFromFile(file.name);
  const referenceCode = invalidByName ? "" : invoiceNumber;

  return {
    supplierName: profile.name,
    supplierVatNumber: profile.vat,
    supplierChamberOfCommerceNumber: profile.chamberOfCommerceNumber,
    supplierAddress: profile.address,
    supplierCountry: profile.country,
    invoiceNumber,
    referenceCode,
    referenceCodeConfidence: invalidByName ? 0 : (detectedReference?.confidence ?? 0.82),
    invoiceDate: isoDate(invoiceDate),
    dueDate: invalidByName ? "" : isoDate(addDays(invoiceDate, 30)),
    paymentTerms: paymentMismatch ? "immediately" : profile.paymentTerms,
    currency: "EUR",
    netAmount,
    vatAmount,
    grossAmount: mismatchByName ? grossAmount + 0.01 : grossAmount,
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
    lineItems: [
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
    ],
  };
}
