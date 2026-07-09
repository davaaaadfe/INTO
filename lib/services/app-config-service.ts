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
  deploymentUrl: string;
  environment: "development" | "production" | "test";
  isPreviewDeployment: boolean;
  previewDeploymentMessage?: string;
  exactCallbackUrl: string;
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
    normalizeHost(envValue("NEXT_PUBLIC_APP_URL")) ||
    normalizeHost(envValue("VERCEL_PROJECT_PRODUCTION_URL")) ||
    normalizeHost(envValue("VERCEL_URL")) ||
    "http://localhost:3000"
  );
}

export function currentDeploymentUrl() {
  return normalizeHost(envValue("VERCEL_URL")) || applicationBaseUrl();
}

export function isPreviewDeployment() {
  if (envValue("VERCEL_ENV") === "preview") {
    return true;
  }

  return Boolean(
    envValue("VERCEL_URL") &&
      currentDeploymentUrl() !== applicationBaseUrl() &&
      envValue("VERCEL_ENV") !== "production"
  );
}

export function previewDeploymentMessage() {
  if (!isPreviewDeployment()) {
    return undefined;
  }

  return "You are viewing a Vercel preview deployment. UI testing is okay here, but Exact Online OAuth should use the stable production callback URL configured in the system settings.";
}

export function exactOAuthCallbackUrl() {
  return `${applicationBaseUrl()}/api/exact/callback`;
}

export function exactRedirectUri() {
  return envValue("EXACT_ONLINE_REDIRECT_URI") || exactOAuthCallbackUrl();
}
