import type {
  ExactConnection,
  ExactMasterDataCache,
  OutlookConnection,
} from "../domain/invoice";
import {
  getExactConnection,
  getExactMasterData,
  getOutlookConnection,
  isCachedExactMasterDataStale,
  listInvoices,
  refreshExactConnectionForUser,
  setOutlookConnection,
  setOutlookConnectionNeedsReconnect,
  syncExactDataNow,
} from "../repository/invoice-store";
import {
  applicationBaseUrl,
  exactRedirectUri,
  microsoftRedirectUri,
  type SetupCheck,
  type SetupStatus,
  type SetupStatusLevel,
} from "./app-config-service";
import {
  fetchExactCurrentDivision,
  isMockExactConnection,
  isRealExactMode,
} from "./exact-api-client";
import { bookInvoiceInExact } from "./exact-online-service";
import {
  refreshOutlookTokenIfNeeded,
  verifyOutlookMailboxAccess,
} from "./outlook-service";
import {
  supportedInvoiceFileExtensions,
  verifyInvoiceStorageWorks,
} from "./storage-service";

type ExactReadiness = {
  status: SetupStatusLevel;
  message: string;
  details: string[];
  missingEnv: string[];
  connection: ExactConnection | null;
};

type OutlookReadiness = {
  status: SetupStatusLevel;
  message: string;
  details: string[];
  missingEnv: string[];
  connection: OutlookConnection | null;
};

type MasterDataReadiness = {
  status: SetupStatusLevel;
  message: string;
  details: string[];
  cache: ExactMasterDataCache | null;
};

function runtimeEnvironment(): SetupStatus["environment"] {
  if (process.env.NODE_ENV === "production") {
    return "production";
  }

  if (process.env.NODE_ENV === "test") {
    return "test";
  }

  return "development";
}

function readinessCheck(
  id: string,
  label: string,
  status: SetupStatusLevel,
  message: string,
  details: string[] = [],
  missingEnv: string[] = []
): SetupCheck {
  return {
    id,
    label,
    status,
    message,
    missingEnv,
    details,
  };
}

function hasEnv(key: string) {
  return Boolean(process.env[key]?.trim());
}

function missingRequiredEnv(keys: string[]) {
  return keys.filter((key) => !hasEnv(key));
}

function missingOAuthSecurityEnv() {
  const missing: string[] = [];

  if (!["OAUTH_TOKEN_ENCRYPTION_KEY", "EXACT_TOKEN_ENCRYPTION_KEY"].some(hasEnv)) {
    missing.push("OAUTH_TOKEN_ENCRYPTION_KEY");
  }

  if (
    ![
      "OAUTH_STATE_SECRET",
      "EXACT_OAUTH_STATE_SECRET",
      "OAUTH_TOKEN_ENCRYPTION_KEY",
    ].some(hasEnv)
  ) {
    missing.push("OAUTH_STATE_SECRET");
  }

  return missing;
}

function missingExactServerSettings() {
  return [
    ...missingRequiredEnv([
      "EXACT_ONLINE_CLIENT_ID",
      "EXACT_ONLINE_CLIENT_SECRET",
    ]),
    ...missingOAuthSecurityEnv(),
  ];
}

function missingOutlookServerSettings() {
  return [
    ...missingRequiredEnv(["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"]),
    ...missingOAuthSecurityEnv(),
  ];
}

function needsSetup(
  message: string,
  details: string[] = [],
  missingEnv: string[] = []
) {
  return { status: "warning" as const, message, details, missingEnv };
}

function notReady(
  message: string,
  details: string[] = [],
  missingEnv: string[] = []
) {
  return { status: "error" as const, message, details, missingEnv };
}

async function exactConnectionReadiness(): Promise<ExactReadiness> {
  const connection = getExactConnection();

  if (!connection) {
    return {
      ...needsSetup(
        "INTO is not connected to Exact Online yet. Ask the system owner to connect the shared Exact Online account.",
        ["Invoice booking will be available after the company Exact account is connected."],
        missingExactServerSettings()
      ),
      connection: null,
    };
  }

  if (
    connection.status !== "connected" ||
    !connection.accessTokenCiphertext ||
    !connection.refreshTokenCiphertext
  ) {
    return {
      ...needsSetup(
        "INTO is not connected to Exact Online yet. Ask the system owner to reconnect the shared Exact Online account.",
        ["The saved company Exact connection cannot currently be used."],
        missingExactServerSettings()
      ),
      connection,
    };
  }

  try {
    const refreshedConnection = await refreshExactConnectionForUser();

    if (!refreshedConnection || refreshedConnection.status !== "connected") {
      return {
        ...needsSetup(
          "INTO is not connected to Exact Online yet. Ask the system owner to reconnect the shared Exact Online account.",
          ["INTO could not refresh the company Exact connection."],
          missingExactServerSettings()
        ),
        connection: refreshedConnection,
      };
    }

    const divisionCode =
      isRealExactMode() && !isMockExactConnection(refreshedConnection)
        ? await fetchExactCurrentDivision(refreshedConnection)
        : refreshedConnection.divisionCode;

    if (!divisionCode) {
      return {
        ...needsSetup(
          "INTO is connected to Exact Online, but company access could not be confirmed. Ask the system owner to check the shared Exact Online account.",
          ["INTO could not confirm the Exact company division."],
          missingExactServerSettings()
        ),
        connection: refreshedConnection,
      };
    }

    return {
      status: "ok",
      message: "Shared Exact Online connection is ready.",
      details: ["The company Exact account is connected and reachable."],
      missingEnv: [],
      connection: refreshedConnection,
    };
  } catch {
    return {
      ...needsSetup(
        "INTO is not connected to Exact Online yet. Ask the system owner to reconnect the shared Exact Online account.",
        ["INTO could not verify access to the company Exact account."],
        missingExactServerSettings()
      ),
      connection,
    };
  }
}

