import type { OutlookConnection } from "../domain/invoice";
import { createId } from "../utils/id";
import {
  decodeExactStatePayload,
  decryptOAuthSecret,
  encodeExactStatePayload,
  encryptOAuthSecret,
  signExactState,
} from "./exact-token-crypto";
import { microsoftRedirectUri } from "./app-config-service";

type MicrosoftTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
};

type MicrosoftStatePayload = {
  userId: string;
  nonce: string;
  issuedAt: number;
};

type MicrosoftProfile = {
  mail?: string;
  userPrincipalName?: string;
  displayName?: string;
};

function microsoftTenantId() {
  return process.env.MICROSOFT_TENANT_ID || "common";
}

function microsoftConfig() {
  const tenantId = microsoftTenantId();
  const clientId = process.env.MICROSOFT_CLIENT_ID || "";
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET || "";
  const redirectUri = microsoftRedirectUri();

  if (isRealOutlookMode() && (!clientId || !clientSecret || !redirectUri)) {
    throw new Error(
      "MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, and MICROSOFT_REDIRECT_URI are required for real Outlook OAuth."
    );
  }

  return { tenantId, clientId, clientSecret, redirectUri };
}

export function outlookIntegrationMode() {
  const explicit = process.env.MICROSOFT_OUTLOOK_MODE?.toLowerCase();
  if (explicit === "real" || explicit === "mock") {
    return explicit;
  }

  return process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET
    ? "real"
    : "mock";
}

export function isRealOutlookMode() {
  return outlookIntegrationMode() === "real";
}

export function isMockOutlookConnection(connection: OutlookConnection | null) {
  return (
    !connection ||
    connection.accessTokenCiphertext.startsWith("mock-") ||
    connection.refreshTokenCiphertext.startsWith("mock-")
  );
}

export async function createMicrosoftOAuthState(userId: string) {
  const payload = encodeExactStatePayload({
    userId,
    nonce: createId("outlook_state"),
    issuedAt: Date.now(),
  } satisfies MicrosoftStatePayload);
  const signature = await signExactState(payload);

  return `${payload}.${signature}`;
}

export async function verifyMicrosoftOAuthState(state: string) {
  const [payload, signature] = state.split(".");
  if (!payload || !signature) {
    throw new Error("Outlook OAuth state is missing or invalid.");
  }

  const expected = await signExactState(payload);
  if (signature !== expected) {
    throw new Error("Outlook OAuth state signature is invalid.");
  }

  const decoded = decodeExactStatePayload<MicrosoftStatePayload>(payload);
  if (Date.now() - decoded.issuedAt > 15 * 60 * 1000) {
    throw new Error("Outlook OAuth state has expired. Start the connection again.");
  }

  return decoded;
}

