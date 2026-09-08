import { createHash, randomUUID } from "node:crypto";
import { assertInvoiceBookingAllowed, hasPendingBooking, type UploadedInvoice } from "../domain/invoice";
import { bookInvoiceInExact } from "../services/exact-online-service";
import { logger } from "../utils/logger";
import {
  addAuditEvent, addBookingAttempt, assertExpectedInvoiceRevision, deleteInvoiceFileAfterBooking,
  getExactMasterData, getInvoice, isCachedExactMasterDataStale,
  markInvoiceBooked, recomputeInvoiceState, refreshExactConnectionForUser, syncExactDataNow,
  InvoiceRevisionConflictError, InvoiceRevisionValidationError,
} from "./invoice-store";
import { commitPersistentStore, restorePersistentStore } from "./persistent-request";
import { currentRequestPrincipal } from "./request-principal-context";
import { SnapshotRevisionConflictError } from "./sqlite-store";

export class BookingCommandError extends Error {
  readonly status: number;
  readonly code: string;
  readonly currentInvoice?: UploadedInvoice;
  constructor(status: number, code: string, message: string, invoice?: UploadedInvoice) {
    super(message);
    this.status = status;
    this.code = code;
    this.currentInvoice = invoice && structuredClone(invoice);
  }
}

export function isBookingRequestKey(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 200;
}

const reconciliationMessage = "Booking is in progress or requires reconciliation. Do not submit it again.";