async function outlookConnectionReadiness(): Promise<OutlookReadiness> {
  const connection = getOutlookConnection();

  if (!connection) {
    return {
      ...needsSetup(
        "INTO is not connected to the invoice mailbox yet. Ask the system owner to connect the shared Outlook mailbox.",
        ["Invoice email scanning will be available after the company mailbox is connected."],
        missingOutlookServerSettings()
      ),
      connection: null,
    };
  }

  if (
    connection.status !== "connected" ||
    !connection.accessTokenCiphertext ||
    !connection.refreshTokenCiphertext
  ) {
    return {
      ...needsSetup(
        "INTO is not connected to the invoice mailbox yet. Ask the system owner to reconnect the shared Outlook mailbox.",
        ["The saved company Outlook mailbox cannot currently be used."],
        missingOutlookServerSettings()
      ),
      connection,
    };
  }

  try {
    const refreshedConnection = await refreshOutlookTokenIfNeeded(connection);
    const currentConnection =
      refreshedConnection && refreshedConnection.updatedAt !== connection.updatedAt
        ? setOutlookConnection(refreshedConnection)
        : refreshedConnection;

    const mailboxAccessible = await verifyOutlookMailboxAccess(currentConnection);

    if (!currentConnection || !mailboxAccessible) {
      return {
        ...needsSetup(
          "INTO is not connected to the invoice mailbox yet. Ask the system owner to check the shared Outlook mailbox.",
          ["INTO could not confirm access to the configured invoice mailbox."],
          missingOutlookServerSettings()
        ),
        connection: currentConnection,
      };
    }

    return {
      status: "ok",
      message: "Shared Outlook invoice mailbox is ready.",
      details: ["The company invoice mailbox is connected and reachable."],
      missingEnv: [],
      connection: currentConnection,
    };
  } catch {
    setOutlookConnectionNeedsReconnect(connection.userId);
    return {
      ...needsSetup(
        "INTO is not connected to the invoice mailbox yet. Ask the system owner to reconnect the shared Outlook mailbox.",
        ["INTO could not verify access to the company invoice mailbox."],
        missingOutlookServerSettings()
      ),
      connection,
    };
  }
}

function uploadReadiness() {
  const supportedExtensions = supportedInvoiceFileExtensions();
  const requiredExtensions = ["pdf", "jpg", "jpeg", "png", "xml", "ubl"];
  const supportedTypesConfigured = requiredExtensions.every((extension) =>
    supportedExtensions.includes(extension)
  );
  const storageWorks = verifyInvoiceStorageWorks();

  if (!supportedTypesConfigured || !storageWorks) {
    return notReady("Invoice upload needs attention.", [
      supportedTypesConfigured
        ? "Supported invoice file types are configured."
        : "Supported invoice file types are incomplete.",
      storageWorks
        ? "Invoice file storage is working."
        : "Invoice file storage could not save and read a test file.",
    ]);
  }

  return {
    status: "ok" as const,
    message: "Invoice upload is ready.",
    details: ["Users can upload PDF, JPG, PNG, XML, and UBL invoice files."],
  };
}

function reviewQueueReadiness() {
  try {
    const invoices = listInvoices();
    if (!Array.isArray(invoices)) {
      return notReady("Invoice review queue needs attention.", [
        "INTO could not list invoices for review.",
      ]);
    }

    return {
      status: "ok" as const,
      message: "Invoice review queue is ready.",
      details: ["Invoices can be listed for review."],
    };
  } catch {
    return notReady("Invoice review queue needs attention.", [
      "INTO could not list invoices for review.",
    ]);
  }
}

