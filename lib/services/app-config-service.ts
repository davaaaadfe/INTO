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
