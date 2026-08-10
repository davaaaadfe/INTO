"use client";

import {
  ChangeEvent,
  DragEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PDFDocumentLoadingTask, RenderTask } from "pdfjs-dist";
import {
  INTO_PURCHASE_VAT_CODE_LABELS,
  SHARED_ACCESS_PERMISSIONS,
  UNSUPPORTED_VAT_CODE_WARNING,
  intoPurchaseVatCodeOrFallback,
  isIntoPurchaseVatCode,
} from "../lib/domain/invoice";
import type {
  AuditEvent,
  DuplicateDetectionResult,
  ExactMasterDataCache,
  ExtractedInvoiceData,
  InvoiceArchiveResult,
  LearnableCorrectionField,
  PermissionAction,
  PurchaseJournalLine,
  PublicExactConnection,
  SupplierLearningProfile,
  SupplierLearningSummary,
  SupplierOverviewImportStatus,
  UploadedInvoice,
  ValidationError,
} from "../lib/domain/invoice";
import {
  REQUIRED_BOOKING_DISABLED_REASON,
  bookingLineRequiresAccrual,
  getBookingBlockers,
  getRequiredBookingDataIssues,
} from "../lib/services/required-booking-data";
import {
  BOOKING_TOTAL_MISMATCH_MESSAGE,
  calculateBookingTotals,
} from "../lib/services/invoice-validation";
import {
  movePreviewPan,
  previewScrollAfterZoom,
  resetPreviewPan,
  type PreviewPan,
  zoomFromWheel,
} from "../lib/services/preview-pan";
import { readApiJson } from "../lib/utils/api-response";
import { IntoUsersPanel } from "./into-users-panel";

type ApiState = {
  permissions: PermissionAction[];
  invoices: UploadedInvoice[];
  exactConnection: PublicExactConnection | null;
  exactMasterData: ExactMasterDataCache | null;
  exactMasterDataStale: boolean;
  exactMasterDataReadOnly: boolean;
  supplierOverviewImport: SupplierOverviewImportStatus | null;
  supplierLearning: SupplierLearningSummary[];
  supplierLearningLoaded: boolean;
  supplierLearningEnabled: boolean;
  exactConfiguration: {
    ready: boolean;
    missingEnv: string[];
    clientIdLooksLikeEmail: boolean;
    redirectUri: string;
    mode: "real" | "mock";
  } | null;
};

type UploadItemStatus =
  | "checking"
  | "ready"
  | "uploading"
  | "reading"
  | "duplicate"
  | "success"
  | "error";

type UploadItem = {
  id: string;
  fileName: string;
  fileSize: number;
  checksum?: string;
  progress: number;
  status: UploadItemStatus;
  message: string;
};

type ButtonFeedback = "success" | "error";
type PreviewFileStatus = "checking" | "available" | "missing";
type ResolvedPreviewFileStatus = Exclude<PreviewFileStatus, "checking">;
type ActiveView = "queue" | "archive" | "supplier-learning" | "users";
type SafeActor = { id: string; email: string; displayName: string; status: string; version: number };
type PreviewInteractionMode = "pan" | "select_text";
type FieldTone = "neutral" | "warning" | "error";

type SelectOption = {
  value: string;
  label?: string;
};

type FieldIssue = {
  tone: FieldTone;
  message?: string;
};

type ReviewActionDefinition = {
  key: string;
  label: string;
  variant: "primary" | "secondary" | "outline" | "danger" | "ghost";
  onClick: () => void;
  loading: boolean;
  disabled: boolean;
  disabledReason: string;
  feedback?: ButtonFeedback;
};

type BookingLineDraft = PurchaseJournalLine & {
  amountInput: string;
  vatAmountInput: string;
};

type BookingLineIssue = {
  id: string;
  lineIndex?: number;
  field?: "glAccount" | "description" | "from" | "to" | "vatCode" | "amount" | "vatAmount";
  message: string;
};

type ArchiveFilterState = {
  keyword: string;
  invoiceDateFrom: string;
  invoiceDateTo: string;
  uploadedAtFrom: string;
  uploadedAtTo: string;
  supplier: string;
  amountMin: string;
  amountMax: string;
  currency: string;
  invoiceNumber: string;
  bookingStatus: string;
  validationStatus: string;
  source: string;
  exactBookingReference: string;
  journal: string;
  glAccount: string;
  vatCode: string;
  costCenter: string;
  costUnit: string;
  country: string;
  duplicateStatus: string;
  sortBy: string;
  sortDirection: "asc" | "desc";
  page: number;
  pageSize: number;
};


const missingInvoiceFileMessage =
  "Original invoice file could not be found. Please re-upload or re-read this invoice.";
const learnedCorrectionNote = "Applied from previous user correction.";
const exactHistorySuggestionNote = "Suggested from previous Exact bookings.";
const resetLearningConfirmation = "Reset learning for this supplier? INTO will forget previous training patterns for this supplier. Existing invoices and Exact bookings will not be deleted.";

function workspaceLoadErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("Supplier learning storage is not configured")) {
    return "INTO data is temporarily unavailable. Ask the system owner to check the server configuration and redeploy.";
  }
  return message || "Unable to load the INTO workspace.";
}

function supplierReliabilityCopy(band: SupplierLearningSummary["confidence"]["band"]) {
  if (band === "High") {
    return "INTO usually reads this supplier correctly.";
  }
  if (band === "Medium") {
    return "Review recommended.";
  }
  return "More training invoices needed.";
}

function SupplierReliabilityBadge({
  summary,
}: {
  summary: Pick<SupplierLearningSummary, "confidence">;
}) {
  const tone =
    summary.confidence.band === "High"
      ? "border-emerald-200 bg-emerald-50 text-emerald-900"
      : summary.confidence.band === "Medium"
        ? "border-amber-200 bg-amber-50 text-amber-900"
        : "border-stone-300 bg-stone-50 text-stone-700";

  return (
    <span
      className={`inline-flex flex-col rounded-md border px-2 py-1 text-xs ${tone}`}
      title={supplierReliabilityCopy(summary.confidence.band)}
    >
      <span className="font-semibold">
        Supplier reliability {summary.confidence.score}% · {summary.confidence.band}
      </span>
      <span>{supplierReliabilityCopy(summary.confidence.band)}</span>
    </span>
  );
}

function uniqueValidationMessages<T extends { message: string }>(items: T[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.message.trim().toLowerCase();
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function invoiceFileCanBeRequested(invoice: UploadedInvoice) {
  return Boolean(
    invoice.storageKey &&
      invoice.localFileStatus !== "deleted_after_booking" &&
      invoice.localFileStatus !== "deleted_by_cleanup" &&
      invoice.localFileStatus !== "missing"
  );
}

const defaultPreviewZoom = 1;

type DuplicateUploadPrompt = {
  fileName: string;
  fileSize: number;
  checksum?: string;
  reason: string;
  duplicateInvoiceId: string;
  exactBookingId?: string;
  detection: DuplicateDetectionResult;
};

const acceptedExtensions = new Set(["pdf", "jpg", "jpeg", "png", "xml", "ubl"]);
const acceptedLabel = "PDF, JPG, PNG, XML, UBL";

const defaultArchiveFilters: ArchiveFilterState = {
  keyword: "",
  invoiceDateFrom: "",
  invoiceDateTo: "",
  uploadedAtFrom: "",
  uploadedAtTo: "",
  supplier: "",
  amountMin: "",
  amountMax: "",
  currency: "",
  invoiceNumber: "",
  bookingStatus: "",
  validationStatus: "",
  source: "",
  exactBookingReference: "",
  journal: "",
  glAccount: "",
  vatCode: "",
  costCenter: "",
  costUnit: "",
  country: "",
  duplicateStatus: "",
  sortBy: "uploadedAt",
  sortDirection: "desc",
  page: 1,
  pageSize: 10,
};

const statusTone: Record<string, string> = {
  Uploaded: "border-stone-300 bg-stone-100 text-stone-700",
  Reading: "border-sky-200 bg-sky-50 text-sky-800",
  "Validation Failed": "border-amber-300 bg-amber-50 text-amber-900",
  "Attachment Missing": "border-rose-300 bg-rose-50 text-rose-800",
  "Payment Condition Review Required":
    "border-yellow-300 bg-yellow-50 text-yellow-900",
  "Booking Intelligence Review Required":
    "border-violet-300 bg-violet-50 text-violet-900",
  "Possible Duplicate": "border-fuchsia-300 bg-fuchsia-50 text-fuchsia-900",
  "Ready to Book": "border-emerald-300 bg-emerald-50 text-emerald-800",
  Learned: "border-sky-300 bg-sky-50 text-sky-800",
  Booked: "border-teal-300 bg-teal-50 text-teal-800",
  "Booking Failed": "border-rose-300 bg-rose-50 text-rose-800",
};


const reviewStatuses = new Set<UploadedInvoice["status"]>([
  "Validation Failed",
  "Attachment Missing",
  "Payment Condition Review Required",
  "Booking Intelligence Review Required",
  "Possible Duplicate",
  "Booking Failed",
]);

const fieldLabels: Partial<Record<keyof ExtractedInvoiceData, string>> = {
  supplierName: "Supplier",
  supplierVatNumber: "Supplier VAT number",
  supplierCountry: "Supplier country",
  invoiceNumber: "Invoice number",
  referenceCode: "Your ref.",
  invoiceDate: "Invoice date",
  dueDate: "Due date",
  paymentTerms: "Payment terms",
  currency: "Currency",
  netAmount: "Net amount",
  vatAmount: "VAT amount",
  grossAmount: "Total amount",
  expenseDescription: "Expense description",
};

const additionalDataFields: (keyof ExtractedInvoiceData)[] = [
  "dueDate",
  "invoiceNumber",
  "currency",
  "supplierCountry",
  "supplierVatNumber",
];

const confidenceLabels: Record<string, string> = {
  supplierMatch: "Supplier",
  glAccount: "G/L account",
  vatCode: "VAT code",
  costCentre: "Cost center",
  costUnit: "Cost unit",
  paymentCondition: "Payment",
  overall: "Overall",
};

function displayStatus(status: UploadedInvoice["status"]) {
  if (status === "Validation Failed") {
    return "Need check";
  }

  if (status === "Booking Intelligence Review Required") {
    return "Intelligence review";
  }

  if (status === "Possible Duplicate") {
    return "Possible duplicate";
  }

  return status;
}

function formatMoney(amount: number | null | undefined, currency = "EUR") {
  if (typeof amount !== "number") {
    return "-";
  }

  return new Intl.NumberFormat("en-NL", {
    style: "currency",
    currency,
  }).format(amount);
}

function money(invoice: UploadedInvoice) {
  return formatMoney(
    invoice.extractedData.grossAmount,
    invoice.extractedData.currency || "EUR"
  );
}

function formatFileSize(size: number) {
  if (size < 1024) {
    return `${size} B`;
  }

  if (size < 1024 * 1024) {
    return `${Math.round(size / 1024)} KB`;
  }

  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function formatTimestamp(value: string | undefined) {
  if (!value) {
    return "Not synced";
  }

  return new Intl.DateTimeFormat("en-NL", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function numberValue(value: number | null) {
  return typeof value === "number" ? String(value) : "";
}

function auditMessageWithoutActor(event: AuditEvent) {
  const actorPrefix = `${event.userName} `;
  const message = event.message.startsWith(actorPrefix)
    ? event.message.slice(actorPrefix.length)
    : event.message;

  return message ? `${message[0].toUpperCase()}${message.slice(1)}` : message;
}

function moneyValue(value: number) {
  return Number.isFinite(value) ? String(value) : "";
}

function moneyInputValue(value: string | undefined, fallback: number) {
  return value ?? moneyValue(fallback);
}

function amountFromInput(value: string | undefined) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return null;
  }

  const amount = Number(trimmed);
  return Number.isFinite(amount) ? amount : null;
}

function percentScore(value: number) {
  return `${Math.round(value * 100)}%`;
}

function confidenceTone(value: number, threshold: number) {
  return value >= threshold
    ? "border-emerald-200 bg-emerald-50 text-emerald-900"
    : "border-amber-200 bg-amber-50 text-amber-900";
}

function fileExtension(fileName: string) {
  return fileName.split(".").pop()?.toLowerCase() ?? "";
}

function splitExactOption(value: string) {
  const [code = "", ...nameParts] = value.split(" - ");
  return {
    code: code.trim(),
    name: nameParts.join(" - ").trim(),
  };
}

function bookingLineGlValue(line: BookingLineDraft) {
  return [line.glAccount, line.glAccountName].filter(Boolean).join(" - ");
}

function bookingLineVatValue(line: BookingLineDraft) {
  return [line.vatCode, line.vatCodeName].filter(Boolean).join(" - ");
}

function normalizedVatFields(line?: PurchaseJournalLine | null) {
  const unsupported = Boolean(line?.vatCode) && !isIntoPurchaseVatCode(line?.vatCode);
  const vatCode = intoPurchaseVatCodeOrFallback(line?.vatCode);

  return {
    vatCode,
    vatCodeName:
      unsupported || !line?.vatCodeName
        ? INTO_PURCHASE_VAT_CODE_LABELS[vatCode]
        : line.vatCodeName,
    vatConfidence: unsupported ? 0 : (line?.vatConfidence ?? 0),
    vatReasoning: [
      ...(line?.vatReasoning ?? []),
      ...(unsupported ? [UNSUPPORTED_VAT_CODE_WARNING] : []),
    ],
    reviewRequired: unsupported || (line?.reviewRequired ?? true),
  };
}

function toBookingLineDraft(line: PurchaseJournalLine): BookingLineDraft {
  return {
    ...line,
    ...normalizedVatFields(line),
    amountInput: moneyValue(line.amount),
    vatAmountInput: moneyValue(line.vatAmount),
  };
}

function toBookingLinePayload(line: BookingLineDraft): PurchaseJournalLine {
  const { amountInput, vatAmountInput, ...payload } = line;
  return {
    ...payload,
    amount: amountFromInput(amountInput) ?? 0,
    vatAmount: amountFromInput(vatAmountInput) ?? 0,
  };
}

function fallbackBookingLineDraft(
  data: ExtractedInvoiceData,
  seed?: PurchaseJournalLine | null
): BookingLineDraft {
  const amount = data.netAmount ?? data.grossAmount ?? 0;
  const vatAmount = data.vatAmount ?? 0;
  const vatFields = normalizedVatFields(seed);

  return {
    id: `ui_line_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    glAccount: seed?.glAccount ?? "",
    glAccountName: seed?.glAccountName ?? "",
    suggestedGlAccount: seed?.suggestedGlAccount ?? "",
    finalSelectedAccount: seed?.finalSelectedAccount ?? seed?.glAccount ?? "",
    glConfidence: seed?.glConfidence ?? 0,
    description: data.expenseDescription || data.lineItems[0]?.description || "",
    from: seed?.from ?? "",
    to: seed?.to ?? "",
    costCentre: seed?.costCentre ?? "",
    costCentreConfidence: seed?.costCentreConfidence ?? 0,
    costUnit: seed?.costUnit ?? "",
    costUnitConfidence: seed?.costUnitConfidence ?? 0,
    ...vatFields,
    percentage: seed?.percentage ?? 0,
    amount,
    vatAmount,
    amountInput: moneyValue(amount),
    vatAmountInput: moneyValue(vatAmount),
    country: seed?.country ?? data.supplierCountry,
    intercompany: seed?.intercompany ?? "",
    roundingAdjustment: 0,
    reviewRequired: vatFields.reviewRequired,
    reasoning: seed?.reasoning ?? [],
  };
}

function blankBookingLineDraft(seed?: BookingLineDraft): BookingLineDraft {
  const vatFields = normalizedVatFields(seed);

  return {
    id: `ui_line_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    glAccount: "",
    glAccountName: "",
    suggestedGlAccount: "",
    finalSelectedAccount: "",
    glConfidence: 0,
    description: "",
    from: seed?.from ?? "",
    to: seed?.to ?? "",
    costCentre: seed?.costCentre ?? "",
    costCentreConfidence: seed?.costCentreConfidence ?? 0,
    costUnit: seed?.costUnit ?? "",
    costUnitConfidence: seed?.costUnitConfidence ?? 0,
    ...vatFields,
    percentage: seed?.percentage ?? 0,
    amount: 0,
    vatAmount: 0,
    amountInput: "",
    vatAmountInput: "0",
    country: seed?.country ?? "",
    intercompany: seed?.intercompany ?? "",
    roundingAdjustment: 0,
    reviewRequired: vatFields.reviewRequired,
    reasoning: seed?.reasoning ?? [],
  };
}

function isAcceptedFile(file: File) {
  return acceptedExtensions.has(fileExtension(file.name));
}

async function checksumFile(file: File) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function uploadWithProgress(
  formData: FormData,
  onProgress: (progress: number) => void
) {
  return new Promise<{
    invoices: UploadedInvoice[];
    processed?: Array<UploadedInvoice | null>;
    rejected?: Array<{ fileName: string; checksum?: string; reason: string }>;
    duplicates?: DuplicateUploadPrompt[];
  }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/invoices");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(event.loaded / event.total);
      }
    };
    xhr.onload = () => {
      const data = JSON.parse(xhr.responseText || "{}");
      if (xhr.status >= 400) {
        reject(new Error(data.error ?? "Upload failed."));
        return;
      }

      resolve(data);
    };
    xhr.onerror = () => reject(new Error("Upload failed."));
    xhr.send(formData);
  });
}

function ActionButton({
  children,
  onClick,
  type = "button",
  variant = "primary",
  disabled = false,
  disabledReason = "",
  loading = false,
  feedback,
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  variant?: "primary" | "secondary" | "outline" | "danger" | "ghost";
  disabled?: boolean;
  disabledReason?: string;
  loading?: boolean;
  feedback?: ButtonFeedback;
  className?: string;
}) {
  const blocked = disabled || loading;
  const visualState = loading
    ? "loading"
    : feedback ?? (disabled ? "disabled" : "enabled");
  const base =
    "inline-flex min-h-11 items-center justify-center gap-2 rounded-md px-4 py-2.5 text-center text-sm font-semibold leading-snug shadow-sm transition disabled:cursor-not-allowed disabled:opacity-90";
  const pointer = blocked ? "cursor-not-allowed" : "cursor-pointer";
  const variants: Record<string, string> = {
    primary: "bg-[#12674f] text-white hover:bg-[#0d503d]",
    secondary: "bg-[#27343a] text-white hover:bg-[#1b2529]",
    outline:
      "border border-emerald-700 bg-white text-emerald-800 hover:bg-emerald-50",
    danger: "border border-rose-700 bg-white text-rose-800 hover:bg-rose-50",
    ghost: "border border-stone-300 bg-white text-stone-700 hover:bg-stone-50",
  };
  const stateClasses: Record<string, string> = {
    enabled: variants[variant],
    disabled: "border border-stone-300 bg-stone-100 text-stone-600",
    loading: "bg-stone-700 text-white",
    success: "border border-emerald-500 bg-emerald-100 text-emerald-900",
    error: "border border-rose-400 bg-rose-50 text-rose-800",
  };

  return (
    <span className="inline-flex flex-col" title={blocked ? disabledReason : ""}>
      <button
        type={type}
        onClick={onClick}
        disabled={blocked}
        aria-disabled={blocked}
        aria-busy={loading}
        className={`${base} ${pointer} ${stateClasses[visualState]} ${className}`}
      >
        {loading ? (
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
        ) : null}
        {children}
      </button>
    </span>
  );
}

function ReviewActionBar({ actions }: { actions: ReviewActionDefinition[] }) {
  const firstHelpfulReason =
    actions.find(
      (action) =>
        action.disabled &&
        action.disabledReason &&
        action.label !== "Save changes"
    )?.disabledReason ??
    actions.find((action) => action.disabled && action.disabledReason)
      ?.disabledReason;

  return (
    <div className="mt-4 rounded-xl border border-stone-200 bg-white p-3 shadow-sm">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 2xl:grid-cols-3">
        {actions.map((action) => (
          <ActionButton
            key={action.key}
            variant={action.variant}
            onClick={action.onClick}
            loading={action.loading}
            feedback={action.feedback}
            disabled={action.disabled}
            disabledReason={action.disabledReason}
            className="w-full min-w-0 whitespace-normal break-words px-3"
          >
            {action.label}
          </ActionButton>
        ))}
      </div>
      {firstHelpfulReason ? (
        <p className="mt-3 rounded-md bg-stone-50 px-3 py-2 text-xs leading-5 text-stone-600">
          {firstHelpfulReason}
        </p>
      ) : null}
    </div>
  );
}

function ValidationMessage({ issue }: { issue?: FieldIssue }) {
  if (!issue?.message) {
    return null;
  }

  const tone =
    issue.tone === "error"
      ? "text-rose-700"
      : issue.tone === "warning"
        ? "text-amber-700"
        : "text-stone-500";

  return <p className={`text-xs leading-5 ${tone}`}>{issue.message}</p>;
}

function ConfidenceBadge({
  value,
  threshold,
}: {
  value?: number;
  threshold?: number;
}) {
  if (typeof value !== "number") {
    return null;
  }

  const isLow = typeof threshold === "number" && value < threshold;
  return (
    <span
      className={`inline-flex w-fit rounded-md border px-2 py-0.5 text-xs font-semibold ${
        isLow
          ? "border-amber-300 bg-amber-50 text-amber-800"
          : "border-emerald-300 bg-emerald-50 text-emerald-800"
      }`}
    >
      {percentScore(value)}
    </span>
  );
}

function ReviewSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-stone-200 bg-white p-3 shadow-sm">
      <h3 className="text-sm font-semibold text-stone-950">{title}</h3>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">{children}</div>
    </section>
  );
}

