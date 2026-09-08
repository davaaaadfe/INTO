import type {
  ExactConnection,
  ExactMasterDataCache,
  UploadedInvoice,
} from "../domain/invoice";
import { assertInvoiceBookingAllowed } from "../domain/invoice";
import { isExactMasterDataStale } from "./exact-master-data-service";
import { getStoredInvoiceFile } from "./storage-service";
import { createId } from "../utils/id";
import {
  getBookingBlockers,
} from "./required-booking-data";
import {
  DUPLICATE_INVOICE_REFERENCE_MESSAGE,
} from "./invoice-validation";
import {
  type ExactBookingPersistenceHooks,
  type ExactDuplicatePurchaseBooking,
  createRealExactPurchaseBooking,
  findRealExactPurchaseBookingDuplicate,
  isMockExactConnection,
  isRealExactMode,
  refreshRealExactConnection,
} from "./exact-api-client";

export function createExactAuthorizationUrl(state: string) {
  const baseUrl = process.env.EXACT_ONLINE_BASE_URL || "https://start.exactonline.nl";
  const clientId = process.env.EXACT_ONLINE_CLIENT_ID || "mock-client-id";
  const redirectUri =
    process.env.EXACT_ONLINE_REDIRECT_URI ||
    "http://localhost:3000/api/exact/callback";
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    force_login: "0",
    scope: "financial purchase transaction",
    state,
  });

  return `${baseUrl}/api/oauth2/auth?${params.toString()}`;
}

