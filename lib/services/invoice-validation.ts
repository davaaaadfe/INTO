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

  const normalized = String(value).trim().replace(",", ".");
  if (!/^-?\d+(\.\d{1,2})?$/.test(normalized)) {
    return null;
  }

  const [whole, fractional = ""] = normalized.split(".");
  const sign = whole.startsWith("-") ? -1 : 1;
  const absoluteWhole = whole.replace("-", "");
  const cents = fractional.padEnd(2, "0");
  return sign * (Number(absoluteWhole) * 100 + Number(cents));
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
        "Net amount plus VAT amount must equal gross amount exactly."
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
