import type {
  DuplicateCandidate,
  ExtractedInvoiceData,
  ValidationError,
} from "../domain/invoice";
import { createId } from "../utils/id";

type AmountValue = number | string | null | undefined;

const currencyPattern = /^[A-Z]{3}$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

export const DUPLICATE_INVOICE_REFERENCE_MESSAGE =
  "This invoice reference already exists for this supplier. Duplicate invoices cannot be booked.";
export const BOOKING_TOTAL_MISMATCH_MESSAGE =
  "Booking total does not match the invoice total. Difference must be 0.00 before booking to Exact Online.";

function error(
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

export function normalizeText(value: string | null | undefined) {
  return (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

export function isValidIsoDate(value: string | null | undefined) {
  if (!value || !datePattern.test(value)) {
    return false;
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    return false;
  }

  return parsed.toISOString().slice(0, 10) === value;
}

export function amountToMinorUnits(value: AmountValue) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const cleaned = String(value)
    .trim()
    .replace(/\u00a0/g, " ")
    .replace(/\b(?:EUR|USD|GBP|CHF|AUD|CAD|PLN|SEK|NOK|DKK|CZK|HUF|RON|BGN)\b/gi, "")
    .replace(/[€$£¥]/g, "")
    .replace(/[\s']/g, "");
  const negative = cleaned.startsWith("-");
  const unsigned = negative ? cleaned.slice(1) : cleaned;

  if (!/^\d+(?:[.,]\d+)*$/.test(unsigned)) {
    return null;
  }

  const lastComma = unsigned.lastIndexOf(",");
  const lastDot = unsigned.lastIndexOf(".");
  const decimalSeparator =
    lastComma >= 0 && lastDot >= 0
      ? lastComma > lastDot
        ? ","
        : "."
      : lastComma >= 0
        ? ","
        : lastDot >= 0
          ? "."
          : "";
  const separatorIndex = decimalSeparator
    ? unsigned.lastIndexOf(decimalSeparator)
    : -1;
  const fractional = separatorIndex >= 0 ? unsigned.slice(separatorIndex + 1) : "";

  if (fractional.length > 2) {
    return null;
  }

  const whole = (separatorIndex >= 0 ? unsigned.slice(0, separatorIndex) : unsigned)
    .replace(/[.,]/g, "");
  if (!whole || !/^\d+$/.test(whole) || (fractional && !/^\d{1,2}$/.test(fractional))) {
    return null;
  }

  const sign = negative ? -1 : 1;
  const cents = fractional.padEnd(2, "0");
  return sign * (Number(whole) * 100 + Number(cents));
}

export function calculateBookingTotals(
  lines: Array<{ amount: number; vatAmount: number }>,
  invoiceTotal: number | null | undefined
) {
  const lineAmountCents = lines.reduce(
    (sum, line) => sum + (amountToMinorUnits(line.amount) ?? 0),
    0
  );
  const vatAmountCents = lines.reduce(
    (sum, line) => sum + (amountToMinorUnits(line.vatAmount) ?? 0),
    0
  );
  const grossAmountCents = lineAmountCents + vatAmountCents;
  const invoiceTotalCents = amountToMinorUnits(invoiceTotal) ?? 0;

  return {
    lineAmount: lineAmountCents / 100,
    vatAmount: vatAmountCents / 100,
    grossAmount: grossAmountCents / 100,
    invoiceTotal: invoiceTotalCents / 100,
    difference: (invoiceTotalCents - grossAmountCents) / 100,
  };
}

function validateRequiredString(
  data: ExtractedInvoiceData,
  field: keyof ExtractedInvoiceData,
  label: string,
  errors: ValidationError[],
  message = `${label} is required.`
) {
  const value = data[field];
  if (typeof value !== "string" || !value.trim()) {
    errors.push(error(field, message));
  }
}

function validateAmount(
  data: ExtractedInvoiceData,
  field: "netAmount" | "vatAmount" | "grossAmount",
  label: string,
  errors: ValidationError[]
) {
  const amount = amountToMinorUnits(data[field]);

  if (amount === null) {
    errors.push(
      error(field, `${label} must be a valid amount with up to two decimals.`)
    );
    return null;
  }

  if (amount < 0) {
    errors.push(error(field, `${label} cannot be negative.`));
  }

  return amount;
}

export function validateInvoiceData(
  invoiceId: string,
  data: ExtractedInvoiceData,
  duplicateCandidates: DuplicateCandidate[]
) {
  const errors: ValidationError[] = [];

  validateRequiredString(data, "supplierName", "Supplier name", errors);
  validateRequiredString(data, "invoiceDate", "Invoice date", errors);
  validateRequiredString(
    data,
    "referenceCode",
    "Your ref.",
    errors,
    "Your ref. is required before booking to Exact Online."
  );

  if (data.invoiceDate && !isValidIsoDate(data.invoiceDate)) {
    errors.push(
      error("invoiceDate", "Invoice date must be a valid YYYY-MM-DD date.")
    );
  }

  if (data.dueDate && !isValidIsoDate(data.dueDate)) {
    errors.push(error("dueDate", "Due date must be a valid YYYY-MM-DD date."));
  }

  if (data.currency && !currencyPattern.test(data.currency.trim())) {
    errors.push(error("currency", "Currency must be a three-letter ISO code."));
  }

  if (
    data.referenceCode &&
    typeof data.referenceCodeConfidence === "number" &&
    data.referenceCodeConfidence > 0 &&
    data.referenceCodeConfidence < 0.8
  ) {
    errors.push(
      error(
        "referenceCode",
        "Invoice reference could not be confidently detected. Please confirm Your ref.",
        "warning"
      )
    );
  }

  const netAmount = validateAmount(data, "netAmount", "Net amount", errors);
  const vatAmount = validateAmount(data, "vatAmount", "VAT amount", errors);
  const grossAmount = validateAmount(data, "grossAmount", "Gross amount", errors);

  if (
    netAmount !== null &&
    vatAmount !== null &&
    grossAmount !== null &&
    netAmount + vatAmount !== grossAmount
  ) {
    errors.push(
      error(
        "grossAmount",
        BOOKING_TOTAL_MISMATCH_MESSAGE
      )
    );
  }

  const supplier = normalizeText(data.supplierName);
  const invoiceReference = normalizeText(data.referenceCode || data.invoiceNumber);
  if (supplier && invoiceReference) {
    const duplicate = duplicateCandidates.find(
      (candidate) =>
        candidate.id !== invoiceId &&
        normalizeText(candidate.supplierName) === supplier &&
        normalizeText(candidate.referenceCode || candidate.invoiceNumber) ===
          invoiceReference
    );

    if (duplicate) {
      errors.push(
        error(
          "referenceCode",
          DUPLICATE_INVOICE_REFERENCE_MESSAGE
        )
      );
    }
  }

  return errors;
}

export function statusFromValidation(errorCount: number) {
  return errorCount > 0 ? "Validation Failed" : "Ready to Book";
}