export function createMockExactConnection(userId: string): ExactConnection {
  const now = new Date();
  return {
    id: createId("exact"),
    userId,
    divisionCode: "123456",
    status: "connected",
    accessTokenCiphertext: "mock-encrypted-access-token",
    refreshTokenCiphertext: "mock-encrypted-refresh-token",
    expiresAt: new Date(now.getTime() + 55 * 60 * 1000).toISOString(),
    scopes: ["financial", "purchase", "transaction"],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

export async function refreshExactTokenIfNeeded(
  connection: ExactConnection | null
) {
  if (!connection) {
    return null;
  }

  if (new Date(connection.expiresAt).getTime() > Date.now() + 60_000) {
    return connection;
  }

  if (isRealExactMode() && !isMockExactConnection(connection)) {
    return refreshRealExactConnection(connection);
  }

  return {
    ...connection,
    accessTokenCiphertext: "mock-refreshed-encrypted-access-token",
    expiresAt: new Date(Date.now() + 55 * 60 * 1000).toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function duplicateReferenceForInvoice(invoice: UploadedInvoice) {
  return (
    invoice.purchaseJournal?.yourRef ||
    invoice.extractedData.referenceCode ||
    invoice.extractedData.invoiceNumber ||
    ""
  ).trim();
}

function findMockExactDuplicatePurchaseBooking(
  invoice: UploadedInvoice,
  masterData: ExactMasterDataCache
): ExactDuplicatePurchaseBooking | null {
  const yourRef = duplicateReferenceForInvoice(invoice);
  const totalAmount = invoice.extractedData.grossAmount || invoice.purchaseJournal?.totals.grossAmount || 0;
  const expectedSupplier = invoice.purchaseJournal?.supplierResolution.selectedAccountId;

  if (!yourRef) {
    return null;
  }

  const match = masterData.historicalPurchaseBookings.find((booking) => {
    const bookingRef = booking.yourRef || booking.invoiceNumber || "";
    if (bookingRef.trim().toLowerCase() !== yourRef.toLowerCase()) {
      return false;
    }
    return !expectedSupplier || booking.supplierAccountId === expectedSupplier;
  });

  return match
    ? {
        exactBookingId: match.id,
        yourRef,
        totalAmount,
        supplierAccountId: match.supplierAccountId,
      }
    : null;
}

function duplicateBookingMessage(duplicate: ExactDuplicatePurchaseBooking) {
  return [
    DUPLICATE_INVOICE_REFERENCE_MESSAGE,
    `Exact Online already has a purchase booking with reference ${duplicate.yourRef}.`,
    `Existing Exact reference: ${duplicate.exactBookingId}.`,
  ].join(" ");
}

export async function bookInvoiceInExact(
  connection: ExactConnection | null,
  invoice: UploadedInvoice,
  masterData: ExactMasterDataCache | null,
  persistence?: ExactBookingPersistenceHooks
) {
  assertInvoiceBookingAllowed(invoice);
  if (!connection || connection.status !== "connected") {
    throw new Error("Exact Online is not connected.");
  }

  if (isExactMasterDataStale(masterData)) {
    throw new Error("Exact master data is missing or stale. Sync Exact data before booking.");
  }
  const syncedMasterData = masterData as ExactMasterDataCache;

  if (invoice.status !== "Ready to Book") {
    throw new Error("Only invoices with Ready to Book status can be booked.");
  }

  if (!invoice.purchaseJournal) {
    throw new Error("Purchase Journal booking data is missing.");
  }

  const bookingBlocker = getBookingBlockers(
    invoice.extractedData,
    invoice.purchaseJournal,
    syncedMasterData
  )[0];
  if (bookingBlocker) {
    throw new Error(bookingBlocker.message);
  }

  if (
    !invoice.purchaseJournal.attachmentPresent ||
    !invoice.purchaseJournal.attachmentStorageKey
  ) {
    throw new Error(
      "Original invoice attachment is required and must be sent to Exact Online."
    );
  }

  if (!(await getStoredInvoiceFile(invoice.purchaseJournal.attachmentStorageKey))) {
    throw new Error("Original invoice file is not available in storage.");
  }

  if (!invoice.purchaseJournal.autoBookAllowed) {
    throw new Error("Purchase Journal intelligence still requires user review.");
  }

  const selectedSupplierId = invoice.purchaseJournal.supplierResolution.selectedAccountId;
  if (
    !selectedSupplierId ||
    !syncedMasterData.suppliers.some((supplier) => supplier.id === selectedSupplierId)
  ) {
    throw new Error("Selected supplier is not available in Exact master data.");
  }

  if (
    !syncedMasterData.journals.some(
      (journal) =>
        journal.code === invoice.purchaseJournal?.journal &&
        journal.type === "purchase" &&
        journal.isActive
    )
  ) {
    throw new Error("Selected purchase journal is not available in Exact.");
  }

  for (const line of invoice.purchaseJournal.lines) {
    if (
      !syncedMasterData.glAccounts.some(
        (account) => account.code === line.finalSelectedAccount && account.isActive
      )
    ) {
      throw new Error(`G/L account ${line.finalSelectedAccount} is not available in Exact.`);
    }

    if (
      !syncedMasterData.vatCodes.some(
        (vatCode) =>
          vatCode.code === line.vatCode &&
          vatCode.type === "purchase" &&
          vatCode.isActive
      )
    ) {
      throw new Error(`Purchase VAT code ${line.vatCode} is not available in Exact.`);
    }

    if (
      line.costCentre &&
      !syncedMasterData.costCenters.some(
        (costCenter) => costCenter.code === line.costCentre && costCenter.isActive
      )
    ) {
      throw new Error(`Cost center ${line.costCentre} is not available in Exact.`);
    }

    if (
      line.costUnit &&
      !syncedMasterData.costUnits.some(
        (costUnit) => costUnit.code === line.costUnit && costUnit.isActive
      )
    ) {
      throw new Error(`Cost unit ${line.costUnit} is not available in Exact.`);
    }
  }

  if (isRealExactMode() && !isMockExactConnection(connection)) {
    const duplicate = await findRealExactPurchaseBookingDuplicate(connection, invoice);
    if (duplicate) {
      throw new Error(duplicateBookingMessage(duplicate));
    }
    return createRealExactPurchaseBooking(connection, invoice, syncedMasterData, persistence);
  }

  const duplicate = findMockExactDuplicatePurchaseBooking(invoice, syncedMasterData);
  if (duplicate) {
    throw new Error(duplicateBookingMessage(duplicate));
  }

  if (/fail/i.test(invoice.extractedData.supplierName)) {
    throw new Error("Mock Exact Online rejected the supplier ledger mapping.");
  }

  await persistence?.beforeWrite();
  return {
    exactBookingId: createId("exact_booking"),
    divisionCode: connection.divisionCode,
    journal: invoice.purchaseJournal.journal,
    financialYear: invoice.purchaseJournal.financialYear,
    period: invoice.purchaseJournal.period,
    attachedFileKey: invoice.purchaseJournal.attachmentStorageKey,
    bookedAt: new Date().toISOString(),
  };
}
