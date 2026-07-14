import type {
  ExtractedInvoiceData,
  PurchaseJournalBooking,
  ValidationError,
} from "../domain/invoice";

export const REQUIRED_BOOKING_DISABLED_REASON =
  "Complete all required fields before booking to Exact Online.";

export type RequiredBookingDataIssue = {
  field: ValidationError["field"];
  label: string;
  message: string;
};

const requiredLabels: Array<{
  field: ValidationError["field"];
  label: string;
  isFilled: (
    data: ExtractedInvoiceData,
    booking: PurchaseJournalBooking | null | undefined
  ) => boolean;
  message?: string;
}> = [
  {
    field: "supplierName",
    label: "Supplier",
    isFilled: (data) => hasText(data.supplierName),
  },
  {
    field: "expenseDescription",
    label: "Expense description",
    isFilled: (data) => hasText(data.expenseDescription),
  },
  {
    field: "referenceCode",
    label: "Your ref",
    isFilled: (data) => hasText(data.referenceCode),
    message: "Your ref. is required before booking to Exact Online.",
  },
  {
    field: "paymentTerms",
    label: "Payment condition",
    isFilled: (data) => hasText(data.paymentTerms),
  },
  {
    field: "invoiceDate",
    label: "Invoice date",
    isFilled: (data) => hasText(data.invoiceDate),
  },
  {
    field: "glAccount",
    label: "G/L Account",
    isFilled: (_data, booking) =>
      hasText(firstBookingLine(booking)?.finalSelectedAccount) ||
      hasText(firstBookingLine(booking)?.glAccount),
  },
  {
    field: "accrualFrom",
    label: "Accrual From",
    isFilled: (_data, booking) =>
      !bookingRequiresAccrual(booking) || hasText(firstBookingLine(booking)?.from),
  },
  {
    field: "accrualTo",
    label: "Accrual To",
    isFilled: (_data, booking) =>
      !bookingRequiresAccrual(booking) || hasText(firstBookingLine(booking)?.to),
  },
  {
    field: "vatCode",
    label: "VAT code",
    isFilled: (_data, booking) => hasText(firstBookingLine(booking)?.vatCode),
  },
  {
    field: "netAmount",
    label: "Net amount",
    isFilled: (data) => hasNumber(data.netAmount),
  },
  {
    field: "vatAmount",
    label: "VAT amount",
    isFilled: (data) => hasNumber(data.vatAmount),
  },
  {
    field: "grossAmount",
    label: "Total Amount",
    isFilled: (data) => hasNumber(data.grossAmount),
  },
];

function firstBookingLine(booking: PurchaseJournalBooking | null | undefined) {
  return booking?.lines[0];
}

export function bookingRequiresAccrual(
  booking: PurchaseJournalBooking | null | undefined
) {
  return hasText(firstBookingLine(booking)?.accrualReason);
}

function hasText(value: string | undefined | null) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value);
}

export function getRequiredBookingDataIssues(
  data: ExtractedInvoiceData,
  booking: PurchaseJournalBooking | null | undefined
): RequiredBookingDataIssue[] {
  return requiredLabels
    .filter((item) => !item.isFilled(data, booking))
    .map((item) => ({
      field: item.field,
      label: item.label,
      message:
        item.message ?? `${item.label} is required before booking to Exact Online.`,
    }));
}

export function requiredBookingDataValidationErrors(
  data: ExtractedInvoiceData,
  booking: PurchaseJournalBooking | null | undefined
): ValidationError[] {
  return getRequiredBookingDataIssues(data, booking).map((issue) => ({
    id: `required-${String(issue.field)}`,
    field: issue.field,
    message: issue.message,
    severity: "error",
  }));
}
