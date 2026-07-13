import type {
  ExactConnection,
  ExactMasterDataCache,
} from "../domain/invoice";
import {
  getExactConnection,
  getExactMasterData,
  isCachedExactMasterDataStale,
  listInvoices,
  refreshExactConnectionForUser,
  syncExactDataNow,
} from "../repository/invoice-store";
import {
  applicationBaseUrl,
  currentDeploymentUrl,
  exactRedirectUri,
  isPreviewDeployment,
  previewDeploymentMessage,
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
  invoiceStorageProvider,
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

function missingDatabaseSettings() {
  if (runtimeEnvironment() !== "production") {
    return [];
  }

  return missingRequiredEnv(["DATABASE_URL"]);
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

function exactClientIdLooksLikeEmail() {
  const clientId = process.env.EXACT_ONLINE_CLIENT_ID?.trim() ?? "";
  return Boolean(clientId && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientId));
}

function exactSetupGuidance(details: string[] = []) {
  return [
    ...details,
    "Local development: put Exact OAuth details in .env or .env.local.",
    "Vercel production: put Exact OAuth details in Vercel Project Settings > Environment Variables, then redeploy.",
    "Required Exact settings: EXACT_ONLINE_CLIENT_ID, EXACT_ONLINE_CLIENT_SECRET, EXACT_ONLINE_REDIRECT_URI, and OAUTH_TOKEN_ENCRYPTION_KEY.",
    "EXACT_ONLINE_CLIENT_ID must be the Exact OAuth app Client ID, not an email address.",
    "INTO never asks for or stores Exact usernames or passwords; users authenticate on Exact Online's OAuth page.",
    ...(exactClientIdLooksLikeEmail()
      ? ["The configured EXACT_ONLINE_CLIENT_ID looks like an email address. Replace it with the Client ID from the Exact OAuth app."]
      : []),
  ];
}

function missingExactServerSettings() {
  return [
    ...missingRequiredEnv([
      "EXACT_ONLINE_CLIENT_ID",
      "EXACT_ONLINE_CLIENT_SECRET",
      "EXACT_ONLINE_REDIRECT_URI",
    ]),
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
        exactSetupGuidance(["Invoice booking will be available after the company Exact account is connected."]),
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
        exactSetupGuidance(["The saved company Exact connection cannot currently be used."]),
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
          exactSetupGuidance(["INTO could not refresh the company Exact connection."]),
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
          exactSetupGuidance(["INTO could not confirm the Exact company division."]),
          missingExactServerSettings()
        ),
        connection: refreshedConnection,
      };
    }

    return {
      status: "ok",
      message: "Shared Exact Online connection is ready.",
      details: ["The company Exact account is connected and reachable.", "Exact master data can be synced from the shared company Exact connection."],
      missingEnv: [],
      connection: refreshedConnection,
    };
  } catch {
    return {
      ...needsSetup(
        "INTO is not connected to Exact Online yet. Ask the system owner to reconnect the shared Exact Online account.",
        exactSetupGuidance(["INTO could not verify access to the company Exact account."]),
        missingExactServerSettings()
      ),
      connection,
    };
  }
}

async function uploadReadiness() {
  const supportedExtensions = supportedInvoiceFileExtensions();
  const requiredExtensions = ["pdf", "jpg", "jpeg", "png", "xml", "ubl"];
  const supportedTypesConfigured = requiredExtensions.every((extension) =>
    supportedExtensions.includes(extension)
  );
  const storageWorks = await verifyInvoiceStorageWorks();

  if (!supportedTypesConfigured || !storageWorks) {
    return notReady(
      "Invoice upload needs attention.",
      [
        supportedTypesConfigured
          ? "Supported invoice file types are configured."
          : "Supported invoice file types are incomplete.",
        storageWorks
          ? "Invoice file storage is working."
          : "Temporary local invoice storage could not save and read a test file.",
      ]
    );
  }

  const details = [
    "Users can upload PDF, JPG, PNG, XML, and UBL invoice files.",
    "Temporary local invoice storage is ready.",
  ];

  if (runtimeEnvironment() === "production" && invoiceStorageProvider() === "local_temp") {
    details.push(
      "Temporary local storage on Vercel is suitable only for short-lived processing. Files may not survive redeploys. This is acceptable only if invoices are processed and booked quickly."
    );
  }

  return {
    status: "ok" as const,
    message: "Invoice upload is ready.",
    details,
    missingEnv: [],
  };
}

function reviewQueueReadiness() {
  const missingDatabaseEnv = missingDatabaseSettings();
  if (missingDatabaseEnv.length) {
    return needsSetup(
      "Invoice review queue needs production record storage setup.",
      [
        "Invoices, audit history, duplicate decisions, and booking attempts must be stored durably before production use.",
      ],
      missingDatabaseEnv
    );
  }

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
      missingEnv: [],
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
  const exactReadiness = await exactConnectionReadiness();
  const uploadStatus = await uploadReadiness();
  const reviewQueueStatus = reviewQueueReadiness();
  const masterDataStatus = await masterDataReadiness(exactReadiness);
  const bookingStatus = bookingReadiness(exactReadiness, masterDataStatus);

  return {
    appUrl: applicationBaseUrl(),
    deploymentUrl: currentDeploymentUrl(),
    environment: runtimeEnvironment(),
    isPreviewDeployment: isPreviewDeployment(),
    previewDeploymentMessage: previewDeploymentMessage(),
    exactCallbackUrl: exactRedirectUri(),
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
        "invoice-upload",
        "Invoice upload",
        uploadStatus.status,
        uploadStatus.message,
        uploadStatus.details,
        uploadStatus.missingEnv
      ),
      readinessCheck(
        "review-queue",
        "Invoice review queue",
        reviewQueueStatus.status,
        reviewQueueStatus.message,
        reviewQueueStatus.details,
        reviewQueueStatus.missingEnv
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
