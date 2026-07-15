import {
  isIntoPurchaseVatCode,
  type ExactMasterDataCache,
  type PurchaseJournalLine,
  type ExtractedInvoiceData,
  type PurchaseJournalBooking,
  type ValidationError,
} from "../domain/invoice";
import {
  BOOKING_TOTAL_MISMATCH_MESSAGE,
  DUPLICATE_INVOICE_REFERENCE_MESSAGE,
  calculateBookingTotals,
} from "./invoice-validation";

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
      (booking?.lines ?? []).every(
        (line) => !bookingLineRequiresAccrual(line) || hasText(line.from)
      ),
  },
  {
    field: "accrualTo",
    label: "Accrual To",
    isFilled: (_data, booking) =>
      (booking?.lines ?? []).every(
        (line) => !bookingLineRequiresAccrual(line) || hasText(line.to)
      ),
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
  return (booking?.lines ?? []).some(bookingLineRequiresAccrual);
}

export function bookingLineRequiresAccrual(
  line: PurchaseJournalLine | null | undefined
) {
  return hasText(line?.accrualReason) || hasText(line?.from) || hasText(line?.to);
}

function hasText(value: string | undefined | null) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value);
}

export type BookingLineDataIssue = {
  lineIndex?: number;
  field?:
    | "glAccount"
    | "description"
    | "from"
    | "to"
    | "vatCode"
    | "amount"
    | "vatAmount";
  message: string;
};

export function getBookingLineDataIssues(
  lines: PurchaseJournalLine[]
): BookingLineDataIssue[] {
  if (!lines.length) {
    return [{ message: "At least one booking line is required." }];
  }

  return lines.flatMap((line, lineIndex) => {
    const number = lineIndex + 1;
    const issues: BookingLineDataIssue[] = [];
    const add = (field: BookingLineDataIssue["field"], message: string) =>
      issues.push({ lineIndex, field, message: `Line ${number}: ${message}` });

    if (!hasText(line.finalSelectedAccount) && !hasText(line.glAccount)) {
      add("glAccount", "G/L Account is required.");
    }
    if (!hasText(line.description)) {
      add("description", "Description is required.");
    }
    if (bookingLineRequiresAccrual(line) && !hasText(line.from)) {
      add("from", "Accrual From is required.");
    }
    if (bookingLineRequiresAccrual(line) && !hasText(line.to)) {
      add("to", "Accrual To is required.");
    }
    if (!hasText(line.vatCode)) {
      add("vatCode", "VAT code is required.");
    } else if (!isIntoPurchaseVatCode(line.vatCode)) {
      add(
        "vatCode",
        `Unsupported VAT code ${line.vatCode}. Only codes 4, 5, 6, 7, and 8 are allowed.`
      );
    }
    if (!hasNumber(line.amount)) {
      add("amount", "Net amount is required.");
    }
    if (!hasNumber(line.vatAmount)) {
      add("vatAmount", "VAT amount is required.");
    }

    return issues;
  });
}

export type BookingBlocker = {
  field: ValidationError["field"];
  message: string;
};

function bookingLineValidationField(
  field: BookingLineDataIssue["field"]
): ValidationError["field"] {
  if (field === "glAccount") return "glAccount";
  if (field === "from") return "accrualFrom";
  if (field === "to") return "accrualTo";
  if (field === "vatCode") return "vatCode";
  return "purchaseJournal";
}

export function getBookingBlockers(
  data: ExtractedInvoiceData,
  booking: PurchaseJournalBooking | null | undefined,
  exactMasterData: ExactMasterDataCache | null = null
): BookingBlocker[] {
  const blockers: BookingBlocker[] = getRequiredBookingDataIssues(
    data,
    booking
  ).map(({ field, message }) => ({ field, message }));

  if (!booking) {
    blockers.push({
      field: "purchaseJournal",
      message: "Purchase Journal booking data is missing.",
    });
    return blockers;
  }

  const bookingLineBlockers = getBookingLineDataIssues(booking.lines).map(
    (issue) => ({
      field: bookingLineValidationField(issue.field),
      message: issue.message,
    })
  );
  blockers.unshift(...bookingLineBlockers);

  const supplierResolution = booking.supplierResolution;
  if (supplierResolution.reviewRequired) {
    blockers.push({
      field: "supplier",
      message:
        supplierResolution.candidates.length > 1
          ? "Multiple supplier matches found. Please choose the correct supplier."
          : "Supplier could not be confidently matched. Please select the correct supplier.",
    });
  } else if (
    !supplierResolution.selectedAccountId ||
    (exactMasterData &&
      !exactMasterData.suppliers.some(
        (supplier) => supplier.id === supplierResolution.selectedAccountId
      ))
  ) {
    blockers.push({
      field: "supplier",
      message: "Supplier must be matched to Exact Online master data before booking.",
    });
  }

  if (!hasText(booking.yourRef)) {
    blockers.push({
      field: "yourRef",
      message: "Your ref. is required before booking to Exact Online.",
    });
  } else if (!booking.yourRefUnique) {
    blockers.push({
      field: "yourRef",
      message: DUPLICATE_INVOICE_REFERENCE_MESSAGE,
    });
  }

  if (!hasText(booking.paymentConditionCode)) {
    blockers.push({
      field: "paymentCondition",
      message: "Payment condition is required before booking to Exact Online.",
    });
  } else if (
    exactMasterData &&
    !exactMasterData.paymentConditions.some(
      (condition) =>
        condition.code === booking.paymentConditionCode && condition.isActive
    )
  ) {
    blockers.push({
      field: "paymentCondition",
      message: `Payment condition ${booking.paymentConditionCode} is not available in Exact master data.`,
    });
  }

  if (
    typeof data.grossAmount === "number" &&
    Number.isFinite(data.grossAmount) &&
    calculateBookingTotals(booking.lines, data.grossAmount).difference !== 0
  ) {
    blockers.push({
      field: "grossAmount",
      message: BOOKING_TOTAL_MISMATCH_MESSAGE,
    });
  }

  return blockers.filter(
    (blocker, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.field === blocker.field &&
          candidate.message === blocker.message
      ) === index
  );
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