/** The CAS reservation is committed before any Exact POST; an uncertain result never retries. */
export async function executeInvoiceBooking(
  input: { invoiceId: string; expectedRevision: unknown; requestKey: unknown },
  execute: typeof bookInvoiceInExact = bookInvoiceInExact
): Promise<{ invoice: UploadedInvoice; replayed: boolean }> {
  let invoice = getInvoice(input.invoiceId);
  if (!invoice) throw new BookingCommandError(404, "invoice_not_found", "Invoice not found.");
  // This invariant precedes idempotency and all provider/persistence work.
  if (invoice.status === "Learned" || invoice.processingPurpose === "learning_only") {
    logger.warn("invoice.learning_only_booking_blocked", {});
    try { assertInvoiceBookingAllowed(invoice); } catch (error) {
      throw new BookingCommandError(409, "learning_only_booking_blocked", (error as Error).message, invoice);
    }
  }
  if (!isBookingRequestKey(input.requestKey)) {
    throw new BookingCommandError(422, "invalid_request_key", "A request key of 1–200 characters is required.");
  }
  const requestKeyHash = createHash("sha256").update(input.requestKey.trim()).digest("hex");
  const previous = invoice.bookingOperation;
  if (previous?.requestKeyHash === requestKeyHash) {
    if (previous.inputRevision !== input.expectedRevision) {
      throw new BookingCommandError(409, "booking_request_conflict", "Booking request key conflicts with the original request.", invoice);
    }
    if (previous.state === "completed" && invoice.status === "Booked") return { invoice, replayed: true };
  }
  if (hasPendingBooking(invoice)) throw new BookingCommandError(409, "booking_reconciliation_required", reconciliationMessage, invoice);
  assertExpectedInvoiceRevision(invoice, input.expectedRevision);
  const expectedRevision = invoice.revision;
  if (invoice.status !== "Ready to Book" || invoice.exactBookingId) {
    throw new BookingCommandError(422, "booking_not_ready", "Only ready, unbooked invoices can be booked.", invoice);
  }

  const operationId = randomUUID();
  let reserved = false;
  let reservationAttempted = false;
  try {
    const connection = await refreshExactConnectionForUser();
    const masterData = isCachedExactMasterDataStale() ? await syncExactDataNow() : getExactMasterData();
    invoice = getInvoice(input.invoiceId)!;
    assertExpectedInvoiceRevision(invoice, expectedRevision);
    recomputeInvoiceState(invoice.id, { incrementRevision: false });
    const draft = structuredClone(invoice);
    const result = await execute(connection, draft, masterData, {
      beforeWrite: async () => {
        const current = getInvoice(input.invoiceId)!;
        assertExpectedInvoiceRevision(current, expectedRevision);
        assertInvoiceBookingAllowed(current);
        const principal = currentRequestPrincipal();
        const timestamp = new Date().toISOString();
        current.bookingOperation = {
          id: operationId, state: "reserved", requestKeyHash,
          inputRevision: expectedRevision,
          actorId: principal?.actorId ?? "shared_user",
          sessionCorrelationId: principal?.sessionCorrelationId ?? "test_session",
          requestId: principal?.requestId ?? randomUUID(),
          createdAt: timestamp, updatedAt: timestamp,
        };
        current.revision += 1;
        current.updatedAt = timestamp;
        addAuditEvent({ invoiceId: current.id, type: "invoice_booking_reserved", message: "Booking reserved before Exact write." });
        reservationAttempted = true;
        await commitPersistentStore();
        reserved = true;
        logger.info("exact.booking_reserved", {});
      },
      recordProgress: async (progress) => {
        const operation = getInvoice(input.invoiceId)?.bookingOperation;
        if (!reserved || operation?.id !== operationId || operation.state !== "reserved") {
          throw new Error("Booking reservation is not current.");
        }
        for (const key of ["exactDocumentId", "exactAttachmentId", "exactBookingId"] as const) {
          if (progress[key]) operation[key] = progress[key];
        }
        operation.updatedAt = new Date().toISOString();
        await commitPersistentStore();
      },
    });
    const current = getInvoice(input.invoiceId)!;
    if (!reserved || current.bookingOperation?.id !== operationId) throw new Error("Missing booking reservation.");
    current.bookingOperation.state = "completed";
    current.bookingOperation.exactBookingId = result.exactBookingId;
    current.bookingOperation.updatedAt = new Date().toISOString();
    addBookingAttempt(current.id, { status: "success", exactBookingId: result.exactBookingId });
    markInvoiceBooked(current.id, result.exactBookingId, current.revision);
    // Booked must survive a crash before the attachment is deleted.
    await commitPersistentStore();
    logger.info("exact.booking_completed", {});
  } catch (error) {
    // Finalization can throw before its commit barrier. Discard all uncommitted
    // success/learning mutations, while retaining the last durable remote IDs.
    if (reserved) restorePersistentStore();
    const current = getInvoice(input.invoiceId);
    if (reserved && current?.bookingOperation?.id === operationId) {
      current.bookingOperation.state = "uncertain";
      current.bookingOperation.updatedAt = new Date().toISOString();
      current.lastError = reconciliationMessage;
      current.exactBookingStatus = "reconciliation_required";
      current.revision += 1;
      addBookingAttempt(current.id, { status: "failed", errorMessage: reconciliationMessage });
      addAuditEvent({ invoiceId: current.id, type: "invoice_booking_uncertain", message: reconciliationMessage });
      try { await commitPersistentStore(); } catch {
        // The earlier durable reservation still blocks reposts; never clear it on failure.
        throw new BookingCommandError(503, "booking_persistence_unavailable", reconciliationMessage, getInvoice(input.invoiceId) ?? undefined);
      }
      logger.warn("exact.booking_uncertain", {});
      throw new BookingCommandError(409, "booking_reconciliation_required", reconciliationMessage, current);
    }
    if (error instanceof SnapshotRevisionConflictError) {
      throw new BookingCommandError(409, "booking_state_conflict", "Invoice state changed. Refresh before retrying.");
    }
    if (error instanceof BookingCommandError || error instanceof InvoiceRevisionConflictError || error instanceof InvoiceRevisionValidationError) throw error;
    if (reservationAttempted) {
      throw new BookingCommandError(503, "booking_persistence_unavailable", "Booking could not start because durable storage is unavailable.");
    }
    throw new BookingCommandError(422, "booking_preflight_failed", "Booking could not start. Review invoice validation, Exact connection and persistence configuration.", current ?? undefined);
  }
  try { await deleteInvoiceFileAfterBooking(input.invoiceId); } catch {
    logger.warn("exact.booking_attachment_cleanup_deferred", {});
  }
  return { invoice: getInvoice(input.invoiceId)!, replayed: false };
}