function ReviewField({
  label,
  children,
  issue,
  helper,
  confidence,
  threshold,
  emphasized = false,
  required = false,
}: {
  label: string;
  children: ReactNode;
  issue?: FieldIssue;
  helper?: string;
  confidence?: number;
  threshold?: number;
  emphasized?: boolean;
  required?: boolean;
}) {
  const borderTone =
    issue?.tone === "error"
      ? "border-rose-400"
      : issue?.tone === "warning"
        ? "border-amber-400"
        : emphasized
          ? "border-emerald-500"
          : "border-stone-300";

  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-stone-700">
          {label}
          {required ? (
            <>
              <span className="ml-1 text-rose-600" aria-hidden="true">
                *
              </span>
              <span className="sr-only"> required</span>
            </>
          ) : null}
        </span>
        <ConfidenceBadge value={confidence} threshold={threshold} />
      </div>
      <div
        className={`rounded-lg border bg-white shadow-sm transition focus-within:border-emerald-600 focus-within:ring-2 focus-within:ring-emerald-100 ${borderTone} ${
          emphasized ? "bg-emerald-50" : ""
        }`}
      >
        {children}
      </div>
      <ValidationMessage issue={issue} />
      {helper && !issue?.message ? (
        <p className="text-[11px] leading-4 text-stone-500">{helper}</p>
      ) : null}
    </label>
  );
}

function inputBaseClass(emphasized = false) {
  return `w-full rounded-lg border-0 bg-transparent px-2.5 py-2 text-sm outline-none disabled:cursor-not-allowed disabled:bg-stone-50 disabled:text-stone-500 ${
    emphasized ? "text-base font-semibold text-emerald-950" : "text-stone-900"
  }`;
}

function compactLineInputClass(issue?: FieldIssue) {
  const border =
    issue?.tone === "error"
      ? "border-rose-400"
      : issue?.tone === "warning"
        ? "border-amber-400"
        : "border-stone-300";

  return `w-full rounded-md border ${border} bg-white px-2 py-1.5 text-xs text-stone-900 outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100 disabled:cursor-not-allowed disabled:bg-stone-100 disabled:text-stone-500`;
}

function SelectField({
  label,
  value,
  options,
  listId,
  onChange,
  readOnly = false,
  disabled = false,
  issue,
  helper,
  confidence,
  threshold,
  required = false,
}: {
  label: string;
  value: string;
  options: SelectOption[];
  listId: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  disabled?: boolean;
  issue?: FieldIssue;
  helper?: string;
  confidence?: number;
  threshold?: number;
  required?: boolean;
}) {
  return (
    <ReviewField
      label={label}
      issue={issue}
      helper={helper}
      confidence={confidence}
      threshold={threshold}
      required={required}
    >
      <input
        className={inputBaseClass()}
        list={readOnly ? undefined : listId}
        value={value}
        onChange={(event) => onChange?.(event.target.value)}
        readOnly={readOnly}
        disabled={disabled}
      />
      {!readOnly ? (
        <datalist id={listId}>
          {options.map((option) => (
            <option key={`${listId}-${option.value}`} value={option.value}>
              {option.label ?? option.value}
            </option>
          ))}
        </datalist>
      ) : null}
    </ReviewField>
  );
}

function DateField({
  label,
  value,
  onChange,
  disabled,
  issue,
  required = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  issue?: FieldIssue;
  required?: boolean;
}) {
  return (
    <ReviewField label={label} issue={issue} required={required}>
      <input
        className={inputBaseClass()}
        type="date"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
      />
    </ReviewField>
  );
}

function AmountField({
  label,
  value,
  currency,
  onChange,
  disabled,
  issue,
  emphasized = false,
  required = false,
}: {
  label: string;
  value: number | null;
  currency: string;
  onChange: (value: string) => void;
  disabled: boolean;
  issue?: FieldIssue;
  emphasized?: boolean;
  required?: boolean;
}) {
  return (
    <ReviewField
      label={label}
      issue={issue}
      helper={typeof value === "number" ? formatMoney(value, currency) : undefined}
      emphasized={emphasized}
      required={required}
    >
      <input
        className={inputBaseClass(emphasized)}
        type="number"
        step="0.01"
        value={numberValue(value)}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
      />
    </ReviewField>
  );
}

function TextField({
  label,
  value,
  onChange,
  disabled,
  issue,
  helper,
  required = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  issue?: FieldIssue;
  helper?: string;
  required?: boolean;
}) {
  return (
    <ReviewField label={label} issue={issue} helper={helper} required={required}>
      <input
        className={inputBaseClass()}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
      />
    </ReviewField>
  );
}

function CollapsibleSection({
  title,
  open,
  children,
}: {
  title: string;
  open: boolean;
  children: ReactNode;
}) {
  return (
    <details
      open={open || undefined}
      className="rounded-xl border border-stone-200 bg-white/80 p-3 text-stone-700 shadow-sm"
    >
      <summary className="cursor-pointer text-sm font-semibold text-stone-700">
        {title}
      </summary>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">{children}</div>
    </details>
  );
}