export function createOutlookAuthorizationUrl(state: string) {
  const tenantId = microsoftTenantId();
  const clientId = process.env.MICROSOFT_CLIENT_ID || "mock-client-id";
  const redirectUri = microsoftRedirectUri();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    response_mode: "query",
    scope: "offline_access User.Read Mail.ReadWrite",
    prompt: "select_account",
    state,
  });

  return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?${params.toString()}`;
}

export async function createRealOutlookAuthorizationUrl(userId: string) {
  const state = await createMicrosoftOAuthState(userId);
  return {
    authorizationUrl: createOutlookAuthorizationUrl(state),
    state,
  };
}

async function requestMicrosoftToken(params: Record<string, string>) {
  const { tenantId, clientId, clientSecret, redirectUri } = microsoftConfig();
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    ...params,
  });
  const response = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
    }
  );
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const detail =
      payload.error_description || payload.error || response.statusText;
    throw new Error(`Outlook OAuth token request failed: ${detail}`);
  }

  return payload as MicrosoftTokenResponse;
}

async function fetchMicrosoftProfile(accessToken: string) {
  const response = await fetch("https://graph.microsoft.com/v1.0/me", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const detail = payload.error?.message || payload.error || response.statusText;
    throw new Error(`Microsoft Graph profile request failed: ${detail}`);
  }

  return payload as MicrosoftProfile;
}

async function connectionFromMicrosoftToken(
  userId: string,
  token: MicrosoftTokenResponse
): Promise<OutlookConnection> {
  const now = new Date();
  const expiresInSeconds = token.expires_in ?? 3600;

  if (!token.refresh_token) {
    throw new Error("Outlook OAuth response did not include a refresh token.");
  }

  const profile = await fetchMicrosoftProfile(token.access_token);
  const mailboxAddress =
    profile.mail || profile.userPrincipalName || profile.displayName || "unknown";

  return {
    id: createId("outlook"),
    userId,
    mailboxAddress,
    status: "connected",
    accessTokenCiphertext: await encryptOAuthSecret(token.access_token),
    refreshTokenCiphertext: await encryptOAuthSecret(token.refresh_token),
    expiresAt: new Date(now.getTime() + expiresInSeconds * 1000).toISOString(),
    lastSyncAt: undefined,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

export async function exchangeOutlookAuthorizationCode(
  userId: string,
  code: string
) {
  const token = await requestMicrosoftToken({
    grant_type: "authorization_code",
    code,
  });

  return connectionFromMicrosoftToken(userId, token);
}

export async function refreshRealOutlookConnection(connection: OutlookConnection) {
  const refreshToken = await decryptOAuthSecret(connection.refreshTokenCiphertext);
  const token = await requestMicrosoftToken({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const now = new Date();
  const expiresInSeconds = token.expires_in ?? 3600;

  return {
    ...connection,
    accessTokenCiphertext: await encryptOAuthSecret(token.access_token),
    refreshTokenCiphertext: token.refresh_token
      ? await encryptOAuthSecret(token.refresh_token)
      : connection.refreshTokenCiphertext,
    expiresAt: new Date(now.getTime() + expiresInSeconds * 1000).toISOString(),
    updatedAt: now.toISOString(),
  };
}

export async function refreshOutlookTokenIfNeeded(
  connection: OutlookConnection | null
) {
  if (!connection) {
    return null;
  }

  if (new Date(connection.expiresAt).getTime() > Date.now() + 60_000) {
    return connection;
  }

  if (isRealOutlookMode() && !isMockOutlookConnection(connection)) {
    return refreshRealOutlookConnection(connection);
  }

  return {
    ...connection,
    accessTokenCiphertext: "mock-refreshed-encrypted-outlook-access-token",
    expiresAt: new Date(Date.now() + 55 * 60 * 1000).toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export async function verifyOutlookMailboxAccess(connection: OutlookConnection | null) {
  if (!connection || connection.status !== "connected") {
    return false;
  }

  if (isMockOutlookConnection(connection)) {
    return Boolean(connection.mailboxAddress);
  }

  const accessToken = await decryptOAuthSecret(connection.accessTokenCiphertext);
  const profile = await fetchMicrosoftProfile(accessToken);
  return Boolean(profile.mail || profile.userPrincipalName || profile.displayName);
}

export function createMockOutlookConnection(userId: string): OutlookConnection {
  const now = new Date();
  return {
    id: createId("outlook"),
    userId,
    mailboxAddress: "ap@into.example",
    status: "connected",
    accessTokenCiphertext: "mock-encrypted-outlook-access-token",
    refreshTokenCiphertext: "mock-encrypted-outlook-refresh-token",
    expiresAt: new Date(now.getTime() + 55 * 60 * 1000).toISOString(),
    lastSyncAt: now.toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

export function mockDetectedInvoiceEmails() {
  return [
    {
      messageId: createId("msg"),
      subject: "Invoice INV-OUTLOOK-2401 from Delta IT Services",
      sender: "billing@deltait.example",
      attachmentName: "outlook-delta-it-2401.pdf",
      attachmentType: "application/pdf",
      attachmentSize: 182_400,
    },
    {
      messageId: createId("msg"),
      subject: "Invoice needs review",
      sender: "accounts@noordzee.example",
      attachmentName: "missing-due-date-invoice.png",
      attachmentType: "image/png",
      attachmentSize: 94_120,
    },
  ];
}