function hasRequiredExactMasterData(cache: ExactMasterDataCache | null) {
  if (!cache) {
    return false;
  }

  const requiredVatCodes = ["4", "5", "6", "7", "8"];
  const hasRequiredJournals = ["60", "61"].every((code) =>
    cache.journals.some(
      (journal) => journal.code === code && journal.type === "purchase" && journal.isActive
    )
  );
  const hasRequiredVatCodes = requiredVatCodes.every((code) =>
    cache.vatCodes.some(
      (vatCode) => vatCode.code === code && vatCode.type === "purchase" && vatCode.isActive
    )
  );

  return (
    cache.source === "exact-online" &&
    Boolean(cache.divisionCode) &&
    Boolean(cache.lastSyncedAt) &&
    Array.isArray(cache.costCenters) &&
    Array.isArray(cache.costUnits) &&
    cache.suppliers.length > 0 &&
    cache.paymentConditions.length > 0 &&
    cache.glAccounts.some((account) => account.isActive) &&
    hasRequiredJournals &&
    hasRequiredVatCodes
  );
}

async function masterDataReadiness(
  exactReadiness: ExactReadiness
): Promise<MasterDataReadiness> {
  if (exactReadiness.status !== "ok") {
    return {
      status: "warning",
      message:
        "INTO needs Exact Online to be connected before accounting data can be synced.",
      details: [
        "Suppliers, payment conditions, journals, G/L accounts, cost centers, cost units, and VAT codes come from Exact Online.",
      ],
      cache: getExactMasterData(),
    };
  }

  const cachedMasterData = getExactMasterData();
  if (
    !isCachedExactMasterDataStale() &&
    hasRequiredExactMasterData(cachedMasterData)
  ) {
    return {
      status: "ok",
      message: "Exact master data sync is ready.",
      details: ["Required Exact master data is synced and available."],
      cache: cachedMasterData,
    };
  }

  try {
    const syncedMasterData = await syncExactDataNow();
    if (hasRequiredExactMasterData(syncedMasterData)) {
      return {
        status: "ok",
        message: "Exact master data sync is ready.",
        details: ["Required Exact master data was refreshed successfully."],
        cache: syncedMasterData,
      };
    }

    return {
      ...needsSetup(
        "INTO needs to sync accounting data from Exact Online before invoices can be booked. Please run Sync Exact Data.",
        ["INTO synced Exact data but required booking values were missing."]
      ),
      cache: syncedMasterData,
    };
  } catch {
    return {
      ...needsSetup(
        "INTO needs to sync accounting data from Exact Online before invoices can be booked. Please run Sync Exact Data.",
        ["INTO could not refresh required Exact master data."]
      ),
      cache: cachedMasterData,
    };
  }
}

function bookingReadiness(
  exactReadiness: ExactReadiness,
  masterDataReadinessResult: MasterDataReadiness
) {
  if (exactReadiness.status !== "ok") {
    return needsSetup(
      "Invoice booking is not ready yet because Exact Online setup is incomplete.",
      ["Bookings use the configured shared Exact Online environment."]
    );
  }

  if (masterDataReadinessResult.status !== "ok") {
    return needsSetup(
      "Invoice booking is not ready yet because Exact accounting data has not been synced.",
      ["Required suppliers, journals, G/L accounts, and VAT codes must be available."]
    );
  }

  if (typeof bookInvoiceInExact !== "function") {
    return notReady("Invoice booking needs attention.", [
      "The booking service is not available.",
    ]);
  }

  return {
    status: "ok" as const,
    message: "Invoice booking is ready.",
    details: ["Invoices can be booked into the shared Exact Online environment."],
  };
}

export async function getSetupStatus(): Promise<SetupStatus> {
  const [exactReadiness, outlookReadiness] = await Promise.all([
    exactConnectionReadiness(),
    outlookConnectionReadiness(),
  ]);
  const uploadStatus = uploadReadiness();
  const reviewQueueStatus = reviewQueueReadiness();
  const masterDataStatus = await masterDataReadiness(exactReadiness);
  const bookingStatus = bookingReadiness(exactReadiness, masterDataStatus);

  return {
    appUrl: applicationBaseUrl(),
    environment: runtimeEnvironment(),
    exactCallbackUrl: exactRedirectUri(),
    outlookCallbackUrl: microsoftRedirectUri(),
    checks: [
      readinessCheck(
        "shared-exact",
        "Shared Exact Online connection",
        exactReadiness.status,
        exactReadiness.message,
        exactReadiness.details,
        exactReadiness.missingEnv
      ),
      readinessCheck(
        "shared-outlook",
        "Shared Outlook invoice mailbox",
        outlookReadiness.status,
        outlookReadiness.message,
        outlookReadiness.details,
        outlookReadiness.missingEnv
      ),
      readinessCheck(
        "invoice-upload",
        "Invoice upload",
        uploadStatus.status,
        uploadStatus.message,
        uploadStatus.details
      ),
      readinessCheck(
        "review-queue",
        "Invoice review queue",
        reviewQueueStatus.status,
        reviewQueueStatus.message,
        reviewQueueStatus.details
      ),
      readinessCheck(
        "exact-master-sync",
        "Exact master data sync",
        masterDataStatus.status,
        masterDataStatus.message,
        masterDataStatus.details
      ),
      readinessCheck(
        "invoice-booking",
        "Invoice booking",
        bookingStatus.status,
        bookingStatus.message,
        bookingStatus.details
      ),
    ],
  };
}