function UploadProgressList({ items }: { items: UploadItem[] }) {
  if (!items.length) {
    return null;
  }

  return (
    <div className="mt-4 grid gap-2">
      {items.map((item) => (
        <div
          key={item.id}
          className={`rounded-md border px-3 py-2 text-sm ${
            item.status === "error"
              ? "border-rose-200 bg-rose-50"
              : item.status === "duplicate"
                ? "border-fuchsia-200 bg-fuchsia-50"
              : item.status === "success"
                ? "border-emerald-200 bg-emerald-50"
                : "border-stone-200 bg-stone-50"
          }`}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="font-semibold">{item.fileName}</div>
              <div className="text-xs text-stone-500">
                {formatFileSize(item.fileSize)} - {item.message}
              </div>
            </div>
            <div className="text-xs font-semibold">{item.progress}%</div>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-stone-200">
            <div
              className={`h-full rounded-full ${
                item.status === "error"
                  ? "bg-rose-500"
                  : item.status === "duplicate"
                    ? "bg-fuchsia-500"
                    : "bg-[#12674f]"
              }`}
              style={{ width: `${item.progress}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function MissingInvoiceFileNotice() {
  return (
    <div className="flex h-full min-h-[360px] items-center justify-center rounded-lg border border-amber-200 bg-amber-50 p-6 text-center text-sm font-medium leading-6 text-amber-950">
      {missingInvoiceFileMessage}
    </div>
  );
}

function PdfCanvasPreview({
  sourceUrl,
  page,
  zoom,
  rotation,
  onPageCount,
}: {
  sourceUrl: string;
  page: number;
  zoom: number;
  rotation: number;
  onPageCount: (pageCount: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [renderError, setRenderError] = useState("");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const updateWidth = () => setContainerWidth(container.clientWidth);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!containerWidth) {
      return;
    }

    let cancelled = false;
    let renderTask: RenderTask | undefined;
    let loadingTask: PDFDocumentLoadingTask | undefined;

    async function renderPdf() {
      try {
        setRenderError("");
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          "pdfjs-dist/build/pdf.worker.min.mjs",
          import.meta.url
        ).toString();
        loadingTask = pdfjs.getDocument({ url: sourceUrl, withCredentials: true });
        const document = await loadingTask.promise;
        if (cancelled) {
          return;
        }

        onPageCount(document.numPages);
        const pdfPage = await document.getPage(Math.min(page, document.numPages));
        const baseViewport = pdfPage.getViewport({ scale: 1, rotation });
        const cssScale = (containerWidth * zoom) / baseViewport.width;
        const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
        const viewport = pdfPage.getViewport({
          scale: cssScale * pixelRatio,
          rotation,
        });
        const canvas = canvasRef.current;
        if (!canvas || cancelled) {
          return;
        }

        const context = canvas.getContext("2d");
        if (!context) {
          throw new Error("Canvas rendering is unavailable.");
        }

        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        canvas.style.width = `${viewport.width / pixelRatio}px`;
        canvas.style.height = `${viewport.height / pixelRatio}px`;
        renderTask = pdfPage.render({ canvas, canvasContext: context, viewport });
        await renderTask.promise;
      } catch (error) {
        if (!cancelled && !(error instanceof Error && error.name === "RenderingCancelledException")) {
          setRenderError("The original PDF could not be rendered. Download it to inspect the source file.");
        }
      }
    }

    void renderPdf();
    return () => {
      cancelled = true;
      renderTask?.cancel();
      void loadingTask?.destroy();
    };
  }, [containerWidth, onPageCount, page, rotation, sourceUrl, zoom]);

  return (
    <div ref={containerRef} className="w-full min-w-full">
      {renderError ? (
        <div className="flex min-h-[360px] items-center justify-center rounded-lg border border-amber-200 bg-amber-50 p-6 text-center text-sm font-medium text-amber-950">
          {renderError}
        </div>
      ) : (
        <canvas
          ref={canvasRef}
          className="block rounded-md border border-stone-300 bg-white shadow-sm"
          aria-label="Original PDF invoice page"
        />
      )}
    </div>
  );
}

function PreviewDocument({
  invoice,
  fileStatus,
  zoom,
  rotation,
  page,
  interactionMode,
  onPageCount,
}: {
  invoice: UploadedInvoice;
  fileStatus: PreviewFileStatus;
  zoom: number;
  rotation: number;
  page: number;
  interactionMode: PreviewInteractionMode;
  onPageCount: (pageCount: number) => void;
}) {
  if (fileStatus === "checking") {
    return (
      <div className="flex min-h-[320px] items-center justify-center rounded-md border border-stone-200 bg-white p-6 text-sm text-stone-500">
        Checking original invoice file...
      </div>
    );
  }

  if (fileStatus === "missing") {
    return <MissingInvoiceFileNotice />;
  }

  const sourceUrl = `/api/invoices/${invoice.id}/file`;
  const previewType = invoice.fileType;
  const isImage =
    previewType.startsWith("image/") ||
    ["jpg", "jpeg", "png"].includes(fileExtension(invoice.fileName));
  const isPdf =
    previewType === "application/pdf" || fileExtension(invoice.fileName) === "pdf";
  const imageStyle = {
    transform: `rotate(${rotation}deg)`,
    transformOrigin: "center top",
    width: `${zoom * 100}%`,
    maxWidth: "none",
  };
  const baseFrame =
    "rounded-md border border-stone-300 bg-white shadow-sm transition-transform";

  if (isImage) {
    return (
      // Authenticated invoice originals cannot use the public Next image optimizer.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={sourceUrl}
        alt={invoice.fileName}
        className={`mx-auto h-auto w-full max-w-none object-contain ${baseFrame}`}
        decoding="async"
        style={imageStyle}
        onLoad={() => onPageCount(1)}
      />
    );
  }

  if (isPdf) {
    if (interactionMode === "select_text") {
      return (
        <iframe
          src={sourceUrl}
          title="Selectable PDF invoice"
          className={`min-h-[680px] w-full ${baseFrame}`}
        />
      );
    }

    return (
      <PdfCanvasPreview
        sourceUrl={sourceUrl}
        page={page}
        zoom={zoom}
        rotation={rotation}
        onPageCount={onPageCount}
      />
    );
  }

  return (
    <iframe
      src={sourceUrl}
      title={`Original invoice source: ${invoice.fileName}`}
      className={`mx-auto min-h-[680px] w-full ${baseFrame}`}
      onLoad={() => onPageCount(1)}
    />
  );
}

export function IntoWorkbench() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const supplierOverviewInputRef = useRef<HTMLInputElement | null>(null);
  const resetLearningDialogRef = useRef<HTMLDialogElement | null>(null);
  const resetLearningCancelRef = useRef<HTMLButtonElement | null>(null);
  const previewViewportRef = useRef<HTMLDivElement | null>(null);
  const previewDragStartRef = useRef<{
    x: number;
    y: number;
    scrollLeft: number;
    scrollTop: number;
  } | null>(null);
  const [state, setState] = useState<ApiState>({
    permissions: [...SHARED_ACCESS_PERMISSIONS],
    invoices: [],
    exactConnection: null,
    exactMasterData: null,
    exactMasterDataStale: true,
    exactMasterDataReadOnly: true,
    supplierOverviewImport: null,
    supplierLearning: [],
    supplierLearningLoaded: false,
    supplierLearningEnabled: false,
    exactConfiguration: null,
  });
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string>("");
  const [draft, setDraft] = useState<ExtractedInvoiceData | null>(null);
  const [bookingLineDrafts, setBookingLineDrafts] = useState<BookingLineDraft[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const [buttonFeedback, setButtonFeedback] = useState<
    Partial<Record<string, ButtonFeedback>>
  >({});
  const [isDragging, setIsDragging] = useState(false);
  const [uploadItems, setUploadItems] = useState<UploadItem[]>([]);
  const [duplicatePrompts, setDuplicatePrompts] = useState<DuplicateUploadPrompt[]>([]);
  const [previewZoom, setPreviewZoom] = useState(defaultPreviewZoom);
  const [previewRotation, setPreviewRotation] = useState(0);
  const [previewPage, setPreviewPage] = useState(1);
  const [previewPageCount, setPreviewPageCount] = useState(1);
  const [previewInteractionMode, setPreviewInteractionMode] =
    useState<PreviewInteractionMode>("pan");
  const [, setPreviewPan] = useState<PreviewPan>(() => resetPreviewPan());
  const [previewDragging, setPreviewDragging] = useState(false);
  const [previewFileProbe, setPreviewFileProbe] = useState<{
    invoiceId: string;
    status: ResolvedPreviewFileStatus;
  } | null>(null);
  const [activeView, setActiveView] = useState<ActiveView>("queue");
  const [actor, setActor] = useState<SafeActor | null>(null);
  const [archiveFilters, setArchiveFilters] =
    useState<ArchiveFilterState>(defaultArchiveFilters);
  const [archive, setArchive] = useState<InvoiceArchiveResult | null>(null);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [learningResetTarget, setLearningResetTarget] =
    useState<SupplierLearningSummary | null>(null);
  const [learningDetailAccountId, setLearningDetailAccountId] = useState("");
  const availableViews: ActiveView[] = state.supplierLearningEnabled
    ? ["queue", "archive", "supplier-learning"]
    : ["queue", "archive"];
  if (actor) availableViews.push("users");
  const visibleActiveView =
    activeView === "supplier-learning" && !state.supplierLearningEnabled
      ? "queue"
      : activeView;

  const selectedInvoice = useMemo(
    () =>
      state.invoices.find((invoice) => invoice.id === selectedInvoiceId) ??
      state.invoices[0] ??
      null,
    [selectedInvoiceId, state.invoices]
  );
  const previewFileStatus = useMemo<PreviewFileStatus>(() => {
    if (!selectedInvoice || !invoiceFileCanBeRequested(selectedInvoice)) {
      return "missing";
    }

    if (previewFileProbe?.invoiceId !== selectedInvoice.id) {
      return "checking";
    }

    return previewFileProbe.status;
  }, [previewFileProbe, selectedInvoice]);
  const selectedPurchaseJournal = selectedInvoice?.purchaseJournal ?? null;
  const selectedInvoiceIsPdf = Boolean(
    selectedInvoice &&
      (selectedInvoice.fileType === "application/pdf" ||
        fileExtension(selectedInvoice.fileName) === "pdf")
  );
  const selectedInvoiceIsImage = Boolean(
    selectedInvoice &&
      (selectedInvoice.fileType.startsWith("image/") ||
        ["jpg", "jpeg", "png"].includes(fileExtension(selectedInvoice.fileName)))
  );
  const matchedSupplierLabel =
    selectedPurchaseJournal?.supplierResolution.selectedAccountCode &&
    selectedPurchaseJournal.supplierResolution.selectedAccountName
      ? `${selectedPurchaseJournal.supplierResolution.selectedAccountCode} - ${selectedPurchaseJournal.supplierResolution.selectedAccountName}`
      : "";
  const currentCurrency =
    draft?.currency || selectedPurchaseJournal?.currency || "EUR";
  const confidenceThreshold = selectedPurchaseJournal?.confidenceThreshold;
  const exactSupplierAccounts = (state.exactMasterData?.suppliers ?? [])
    .filter((supplier) => supplier.name && supplier.isSupplier !== false)
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name));
  const recordedSupplierLearningByAccount = new Map(
    state.supplierLearning.map((summary) => [summary.supplierAccountId, summary])
  );
  const supplierLearningRows =
    state.supplierLearningEnabled && state.supplierLearningLoaded
      ? [
          ...exactSupplierAccounts.map(
            (supplier): SupplierLearningSummary =>
              recordedSupplierLearningByAccount.get(supplier.id) ?? {
                supplierAccountId: supplier.id,
                supplierCode: supplier.code,
                supplierName: supplier.name,
                generation: 0,
                exampleCount: 0,
                formatDrift: "none",
                confidence: {
                  score: 35,
                  band: "Low",
                  baseline: 35,
                  exampleCount: 0,
                  volume: 0,
                  quality: 0,
                  driftPenalty: 0,
                },
              }
          ),
          ...state.supplierLearning.filter(
            (summary) =>
              !exactSupplierAccounts.some(
                (supplier) => supplier.id === summary.supplierAccountId
              )
          ),
        ]
      : [];
  const supplierLearningByAccount = new Map(
    supplierLearningRows.map((summary) => [summary.supplierAccountId, summary])
  );
  const learningDetail = learningDetailAccountId
    ? supplierLearningByAccount.get(learningDetailAccountId)
    : undefined;
  const selectedSupplierLearning = selectedPurchaseJournal?.supplierResolution
    .selectedAccountId
    ? supplierLearningByAccount.get(
        selectedPurchaseJournal.supplierResolution.selectedAccountId
      )
    : undefined;
  const duplicateSupplierCandidates =
    selectedPurchaseJournal?.supplierResolution.reasonCode ===
      "supplier_ambiguous" &&
    selectedPurchaseJournal.supplierResolution.candidates.length > 1
      ? selectedPurchaseJournal.supplierResolution.candidates
      : [];
  const paymentConditionOptions: SelectOption[] = (
    state.exactMasterData?.paymentConditions ?? []
  )
    .filter((condition) => condition.isActive)
    .map((condition) => ({
      value: condition.label,
      label: `${condition.code} - ${condition.label}`,
    }));
  const glAccountOptions: SelectOption[] = (
    state.exactMasterData?.glAccounts ?? []
  )
    .filter((account) => account.isActive)
    .map((account) => ({
      value: `${account.code} - ${account.name}`,
      label: `${account.code} - ${account.name}`,
    }));
  const vatCodeOptions: SelectOption[] = (state.exactMasterData?.vatCodes ?? [])
    .filter(
      (vatCode) =>
        vatCode.type === "purchase" &&
        vatCode.isActive &&
        isIntoPurchaseVatCode(vatCode.code)
    )
    .map((vatCode) => {
      const code = intoPurchaseVatCodeOrFallback(vatCode.code);
      const value = `${code} - ${INTO_PURCHASE_VAT_CODE_LABELS[code]}`;
      return { value, label: value };
    });
  const costCenterOptions: SelectOption[] = (
    state.exactMasterData?.costCenters ?? []
  )
    .filter((costCenter) => costCenter.isActive)
    .map((costCenter) => ({
      value: costCenter.code,
      label: `${costCenter.code} - ${costCenter.description}`,
    }));
  const costUnitOptions: SelectOption[] = (state.exactMasterData?.costUnits ?? [])
    .filter((costUnit) => costUnit.isActive)
    .map((costUnit) => ({
      value: costUnit.code,
      label: `${costUnit.code} - ${costUnit.description}`,
    }));
  const previewCanPan =
    previewFileStatus === "available" && previewInteractionMode === "pan";
  const pageCount = previewPageCount;
  const bookingLinePayloads = bookingLineDrafts.map(toBookingLinePayload);
  const hasBookingLineChanges = Boolean(
    selectedInvoice &&
      JSON.stringify(bookingLinePayloads) !==
        JSON.stringify(selectedPurchaseJournal?.lines ?? [])
  );
  const hasUnsavedChanges = Boolean(
    selectedInvoice &&
      draft &&
      (JSON.stringify(draft) !== JSON.stringify(selectedInvoice.extractedData) ||
        hasBookingLineChanges)
  );
  const hasPermission = (permission: PermissionAction) =>
    state.permissions.includes(permission);
  const hasFieldValidationWarning = (fields: (keyof ExtractedInvoiceData)[]) =>
    Boolean(
      selectedInvoice?.validationErrors.some((error) =>
        fields.includes(error.field as keyof ExtractedInvoiceData)
      )
    );
  const validationIssueFor = (
    fields: ValidationError["field"][],
    extraMessages: Array<string | undefined | false> = []
  ): FieldIssue | undefined => {
    const validationIssue = selectedInvoice?.validationErrors.find((error) =>
      fields.includes(error.field)
    );
    const extraMessage = extraMessages.find(Boolean);
    const message = extraMessage || validationIssue?.message;
    if (!message) {
      return undefined;
    }

    return {
      tone: validationIssue?.severity === "error" ? "error" : "warning",
      message,
    };
  };
  const additionalDataOpen = hasFieldValidationWarning(additionalDataFields);
  const requiredBookingIssuesForInvoice = (invoice: UploadedInvoice) =>
    getRequiredBookingDataIssues(
      selectedInvoice?.id === invoice.id && draft ? draft : invoice.extractedData,
      invoice.purchaseJournal
    );
  const selectedRequiredBookingIssues =
    selectedInvoice && draft
      ? getRequiredBookingDataIssues(draft, selectedPurchaseJournal)
      : [];
  const contextualSupplierReviewVisible = Boolean(
    duplicateSupplierCandidates.length > 1
  );
  const requiredIssueFor = (
    fields: ValidationError["field"][]
  ): FieldIssue | undefined => {
    const issue = selectedRequiredBookingIssues.find((item) =>
      fields.includes(item.field)
    );
    return issue ? { tone: "error", message: issue.message } : undefined;
  };
  const extractionEvidenceIssueFor = (
    field: keyof NonNullable<ExtractedInvoiceData["extractionEvidence"]>,
    learnedField: LearnableCorrectionField,
    hasValue: boolean,
    label: string
  ): FieldIssue | undefined => {
    if (
      !selectedInvoice ||
      !hasValue ||
      selectedInvoice.extractedData.extractionEvidence?.[field] ||
      selectedInvoice.learnedFieldsApplied?.includes(learnedField)
    ) {
      return undefined;
    }
    return {
      tone: "warning",
      message:
        selectedInvoice.extractedData.documentTextMode === "unavailable"
          ? `${label} could not be verified from embedded document text. Please confirm it.`
          : `${label} was not linked to a labelled source value. Please confirm it.`,
    };
  };
  const supplierIssue = contextualSupplierReviewVisible
    ? undefined
    : validationIssueFor(["supplier", "supplierName"]);
  const supplierFieldIssue = contextualSupplierReviewVisible
    ? undefined
    : requiredIssueFor(["supplierName"]) ?? supplierIssue;
  const expenseDescriptionIssue =
    requiredIssueFor(["expenseDescription"]) ??
    validationIssueFor(["expenseDescription"]);
  const paymentConditionIssue = validationIssueFor(
    ["paymentCondition", "paymentTerms"],
    [
      selectedPurchaseJournal?.paymentConditionMismatch
        ? "Payment condition does not match Exact supplier default."
        : undefined,
    ]
  );
  const paymentConditionFieldIssue =
    requiredIssueFor(["paymentTerms"]) ?? paymentConditionIssue;
  const yourRefIssue =
    requiredIssueFor(["referenceCode"]) ??
    validationIssueFor(["yourRef", "referenceCode"]) ??
    extractionEvidenceIssueFor(
      "referenceCode",
      "yourRefPattern",
      Boolean(draft?.referenceCode.trim()),
      "Your ref."
    );
  const invoiceDateIssue =
    requiredIssueFor(["invoiceDate"]) ??
    validationIssueFor(["invoiceDate"]) ??
    extractionEvidenceIssueFor(
      "invoiceDate",
      "invoiceDate",
      Boolean(draft?.invoiceDate),
      "Invoice date"
    );
  const totalAmountIssue = validationIssueFor(
    ["grossAmount"],
    [
      selectedPurchaseJournal?.totals.difference
        ? BOOKING_TOTAL_MISMATCH_MESSAGE
        : undefined,
    ]
  );
  const totalAmountFieldIssue =
    requiredIssueFor(["grossAmount"]) ??
    totalAmountIssue ??
    extractionEvidenceIssueFor(
      "grossAmount",
      "totalAmount",
      draft?.grossAmount !== null && draft?.grossAmount !== undefined,
      "Total amount"
    );
  const bookingLineTotals = useMemo(
    () =>
      calculateBookingTotals(
        bookingLineDrafts.map((line) => ({
          amount: amountFromInput(line.amountInput) ?? 0,
          vatAmount: amountFromInput(line.vatAmountInput) ?? 0,
        })),
        draft?.grossAmount
      ),
    [bookingLineDrafts, draft?.grossAmount]
  );
  const selectedBookingLineIssues = useMemo<BookingLineIssue[]>(() => {
    const issues: BookingLineIssue[] = [];

    if (!selectedInvoice) {
      return issues;
    }

    if (!bookingLineDrafts.length) {
      issues.push({
        id: "booking-lines-required",
        message: "At least one booking line is required.",
      });
    }

    bookingLineDrafts.forEach((line, index) => {
      const lineNumber = index + 1;
      const requiresAccrualDates = bookingLineRequiresAccrual(line);

      if (!line.glAccount.trim()) {
        issues.push({
          id: `line-${line.id}-gl`,
          lineIndex: index,
          field: "glAccount",
          message: `Line ${lineNumber}: G/L Account is required.`,
        });
      }

      if (!line.description.trim()) {
        issues.push({
          id: `line-${line.id}-description`,
          lineIndex: index,
          field: "description",
          message: `Line ${lineNumber}: Description is required.`,
        });
      }

      if (requiresAccrualDates && !line.from) {
        issues.push({
          id: `line-${line.id}-from`,
          lineIndex: index,
          field: "from",
          message: `Line ${lineNumber}: Accrual From is required.`,
        });
      }

      if (requiresAccrualDates && !line.to) {
        issues.push({
          id: `line-${line.id}-to`,
          lineIndex: index,
          field: "to",
          message: `Line ${lineNumber}: Accrual To is required.`,
        });
      }

      if (!line.vatCode) {
        issues.push({
          id: `line-${line.id}-vat`,
          lineIndex: index,
          field: "vatCode",
          message: `Line ${lineNumber}: VAT code is required.`,
        });
      } else if (!isIntoPurchaseVatCode(line.vatCode)) {
        issues.push({
          id: `line-${line.id}-vat-unsupported`,
          lineIndex: index,
          field: "vatCode",
          message: `Line ${lineNumber}: Unsupported VAT code ${line.vatCode}. Only codes 4, 5, 6, 7, and 8 are allowed.`,
        });
      }

      if (amountFromInput(line.amountInput) === null) {
        issues.push({
          id: `line-${line.id}-amount`,
          lineIndex: index,
          field: "amount",
          message: `Line ${lineNumber}: Net amount is required.`,
        });
      }

      if (amountFromInput(line.vatAmountInput) === null) {
        issues.push({
          id: `line-${line.id}-vat-amount`,
          lineIndex: index,
          field: "vatAmount",
          message: `Line ${lineNumber}: VAT amount is required.`,
        });
      }
    });

    if (bookingLineDrafts.length && bookingLineTotals.difference !== 0) {
      issues.push({
        id: "booking-lines-difference",
        message: BOOKING_TOTAL_MISMATCH_MESSAGE,
      });
    }

    return issues;
  }, [
    bookingLineDrafts,
    bookingLineTotals.difference,
    selectedInvoice,
  ]);
  const selectedBookingLineDisabledReason = selectedBookingLineIssues.length
    ? selectedBookingLineIssues.some((issue) => issue.id === "booking-lines-difference")
      ? BOOKING_TOTAL_MISMATCH_MESSAGE
      : "Complete all booking line required fields before booking to Exact Online."
    : "";
  const bookingLineIssueFor = (
    lineIndex: number,
    field: BookingLineIssue["field"]
  ): FieldIssue | undefined => {
    const issue = selectedBookingLineIssues.find(
      (item) => item.lineIndex === lineIndex && item.field === field
    );
    if (issue) {
      return { tone: "error", message: issue.message };
    }
    return lineIndex === 0 && field === "description"
      ? expenseDescriptionIssue
      : undefined;
  };
  const bookingLineVatIssueFor = (lineIndex: number): FieldIssue | undefined =>
    bookingLineIssueFor(lineIndex, "vatCode") ??
    (bookingLineDrafts[lineIndex]?.vatReasoning.includes(
      UNSUPPORTED_VAT_CODE_WARNING
    )
      ? { tone: "warning", message: UNSUPPORTED_VAT_CODE_WARNING }
      : undefined);
  const visibleValidationMessages = selectedInvoice
    ? uniqueValidationMessages([
        ...selectedInvoice.validationErrors
          .filter(
            (item) =>
              !contextualSupplierReviewVisible ||
              (item.field !== "supplier" && item.field !== "supplierName")
          )
          .map((item) => ({
            id: item.id,
            message: item.message,
          })),
        ...selectedRequiredBookingIssues
          .filter(
            (issue) =>
              (!contextualSupplierReviewVisible || issue.field !== "supplierName") &&
              !selectedInvoice.validationErrors.some(
                (error) => error.field === issue.field
              )
          )
          .map((issue) => ({
            id: `required-${String(issue.field)}`,
            message: issue.message,
          })),
        ...selectedBookingLineIssues.map((issue) => ({
          id: issue.id,
          message: issue.message,
        })),
      ])
    : [];

  const stats = useMemo(() => {
    const ready = state.invoices.filter(
      (invoice) => invoice.status === "Ready to Book"
    ).length;
    const needsCheck = state.invoices.filter((invoice) =>
      reviewStatuses.has(invoice.status)
    ).length;
    const booked = state.invoices.filter(
      (invoice) => invoice.status === "Booked"
    ).length;

    return {
      total: state.invoices.length,
      ready,
      needsCheck,
      booked,
    };
  }, [state.invoices]);
  const bookAllLineBlockedInvoice = state.invoices.find(
    (invoice) =>
      invoice.status === "Ready to Book" && bookingLineDisabledReason(invoice)
  );
  const bookAllLineDisabledReason = bookAllLineBlockedInvoice
    ? `${bookAllLineBlockedInvoice.fileName}: ${bookingLineDisabledReason(bookAllLineBlockedInvoice)}`
    : "";

  const canApproveSelectedIntelligence = Boolean(
    selectedPurchaseJournal &&
      selectedPurchaseJournal.reviewRequired &&
      !selectedPurchaseJournal.supplierResolution.reviewRequired &&
      selectedPurchaseJournal.attachmentPresent &&
      selectedPurchaseJournal.yourRef &&
      selectedPurchaseJournal.yourRefUnique
  );
  const reviewActions: ReviewActionDefinition[] = selectedInvoice
    ? [
        {
          key: "save",
          label: "Save changes",
          variant: "primary",
          onClick: saveDraft,
          loading: busy === "save",
          feedback: buttonFeedbackFor("save", "save"),
          disabled: Boolean(saveChangesDisabledReason()),
          disabledReason: saveChangesDisabledReason(),
        },
        ...(state.supplierLearningEnabled
          ? [
              {
                key: "learn",
                label: "Learn",
                variant: "secondary" as const,
                onClick: learnSelectedInvoice,
                loading: busy === "learn",
                feedback: buttonFeedbackFor("learn", "learn"),
                disabled: Boolean(learnDisabledReason(selectedInvoice)),
                disabledReason: learnDisabledReason(selectedInvoice),
              },
            ]
          : []),
        {
          key: `reread-${selectedInvoice.id}`,
          label: "Re-read invoice",
          variant: "ghost",
          onClick: rereadSelectedInvoice,
          loading: busy === `reread-${selectedInvoice.id}`,
          feedback: buttonFeedbackFor(
            `reread-${selectedInvoice.id}`,
            `reread-${selectedInvoice.id}`
          ),
          disabled: Boolean(reReadDisabledReason(selectedInvoice)),
          disabledReason: reReadDisabledReason(selectedInvoice),
        },
        {
          key: "approve-intelligence",
          label: "Mark as reviewed",
          variant: "secondary",
          onClick: () => applyIntelligenceAction("approve"),
          loading: busy === "approve-intelligence",
          feedback: buttonFeedbackFor(
            "approve-intelligence",
            "approve-intelligence"
          ),
          disabled: Boolean(markReviewedDisabledReason(selectedInvoice)),
          disabledReason: markReviewedDisabledReason(selectedInvoice),
        },
        {
          key: `book-${selectedInvoice.id}`,
          label: "Book invoice",
          variant: "outline",
          onClick: () => bookInvoice(selectedInvoice.id),
          loading: busy === `book-${selectedInvoice.id}`,
          feedback: buttonFeedbackFor(
            `book-${selectedInvoice.id}`,
            `book-${selectedInvoice.id}`
          ),
          disabled: Boolean(bookReviewDisabledReason(selectedInvoice)),
          disabledReason: bookReviewDisabledReason(selectedInvoice),
        },
        {
          key: `needs-review-${selectedInvoice.id}`,
          label: "Reject / Needs review",
          variant: "danger",
          onClick: markSelectedNeedsReview,
          loading: busy === `needs-review-${selectedInvoice.id}`,
          feedback: buttonFeedbackFor(
            `needs-review-${selectedInvoice.id}`,
            `needs-review-${selectedInvoice.id}`
          ),
          disabled: Boolean(needsReviewDisabledReason(selectedInvoice)),
          disabledReason: needsReviewDisabledReason(selectedInvoice),
        },
      ]
    : [];

  function setUploadItem(id: string, patch: Partial<UploadItem>) {
    setUploadItems((current) =>
      current.map((item) => (item.id === id ? { ...item, ...patch } : item))
    );
  }

  function flashButton(key: string, feedback: ButtonFeedback) {
    setButtonFeedback((current) => ({ ...current, [key]: feedback }));
    window.setTimeout(() => {
      setButtonFeedback((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    }, 1800);
  }

  function buttonFeedbackFor(key: string, loadingKey?: string) {
    return busy === (loadingKey ?? key) ? undefined : buttonFeedback[key];
  }

  function selectInvoice(invoiceId: string) {
    if (invoiceId === selectedInvoiceId) {
      return;
    }

    if (
      hasUnsavedChanges &&
      !window.confirm("You have unsaved edits. Switch invoice and discard them?")
    ) {
      return;
    }

    setSelectedInvoiceId(invoiceId);
  }

  const handlePreviewPageCount = useCallback((count: number) => {
    const safeCount = Math.max(1, Math.trunc(count));
    setPreviewPageCount(safeCount);
    setPreviewPage((current) => Math.min(current, safeCount));
  }, []);

  function handlePreviewWheel(event: ReactWheelEvent<HTMLDivElement>) {
    if (!event.ctrlKey || previewFileStatus !== "available") {
      return;
    }

    const viewport = previewViewportRef.current;
    if (!viewport) {
      return;
    }

    event.preventDefault();
    const nextZoom = zoomFromWheel(previewZoom, event.deltaY);
    if (nextZoom === previewZoom) {
      return;
    }

    const bounds = viewport.getBoundingClientRect();
    const nextScroll = previewScrollAfterZoom({
      currentZoom: previewZoom,
      nextZoom,
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop,
      pointerX: event.clientX - bounds.left,
      pointerY: event.clientY - bounds.top,
    });
    setPreviewZoom(nextZoom);
    window.requestAnimationFrame(() => {
      viewport.scrollLeft = nextScroll.left;
      viewport.scrollTop = nextScroll.top;
    });
  }

  const resetPreviewScroll = useCallback(() => {
    window.requestAnimationFrame(() => {
      const viewport = previewViewportRef.current;
      if (!viewport) {
        return;
      }

      viewport.scrollLeft = 0;
      viewport.scrollTop = 0;
    });
  }, []);

  function startPreviewPan(event: ReactPointerEvent<HTMLDivElement>) {
    if (!previewCanPan) {
      return;
    }

    const viewport = previewViewportRef.current;
    if (!viewport || event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    previewDragStartRef.current = {
      x: event.clientX,
      y: event.clientY,
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop,
    };
    setPreviewDragging(true);
  }

  function movePreview(event: ReactPointerEvent<HTMLDivElement>) {
    if (!previewDragging) {
      return;
    }

    event.preventDefault();
    const viewport = previewViewportRef.current;
    const start = previewDragStartRef.current;
    if (!viewport || !start) {
      return;
    }

    viewport.scrollLeft = start.scrollLeft - (event.clientX - start.x);
    viewport.scrollTop = start.scrollTop - (event.clientY - start.y);
    setPreviewPan((current) =>
      movePreviewPan(current, { x: event.movementX, y: event.movementY })
    );
  }

  function stopPreviewPan(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    previewDragStartRef.current = null;
    setPreviewDragging(false);
  }

  async function refreshAll() {
    const [invoiceResponse, exactResponse, learningResponse] = await Promise.all([
      fetch("/api/invoices"),
      fetch("/api/exact/status"),
      fetch("/api/suppliers/learning"),
    ]);
    const invoiceData = (await readApiJson(invoiceResponse)) as {
      invoices?: UploadedInvoice[];
      error?: string;
    };
    const exactData = (await readApiJson(exactResponse)) as {
      connection: PublicExactConnection | null;
      masterData: ExactMasterDataCache | null;
      masterDataStale: boolean;
      masterDataReadOnly: boolean;
      supplierOverviewImport: SupplierOverviewImportStatus | null;
      configuration: NonNullable<ApiState["exactConfiguration"]>;
      error?: string;
    };
    const learningData = (await readApiJson(learningResponse)) as {
      enabled?: boolean;
      suppliers?: SupplierLearningSummary[];
      error?: string;
    };
    if (!invoiceResponse.ok || !Array.isArray(invoiceData.invoices)) {
      throw new Error(invoiceData.error ?? "Invoice data could not be loaded.");
    }
    if (!exactResponse.ok || !exactData.configuration) {
      throw new Error(exactData.error ?? "Exact Online status could not be loaded.");
    }
    const invoices = invoiceData.invoices;
    const learningStateLoaded =
      learningResponse.ok &&
      typeof learningData.enabled === "boolean" &&
      Array.isArray(learningData.suppliers);
    if (!learningStateLoaded) {
      setMessage(
        learningData.error ?? "Supplier learning summaries could not be loaded."
      );
    } else if (!learningData.enabled) {
      setActiveView("queue");
      setLearningResetTarget(null);
    }
    setState((current) => ({
      permissions: [...SHARED_ACCESS_PERMISSIONS],
      invoices,
      exactConnection: exactData.connection,
      exactMasterData: exactData.masterData,
      exactMasterDataStale: exactData.masterDataStale,
      exactMasterDataReadOnly: exactData.masterDataReadOnly,
      supplierOverviewImport: exactData.supplierOverviewImport,
      supplierLearning: learningStateLoaded
        ? learningData.enabled
          ? learningData.suppliers!
          : []
        : current.supplierLearning,
      supplierLearningLoaded: learningStateLoaded
        ? true
        : current.supplierLearningLoaded,
      supplierLearningEnabled: learningStateLoaded
        ? learningData.enabled!
        : current.supplierLearningEnabled,
      exactConfiguration: exactData.configuration,
    }));

    if (!selectedInvoiceId && invoices[0]) {
      setSelectedInvoiceId(invoices[0].id);
    }
  }

  async function refreshSupplierLearning() {
    const response = await fetch("/api/suppliers/learning");
    const data = (await readApiJson(response)) as {
      enabled?: boolean;
      suppliers?: SupplierLearningSummary[];
      error?: string;
    };
    if (
      !response.ok ||
      typeof data.enabled !== "boolean" ||
      !Array.isArray(data.suppliers)
    ) {
      throw new Error(data.error ?? "Supplier learning could not be refreshed.");
    }
    if (!data.enabled) {
      setActiveView("queue");
      setLearningResetTarget(null);
    }
    setState((current) => ({
      ...current,
      supplierLearning: data.enabled ? data.suppliers! : [],
      supplierLearningLoaded: true,
      supplierLearningEnabled: data.enabled!,
    }));
  }

  function applyResetProfile(
    target: SupplierLearningSummary,
    profile: SupplierLearningProfile
  ) {
    const summary: SupplierLearningSummary = {
      ...target,
      ...profile,
      lastLearnedAt: profile.lastLearnedAt,
      formatFingerprint: profile.formatFingerprint,
      confidence: {
        score: 35,
        band: "Low",
        baseline: 35,
        exampleCount: 0,
        volume: 0,
        quality: 0,
        driftPenalty: 0,
      },
    };
    setState((current) => ({
      ...current,
      supplierLearningLoaded: true,
      supplierLearning: current.supplierLearning.some(
        (item) => item.supplierAccountId === summary.supplierAccountId
      )
        ? current.supplierLearning.map((item) =>
            item.supplierAccountId === summary.supplierAccountId ? summary : item
          )
        : [...current.supplierLearning, summary],
    }));
  }

  async function loadArchive(nextFilters = archiveFilters) {
    setBusy("archive-search");
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(nextFilters)) {
      if (value === "" || value === undefined || value === null) {
        continue;
      }

      params.set(key, String(value));
    }

    try {
      const response = await fetch(`/api/invoices/archive?${params.toString()}`);
      const data = (await readApiJson(response)) as {
        archive?: InvoiceArchiveResult;
        error?: string;
      };

      if (!response.ok || !data.archive) {
        throw new Error(data.error ?? "Archive search failed.");
      }

      setArchive(data.archive);
      return data.archive;
    } finally {
      setBusy("");
    }
  }

  async function loadAudit(invoiceId: string) {
    const response = await fetch(`/api/invoices/${invoiceId}/audit`);
    const data = (await readApiJson(response)) as { events?: AuditEvent[] };
    setAuditEvents(response.ok ? data.events ?? [] : []);
  }

  async function lockInto() {
    setBusy("lock-into");
    try {
      const response = await fetch("/api/access/logout", { method: "POST" });
      if (!response.ok) {
        throw new Error("INTO could not be locked. Please try again.");
      }
      window.location.replace("/");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "INTO could not be locked. Please try again."
      );
      setBusy("");
    }
  }

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      refreshAll().catch((error: unknown) =>
        setMessage(workspaceLoadErrorMessage(error))
      );
    }, 0);

    return () => window.clearTimeout(timeoutId);
    // Run once on mount; refreshAll updates the state this effect would otherwise depend on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      fetch("/api/access/session")
        .then((response) => response.json())
        .then((body: { user?: SafeActor | null }) => setActor(body.user ?? null))
        .catch(() => setActor(null));
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const exactStatus = params.get("exact");
    if (!exactStatus) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setMessage(
        exactStatus === "connected"
          ? "Exact Online is connected. INTO synced Exact master data."
          : "Exact Online connection failed. Check your Exact app credentials and redirect URI."
      );
      refreshAll().catch((error: unknown) =>
        setMessage(workspaceLoadErrorMessage(error))
      );
    }, 0);
    params.delete("exact");
    const nextQuery = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}`
    );

    return () => window.clearTimeout(timeoutId);
    // Consume the OAuth callback query once; refreshAll would recreate on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!state.exactConnection) {
      return;
    }

    const intervalId = window.setInterval(() => {
      const staleByTime =
        !state.exactMasterData ||
        new Date(state.exactMasterData.staleAfter).getTime() <= Date.now();

      if ((state.exactMasterDataStale || staleByTime) && !busy) {
        syncExactData({ silent: true }).catch(() => undefined);
      }
    }, 60_000);

    return () => window.clearInterval(intervalId);
    // syncExactData is intentionally captured to avoid restarting this timer per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, state.exactConnection, state.exactMasterData, state.exactMasterDataStale]);

  useEffect(() => {
    if (selectedInvoice) {
      const nextDraft = { ...selectedInvoice.extractedData };
      const nextBookingLines =
        selectedInvoice.purchaseJournal?.lines.length
          ? selectedInvoice.purchaseJournal.lines.map(toBookingLineDraft)
          : [fallbackBookingLineDraft(nextDraft)];
      const timeoutId = window.setTimeout(() => {
        setDraft(nextDraft);
        setBookingLineDrafts(nextBookingLines);
        setPreviewPage(1);
        setPreviewPageCount(1);
        setPreviewZoom(defaultPreviewZoom);
        setPreviewRotation(0);
        setPreviewInteractionMode("pan");
        setPreviewPan(resetPreviewPan());
        resetPreviewScroll();
      }, 0);

      return () => window.clearTimeout(timeoutId);
    }

    const timeoutId = window.setTimeout(() => {
      setDraft(null);
      setBookingLineDrafts([]);
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [selectedInvoice, resetPreviewScroll]);

  useEffect(() => {
    if (!selectedInvoice || !invoiceFileCanBeRequested(selectedInvoice)) {
      return;
    }

    let cancelled = false;
    fetch(`/api/invoices/${selectedInvoice.id}/file`, { method: "HEAD" })
      .then((response) => {
        if (!cancelled) {
          setPreviewFileProbe({
            invoiceId: selectedInvoice.id,
            status: response.ok ? "available" : "missing",
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPreviewFileProbe({ invoiceId: selectedInvoice.id, status: "missing" });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedInvoice, resetPreviewScroll]);

  useEffect(() => {
    if (!selectedInvoice?.id) {
      const timeoutId = window.setTimeout(() => setAuditEvents([]), 0);
      return () => window.clearTimeout(timeoutId);
    }

    const timeoutId = window.setTimeout(() => {
      loadAudit(selectedInvoice.id).catch(() => setAuditEvents([]));
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [selectedInvoice?.id]);

  useEffect(() => {
    const dialog = resetLearningDialogRef.current;
    if (!dialog) {
      return;
    }

    if (learningResetTarget && !dialog.open) {
      dialog.showModal();
      window.setTimeout(() => resetLearningCancelRef.current?.focus(), 0);
    } else if (!learningResetTarget && dialog.open) {
      dialog.close();
    }
  }, [learningResetTarget]);

  async function processFiles(fileList: FileList | File[]) {
    if (!hasPermission("upload")) {
      setMessage("Your INTO account is not verified for invoice uploads.");
      return;
    }

    const files = Array.from(fileList);
    if (!files.length) {
      return;
    }

    if (busy === "upload") {
      setMessage("Upload is already running.");
      return;
    }

    setBusy("upload");
    setMessage("Checking invoice files...");

    const initialItems: UploadItem[] = files.map((file, index) => ({
      id: `${file.name}-${file.size}-${file.lastModified}-${index}`,
      fileName: file.name,
      fileSize: file.size,
      progress: 5,
      status: "checking",
      message: "Checking file",
    }));
    setUploadItems(initialItems);

    const batchFingerprints = new Set<string>();
    const accepted: Array<{ file: File; checksum: string; itemId: string }> = [];

    for (const [index, file] of files.entries()) {
      const itemId = initialItems[index].id;

      if (!isAcceptedFile(file)) {
        setUploadItem(itemId, {
          progress: 100,
          status: "error",
          message: `Unsupported file type. Accepted: ${acceptedLabel}.`,
        });
        continue;
      }

      try {
        const checksum = await checksumFile(file);
        const fingerprint = [file.name.toLowerCase(), file.size, checksum].join("|");

        if (batchFingerprints.has(fingerprint)) {
          setUploadItem(itemId, {
            checksum,
            progress: 100,
            status: "error",
            message: "Duplicate file in this upload batch.",
          });
          continue;
        }

        batchFingerprints.add(fingerprint);
        accepted.push({ file, checksum, itemId });
        setUploadItem(itemId, {
          checksum,
          progress: 25,
          status: "ready",
          message: "Ready to upload",
        });
      } catch {
        setUploadItem(itemId, {
          progress: 100,
          status: "error",
          message: "Could not calculate checksum.",
        });
      }
    }

    if (!accepted.length) {
      setBusy("");
      setMessage("No valid new invoice files to upload.");
      flashButton("upload", "error");
      return;
    }

    const formData = new FormData();
    for (const item of accepted) {
      formData.append("files", item.file);
      formData.append("checksums", item.checksum);
      setUploadItem(item.itemId, {
        progress: 35,
        status: "uploading",
        message: "Uploading",
      });
    }

    try {
      const data = await uploadWithProgress(formData, (progress) => {
        const percent = Math.min(90, 35 + Math.round(progress * 55));
        for (const item of accepted) {
          setUploadItem(item.itemId, {
            progress: percent,
            status: "uploading",
            message: "Uploading",
          });
        }
      });

      for (const item of accepted) {
        setUploadItem(item.itemId, {
          progress: 95,
          status: "reading",
          message: "Reading and validating",
        });
      }

      const rejectedByChecksum = new Map(
        (data.rejected ?? []).map((item) => [item.checksum, item.reason])
      );
      const duplicatesByChecksum = new Map(
        (data.duplicates ?? []).map((item) => [item.checksum, item])
      );
      for (const item of accepted) {
        const rejectedReason = rejectedByChecksum.get(item.checksum);
        const duplicatePrompt = duplicatesByChecksum.get(item.checksum);
        const processedInvoice = data.processed?.find(
          (invoice): invoice is UploadedInvoice =>
            Boolean(invoice && invoice.checksum === item.checksum)
        );

        if (duplicatePrompt) {
          setUploadItem(item.itemId, {
            progress: 100,
            status: "duplicate",
            message: duplicatePrompt.reason,
          });
          continue;
        }

        if (rejectedReason) {
          setUploadItem(item.itemId, {
            progress: 100,
            status: "error",
            message: rejectedReason,
          });
          continue;
        }

        setUploadItem(item.itemId, {
          progress: 100,
          status: processedInvoice?.status === "Validation Failed" ? "error" : "success",
          message: processedInvoice
            ? `Processed - ${displayStatus(processedInvoice.status)}`
            : "Processed",
        });
      }

      setState((current) => ({ ...current, invoices: data.invoices }));
      const duplicateUploads = data.duplicates ?? [];
      if (duplicateUploads.length) {
        setDuplicatePrompts((current) => {
          const existing = new Set(
            current.map((item) => `${item.duplicateInvoiceId}:${item.checksum ?? ""}`)
          );
          return [
            ...current,
            ...duplicateUploads.filter(
              (item) => !existing.has(`${item.duplicateInvoiceId}:${item.checksum ?? ""}`)
            ),
          ];
        });
      }
      const firstProcessed =
        data.processed?.find((invoice): invoice is UploadedInvoice => Boolean(invoice)) ??
        data.invoices[0];
      if (firstProcessed) {
        setSelectedInvoiceId(firstProcessed.id);
      }

      const rejectedCount = data.rejected?.length ?? 0;
      const duplicateCount = data.duplicates?.length ?? 0;
      setMessage(
        rejectedCount || duplicateCount
          ? `Processed ${accepted.length - rejectedCount - duplicateCount} invoice file(s), found ${duplicateCount} duplicate(s), rejected ${rejectedCount}.`
          : `Processed ${accepted.length} invoice file(s).`
      );
      flashButton("upload", "success");
    } catch (error) {
      for (const item of accepted) {
        setUploadItem(item.itemId, {
          progress: 100,
          status: "error",
          message: error instanceof Error ? error.message : "Upload failed.",
        });
      }
      setMessage(error instanceof Error ? error.message : "Upload failed.");
      flashButton("upload", "error");
    } finally {
      setBusy("");
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  function handleFileInput(event: ChangeEvent<HTMLInputElement>) {
    if (event.target.files?.length) {
      processFiles(event.target.files);
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    processFiles(event.dataTransfer.files);
  }

  async function connectExact() {
    setBusy("exact");
    try {
      const response = await fetch("/api/exact/connect", { method: "POST" });
      const data = await readApiJson(response);

      if (!response.ok) {
        throw new Error(data.error ?? "Exact Online connection failed.");
      }

      if (data.requiresRedirect && data.authorizationUrl) {
        setMessage("Redirecting to Exact Online to authorize INTO.");
        window.location.assign(data.authorizationUrl);
        return;
      }

      setState((current) => ({
        ...current,
        invoices: data.invoices ?? current.invoices,
        exactConnection: data.connection,
        exactMasterData: data.masterData,
        exactMasterDataStale: false,
        exactMasterDataReadOnly: true,
      }));
      setMessage(
        data.mode === "real"
          ? "Exact Online is connected and master data is synced."
          : "Exact Online mock connection is active and master data is synced."
      );
      flashButton("exact", "success");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Exact Online connection failed."
      );
      flashButton("exact", "error");
    } finally {
      setBusy("");
    }
  }

  async function syncExactData(options: { silent?: boolean } = {}) {
    if (!options.silent) {
      setBusy("exact-sync");
    }

    try {
      const response = await fetch("/api/exact/sync", { method: "POST" });
      const data = await readApiJson(response);

      if (!response.ok) {
        throw new Error(data.error ?? "Exact master-data sync failed.");
      }

      setState((current) => ({
        ...current,
        invoices: data.invoices ?? current.invoices,
        exactMasterData: data.masterData,
        exactMasterDataStale: false,
        exactMasterDataReadOnly: true,
      }));

      if (!options.silent) {
        setMessage("Exact master data synced from Exact Online.");
        flashButton("exact-sync", "success");
      }
    } catch (error) {
      if (!options.silent) {
        setMessage(
          error instanceof Error ? error.message : "Exact master-data sync failed."
        );
        flashButton("exact-sync", "error");
      }
      throw error;
    } finally {
      if (!options.silent) {
        setBusy("");
      }
    }
  }

  async function disconnectExact() {
    setBusy("exact-disconnect");
    try {
      const response = await fetch("/api/exact/disconnect", { method: "POST" });
      const data = await readApiJson(response);

      if (!response.ok) {
        throw new Error(data.error ?? "Exact disconnect failed.");
      }

      setState((current) => ({
        ...current,
        invoices: data.invoices ?? current.invoices,
        exactConnection: data.connection,
        exactMasterData: data.masterData,
        exactMasterDataStale: true,
      }));
      setMessage("Exact Online disconnected. Local OAuth tokens were removed.");
      flashButton("exact-disconnect", "success");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Exact disconnect failed.");
      flashButton("exact-disconnect", "error");
    } finally {
      setBusy("");
    }
  }

  async function saveDraft() {
    if (!selectedInvoice || !draft) {
      return;
    }

    if (!hasPermission("edit")) {
      setMessage("Your INTO account is not verified for invoice edits.");
      return;
    }

    setBusy("save");
    try {
      const response = await fetch(`/api/invoices/${selectedInvoice.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          extractedData: draft,
          bookingLines: bookingLinePayloads,
        }),
      });
      const data = await readApiJson(response);

      if (!response.ok) {
        throw new Error(data.error ?? "Save failed.");
      }

      setState((current) => ({ ...current, invoices: data.invoices }));
      setMessage("Review changes saved and validation reran.");
      flashButton("save", "success");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Save failed.");
      flashButton("save", "error");
    } finally {
      setBusy("");
    }
  }

  async function learnSelectedInvoice() {
    if (!selectedInvoice || !draft) {
      return;
    }

    const disabledReason = learnDisabledReason(selectedInvoice);
    if (disabledReason) {
      setMessage(disabledReason);
      return;
    }

    setBusy("learn");
    try {
      const response = await fetch(`/api/invoices/${selectedInvoice.id}/learn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestKey: `learn-${selectedInvoice.id}-${selectedInvoice.revision}`,
          expectedRevision: selectedInvoice.revision,
          extractedData: draft,
          bookingLines: bookingLinePayloads,
        }),
      });
      const data = (await readApiJson(response)) as {
        invoice?: UploadedInvoice;
        message?: string;
        error?: string;
      };
      if (!response.ok || !data.invoice) {
        if (response.status === 409 && data.invoice) {
          setState((current) => ({
            ...current,
            invoices: current.invoices.map((invoice) =>
              invoice.id === data.invoice!.id ? data.invoice! : invoice
            ),
          }));
        }
        throw new Error(data.error ?? "Learning could not be saved.");
      }

      setState((current) => ({
        ...current,
        invoices: current.invoices.map((invoice) =>
          invoice.id === data.invoice!.id ? data.invoice! : invoice
        ),
      }));
      setMessage(data.message ?? "Learning saved for this supplier.");
      flashButton("learn", "success");
      try {
        await refreshSupplierLearning();
      } catch {
        setMessage(
          "Supplier learning was saved, but its summary could not be refreshed."
        );
      }
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Learning could not be saved."
      );
      flashButton("learn", "error");
    } finally {
      setBusy("");
    }
  }

  async function confirmResetSupplierLearning() {
    if (!learningResetTarget) {
      return;
    }

    setBusy(`reset-learning-${learningResetTarget.supplierAccountId}`);
    try {
      const response = await fetch(
        `/api/suppliers/${encodeURIComponent(
          learningResetTarget.supplierAccountId
        )}/learning/reset`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            expectedGeneration: learningResetTarget.generation,
          }),
        }
      );
      const data = (await readApiJson(response)) as {
        profile?: SupplierLearningProfile;
        error?: string;
      };
      if (!response.ok || !data.profile) {
        if (response.status === 409) {
          await refreshSupplierLearning();
          setLearningResetTarget(null);
        }
        throw new Error(data.error ?? "Supplier learning reset failed.");
      }
      applyResetProfile(learningResetTarget, data.profile);
      setLearningResetTarget(null);
      setMessage(`Learning reset for ${learningResetTarget.supplierName}.`);
      flashButton(
        `reset-learning-${learningResetTarget.supplierAccountId}`,
        "success"
      );
      try {
        await refreshSupplierLearning();
      } catch {
        setMessage(
          "Supplier learning was reset, but its summary could not be refreshed."
        );
      }
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Supplier learning reset failed."
      );
      flashButton(
        `reset-learning-${learningResetTarget.supplierAccountId}`,
        "error"
      );
    } finally {
      setBusy("");
    }
  }

  async function applyIntelligenceAction(
    action: "approve" | "selectSupplier",
    accountId?: string
  ) {
    if (!selectedInvoice) {
      return;
    }

    const busyKey =
      action === "approve" ? "approve-intelligence" : `supplier-${accountId}`;
    setBusy(busyKey);
    try {
      const response = await fetch(
        `/api/invoices/${selectedInvoice.id}/intelligence`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            accountId,
            ...(action === "selectSupplier" && hasUnsavedChanges && draft
              ? {
                  expectedRevision: selectedInvoice.revision,
                  extractedData: draft,
                  bookingLines: bookingLinePayloads,
                }
              : {}),
          }),
        }
      );
      const data = (await readApiJson(response)) as {
        invoice?: UploadedInvoice;
        invoices?: UploadedInvoice[];
        error?: string;
      };

      if (!response.ok) {
        if (response.status === 409 && data.invoice) {
          setState((current) => ({
            ...current,
            invoices: current.invoices.map((invoice) =>
              invoice.id === data.invoice!.id ? data.invoice! : invoice
            ),
          }));
        }
        throw new Error(data.error ?? "Could not save purchase journal decision.");
      }

      setState((current) => ({
        ...current,
        invoices: data.invoices ?? current.invoices,
      }));
      setMessage(
        action === "selectSupplier"
          ? "Supplier decision saved and future matches will use it."
          : "Purchase Journal intelligence approved."
      );
      flashButton(busyKey, "success");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Could not save purchase journal decision."
      );
      flashButton(busyKey, "error");
    } finally {
      setBusy("");
    }
  }

  async function resolveDuplicatePrompt(
    prompt: DuplicateUploadPrompt,
    decision: "re_read" | "keep_existing" | "cancel_upload"
  ) {
    const busyKey = `duplicate-${decision}-${prompt.duplicateInvoiceId}`;
    setBusy(busyKey);

    try {
      const response = await fetch(
        `/api/invoices/${prompt.duplicateInvoiceId}/duplicate-resolution`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            decision,
            detectionOutcome: prompt.detection.outcome,
            message: prompt.reason,
          }),
        }
      );
      const data = await readApiJson(response);

      if (!response.ok) {
        throw new Error(data.error ?? "Duplicate decision failed.");
      }

      setState((current) => ({
        ...current,
        invoices: data.invoices ?? current.invoices,
      }));
      setDuplicatePrompts((current) =>
        current.filter(
          (item) =>
            !(
              item.duplicateInvoiceId === prompt.duplicateInvoiceId &&
              item.checksum === prompt.checksum
            )
        )
      );
      setSelectedInvoiceId(prompt.duplicateInvoiceId);
      setMessage(
        decision === "re_read"
          ? "INTO re-read the existing processed invoice and kept the previous extraction in history."
          : decision === "keep_existing"
            ? "Existing processed invoice kept and highlighted."
            : "Duplicate upload cancelled."
      );
      flashButton(busyKey, "success");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Duplicate decision failed."
      );
      flashButton(busyKey, "error");
    } finally {
      setBusy("");
    }
  }

  async function resolveSelectedDuplicate(decision: "continue_anyway" | "re_read" | "cancel_upload") {
    if (!selectedInvoice?.duplicateDetection) {
      return;
    }

    const busyKey = `selected-duplicate-${decision}`;
    setBusy(busyKey);
    try {
      const response = await fetch(
        `/api/invoices/${selectedInvoice.id}/duplicate-resolution`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            decision,
            detectionOutcome: selectedInvoice.duplicateDetection.outcome,
            message: selectedInvoice.duplicateDetection.message,
          }),
        }
      );
      const data = await readApiJson(response);

      if (!response.ok) {
        throw new Error(data.error ?? "Duplicate decision failed.");
      }

      setState((current) => ({
        ...current,
        invoices: data.invoices ?? current.invoices,
      }));
      setSelectedInvoiceId(data.invoice?.id ?? data.invoices?.[0]?.id ?? "");
      setMessage(
        decision === "continue_anyway"
          ? "Duplicate warning cleared and invoice kept for processing."
          : decision === "re_read"
            ? "INTO re-read the invoice and saved the previous extraction in history."
            : "Duplicate invoice upload cancelled."
      );
      flashButton(busyKey, "success");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Duplicate decision failed."
      );
      flashButton(busyKey, "error");
    } finally {
      setBusy("");
    }
  }

  async function rereadSelectedInvoice() {
    if (!selectedInvoice) {
      return;
    }

    const key = `reread-${selectedInvoice.id}`;
    setBusy(key);
    try {
      const response = await fetch(
        `/api/invoices/${selectedInvoice.id}/duplicate-resolution`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            decision: "re_read",
            detectionOutcome:
              selectedInvoice.duplicateDetection?.outcome ?? "processed_unbooked",
            message: "User requested a fresh read from the original invoice.",
          }),
        }
      );
      const data = await readApiJson(response);

      if (!response.ok) {
        throw new Error(data.error ?? "Re-read failed.");
      }

      setState((current) => ({
        ...current,
        invoices: data.invoices ?? current.invoices,
      }));
      setSelectedInvoiceId(data.invoice?.id ?? selectedInvoice.id);
      setMessage("Invoice re-read from the original file and validation reran.");
      flashButton(key, "success");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Re-read failed.");
      flashButton(key, "error");
    } finally {
      setBusy("");
    }
  }

  async function markSelectedNeedsReview() {
    if (!selectedInvoice) {
      return;
    }

    const key = `needs-review-${selectedInvoice.id}`;
    setBusy(key);
    try {
      const response = await fetch(
        `/api/invoices/${selectedInvoice.id}/review-action`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "needs_review",
            reason: "Marked as needs review by user.",
          }),
        }
      );
      const data = await readApiJson(response);

      if (!response.ok) {
        throw new Error(data.error ?? "Could not mark invoice for review.");
      }

      setState((current) => ({
        ...current,
        invoices: data.invoices ?? current.invoices,
      }));
      setSelectedInvoiceId(data.invoice?.id ?? selectedInvoice.id);
      setMessage("Invoice marked as needing review.");
      flashButton(key, "success");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Could not mark invoice for review."
      );
      flashButton(key, "error");
    } finally {
      setBusy("");
    }
  }

  async function bookInvoice(invoiceId: string) {
    const key = `book-${invoiceId}`;
    setBusy(key);
    try {
      const response = await fetch(`/api/invoices/${invoiceId}/book`, {
        method: "POST",
      });
      const data = await readApiJson(response);

      setState((current) => ({
        ...current,
        invoices: current.invoices.map((invoice) =>
          invoice.id === data.invoice?.id ? data.invoice : invoice
        ),
      }));

      if (!response.ok) {
        throw new Error(data.error ?? "Booking failed.");
      }

      setMessage("Invoice booked into mock Exact Online.");
      flashButton(key, "success");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Booking failed.");
      flashButton(key, "error");
    } finally {
      setBusy("");
    }
  }

  async function bookAllReady() {
    const blockedReadyInvoice = state.invoices.find(
      (invoice) =>
        invoice.status === "Ready to Book" && bookingLineDisabledReason(invoice)
    );
    if (blockedReadyInvoice) {
      setMessage(
        `${blockedReadyInvoice.fileName}: ${bookingLineDisabledReason(blockedReadyInvoice)}`
      );
      flashButton("book-all", "error");
      return;
    }

    setBusy("book-all");
    try {
      const response = await fetch("/api/invoices/book-ready", { method: "POST" });
      const data = await readApiJson(response);

      if (!response.ok) {
        throw new Error(data.error ?? "Bulk booking failed.");
      }

      setState((current) => ({ ...current, invoices: data.invoices }));
      setMessage("Ready invoices were sent to mock Exact Online.");
      flashButton("book-all", "success");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Bulk booking failed.");
      flashButton("book-all", "error");
    } finally {
      setBusy("");
    }
  }

  function updateDraft(field: keyof ExtractedInvoiceData, value: string) {
    setDraft((current) => {
      if (!current) {
        return current;
      }

      if (field === "netAmount" || field === "vatAmount" || field === "grossAmount") {
        return { ...current, [field]: value === "" ? null : Number(value) };
      }

      return { ...current, [field]: value };
    });
  }

  function updateBookingLine(
    index: number,
    patch: Partial<BookingLineDraft>
  ) {
    setBookingLineDrafts((current) =>
      current.map((line, lineIndex) =>
        lineIndex === index ? { ...line, ...patch } : line
      )
    );
    if (index === 0 && typeof patch.description === "string") {
      updateDraft("expenseDescription", patch.description);
    }
  }

  function updateBookingLineGl(index: number, value: string) {
    const exactAccount = state.exactMasterData?.glAccounts.find(
      (account) => `${account.code} - ${account.name}` === value
    );
    const parsed = splitExactOption(value);
    const code = exactAccount?.code ?? parsed.code;
    const name = exactAccount?.name ?? parsed.name;

    updateBookingLine(index, {
      glAccount: code,
      glAccountName: name,
      finalSelectedAccount: code,
    });
  }

  function updateBookingLineVat(index: number, value: string) {
    const parsed = splitExactOption(value);
    const exactVat = state.exactMasterData?.vatCodes.find(
      (vatCode) =>
        vatCode.code === parsed.code &&
        vatCode.type === "purchase" &&
        vatCode.isActive &&
        isIntoPurchaseVatCode(vatCode.code)
    );

    updateBookingLine(index, {
      vatCode: (exactVat?.code ?? parsed.code) as PurchaseJournalLine["vatCode"],
      vatCodeName: exactVat?.description ?? parsed.name,
      percentage: exactVat?.percentage ?? bookingLineDrafts[index]?.percentage ?? 0,
      vatReasoning: (bookingLineDrafts[index]?.vatReasoning ?? []).filter(
        (reason) => reason !== UNSUPPORTED_VAT_CODE_WARNING
      ),
    });
  }

  async function importSupplierOverview(file: File) {
    setBusy("supplier-overview-import");
    try {
      const formData = new FormData();
      formData.append("file", file);
      const response = await fetch("/api/exact/suppliers/import", {
        method: "POST",
        body: formData,
      });
      const data = (await readApiJson(response)) as {
        supplierOverviewImport?: SupplierOverviewImportStatus;
        masterData?: ExactMasterDataCache;
        invoices?: UploadedInvoice[];
        error?: string;
      };
      if (!response.ok) {
        throw new Error(data.error ?? "Supplier overview import failed.");
      }

      setState((current) => ({
        ...current,
        invoices: data.invoices ?? current.invoices,
        exactMasterData: data.masterData ?? current.exactMasterData,
        exactMasterDataStale: data.masterData
          ? new Date(data.masterData.staleAfter).getTime() <= Date.now()
          : current.exactMasterDataStale,
        supplierOverviewImport:
          data.supplierOverviewImport ?? current.supplierOverviewImport,
      }));
      setMessage(
        `Imported ${data.supplierOverviewImport?.supplierCount ?? 0} Exact suppliers from ${file.name}.`
      );
      flashButton("supplier-overview-import", "success");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Supplier overview import failed."
      );
      flashButton("supplier-overview-import", "error");
    } finally {
      setBusy("");
      if (supplierOverviewInputRef.current) {
        supplierOverviewInputRef.current.value = "";
      }
    }
  }

  function handleSupplierOverviewInput(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) importSupplierOverview(file);
  }

  function updateBookingLineAmount(
    index: number,
    field: "amount" | "vatAmount",
    value: string
  ) {
    const amount = amountFromInput(value) ?? 0;
    updateBookingLine(index, {
      [field]: amount,
      [`${field}Input`]: value,
    } as Partial<BookingLineDraft>);
  }

  function addBookingLine() {
    setBookingLineDrafts((current) => [
      ...current,
      blankBookingLineDraft(current[0]),
    ]);
  }

  function deleteBookingLine(index: number) {
    const nextLines = bookingLineDrafts.filter((_, lineIndex) => lineIndex !== index);
    setBookingLineDrafts(nextLines);
    if (index === 0) {
      updateDraft("expenseDescription", nextLines[0]?.description ?? "");
    }
  }

  function downloadOriginal() {
    if (!selectedInvoice || previewFileStatus !== "available") {
      setMessage(missingInvoiceFileMessage);
      return;
    }

    const link = document.createElement("a");
    link.href = `/api/invoices/${selectedInvoice.id}/file?download=1`;
    link.download = selectedInvoice.fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  async function copyExtractedText() {
    const extractedText = selectedInvoice?.extractedData.rawText?.trim();
    if (!extractedText) {
      setMessage("No extracted invoice text is available to copy.");
      return;
    }

    try {
      await navigator.clipboard.writeText(extractedText);
      setMessage("Extracted invoice text copied.");
    } catch {
      setMessage("Extracted invoice text could not be copied.");
    }
  }

  function busyDisabledReason(actionKey: string) {
    return busy && busy !== actionKey ? "Another invoice action is already running." : "";
  }

  function saveChangesDisabledReason() {
    const busyReason = busyDisabledReason("save");
    if (busyReason) {
      return busyReason;
    }

    if (!hasPermission("edit")) {
      return "Your INTO account is not verified for invoice edits.";
    }

    if (!hasUnsavedChanges) {
      return "Save changes is disabled because there are no unsaved changes.";
    }

    return "";
  }

  function learnDisabledReason(invoice: UploadedInvoice) {
    const busyReason = busyDisabledReason("learn");
    if (busyReason) {
      return busyReason;
    }

    if (!hasPermission("train")) {
      return "Your INTO account is not verified for supplier training.";
    }

    const activeSupplierGeneration = invoice.learningMetadata
      ? supplierLearningByAccount.get(invoice.learningMetadata.supplierAccountId)
          ?.generation
      : undefined;
    const canRelearnAfterReset = Boolean(
      invoice.learningMetadata &&
        typeof activeSupplierGeneration === "number" &&
        activeSupplierGeneration > invoice.learningMetadata.generation
    );

    if (
      invoice.status === "Reading" ||
      invoice.status === "Booked" ||
      ((invoice.status === "Learned" ||
        invoice.processingPurpose === "learning_only") &&
        !canRelearnAfterReset)
    ) {
      return "This invoice cannot be saved as a new learning example.";
    }

    if (!selectedPurchaseJournal?.supplierResolution.selectedAccountId) {
      return "Select one Exact supplier before saving learning.";
    }

    if (
      !draft?.rawText?.trim() &&
      (!draft?.documentTextMode || draft.documentTextMode === "unavailable")
    ) {
      return "Document analysis must finish before saving learning.";
    }

    const trainableValue =
      draft.referenceCode ||
      draft.invoiceDate ||
      draft.paymentTerms ||
      draft.expenseDescription ||
      typeof draft.netAmount === "number" ||
      typeof draft.vatAmount === "number" ||
      typeof draft.grossAmount === "number" ||
      bookingLinePayloads.length > 0;
    if (!trainableValue) {
      return "Add at least one trainable invoice or booking field.";
    }

    return "";
  }

  function reReadDisabledReason(invoice: UploadedInvoice) {
    const actionKey = `reread-${invoice.id}`;
    const busyReason = busyDisabledReason(actionKey);
    if (busyReason) {
      return busyReason;
    }

    if (!hasPermission("edit")) {
      return "Your INTO account is not verified to re-read invoices.";
    }

    if (invoice.status === "Reading") {
      return "Re-read invoice is disabled while extraction is already running.";
    }

    if (invoice.status === "Booked") {
      return "Booked invoices cannot be re-read.";
    }

    if (!invoice.storageKey) {
      return "Re-read invoice is disabled because the original invoice attachment is missing.";
    }

    return "";
  }

  function markReviewedDisabledReason(invoice: UploadedInvoice) {
    const busyReason = busyDisabledReason("approve-intelligence");
    if (busyReason) {
      return busyReason;
    }

    if (!hasPermission("approve")) {
      return "Your INTO account is not verified for review approval.";
    }

    if (hasUnsavedChanges) {
      return "Save changes before marking this invoice as reviewed.";
    }

    if (invoice.status === "Booked") {
      return "This invoice is already booked.";
    }

    if (invoice.status === "Ready to Book") {
      return "This invoice is already reviewed and ready to book.";
    }

    if (!selectedPurchaseJournal) {
      return "Invoice must be read before it can be marked as reviewed.";
    }

    if (selectedPurchaseJournal.supplierResolution.reviewRequired) {
      return (
        selectedPurchaseJournal.supplierResolution.reasoning[0] ??
        "Select the correct Exact supplier before marking this invoice as reviewed."
      );
    }

    if (!selectedPurchaseJournal.attachmentPresent) {
      return "Mark as reviewed is disabled because the invoice attachment is missing.";
    }

    if (!selectedPurchaseJournal.yourRef || !selectedPurchaseJournal.yourRefUnique) {
      return "Mark as reviewed is disabled until Your ref. is present and unique.";
    }

    if (!canApproveSelectedIntelligence) {
      return "Fix validation warnings before marking this invoice as reviewed.";
    }

    return "";
  }

  function bookingLineDisabledReason(invoice: UploadedInvoice) {
    if (
      selectedInvoice?.id === invoice.id &&
      selectedBookingLineDisabledReason
    ) {
      return selectedBookingLineDisabledReason;
    }

    return (
      getBookingBlockers(
        invoice.extractedData,
        invoice.purchaseJournal,
        state.exactMasterData
      )[0]?.message ?? ""
    );
  }

  function bookDisabledReason(invoice: UploadedInvoice) {
    if (!hasPermission("book")) {
      return "Your INTO account is not verified for invoice booking.";
    }

    if (requiredBookingIssuesForInvoice(invoice).length > 0) {
      return REQUIRED_BOOKING_DISABLED_REASON;
    }

    if (hasUnsavedChanges) {
      return "Save changes before booking so validation uses your latest values.";
    }

    const bookingLineReason = bookingLineDisabledReason(invoice);
    if (bookingLineReason) {
      return bookingLineReason;
    }

    if (!state.exactConnection) {
      return "Connect the company Exact account before booking.";
    }

    if (!state.exactMasterData || state.exactMasterDataStale) {
      return "Sync Exact data before booking so INTO can validate Exact master records.";
    }

    if (!invoice.purchaseJournal?.attachmentPresent) {
      return "Book invoice is disabled because the original invoice attachment is missing.";
    }

    if (invoice.purchaseJournal?.supplierResolution.reviewRequired) {
      return "Book invoice is disabled because the supplier is unresolved.";
    }

    if (invoice.status !== "Ready to Book") {
      return "Book Invoice is disabled because this invoice still needs validation or review.";
    }

    return "";
  }

  function bookReviewDisabledReason(invoice: UploadedInvoice) {
    const actionKey = `book-${invoice.id}`;
    const busyReason = busyDisabledReason(actionKey);
    return busyReason || bookDisabledReason(invoice);
  }

  function needsReviewDisabledReason(invoice: UploadedInvoice) {
    const actionKey = `needs-review-${invoice.id}`;
    const busyReason = busyDisabledReason(actionKey);
    if (busyReason) {
      return busyReason;
    }

    if (!hasPermission("review")) {
      return "Your INTO account is not verified to mark invoices as needing review.";
    }

    if (invoice.status === "Booked") {
      return "Booked invoices cannot be rejected or moved back to review.";
    }

    if (reviewStatuses.has(invoice.status)) {
      return "This invoice is already marked as needing review.";
    }

    return "";
  }

  function reviewInputType(field: keyof ExtractedInvoiceData) {
    const fieldName = String(field);
    if (fieldName.includes("Date")) {
      return "date";
    }
    if (fieldName.includes("Amount")) {
      return "number";
    }
    return "text";
  }

  function reviewInputValue(field: keyof ExtractedInvoiceData) {
    if (!draft) {
      return "";
    }

    const value = draft[field];
    return String(field).includes("Amount")
      ? numberValue(value as number | null)
      : String(value ?? "");
  }

  function renderEditableReviewField(
    label: string,
    field: keyof ExtractedInvoiceData,
    options: { helper?: string; emphasized?: boolean } = {}
  ) {
    const issue = validationIssueFor([field]);
    if (reviewInputType(field) === "date") {
      return (
        <DateField
          key={String(field)}
          label={label}
          value={reviewInputValue(field)}
          onChange={(value) => updateDraft(field, value)}
          disabled={!hasPermission("edit")}
          issue={issue}
        />
      );
    }

    if (reviewInputType(field) === "number") {
      return (
        <AmountField
          key={String(field)}
          label={label}
          value={draft?.[field] as number | null}
          currency={currentCurrency}
          onChange={(value) => updateDraft(field, value)}
          disabled={!hasPermission("edit")}
          issue={issue}
          emphasized={options.emphasized}
        />
      );
    }

    return (
      <TextField
        key={String(field)}
        label={label}
        value={reviewInputValue(field)}
        onChange={(value) => updateDraft(field, value)}
        disabled={!hasPermission("edit")}
        issue={issue}
        helper={options.helper}
      />
    );
  }

  return (
    <main className="min-h-screen bg-[#f6f7f4] text-[#171b1d]">
      <div className="mx-auto flex max-w-[1560px] flex-col gap-5 px-5 py-5 lg:px-8">
        <header className="flex flex-col gap-4 border-b border-stone-300 pb-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-sm font-semibold text-emerald-800">INTO</p>
            <h1 className="mt-1 text-3xl font-semibold">
              Invoice booking automation
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-stone-600">
              Bulk upload invoices, review extracted fields, validate every total,
              and book approved purchases into Exact Online.
            </p>
          </div>
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-4 gap-2 text-center">
              {[
                ["Total", stats.total],
                ["Ready", stats.ready],
                ["Need check", stats.needsCheck],
                ["Booked", stats.booked],
              ].map(([label, value]) => (
                <div
                  key={label}
                  className="min-w-20 rounded-lg border border-stone-300 bg-white px-3 py-2"
                >
                  <div className="text-lg font-semibold">{value}</div>
                  <div className="text-xs text-stone-500">{label}</div>
                </div>
              ))}
            </div>
            <div className="flex justify-end">
              <span className="mr-3 self-center text-sm text-stone-600">
                {actor ? `Signed in as ${actor.displayName}` : "Shared access"}
              </span>
              <ActionButton
                variant="ghost"
                onClick={lockInto}
                loading={busy === "lock-into"}
                disabled={busy === "lock-into"}
                disabledReason="INTO is being locked."
              >
                {actor ? "Logout" : "Lock INTO"}
              </ActionButton>
            </div>
          </div>
        </header>


        <section className="grid gap-4 xl:grid-cols-[1.45fr_0.55fr]">
          <div className="rounded-lg border border-stone-300 bg-white p-4">
            <div
              onClick={() => {
                if (hasPermission("upload")) {
                  fileInputRef.current?.click();
                }
              }}
              onDragEnter={(event) => {
                event.preventDefault();
                setIsDragging(true);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              className={`flex min-h-36 flex-col justify-center rounded-md border-2 border-dashed p-5 transition ${
                hasPermission("upload") ? "cursor-pointer" : "cursor-not-allowed"
              } ${
                isDragging
                  ? "border-emerald-500 bg-emerald-50"
                  : "border-stone-300 bg-stone-50 hover:border-emerald-400 hover:bg-emerald-50/50"
              }`}
            >
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <h2 className="text-lg font-semibold">Bulk upload</h2>
                  <p className="mt-1 text-sm text-stone-500">
                    Drop multiple invoices here or browse from your computer.
                  </p>
                  <p className="mt-2 text-xs font-semibold text-stone-600">
                    Accepted file types: {acceptedLabel}
                  </p>
                </div>
                <ActionButton
                  onClick={() => fileInputRef.current?.click()}
                  loading={busy === "upload"}
                  feedback={buttonFeedbackFor("upload", "upload")}
                  disabled={busy === "upload" || !hasPermission("upload")}
                  disabledReason={
                    !hasPermission("upload")
                      ? "Your INTO account is not verified for invoice uploads."
                      : "Upload is already running."
                  }
                >
                  Browse files
                </ActionButton>
              </div>
              <input
                ref={fileInputRef}
                className="sr-only"
                name="files"
                type="file"
                multiple
                accept=".pdf,.jpg,.jpeg,.png,.xml,.ubl,application/pdf,image/jpeg,image/png,text/xml,application/xml"
                onChange={handleFileInput}
              />
            </div>
            <UploadProgressList items={uploadItems} />
          </div>

          {hasPermission("manage_connections") ? (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-1">
                <div className="rounded-lg border border-stone-300 bg-white p-4">
                  <h2 className="text-lg font-semibold">Company Exact Online</h2>
                  <p className="mt-1 text-sm text-stone-500">
                    {state.exactConnection
                      ? `Company connection active for division ${state.exactConnection.divisionCode}`
                      : "No company Exact account connected"}
                  </p>
                  <div className="mt-3 rounded-md border border-sky-200 bg-sky-50 p-3 text-xs text-sky-950">
                    <div className="font-semibold text-sky-950">
                      Exact OAuth setup
                    </div>
                    <ul className="mt-2 list-disc space-y-1 pl-4">
                      <li>
                        Local development: put Exact OAuth details in `.env` or
                        `.env.local`.
                      </li>
                      <li>
                        Vercel: put Exact OAuth details in Project Settings &gt;
                        Environment Variables, then redeploy.
                      </li>
                      <li>
                        Required variables: `EXACT_ONLINE_CLIENT_ID`,
                        `EXACT_ONLINE_CLIENT_SECRET`, `EXACT_ONLINE_REDIRECT_URI`,
                        and `OAUTH_TOKEN_ENCRYPTION_KEY`.
                      </li>
                      <li>
                        `EXACT_ONLINE_CLIENT_ID` must be the Exact OAuth app
                        Client ID, not an email address.
                      </li>
                      <li>
                        INTO never asks for or stores an Exact username or
                        password. Exact login happens on Exact Online&apos;s OAuth
                        page, then INTO stores encrypted OAuth tokens.
                      </li>
                      <li>
                        After connecting Exact, run Sync Exact Data Now to load
                        suppliers, journals, G/L accounts, VAT codes, cost
                        centers, cost units, and payment conditions.
                      </li>
                    </ul>
                  </div>
                  {state.exactConfiguration ? (
                    state.exactConfiguration.ready &&
                    state.exactConfiguration.mode === "real" ? (
                      <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-xs font-semibold text-emerald-900">
                        Exact OAuth credentials are configured on the server.
                      </div>
                    ) : (
                      <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950">
                        <div className="font-semibold">
                          {state.exactConfiguration.clientIdLooksLikeEmail
                            ? "EXACT_ONLINE_CLIENT_ID must be the Exact OAuth app Client ID, not an email address."
                            : "Exact OAuth setup is incomplete."}
                        </div>
                        {state.exactConfiguration.missingEnv.length ? (
                          <div className="mt-1">
                            Add these server settings in Vercel, then redeploy:{" "}
                            {state.exactConfiguration.missingEnv.join(", ")}.
                          </div>
                        ) : null}
                      </div>
                    )
                  ) : null}
                  {state.exactMasterDataReadOnly ? (
                    <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-xs font-semibold text-emerald-900">
                      Exact master data is read-only in INTO. Suppliers, journals, G/L
                      accounts, VAT codes, cost centers, cost units, and payment
                      conditions are only read and cached.
                    </div>
                  ) : null}
                  {state.exactMasterData ? (
                    <div className="mt-3 rounded-md border border-stone-200 bg-stone-50 p-3 text-xs text-stone-600">
                      <div className="font-semibold text-stone-800">
                        Exact data cache{" "}
                        {state.exactMasterDataStale ? "stale" : "fresh"}
                      </div>
                      <div className="mt-1">
                        Last synced{" "}
                        {formatTimestamp(state.exactMasterData.lastSyncedAt)}
                      </div>
                      <div className="mt-1">
                        {state.exactMasterData.suppliers.length} suppliers,{" "}
                        {state.exactMasterData.glAccounts.length} G/L accounts,{" "}
                        {state.exactMasterData.vatCodes.length} VAT codes
                      </div>
                    </div>
                  ) : (
                    <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                      Exact master data has not been synced yet.
                    </div>
                  )}
                  <div className="mt-3 rounded-md border border-stone-200 bg-stone-50 p-3 text-xs text-stone-600">
                    <div className="font-semibold text-stone-800">
                      Exact supplier overview
                    </div>
                    {state.supplierOverviewImport ? (
                      <>
                        <div className="mt-1">
                          {state.supplierOverviewImport.supplierCount} suppliers imported
                          from {state.supplierOverviewImport.sourceFileName}
                        </div>
                        <div className="mt-1">
                          Last imported {formatTimestamp(state.supplierOverviewImport.importedAt)}
                        </div>
                      </>
                    ) : (
                      <div className="mt-1">
                        Import the Exact Accounts supplier overview (.xlsx) to improve
                        supplier matching.
                      </div>
                    )}
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <ActionButton
                      variant="outline"
                      onClick={connectExact}
                      loading={busy === "exact"}
                      feedback={buttonFeedbackFor("exact", "exact")}
                      disabled={
                        busy === "exact" ||
                        state.exactConfiguration?.ready !== true
                      }
                      disabledReason={
                        busy === "exact"
                          ? "Company Exact Online connection is in progress."
                          : "Configure the required Exact OAuth server settings first."
                      }
                    >
                      {state.exactConnection
                        ? "Reconnect Company Exact"
                        : "Connect Company Exact"}
                    </ActionButton>
                    <ActionButton
                      variant="secondary"
                      onClick={() => syncExactData()}
                      loading={busy === "exact-sync"}
                      feedback={buttonFeedbackFor("exact-sync", "exact-sync")}
                      disabled={
                        !state.exactConnection ||
                        busy === "exact-sync" ||
                        busy === "exact"
                      }
                      disabledReason="Connect the company Exact account before syncing Exact data."
                    >
                      Sync Exact master data
                    </ActionButton>
                    <ActionButton
                      variant="outline"
                      onClick={() => supplierOverviewInputRef.current?.click()}
                      loading={busy === "supplier-overview-import"}
                      feedback={buttonFeedbackFor(
                        "supplier-overview-import",
                        "supplier-overview-import"
                      )}
                      disabled={busy === "supplier-overview-import"}
                      disabledReason="Supplier overview import is already running."
                    >
                      {state.supplierOverviewImport
                        ? "Re-import supplier overview"
                        : "Import supplier overview"}
                    </ActionButton>
                    <input
                      ref={supplierOverviewInputRef}
                      className="sr-only"
                      type="file"
                      accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                      onChange={handleSupplierOverviewInput}
                    />
                    <ActionButton
                      variant="danger"
                      onClick={disconnectExact}
                      loading={busy === "exact-disconnect"}
                      feedback={buttonFeedbackFor(
                        "exact-disconnect",
                        "exact-disconnect"
                      )}
                      disabled={!state.exactConnection || busy === "exact-disconnect"}
                      disabledReason="Company Exact Online is not connected."
                    >
                      Disconnect Company Exact
                    </ActionButton>
                  </div>
                </div>
            </div>
          ) : null}
        </section>

        {message ? (
          <div className="rounded-lg border border-stone-300 bg-[#fffdf5] px-4 py-3 text-sm text-stone-700">
            {message}
          </div>
        ) : null}

        {duplicatePrompts.length ? (
          <section className="rounded-lg border border-fuchsia-300 bg-fuchsia-50 p-4">
            <div className="flex flex-col gap-1">
              <h2 className="text-lg font-semibold text-fuchsia-950">
                Duplicate invoice decisions
              </h2>
            </div>
            <div className="mt-3 grid gap-3">
              {duplicatePrompts.map((prompt) => {
                const alreadyBooked =
                  prompt.detection.outcome === "already_booked";
                const candidate = prompt.detection.candidates[0];

                return (
                  <div
                    key={`${prompt.duplicateInvoiceId}-${prompt.checksum ?? prompt.fileName}`}
                    className="rounded-lg border border-fuchsia-200 bg-white p-3 text-sm"
                  >
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                      <div>
                        <div className="font-semibold text-fuchsia-950">
                          {prompt.fileName}
                        </div>
                        <p className="mt-1 text-stone-700">{prompt.reason}</p>
                        <dl className="mt-2 grid gap-1 text-xs text-stone-600 sm:grid-cols-[140px_1fr]">
                          <dt>Existing record</dt>
                          <dd>{candidate?.fileName ?? prompt.duplicateInvoiceId}</dd>
                          <dt>Status</dt>
                          <dd>{candidate?.status ?? "-"}</dd>
                          <dt>Exact reference</dt>
                          <dd>{prompt.exactBookingId ?? candidate?.exactBookingId ?? "-"}</dd>
                          <dt>Match</dt>
                          <dd>
                            {candidate ? percentScore(candidate.matchScore) : "-"}{" "}
                            {candidate?.matchReasons.join(" ")}
                          </dd>
                        </dl>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {alreadyBooked ? (
                          <ActionButton
                            variant="secondary"
                            onClick={() => {
                              setSelectedInvoiceId(prompt.duplicateInvoiceId);
                              setDuplicatePrompts((current) =>
                                current.filter((item) => item !== prompt)
                              );
                            }}
                          >
                            Show existing invoice
                          </ActionButton>
                        ) : (
                          <>
                            <ActionButton
                              variant="secondary"
                              onClick={() => resolveDuplicatePrompt(prompt, "re_read")}
                              loading={
                                busy === `duplicate-re_read-${prompt.duplicateInvoiceId}`
                              }
                              feedback={buttonFeedbackFor(
                                `duplicate-re_read-${prompt.duplicateInvoiceId}`,
                                `duplicate-re_read-${prompt.duplicateInvoiceId}`
                              )}
                            >
                              Re-read invoice
                            </ActionButton>
                            <ActionButton
                              variant="outline"
                              onClick={() =>
                                resolveDuplicatePrompt(prompt, "keep_existing")
                              }
                              loading={
                                busy ===
                                `duplicate-keep_existing-${prompt.duplicateInvoiceId}`
                              }
                              feedback={buttonFeedbackFor(
                                `duplicate-keep_existing-${prompt.duplicateInvoiceId}`,
                                `duplicate-keep_existing-${prompt.duplicateInvoiceId}`
                              )}
                            >
                              Keep existing processed invoice
                            </ActionButton>
                            <ActionButton
                              variant="ghost"
                              onClick={() =>
                                resolveDuplicatePrompt(prompt, "cancel_upload")
                              }
                              loading={
                                busy ===
                                `duplicate-cancel_upload-${prompt.duplicateInvoiceId}`
                              }
                              feedback={buttonFeedbackFor(
                                `duplicate-cancel_upload-${prompt.duplicateInvoiceId}`,
                                `duplicate-cancel_upload-${prompt.duplicateInvoiceId}`
                              )}
                            >
                              Cancel upload
                            </ActionButton>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {availableViews.map((view) => (
            <ActionButton
              key={view}
              variant={visibleActiveView === view ? "secondary" : "ghost"}
              onClick={() => {
                setActiveView(view);
                if (view === "archive" && !archive) {
                  loadArchive().catch((error) =>
                    setMessage(error instanceof Error ? error.message : "Archive search failed.")
                  );
                }
              }}
              disabled={view === "archive" && !hasPermission("search_archive")}
              disabledReason="Your INTO account is not verified for archive search."
            >
              {view === "queue"
                ? "Processing queue"
                : view === "archive"
                  ? "Invoice archive"
                  : view === "users"
                    ? "Users"
                    : "Supplier learning"}
            </ActionButton>
          ))}
        </div>

        {visibleActiveView === "users" ? <IntoUsersPanel /> : null}

        {visibleActiveView === "archive" ? (
          <section className="rounded-lg border border-stone-300 bg-white p-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <h2 className="text-lg font-semibold">Invoice archive</h2>
                <p className="text-sm text-stone-500">
                  Search retained invoice records from all INTO users.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <ActionButton
                  variant="secondary"
                  onClick={() =>
                    loadArchive({ ...archiveFilters, page: 1 })
                      .then(() =>
                        setArchiveFilters((current) => ({ ...current, page: 1 }))
                      )
                      .catch((error) =>
                        setMessage(
                          error instanceof Error ? error.message : "Archive search failed."
                        )
                      )
                  }
                  loading={busy === "archive-search"}
                  disabled={!hasPermission("search_archive")}
                  disabledReason="Your INTO account is not verified for archive search."
                >
                  Search archive
                </ActionButton>
                <ActionButton
                  variant="ghost"
                  onClick={() => {
                    setArchiveFilters(defaultArchiveFilters);
                    loadArchive(defaultArchiveFilters).catch((error) =>
                      setMessage(
                        error instanceof Error ? error.message : "Archive search failed."
                      )
                    );
                  }}
                >
                  Reset filters
                </ActionButton>
              </div>
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              {[
                ["keyword", "Keyword"],
                ["supplier", "Supplier"],
                ["invoiceNumber", "Invoice / Your ref."],
                ["exactBookingReference", "Exact reference"],
                ["invoiceDateFrom", "Invoice from"],
                ["invoiceDateTo", "Invoice to"],
                ["uploadedAtFrom", "Uploaded from"],
                ["uploadedAtTo", "Uploaded to"],
                ["amountMin", "Min amount"],
                ["amountMax", "Max amount"],
                ["currency", "Currency"],
                ["journal", "Journal"],
                ["glAccount", "G/L account"],
                ["vatCode", "VAT code"],
                ["costCenter", "Cost center"],
                ["costUnit", "Cost unit"],
                ["country", "Country"],
              ].map(([field, label]) => (
                <label key={field} className="flex flex-col gap-1 text-sm">
                  <span className="font-semibold text-stone-700">{label}</span>
                  <input
                    className="rounded-md border border-stone-300 px-3 py-2"
                    type={
                      field.toLowerCase().includes("date") ||
                      field.toLowerCase().includes("from") ||
                      field.toLowerCase().includes("to")
                        ? "date"
                        : field.toLowerCase().includes("amount")
                          ? "number"
                          : "text"
                    }
                    value={String(
                      archiveFilters[field as keyof ArchiveFilterState] ?? ""
                    )}
                    onChange={(event) =>
                      setArchiveFilters((current) => ({
                        ...current,
                        [field]: event.target.value,
                        page: 1,
                      }))
                    }
                  />
                </label>
              ))}
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-semibold text-stone-700">Status</span>
                <select
                  className="rounded-md border border-stone-300 px-3 py-2"
                  value={archiveFilters.bookingStatus}
                  onChange={(event) =>
                    setArchiveFilters((current) => ({
                      ...current,
                      bookingStatus: event.target.value,
                      page: 1,
                    }))
                  }
                >
                  <option value="">All</option>
                  {Object.keys(statusTone).map((status) => (
                    <option key={status} value={status}>
                      {displayStatus(status as UploadedInvoice["status"])}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-semibold text-stone-700">Validation</span>
                <select
                  className="rounded-md border border-stone-300 px-3 py-2"
                  value={archiveFilters.validationStatus}
                  onChange={(event) =>
                    setArchiveFilters((current) => ({
                      ...current,
                      validationStatus: event.target.value,
                      page: 1,
                    }))
                  }
                >
                  <option value="">All</option>
                  <option value="valid">Valid</option>
                  <option value="warning">Warning</option>
                  <option value="error">Error</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-semibold text-stone-700">Source</span>
                <select
                  className="rounded-md border border-stone-300 px-3 py-2"
                  value={archiveFilters.source}
                  onChange={(event) =>
                    setArchiveFilters((current) => ({
                      ...current,
                      source: event.target.value,
                      page: 1,
                    }))
                  }
                >
                  <option value="">All</option>
                  <option value="manual_upload">Manual upload</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-semibold text-stone-700">Duplicate status</span>
                <select
                  className="rounded-md border border-stone-300 px-3 py-2"
                  value={archiveFilters.duplicateStatus}
                  onChange={(event) =>
                    setArchiveFilters((current) => ({
                      ...current,
                      duplicateStatus: event.target.value,
                      page: 1,
                    }))
                  }
                >
                  <option value="">All</option>
                  <option value="none">None</option>
                  <option value="already_booked">Already booked</option>
                  <option value="processed_unbooked">Processed unbooked</option>
                  <option value="possible_duplicate">Possible duplicate</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-semibold text-stone-700">Sort by</span>
                <select
                  className="rounded-md border border-stone-300 px-3 py-2"
                  value={archiveFilters.sortBy}
                  onChange={(event) =>
                    setArchiveFilters((current) => ({
                      ...current,
                      sortBy: event.target.value,
                      page: 1,
                    }))
                  }
                >
                  <option value="uploadedAt">Upload date</option>
                  <option value="invoiceDate">Invoice date</option>
                  <option value="supplier">Supplier</option>
                  <option value="amount">Amount</option>
                  <option value="status">Status</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-semibold text-stone-700">Sort direction</span>
                <select
                  className="rounded-md border border-stone-300 px-3 py-2"
                  value={archiveFilters.sortDirection}
                  onChange={(event) =>
                    setArchiveFilters((current) => ({
                      ...current,
                      sortDirection: event.target.value === "asc" ? "asc" : "desc",
                      page: 1,
                    }))
                  }
                >
                  <option value="desc">Descending</option>
                  <option value="asc">Ascending</option>
                </select>
              </label>
            </div>

            <div className="mt-4 overflow-x-auto rounded-md border border-stone-200">
              <table className="w-full min-w-[1040px] border-collapse text-left text-sm">
                <thead className="bg-stone-100 text-xs font-semibold text-stone-600">
                  <tr>
                    <th className="px-3 py-2">Invoice date</th>
                    <th className="px-3 py-2">Supplier</th>
                    <th className="px-3 py-2">Invoice</th>
                    <th className="px-3 py-2">Total</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Source</th>
                    <th className="px-3 py-2">Exact ref.</th>
                    <th className="px-3 py-2">Last updated</th>
                  </tr>
                </thead>
                <tbody>
                  {(archive?.invoices ?? []).map((invoice) => (
                    <tr
                      key={invoice.id}
                      className={`border-t border-stone-200 ${
                        selectedInvoice?.id === invoice.id ? "bg-emerald-50" : ""
                      }`}
                    >
                      <td className="px-3 py-2">
                        {invoice.extractedData.invoiceDate || "-"}
                      </td>
                      <td className="px-3 py-2">
                        <button
                          onClick={() => {
                            selectInvoice(invoice.id);
                            setActiveView("queue");
                          }}
                          className="cursor-pointer text-left font-semibold text-[#145c48] hover:underline"
                        >
                          {invoice.extractedData.supplierName || invoice.fileName}
                        </button>
                      </td>
                      <td className="px-3 py-2">
                        {invoice.extractedData.invoiceNumber ||
                          invoice.extractedData.referenceCode ||
                          "-"}
                      </td>
                      <td className="px-3 py-2">{money(invoice)}</td>
                      <td className="px-3 py-2">
                        <span
                          className={`inline-flex rounded-md border px-2 py-1 text-xs font-semibold ${
                            statusTone[invoice.status] ?? statusTone.Uploaded
                          }`}
                        >
                          {displayStatus(invoice.status)}
                        </span>
                      </td>
                      <td className="px-3 py-2">{invoice.source}</td>
                      <td className="px-3 py-2">{invoice.exactBookingId ?? "-"}</td>
                      <td className="px-3 py-2">{formatTimestamp(invoice.updatedAt)}</td>
                    </tr>
                  ))}
                  {!archive?.invoices.length ? (
                    <tr>
                      <td className="px-3 py-8 text-center text-stone-500" colSpan={8}>
                        No archived invoices match the current filters.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm text-stone-600">
              <div>
                {archive
                  ? `${archive.total} result(s), page ${archive.page} of ${archive.totalPages}`
                  : "Run a search to load archive results."}
              </div>
              <div className="flex gap-2">
                <ActionButton
                  variant="ghost"
                  onClick={() => {
                    const next = {
                      ...archiveFilters,
                      page: Math.max(1, archiveFilters.page - 1),
                    };
                    setArchiveFilters(next);
                    loadArchive(next).catch((error) =>
                      setMessage(
                        error instanceof Error ? error.message : "Archive search failed."
                      )
                    );
                  }}
                  disabled={!archive || archive.page <= 1}
                  disabledReason="Already on the first archive page."
                  className="min-h-8 px-3 py-1 text-xs"
                >
                  Previous
                </ActionButton>
                <ActionButton
                  variant="ghost"
                  onClick={() => {
                    const next = {
                      ...archiveFilters,
                      page: Math.min(
                        archive?.totalPages ?? archiveFilters.page,
                        archiveFilters.page + 1
                      ),
                    };
                    setArchiveFilters(next);
                    loadArchive(next).catch((error) =>
                      setMessage(
                        error instanceof Error ? error.message : "Archive search failed."
                      )
                    );
                  }}
                  disabled={!archive || archive.page >= archive.totalPages}
                  disabledReason="Already on the last archive page."
                  className="min-h-8 px-3 py-1 text-xs"
                >
                  Next
                </ActionButton>
              </div>
            </div>
          </section>
        ) : null}

        {state.supplierLearningEnabled && activeView === "supplier-learning" ? (
          <section className="rounded-lg border border-stone-300 bg-white p-4">
            <div>
              <h2 className="text-lg font-semibold">Supplier learning</h2>
              <p className="text-sm text-stone-500">
                Reliability is supplier-specific and separate from the match confidence
                for one invoice.
              </p>
            </div>

            <div className="mt-4 overflow-x-auto rounded-lg border border-stone-200">
              <table className="w-full min-w-[880px] border-collapse text-left text-sm">
                <thead className="bg-stone-100 text-xs font-semibold text-stone-600">
                  <tr>
                    <th className="px-3 py-2">Supplier</th>
                    <th className="px-3 py-2">Supplier reliability</th>
                    <th className="px-3 py-2">Learned invoices</th>
                    <th className="px-3 py-2">Format drift</th>
                    <th className="px-3 py-2">Last learned</th>
                    <th className="px-3 py-2">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {supplierLearningRows.map((summary) => {
                    const actionKey = `reset-learning-${summary.supplierAccountId}`;
                    return (
                      <tr
                        key={summary.supplierAccountId}
                        className="border-t border-stone-200"
                      >
                        <td className="px-3 py-3">
                          <div className="font-semibold text-stone-900">
                            {summary.supplierName}
                          </div>
                          <div className="text-xs text-stone-500">
                            {summary.supplierCode}
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          <SupplierReliabilityBadge summary={summary} />
                          <div className="mt-1 text-xs text-stone-500">
                            Evidence {Math.round(summary.confidence.volume * 100)}% ·
                            quality {Math.round(summary.confidence.quality * 100)}%
                          </div>
                        </td>
                        <td className="px-3 py-3">{summary.exampleCount}</td>
                        <td className="px-3 py-3 capitalize">
                          {summary.formatDrift}
                        </td>
                        <td className="px-3 py-3">
                          {summary.lastLearnedAt
                            ? formatTimestamp(summary.lastLearnedAt)
                            : "Not trained"}
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex flex-wrap gap-2">
                            <ActionButton
                              variant="secondary"
                              onClick={() =>
                                setLearningDetailAccountId((current) =>
                                  current === summary.supplierAccountId
                                    ? ""
                                    : summary.supplierAccountId
                                )
                              }
                            >
                              {learningDetailAccountId === summary.supplierAccountId
                                ? "Hide details"
                                : "View details"}
                            </ActionButton>
                            <ActionButton
                              variant="danger"
                              onClick={() => setLearningResetTarget(summary)}
                              loading={busy === actionKey}
                              feedback={buttonFeedbackFor(actionKey, actionKey)}
                              disabled={
                                !hasPermission("manage_learning") ||
                                summary.exampleCount === 0 ||
                                Boolean(busy)
                              }
                              disabledReason={
                                !hasPermission("manage_learning")
                                  ? "Your INTO account cannot reset supplier learning."
                                  : summary.exampleCount === 0
                                    ? "This supplier has no active learning to reset."
                                    : "Another action is already running."
                              }
                            >
                              Reset learning
                            </ActionButton>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {!supplierLearningRows.length ? (
                <p className="p-4 text-sm text-stone-500">
                  {state.supplierLearningLoaded
                    ? "Sync Exact supplier data to begin supplier learning."
                    : "Supplier reliability is unavailable until learning summaries load."}
                </p>
              ) : null}
            </div>
            {learningDetail ? (
              <section
                className="mt-4 rounded-lg border border-stone-200 bg-stone-50 p-4"
                aria-labelledby="supplier-learning-detail-title"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3
                      id="supplier-learning-detail-title"
                      className="font-semibold text-stone-950"
                    >
                      {learningDetail.supplierName} reliability details
                    </h3>
                    <p className="text-xs text-stone-600">
                      Generation {learningDetail.generation} ·{" "}
                      {learningDetail.confidence.copy ??
                        supplierReliabilityCopy(learningDetail.confidence.band)}
                    </p>
                  </div>
                  <div className="text-right text-sm">
                    <div className="font-semibold text-stone-950">
                      {learningDetail.confidence.score}% {learningDetail.confidence.band}
                    </div>
                    <div className="text-xs text-stone-500">
                      Drift penalty {learningDetail.confidence.driftPenalty} points
                    </div>
                  </div>
                </div>
                {learningDetail.confidence.metrics?.length ? (
                  <div className="mt-3 overflow-x-auto">
                    <table className="w-full min-w-[640px] text-left text-xs">
                      <thead className="text-stone-600">
                        <tr>
                          <th className="py-2 pr-3">Metric</th>
                          <th className="py-2 pr-3">Outcomes</th>
                          <th className="py-2 pr-3">Quality</th>
                          <th className="py-2">Weighted contribution</th>
                        </tr>
                      </thead>
                      <tbody>
                        {learningDetail.confidence.metrics.map((metric) => (
                          <tr key={metric.metric} className="border-t border-stone-200">
                            <td className="py-2 pr-3 font-medium text-stone-900">
                              {metric.label}
                            </td>
                            <td className="py-2 pr-3">
                              {metric.successes}/{metric.attempts}
                            </td>
                            <td className="py-2 pr-3">
                              {Math.round(metric.quality * 100)}%
                            </td>
                            <td className="py-2">
                              {Math.round(metric.contribution * 100)}%
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="mt-3 text-sm text-stone-600">
                    No trusted metric outcomes have been recorded yet.
                  </p>
                )}
              </section>
            ) : null}
          </section>
        ) : null}

        {visibleActiveView === "queue" ? (
        <section className="rounded-lg border border-stone-300 bg-white">
          <div className="flex flex-col gap-3 border-b border-stone-200 p-4 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-lg font-semibold">Invoice queue</h2>
              <p className="text-sm text-stone-500">
                Select an invoice to compare the source document with extracted
                booking data.
              </p>
            </div>
            <ActionButton
              variant="secondary"
              onClick={bookAllReady}
              loading={busy === "book-all"}
              feedback={buttonFeedbackFor("book-all", "book-all")}
              disabled={
                !stats.ready ||
                !hasPermission("book") ||
                !state.exactConnection ||
                !state.exactMasterData ||
                state.exactMasterDataStale ||
                Boolean(bookAllLineDisabledReason) ||
                busy === "book-all"
              }
              disabledReason={
                !hasPermission("book")
                  ? "Your INTO account is not verified for invoice booking."
                  : !state.exactConnection
                  ? "Connect the company Exact account before booking ready invoices."
                  : !state.exactMasterData || state.exactMasterDataStale
                    ? "Sync Exact data before booking ready invoices."
                  : bookAllLineDisabledReason
                    ? bookAllLineDisabledReason
                  : "Book All Ready Invoices is disabled because no invoices are ready."
              }
            >
              Book all ready invoices
            </ActionButton>
          </div>

          <div className="grid gap-3 p-4 md:hidden">
            {state.invoices.map((invoice) => (
              <button
                key={invoice.id}
                onClick={() => selectInvoice(invoice.id)}
                className={`cursor-pointer rounded-lg border p-3 text-left ${
                  selectedInvoice?.id === invoice.id
                    ? "border-emerald-400 bg-emerald-50 shadow-sm"
                    : "border-stone-200 bg-white"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-semibold text-[#145c48]">
                      {invoice.fileName}
                    </div>
                    <div className="mt-1 text-xs text-stone-500">
                      {invoice.source} - {formatFileSize(invoice.fileSize)}
                    </div>
                  </div>
                  <span
                    className={`rounded-md border px-2 py-1 text-xs font-semibold ${
                      statusTone[invoice.status] ?? statusTone.Uploaded
                    }`}
                  >
                    {displayStatus(invoice.status)}
                  </span>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                  <span className="text-stone-500">Supplier</span>
                  <span>{invoice.extractedData.supplierName || "-"}</span>
                  <span className="text-stone-500">Invoice</span>
                  <span>{invoice.extractedData.invoiceNumber || "-"}</span>
                  <span className="text-stone-500">Amount</span>
                  <span>{money(invoice)}</span>
                  <span className="text-stone-500">Journal</span>
                  <span>{invoice.purchaseJournal?.journal ?? "-"}</span>
                  <span className="text-stone-500">Confidence</span>
                  <span>
                    {invoice.purchaseJournal
                      ? percentScore(invoice.purchaseJournal.confidenceScores.overall)
                      : "-"}
                  </span>
                  <span className="text-stone-500">Issues</span>
                  <span>{invoice.validationErrors.length}</span>
                </div>
              </button>
            ))}
          </div>

          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[1040px] border-collapse text-left text-sm">
              <thead className="bg-stone-100 text-xs font-semibold text-stone-600">
                <tr>
                  <th className="px-4 py-3">File</th>
                  <th className="px-4 py-3">Supplier</th>
                  <th className="px-4 py-3">Invoice</th>
                  <th className="px-4 py-3">Amount</th>
                  <th className="px-4 py-3">Journal</th>
                  <th className="px-4 py-3">Confidence</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Issues</th>
                  <th className="px-4 py-3">Action</th>
                </tr>
              </thead>
              <tbody>
                {state.invoices.map((invoice) => {
                  const disabledReason = bookDisabledReason(invoice);
                  return (
                    <tr
                      key={invoice.id}
                      className={`border-t border-stone-200 ${
                        selectedInvoice?.id === invoice.id
                          ? "bg-emerald-50/70 ring-1 ring-inset ring-emerald-200"
                          : ""
                      }`}
                    >
                      <td className="px-4 py-3">
                        <button
                          onClick={() => selectInvoice(invoice.id)}
                          className="cursor-pointer text-left font-semibold text-[#145c48] hover:underline"
                        >
                          {invoice.fileName}
                        </button>
                        <div className="mt-1 text-xs text-stone-500">
                          {invoice.source} - {formatFileSize(invoice.fileSize)}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {invoice.extractedData.supplierName || "-"}
                      </td>
                      <td className="px-4 py-3">
                        {invoice.extractedData.invoiceNumber || "-"}
                      </td>
                      <td className="px-4 py-3">{money(invoice)}</td>
                      <td className="px-4 py-3">
                        {invoice.purchaseJournal?.journal ?? "-"}
                      </td>
                      <td className="px-4 py-3">
                        {invoice.purchaseJournal
                          ? percentScore(invoice.purchaseJournal.confidenceScores.overall)
                          : "-"}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex rounded-md border px-2 py-1 text-xs font-semibold ${
                            statusTone[invoice.status] ?? statusTone.Uploaded
                          }`}
                        >
                          {displayStatus(invoice.status)}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {invoice.validationErrors.length ? (
                          <span className="font-semibold text-amber-800">
                            {invoice.validationErrors.length}
                          </span>
                        ) : (
                          <span className="text-stone-400">0</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <ActionButton
                          variant="outline"
                          onClick={() => bookInvoice(invoice.id)}
                          loading={busy === `book-${invoice.id}`}
                          feedback={buttonFeedbackFor(
                            `book-${invoice.id}`,
                            `book-${invoice.id}`
                          )}
                          disabled={
                            Boolean(disabledReason) ||
                            invoice.status !== "Ready to Book" ||
                            !hasPermission("book") ||
                            !state.exactConnection ||
                            !state.exactMasterData ||
                            state.exactMasterDataStale ||
                            busy === `book-${invoice.id}`
                          }
                          disabledReason={disabledReason}
                          className="min-h-9 px-3 py-1 text-xs"
                        >
                          Book invoice
                        </ActionButton>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
        ) : null}

        {selectedInvoice && draft ? (
          <section className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(380px,0.95fr)]">
            <section className="min-w-0 overflow-hidden rounded-xl border border-stone-200 bg-white shadow-sm lg:sticky lg:top-4 lg:self-start">
              <div className="flex flex-col gap-3 border-b border-stone-200 bg-white p-4 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <h2 className="text-xl font-semibold text-stone-950">
                    Invoice preview
                  </h2>
                  <p className="mt-1 break-all text-sm leading-5 text-stone-500">
                    {selectedInvoice.fileName} - {formatFileSize(selectedInvoice.fileSize)}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2 lg:justify-end">
                  <ActionButton
                    variant={previewInteractionMode === "pan" ? "secondary" : "ghost"}
                    onClick={() => setPreviewInteractionMode("pan")}
                    className="min-h-9 px-3 py-1 text-xs"
                  >
                    Pan mode
                  </ActionButton>
                  <ActionButton
                    variant={
                      previewInteractionMode === "select_text" ? "secondary" : "ghost"
                    }
                    onClick={() => {
                      setPreviewInteractionMode("select_text");
                      setPreviewDragging(false);
                      previewDragStartRef.current = null;
                    }}
                    disabled={
                      !selectedInvoiceIsPdf || previewFileStatus !== "available"
                    }
                    disabledReason={
                      selectedInvoiceIsPdf
                        ? missingInvoiceFileMessage
                        : "Text selection is available for PDF invoices."
                    }
                    className="min-h-9 px-3 py-1 text-xs"
                  >
                    Select text mode
                  </ActionButton>
                  <ActionButton
                    variant="ghost"
                    onClick={() => {
                      setPreviewRotation((value) => (value + 270) % 360);
                      setPreviewPan(resetPreviewPan());
                      resetPreviewScroll();
                    }}
                    disabled={previewInteractionMode === "select_text"}
                    disabledReason="Switch to Pan mode to rotate the invoice."
                    className="min-h-9 px-3 py-1 text-xs"
                  >
                    Rotate left
                  </ActionButton>
                  <ActionButton
                    variant="ghost"
                    onClick={() => {
                      setPreviewRotation((value) => (value + 90) % 360);
                      setPreviewPan(resetPreviewPan());
                      resetPreviewScroll();
                    }}
                    disabled={previewInteractionMode === "select_text"}
                    disabledReason="Switch to Pan mode to rotate the invoice."
                    className="min-h-9 px-3 py-1 text-xs"
                  >
                    Rotate right
                  </ActionButton>
                  <ActionButton
                    variant="outline"
                    onClick={downloadOriginal}
                    disabled={previewFileStatus !== "available"}
                    disabledReason={missingInvoiceFileMessage}
                    className="min-h-9 px-3 py-1 text-xs"
                  >
                    Download original
                  </ActionButton>
                  {selectedInvoiceIsImage &&
                  selectedInvoice.extractedData.rawText?.trim() ? (
                    <ActionButton
                      variant="outline"
                      onClick={() => void copyExtractedText()}
                      className="min-h-9 px-3 py-1 text-xs"
                    >
                      Copy extracted text
                    </ActionButton>
                  ) : null}
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-200 bg-stone-50/70 px-4 py-2 text-sm">
                <div className="text-stone-600">
                  {previewInteractionMode === "select_text"
                    ? "Select and copy text in the PDF viewer."
                    : `Page ${previewPage} of ${pageCount} - Zoom ${Math.round(
                        previewZoom * 100
                      )}%${previewRotation ? ` - Rotated ${previewRotation}deg` : ""}`}
                </div>
                {previewInteractionMode === "pan" ? (
                  <div className="flex gap-2">
                  <ActionButton
                    variant="ghost"
                    onClick={() => setPreviewPage((value) => Math.max(1, value - 1))}
                    disabled={previewPage <= 1}
                    disabledReason="Already on the first page."
                    className="min-h-8 px-3 py-1 text-xs"
                  >
                    Previous
                  </ActionButton>
                  <ActionButton
                    variant="ghost"
                    onClick={() =>
                      setPreviewPage((value) => Math.min(pageCount, value + 1))
                    }
                    disabled={previewPage >= pageCount}
                    disabledReason="Already on the last page."
                    className="min-h-8 px-3 py-1 text-xs"
                  >
                    Next
                  </ActionButton>
                  </div>
                ) : null}
              </div>
              <div
                ref={previewViewportRef}
                className={`relative h-[min(78vh,980px)] min-h-[680px] overflow-auto bg-[#f7f8f5] p-3 [scrollbar-width:none] sm:p-4 [&::-webkit-scrollbar]:hidden ${
                  previewCanPan
                    ? previewDragging
                      ? "select-none cursor-grabbing"
                      : "select-none cursor-grab"
                    : "select-text cursor-text"
                } lg:h-[calc(100vh-170px)]`}
                role="presentation"
                onPointerDown={startPreviewPan}
                onPointerMove={movePreview}
                onPointerUp={stopPreviewPan}
                onPointerCancel={stopPreviewPan}
                onPointerLeave={stopPreviewPan}
                onWheel={handlePreviewWheel}
              >
                <div
                  className="flex min-h-full min-w-full items-start justify-center"
                >
                  <PreviewDocument
                    invoice={selectedInvoice}
                    fileStatus={previewFileStatus}
                    zoom={previewZoom}
                    rotation={previewRotation}
                    page={previewPage}
                    interactionMode={previewInteractionMode}
                    onPageCount={handlePreviewPageCount}
                  />
                </div>
              </div>
            </section>

            <aside className="min-w-0 overflow-hidden rounded-xl border border-stone-200 bg-white shadow-sm">
              <div className="border-b border-stone-200 bg-white/95 p-3 shadow-sm">
                <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    <h2 className="text-lg font-semibold text-stone-950">
                      Review invoice
                    </h2>
                    <p className="mt-1 text-xs leading-4 text-stone-500">
                      Fix fields here, then save to rerun validation.
                    </p>
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-3 bg-stone-50/40 p-3 sm:p-4">
                <section className="grid gap-3">
                  <ReviewSection title="Required data">
                    {[learnedCorrectionNote, exactHistorySuggestionNote]
                      .filter((note) =>
                        selectedPurchaseJournal?.learningSummary.includes(note)
                      )
                      .map((note) => (
                        <p
                          key={note}
                          className="sm:col-span-2 text-xs font-medium text-emerald-700"
                        >
                          {note}
                        </p>
                      ))}
                    <SelectField
                      label="Supplier"
                      required
                      value={draft.supplierName}
                      options={[]}
                      listId={`supplier-options-${selectedInvoice.id}`}
                      onChange={(value) => updateDraft("supplierName", value)}
                      disabled={!hasPermission("edit")}
                      issue={supplierFieldIssue}
                      helper={
                        matchedSupplierLabel
                          ? `Exact supplier: ${matchedSupplierLabel}`
                          : "Search synced Exact supplier accounts."
                      }
                      confidence={
                        selectedPurchaseJournal?.supplierResolution.matchConfidence
                      }
                      threshold={confidenceThreshold}
                    />
                    {state.supplierLearningEnabled && selectedSupplierLearning ? (
                      <div className="sm:col-span-2">
                        <SupplierReliabilityBadge summary={selectedSupplierLearning} />
                      </div>
                    ) : null}
                    {contextualSupplierReviewVisible ? (
                      <div className="sm:col-span-2 rounded-lg border border-stone-300 bg-stone-50 p-3">
                        <p className="text-sm font-semibold text-stone-950">
                          Multiple Exact suppliers match
                        </p>
                        <p className="mt-1 text-xs leading-5 text-stone-700">
                          Select the supplier shown on this invoice. INTO will remember
                          the choice for this supplier layout.
                        </p>
                        {duplicateSupplierCandidates.length > 1 ? (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {duplicateSupplierCandidates.map(
                              (candidate) => (
                                <ActionButton
                                  key={candidate.account.id}
                                  variant="ghost"
                                  onClick={() =>
                                    applyIntelligenceAction(
                                      "selectSupplier",
                                      candidate.account.id
                                    )
                                  }
                                  loading={busy === `supplier-${candidate.account.id}`}
                                  feedback={buttonFeedbackFor(
                                    `supplier-${candidate.account.id}`,
                                    `supplier-${candidate.account.id}`
                                  )}
                                  disabled={!hasPermission("approve")}
                                  disabledReason="Supplier selection is not available."
                                  className="justify-start text-left"
                                >
                                  <span>
                                    {candidate.account.code} - {candidate.account.name} (
                                    {percentScore(candidate.confidence)} match)
                                    {state.supplierLearningEnabled &&
                                    supplierLearningByAccount.get(candidate.account.id) ? (
                                      <span className="block text-xs font-normal text-stone-500">
                                        Supplier reliability{" "}
                                        {
                                          supplierLearningByAccount.get(
                                            candidate.account.id
                                          )!.confidence.score
                                        }
                                        %
                                      </span>
                                    ) : null}
                                  </span>
                                </ActionButton>
                              )
                            )}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                    <TextField
                      label="Your ref"
                      required
                      value={draft.referenceCode}
                      onChange={(value) => updateDraft("referenceCode", value)}
                      disabled={!hasPermission("edit")}
                      issue={yourRefIssue}
                      helper={
                        selectedPurchaseJournal?.yourRef
                          ? `Booking reference: ${selectedPurchaseJournal.yourRef}`
                          : undefined
                      }
                    />
                    <SelectField
                      label="Payment condition"
                      required
                      value={draft.paymentTerms}
                      options={paymentConditionOptions}
                      listId={`payment-options-${selectedInvoice.id}`}
                      onChange={(value) => updateDraft("paymentTerms", value)}
                      disabled={!hasPermission("edit")}
                      issue={paymentConditionFieldIssue}
                      helper={
                        selectedPurchaseJournal
                          ? `Exact default: ${selectedPurchaseJournal.paymentConditionCode || "-"} - ${selectedPurchaseJournal.paymentConditionLabel || "-"}`
                          : "Search synced Exact payment conditions."
                      }
                      confidence={selectedPurchaseJournal?.confidenceScores.paymentCondition}
                      threshold={confidenceThreshold}
                    />
                    <DateField
                      label="Invoice date"
                      required
                      value={draft.invoiceDate}
                      onChange={(value) => updateDraft("invoiceDate", value)}
                      disabled={!hasPermission("edit")}
                      issue={invoiceDateIssue}
                    />
                    <div className="sm:col-span-2 rounded-lg border border-stone-200 bg-stone-50/60 p-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <h4 className="text-sm font-semibold text-stone-900">
                            Booking lines
                            <span className="ml-1 text-rose-600" aria-hidden="true">
                              *
                            </span>
                            <span className="sr-only"> required</span>
                          </h4>
                          <p className="mt-1 text-xs leading-5 text-stone-500">
                            Split the invoice into one or more Exact purchase journal
                            lines.
                          </p>
                        </div>
                        <ActionButton
                          variant="ghost"
                          onClick={addBookingLine}
                          disabled={!hasPermission("edit")}
                          disabledReason="Your INTO account is not verified for invoice edits."
                          className="min-h-9 px-3 py-1.5 text-xs"
                        >
                          Add line
                        </ActionButton>
                      </div>

                      <div className="mt-3 overflow-x-auto rounded-lg border border-stone-200 bg-white">
                        <table className="w-full min-w-[980px] border-collapse text-left text-xs">
                          <thead className="bg-stone-100 text-stone-600">
                            <tr>
                              <th className="px-2 py-2">
                                G/L Account <span className="text-rose-600">*</span>
                              </th>
                              <th className="px-2 py-2">
                                Expense description <span className="text-rose-600">*</span>
                              </th>
                              <th className="px-2 py-2">From</th>
                              <th className="px-2 py-2">To</th>
                              <th className="px-2 py-2">Cost center</th>
                              <th className="px-2 py-2">Cost unit</th>
                              <th className="px-2 py-2">
                                VAT code <span className="text-rose-600">*</span>
                              </th>
                              <th className="px-2 py-2 text-right">
                                Net amount <span className="text-rose-600">*</span>
                              </th>
                              <th className="px-2 py-2 text-right">
                                VAT amount <span className="text-rose-600">*</span>
                              </th>
                              <th className="px-2 py-2 text-right">Actions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {bookingLineDrafts.length ? (
                              bookingLineDrafts.map((line, index) => (
                                <tr
                                  key={line.id}
                                  className="border-t border-stone-200 align-top"
                                >
                                  <td className="w-[150px] px-2 py-2">
                                    <input
                                      className={compactLineInputClass(
                                        bookingLineIssueFor(index, "glAccount")
                                      )}
                                      list={`line-gl-options-${selectedInvoice.id}`}
                                      value={bookingLineGlValue(line)}
                                      onChange={(event) =>
                                        updateBookingLineGl(index, event.target.value)
                                      }
                                      disabled={!hasPermission("edit")}
                                    />
                                    <ValidationMessage
                                      issue={bookingLineIssueFor(index, "glAccount")}
                                    />
                                  </td>
                                  <td className="w-[190px] px-2 py-2">
                                    <input
                                      className={compactLineInputClass(
                                        bookingLineIssueFor(index, "description")
                                      )}
                                      value={line.description}
                                      onChange={(event) =>
                                        updateBookingLine(index, {
                                          description: event.target.value,
                                        })
                                      }
                                      disabled={!hasPermission("edit")}
                                    />
                                    <ValidationMessage
                                      issue={bookingLineIssueFor(index, "description")}
                                    />
                                  </td>
                                  <td className="w-[110px] px-2 py-2">
                                    <input
                                      className={compactLineInputClass(
                                        bookingLineIssueFor(index, "from")
                                      )}
                                      type="date"
                                      value={line.from}
                                      onChange={(event) =>
                                        updateBookingLine(index, {
                                          from: event.target.value,
                                        })
                                      }
                                      disabled={!hasPermission("edit")}
                                    />
                                    <ValidationMessage
                                      issue={bookingLineIssueFor(index, "from")}
                                    />
                                  </td>
                                  <td className="w-[110px] px-2 py-2">
                                    <input
                                      className={compactLineInputClass(
                                        bookingLineIssueFor(index, "to")
                                      )}
                                      type="date"
                                      value={line.to}
                                      onChange={(event) =>
                                        updateBookingLine(index, {
                                          to: event.target.value,
                                        })
                                      }
                                      disabled={!hasPermission("edit")}
                                    />
                                    <ValidationMessage
                                      issue={bookingLineIssueFor(index, "to")}
                                    />
                                  </td>
                                  <td className="w-[110px] px-2 py-2">
                                    <input
                                      className={compactLineInputClass()}
                                      list={`line-cost-center-options-${selectedInvoice.id}`}
                                      value={line.costCentre}
                                      onChange={(event) =>
                                        updateBookingLine(index, {
                                          costCentre: event.target.value,
                                        })
                                      }
                                      disabled={!hasPermission("edit")}
                                    />
                                  </td>
                                  <td className="w-[110px] px-2 py-2">
                                    <input
                                      className={compactLineInputClass()}
                                      list={`line-cost-unit-options-${selectedInvoice.id}`}
                                      value={line.costUnit}
                                      onChange={(event) =>
                                        updateBookingLine(index, {
                                          costUnit: event.target.value,
                                        })
                                      }
                                      disabled={!hasPermission("edit")}
                                    />
                                  </td>
                                  <td className="w-[130px] px-2 py-2">
                                    <input
                                      className={compactLineInputClass(
                                        bookingLineVatIssueFor(index)
                                      )}
                                      list={`line-vat-options-${selectedInvoice.id}`}
                                      value={bookingLineVatValue(line)}
                                      onChange={(event) =>
                                        updateBookingLineVat(index, event.target.value)
                                      }
                                      disabled={!hasPermission("edit")}
                                    />
                                    <ValidationMessage
                                      issue={bookingLineVatIssueFor(index)}
                                    />
                                  </td>
                                  <td className="w-[100px] px-2 py-2">
                                    <input
                                      className={`${compactLineInputClass(
                                        bookingLineIssueFor(index, "amount")
                                      )} text-right`}
                                      type="number"
                                      step="0.01"
                                      value={moneyInputValue(
                                        line.amountInput,
                                        line.amount
                                      )}
                                      onChange={(event) =>
                                        updateBookingLineAmount(
                                          index,
                                          "amount",
                                          event.target.value
                                        )
                                      }
                                      disabled={!hasPermission("edit")}
                                    />
                                    <ValidationMessage
                                      issue={bookingLineIssueFor(index, "amount")}
                                    />
                                  </td>
                                  <td className="w-[100px] px-2 py-2">
                                    <input
                                      className={`${compactLineInputClass(
                                        bookingLineIssueFor(index, "vatAmount")
                                      )} text-right`}
                                      type="number"
                                      step="0.01"
                                      value={moneyInputValue(
                                        line.vatAmountInput,
                                        line.vatAmount
                                      )}
                                      onChange={(event) =>
                                        updateBookingLineAmount(
                                          index,
                                          "vatAmount",
                                          event.target.value
                                        )
                                      }
                                      disabled={!hasPermission("edit")}
                                    />
                                    <ValidationMessage
                                      issue={bookingLineIssueFor(index, "vatAmount")}
                                    />
                                  </td>
                                  <td className="w-[80px] px-2 py-2 text-right">
                                    <button
                                      type="button"
                                      onClick={() => deleteBookingLine(index)}
                                      disabled={!hasPermission("edit")}
                                      className="cursor-pointer rounded-md border border-rose-200 bg-white px-2 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:border-stone-200 disabled:bg-stone-100 disabled:text-stone-400"
                                    >
                                      Delete
                                    </button>
                                  </td>
                                </tr>
                              ))
                            ) : (
                              <tr>
                                <td
                                  className="px-3 py-4 text-center text-sm text-rose-700"
                                  colSpan={10}
                                >
                                  At least one booking line is required.
                                </td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>

                      <datalist id={`line-gl-options-${selectedInvoice.id}`}>
                        {glAccountOptions.map((option) => (
                          <option
                            key={`line-gl-${option.value}`}
                            value={option.value}
                          >
                            {option.label ?? option.value}
                          </option>
                        ))}
                      </datalist>
                      <datalist id={`line-vat-options-${selectedInvoice.id}`}>
                        {vatCodeOptions.map((option) => (
                          <option
                            key={`line-vat-${option.value}`}
                            value={option.value}
                          >
                            {option.label ?? option.value}
                          </option>
                        ))}
                      </datalist>
                      <datalist id={`line-cost-center-options-${selectedInvoice.id}`}>
                        {costCenterOptions.map((option) => (
                          <option
                            key={`line-cost-center-${option.value}`}
                            value={option.value}
                          >
                            {option.label ?? option.value}
                          </option>
                        ))}
                      </datalist>
                      <datalist id={`line-cost-unit-options-${selectedInvoice.id}`}>
                        {costUnitOptions.map((option) => (
                          <option
                            key={`line-cost-unit-${option.value}`}
                            value={option.value}
                          >
                            {option.label ?? option.value}
                          </option>
                        ))}
                      </datalist>

                      <div className="mt-3 grid gap-2 rounded-lg border border-stone-200 bg-white p-3 text-sm sm:grid-cols-2 xl:grid-cols-4">
                        <div>
                          <div className="text-xs font-semibold text-stone-500">
                            Net amount
                          </div>
                          <div className="mt-1 font-semibold text-stone-900">
                            {formatMoney(bookingLineTotals.lineAmount, currentCurrency)}
                          </div>
                        </div>
                        <div>
                          <div className="text-xs font-semibold text-stone-500">
                            VAT amount
                          </div>
                          <div className="mt-1 font-semibold text-stone-900">
                            {formatMoney(bookingLineTotals.vatAmount, currentCurrency)}
                          </div>
                        </div>
                        <div>
                          <div className="text-xs font-semibold text-stone-500">
                            Total amount from invoice
                            <span className="ml-1 text-rose-600">*</span>
                          </div>
                          <input
                            type="number"
                            step="0.01"
                            value={numberValue(draft.grossAmount)}
                            onChange={(event) =>
                              updateDraft("grossAmount", event.target.value)
                            }
                            disabled={!hasPermission("edit")}
                            className="mt-1 w-full rounded-md border-2 border-emerald-600 bg-emerald-50 px-2 py-1.5 text-right font-semibold text-stone-950 outline-none focus:ring-2 focus:ring-emerald-100 disabled:cursor-not-allowed disabled:border-stone-300 disabled:bg-stone-100 disabled:text-stone-500"
                          />
                          <ValidationMessage issue={totalAmountFieldIssue} />
                        </div>
                        <div>
                          <div className="text-xs font-semibold text-stone-500">
                            Difference
                          </div>
                          <div
                            className={`mt-1 font-semibold ${
                              bookingLineTotals.difference === 0
                                ? "text-emerald-700"
                                : "text-rose-700"
                            }`}
                          >
                            {formatMoney(bookingLineTotals.difference, currentCurrency)}
                          </div>
                        </div>
                      </div>
                      {selectedBookingLineDisabledReason ? (
                        <p className="mt-2 text-xs font-medium leading-5 text-rose-700">
                          {selectedBookingLineDisabledReason}
                        </p>
                      ) : null}
                    </div>
                  </ReviewSection>

                  <ReviewActionBar actions={reviewActions} />

                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded-md border px-2 py-1 text-xs font-semibold ${
                      statusTone[selectedInvoice.status] ?? statusTone.Uploaded
                    }`}
                  >
                    {displayStatus(selectedInvoice.status)}
                  </span>
                  <span className="text-xs text-stone-500">
                    Extraction confidence{" "}
                    {Math.round((selectedInvoice.extractedData.confidence ?? 0) * 100)}%
                  </span>
                  {hasUnsavedChanges ? (
                    <span className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-900">
                      Unsaved edits
                    </span>
                  ) : null}
                  {selectedInvoice.extractionHistory.length ? (
                    <span className="rounded-md border border-stone-300 bg-stone-50 px-2 py-1 text-xs font-semibold text-stone-700">
                      Extraction history {selectedInvoice.extractionHistory.length}
                    </span>
                  ) : null}
                </div>

                {visibleValidationMessages.length ? (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 shadow-sm">
                    <h3 className="text-sm font-semibold text-amber-950">
                      Validation warnings
                    </h3>
                    <ul className="mt-2 space-y-1 text-sm text-amber-900">
                      {visibleValidationMessages.map((item) => (
                        <li key={item.id}>{item.message}</li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-semibold text-emerald-900 shadow-sm">
                    All required fields are valid.
                  </div>
                )}

                {selectedInvoice.duplicateDetection?.outcome ===
                "possible_duplicate" ? (
                  <div className="rounded-xl border border-fuchsia-200 bg-fuchsia-50 p-4 shadow-sm">
                    <h3 className="text-sm font-semibold text-fuchsia-950">
                      Possible duplicate
                    </h3>
                    <p className="mt-1 text-sm text-fuchsia-900">
                      {selectedInvoice.duplicateDetection.message}
                    </p>
                    <div className="mt-3 grid gap-2">
                      {selectedInvoice.duplicateDetection.candidates.map((candidate) => (
                        <button
                          key={candidate.invoiceId}
                          onClick={() => selectInvoice(candidate.invoiceId)}
                          className="cursor-pointer rounded-md border border-fuchsia-200 bg-white p-2 text-left text-sm hover:bg-fuchsia-50"
                        >
                          <div className="font-semibold">
                            {candidate.fileName} - {percentScore(candidate.matchScore)}
                          </div>
                          <div className="mt-1 text-xs text-stone-600">
                            {candidate.supplierName || "-"} /{" "}
                            {candidate.invoiceNumber || candidate.yourRef || "-"} /{" "}
                            {formatMoney(candidate.totalAmount)}
                          </div>
                          <div className="mt-1 text-xs text-stone-500">
                            {candidate.matchReasons.join(" ")}
                          </div>
                        </button>
                      ))}
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <ActionButton
                        variant="secondary"
                        onClick={() => resolveSelectedDuplicate("continue_anyway")}
                        loading={busy === "selected-duplicate-continue_anyway"}
                        feedback={buttonFeedbackFor(
                          "selected-duplicate-continue_anyway",
                          "selected-duplicate-continue_anyway"
                        )}
                      >
                        Continue anyway
                      </ActionButton>
                      <ActionButton
                        variant="outline"
                        onClick={() => resolveSelectedDuplicate("re_read")}
                        loading={busy === "selected-duplicate-re_read"}
                        feedback={buttonFeedbackFor(
                          "selected-duplicate-re_read",
                          "selected-duplicate-re_read"
                        )}
                      >
                        Re-read invoice
                      </ActionButton>
                      <ActionButton
                        variant="ghost"
                        onClick={() => resolveSelectedDuplicate("cancel_upload")}
                        loading={busy === "selected-duplicate-cancel_upload"}
                        feedback={buttonFeedbackFor(
                          "selected-duplicate-cancel_upload",
                          "selected-duplicate-cancel_upload"
                        )}
                      >
                        Cancel upload
                      </ActionButton>
                    </div>
                  </div>
                ) : null}


                  <CollapsibleSection
                    title="Additional data"
                    open={additionalDataOpen}
                  >
                    {additionalDataFields.map((field) =>
                      renderEditableReviewField(fieldLabels[field] ?? String(field), field)
                    )}

                    <div className="rounded-lg border border-stone-200 bg-stone-50/70 p-3 text-sm sm:col-span-2">
                      <h4 className="font-semibold text-stone-700">Line items</h4>
                      <div className="mt-2 space-y-2">
                        {selectedInvoice.extractedData.lineItems.length ? (
                          selectedInvoice.extractedData.lineItems.map((item) => (
                            <div
                              key={item.id}
                              className="grid grid-cols-[1fr_auto] gap-3 border-t border-stone-200 pt-2"
                            >
                              <span>{item.description}</span>
                              <span>{item.netAmount.toFixed(2)}</span>
                            </div>
                          ))
                        ) : (
                          <p className="text-stone-500">No line items detected.</p>
                        )}
                      </div>
                    </div>

                    <div className="rounded-lg border border-stone-200 bg-stone-50/70 p-3 text-sm sm:col-span-2">
                      <div className="flex items-center justify-between gap-3">
                        <h4 className="font-semibold text-stone-700">
                          Processing timeline
                        </h4>
                        <span className="text-xs text-stone-500">
                          {auditEvents.length} event(s)
                        </span>
                      </div>
                      <div className="mt-3 space-y-3">
                        {auditEvents.length ? (
                          auditEvents.map((event) => (
                            <div
                              key={event.id}
                              className="border-l-2 border-stone-300 pl-3"
                            >
                              <div className="font-semibold text-stone-700">
                                {auditMessageWithoutActor(event)}
                              </div>
                              <div className="mt-1 text-xs text-stone-500">
                                {formatTimestamp(event.createdAt)}
                                {event.field ? ` - ${event.field}` : ""}
                              </div>
                              {event.field ? (
                                <div className="mt-1 text-xs text-stone-600">
                                  {String(event.oldValue ?? "-")} {"->"}{" "}
                                  {String(event.newValue ?? "-")}
                                </div>
                              ) : null}
                            </div>
                          ))
                        ) : (
                          <p className="text-stone-500">
                            No audit events recorded yet.
                          </p>
                        )}
                      </div>
                    </div>
                  </CollapsibleSection>
                </section>

                {selectedPurchaseJournal ? (
                  <details className="rounded-xl border border-stone-200 bg-white p-3 shadow-sm">
                    <summary className="flex cursor-pointer items-center justify-between gap-3 text-sm font-semibold text-stone-800">
                      <span>Purchase Journal intelligence</span>
                      <span className="text-xs font-medium text-stone-500">
                        Threshold {percentScore(selectedPurchaseJournal.confidenceThreshold)}
                      </span>
                    </summary>
                    <div className="mt-3 space-y-3">
                      <div className="flex justify-end">
                        <ActionButton
                          variant="ghost"
                          onClick={() => applyIntelligenceAction("approve")}
                          loading={busy === "approve-intelligence"}
                          feedback={buttonFeedbackFor(
                            "approve-intelligence",
                            "approve-intelligence"
                          )}
                          disabled={
                            !hasPermission("approve") ||
                            !canApproveSelectedIntelligence ||
                            busy === "approve-intelligence"
                          }
                          disabledReason={
                            !hasPermission("approve")
                              ? "Your INTO account is not verified for purchase journal approval."
                              : "Approval is available only after required supplier, attachment, and reference checks are resolved."
                          }
                        >
                          Approve intelligence
                        </ActionButton>
                      </div>

                    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                      {Object.entries(selectedPurchaseJournal.confidenceScores).map(
                        ([key, value]) => (
                          <div
                            key={key}
                            className={`rounded-lg border px-3 py-2 text-sm ${confidenceTone(
                              value,
                              selectedPurchaseJournal.confidenceThreshold
                            )}`}
                          >
                            <div className="text-xs font-semibold">
                              {confidenceLabels[key] ?? key}
                            </div>
                            <div className="mt-1 text-lg font-semibold">
                              {percentScore(value)}
                            </div>
                          </div>
                        )
                      )}
                    </div>

                    <div className="grid gap-3 text-sm md:grid-cols-2">
                      <div className="rounded-lg border border-stone-200 bg-stone-50/60 p-3">
                        <div className="text-xs font-semibold text-stone-500">
                          Attachment
                        </div>
                        <div className="mt-1 font-semibold">
                          {selectedPurchaseJournal.attachmentPresent
                            ? "Ready to upload with booking"
                            : "Missing"}
                        </div>
                        <div className="mt-1 break-all text-xs text-stone-500">
                          {selectedPurchaseJournal.attachmentStorageKey ?? "-"}
                        </div>
                      </div>

                      <div className="rounded-lg border border-stone-200 bg-stone-50/60 p-3">
                        <div className="text-xs font-semibold text-stone-500">
                          Supplier
                        </div>
                        <div className="mt-1 font-semibold">
                          {matchedSupplierLabel || "Review required"}
                        </div>
                        <div className="mt-1 text-xs text-stone-500">
                          {selectedPurchaseJournal.supplierResolution.method} -{" "}
                          {percentScore(
                            selectedPurchaseJournal.supplierResolution
                              .matchConfidence
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="grid gap-3 text-sm md:grid-cols-2">
                      <div className="rounded-lg border border-stone-200 bg-stone-50/60 p-3">
                        <div className="text-xs font-semibold text-stone-500">
                          Entry data
                        </div>
                        <dl className="mt-2 grid grid-cols-[120px_1fr] gap-1">
                          <dt className="text-stone-500">Journal</dt>
                          <dd>
                            {selectedPurchaseJournal.journal} -{" "}
                            {selectedPurchaseJournal.journalReason}
                          </dd>
                          <dt className="text-stone-500">Year / period</dt>
                          <dd>
                            {selectedPurchaseJournal.financialYear} /{" "}
                            {selectedPurchaseJournal.period}
                          </dd>
                          <dt className="text-stone-500">Entry no.</dt>
                          <dd>{selectedPurchaseJournal.entryNumber}</dd>
                        </dl>
                        {selectedPurchaseJournal.periodAdjusted ? (
                          <p className="mt-2 text-xs text-amber-700">
                            {selectedPurchaseJournal.periodAdjustmentLog}
                          </p>
                        ) : null}
                      </div>

                      <div className="rounded-lg border border-stone-200 bg-stone-50/60 p-3">
                        <div className="text-xs font-semibold text-stone-500">
                          Suggested corrections
                        </div>
                        <ul className="mt-2 space-y-1 text-sm">
                          {(selectedPurchaseJournal.reviewReasons.length
                            ? selectedPurchaseJournal.reviewReasons
                            : selectedPurchaseJournal.reasoningLog.slice(0, 3)
                          ).map((reason) => (
                            <li key={reason}>{reason}</li>
                          ))}
                        </ul>
                      </div>
                    </div>

                    <div className="overflow-x-auto rounded-lg border border-stone-200">
                      <table className="w-full min-w-[760px] border-collapse text-left text-xs">
                        <thead className="bg-stone-100 text-stone-600">
                          <tr>
                            <th className="px-3 py-2">G/L account</th>
                            <th className="px-3 py-2">Description</th>
                            <th className="px-3 py-2">From / To</th>
                            <th className="px-3 py-2">Cost</th>
                            <th className="px-3 py-2">VAT</th>
                            <th className="px-3 py-2 text-right">Amount</th>
                          </tr>
                        </thead>
                        <tbody>
                          {selectedPurchaseJournal.lines.map((line) => (
                            <tr key={line.id} className="border-t border-stone-200">
                              <td className="px-3 py-2">
                                <div className="font-semibold">
                                  {line.glAccount}
                                </div>
                                <div className="text-stone-500">
                                  {line.glAccountName}
                                </div>
                              </td>
                              <td className="px-3 py-2">{line.description}</td>
                              <td className="px-3 py-2">
                                {line.from || "-"} / {line.to || "-"}
                                {line.accrualReason ? (
                                  <div className="mt-1 text-stone-500">
                                    {line.accrualReason}
                                  </div>
                                ) : null}
                              </td>
                              <td className="px-3 py-2">
                                {line.costCentre || "-"} / {line.costUnit || "-"}
                              </td>
                              <td className="px-3 py-2">
                                <div className="font-semibold">
                                  {line.vatCode} - {line.vatCodeName}
                                </div>
                                <div className="text-stone-500">
                                  {percentScore(line.vatConfidence)}
                                </div>
                              </td>
                              <td className="px-3 py-2 text-right">
                                <div>{line.amount.toFixed(2)}</div>
                                <div className="text-stone-500">
                                  VAT {line.vatAmount.toFixed(2)}
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot className="border-t border-stone-300 bg-stone-50 font-semibold">
                          <tr>
                            <td className="px-3 py-2" colSpan={5}>
                              Difference
                            </td>
                            <td className="px-3 py-2 text-right">
                              {selectedPurchaseJournal.totals.difference.toFixed(2)}
                            </td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                    </div>
                  </details>
                ) : null}

                {selectedInvoice.lastError ? (
                  <p className="text-sm text-rose-700">{selectedInvoice.lastError}</p>
                ) : null}
              </div>
            </aside>
          </section>
        ) : (
          <section className="rounded-lg border border-stone-300 bg-white p-4 text-sm text-stone-500">
            No invoice selected.
          </section>
        )}

        {state.supplierLearningEnabled ? (
          <dialog
            ref={resetLearningDialogRef}
            aria-labelledby="supplier-learning-reset-title"
            onCancel={(event) => {
              event.preventDefault();
              if (
                learningResetTarget &&
                busy === `reset-learning-${learningResetTarget.supplierAccountId}`
              ) {
                return;
              }
              setLearningResetTarget(null);
            }}
            onClose={() => setLearningResetTarget(null)}
            className="m-auto max-w-lg rounded-xl border border-stone-300 bg-white p-0 text-stone-900 shadow-2xl backdrop:bg-stone-950/40"
          >
            <div className="p-5">
              <h2
                id="supplier-learning-reset-title"
                className="text-lg font-semibold"
              >
                Reset learning
              </h2>
              <p className="mt-3 text-sm leading-6 text-stone-700">
                {resetLearningConfirmation}
              </p>
              {learningResetTarget ? (
                <p className="mt-2 text-sm font-semibold text-stone-900">
                  {learningResetTarget.supplierCode} -{" "}
                  {learningResetTarget.supplierName}
                </p>
              ) : null}
              <div className="mt-5 flex justify-end gap-2">
                <button
                  ref={resetLearningCancelRef}
                  type="button"
                  onClick={() => setLearningResetTarget(null)}
                  disabled={Boolean(busy)}
                  className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-md border border-stone-300 bg-white px-4 py-2.5 text-sm font-semibold text-stone-700 shadow-sm hover:bg-stone-50 disabled:cursor-not-allowed disabled:bg-stone-100 disabled:text-stone-500"
                >
                  Cancel
                </button>
                <ActionButton
                  variant="danger"
                  onClick={confirmResetSupplierLearning}
                  loading={Boolean(
                    learningResetTarget &&
                      busy ===
                        `reset-learning-${learningResetTarget.supplierAccountId}`
                  )}
                  disabled={!learningResetTarget || Boolean(busy)}
                  disabledReason="Choose a supplier before resetting learning."
                >
                  Reset learning
                </ActionButton>
              </div>
            </div>
          </dialog>
        ) : null}

      </div>
    </main>
  );
}


