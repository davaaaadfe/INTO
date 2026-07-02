export type SetupStatusLevel = "ok" | "warning" | "error";

export type SetupCheck = {
  id: string;
  label: string;
  status: SetupStatusLevel;
  message: string;
  missingEnv: string[];
  details: string[];
};

export type SetupStatus = {
  appUrl: string;
  environment: "development" | "production" | "test";
  exactCallbackUrl: string;
  outlookCallbackUrl: string;
  checks: SetupCheck[];
};

function nonEmptyEnv(key: string) {
  return Boolean(process.env[key]?.trim());
}

function envValue(key: string) {
  return process.env[key]?.trim() || "";
}

function normalizeHost(value: string) {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return "";
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  return `https://${trimmed}`;
}

export function applicationBaseUrl() {
  return (
    normalizeHost(envValue("APP_URL")) ||
    normalizeHost(envValue("VERCEL_PROJECT_PRODUCTION_URL")) ||
    normalizeHost(envValue("VERCEL_URL")) ||
    "http://localhost:3000"
  );
}

export function oauthCallbackUrl(provider: "exact" | "outlook") {
  const path =
    provider === "exact" ? "/api/exact/callback" : "/api/outlook/callback";
  return `${applicationBaseUrl()}${path}`;
}

export function exactRedirectUri() {
  return envValue("EXACT_ONLINE_REDIRECT_URI") || oauthCallbackUrl("exact");
}

export function microsoftRedirectUri() {
  return envValue("MICROSOFT_REDIRECT_URI") || oauthCallbackUrl("outlook");
}

function statusFromMissing(missingEnv: string[], warningOnly = false) {
  if (!missingEnv.length) {
    return "ok";
  }

  return warningOnly ? "warning" : "error";
}

function checkExactOnline(): SetupCheck {
  const missingEnv = [
    "EXACT_ONLINE_CLIENT_ID",
    "EXACT_ONLINE_CLIENT_SECRET",
  ].filter((key) => !nonEmptyEnv(key));
  const clientIdLooksLikeEmail = envValue("EXACT_ONLINE_CLIENT_ID").includes("@");
  const redirectSource = nonEmptyEnv("EXACT_ONLINE_REDIRECT_URI")
    ? "EXACT_ONLINE_REDIRECT_URI"
    : "auto-derived from deployment URL";
  const status = missingEnv.length
    ? statusFromMissing(missingEnv)
    : clientIdLooksLikeEmail
      ? "warning"
      : "ok";

  return {
    id: "exact-oauth",
    label: "Connect Company Exact Setup",
    status,
    message: missingEnv.length
      ? "Exact Online OAuth is not ready yet."
      : clientIdLooksLikeEmail
        ? "Exact Online Client ID looks like an email address; use the OAuth app Client ID from Exact."
      : "Exact Online OAuth credentials are configured.",
    missingEnv,
    details: [
      `Callback URL: ${exactRedirectUri()}`,
      `Redirect source: ${redirectSource}`,
      "EXACT_ONLINE_CLIENT_ID must be the Exact OAuth app Client ID, not the user's email address.",
      "Register this exact callback URL in the Exact Online app settings.",
    ],
  };
}

function checkMicrosoftOutlook(): SetupCheck {
  const missingEnv = ["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"].filter(
    (key) => !nonEmptyEnv(key)
  );
  const redirectSource = nonEmptyEnv("MICROSOFT_REDIRECT_URI")
    ? "MICROSOFT_REDIRECT_URI"
    : "auto-derived from deployment URL";

  return {
    id: "microsoft-oauth",
    label: "Connect Company Outlook Setup",
    status: statusFromMissing(missingEnv),
    message: missingEnv.length
      ? "Microsoft Outlook OAuth is not ready yet."
      : "Microsoft OAuth credentials are configured.",
    missingEnv,
    details: [
      `Callback URL: ${microsoftRedirectUri()}`,
      `Redirect source: ${redirectSource}`,
      "Register this exact callback URL in Azure App Registration.",
    ],
  };
}

function checkEnvironment(): SetupCheck {
  const missingEnv = [
    ["OAUTH_TOKEN_ENCRYPTION_KEY", "EXACT_TOKEN_ENCRYPTION_KEY"].some(nonEmptyEnv)
      ? ""
      : "OAUTH_TOKEN_ENCRYPTION_KEY",
    ["OAUTH_STATE_SECRET", "EXACT_OAUTH_STATE_SECRET", "OAUTH_TOKEN_ENCRYPTION_KEY"].some(
      nonEmptyEnv
    )
      ? ""
      : "OAUTH_STATE_SECRET",
  ].filter(Boolean);

  return {
    id: "environment",
    label: "Environment Configuration Status",
    status: statusFromMissing(missingEnv),
    message: missingEnv.length
      ? "Required security environment variables are missing."
      : "OAuth encryption and state-signing configuration is present.",
    missingEnv,
    details: [
      `Application URL: ${applicationBaseUrl()}`,
      `Runtime: ${process.env.NODE_ENV || "development"}`,
      "Secrets are checked by name only and are never returned to the browser.",
    ],
  };
}

function checkDatabase(): SetupCheck {
  const hasDatabase =
    nonEmptyEnv("DATABASE_URL") ||
    nonEmptyEnv("POSTGRES_URL") ||
    nonEmptyEnv("VERCEL_POSTGRES_URL") ||
    nonEmptyEnv("DATABASE_AUTH_TOKEN");

  return {
    id: "database",
    label: hasDatabase ? "Database Status" : "Database-Free Mode",
    status: "ok",
    message: hasDatabase
      ? "Database configuration is present."
      : "No database is required. INTO will use Exact Online as the long-term booking record.",
    missingEnv: [],
    details: [
      hasDatabase
        ? "Database records can be used for durable INTO archive and audit history."
        : "Database-free mode keeps only temporary runtime state in INTO; duplicate booking is checked against Exact Online before booking.",
    ],
  };
}

function checkStorage(): SetupCheck {
  const provider = envValue("STORAGE_PROVIDER") || "local";
  const hasS3 =
    nonEmptyEnv("S3_ENDPOINT") &&
    nonEmptyEnv("S3_BUCKET") &&
    nonEmptyEnv("S3_ACCESS_KEY_ID") &&
    nonEmptyEnv("S3_SECRET_ACCESS_KEY");
  const isProduction = process.env.NODE_ENV === "production";
  const missingEnv =
    provider === "s3" && !hasS3
      ? ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"].filter(
          (key) => !nonEmptyEnv(key)
        )
      : [];

  return {
    id: "storage",
    label: "Storage Status",
    status:
      provider === "local" && isProduction
        ? "warning"
        : statusFromMissing(missingEnv),
    message:
      provider === "local" && isProduction
        ? "Local storage is configured in production; use S3-compatible storage for durable invoice files."
        : missingEnv.length
          ? "S3-compatible storage configuration is incomplete."
          : `Storage provider is configured as ${provider}.`,
    missingEnv,
    details: [
      "For Vercel production, use S3-compatible storage because local filesystem data is not durable.",
    ],
  };
}

export function getSetupStatus(): SetupStatus {
  return {
    appUrl: applicationBaseUrl(),
    environment:
      process.env.NODE_ENV === "production"
        ? "production"
        : process.env.NODE_ENV === "test"
          ? "test"
          : "development",
    exactCallbackUrl: exactRedirectUri(),
    outlookCallbackUrl: microsoftRedirectUri(),
    checks: [
      checkExactOnline(),
      checkMicrosoftOutlook(),
      checkEnvironment(),
      checkDatabase(),
      checkStorage(),
    ],
  };
}
