import type {
  ExactConnection,
  ExactCostCenter,
  ExactCostUnit,
  ExactGlAccount,
  ExactHistoricalPurchaseBooking,
  ExactJournal,
  ExactMasterDataCache,
  ExactPaymentCondition,
  ExactSupplierAccount,
  ExactVatCode,
  UploadedInvoice,
} from "../domain/invoice";
import {
  assertInvoiceBookingAllowed,
  isIntoPurchaseVatCode,
} from "../domain/invoice";
import { Buffer } from "node:buffer";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  parseAuthMode,
  type RequestPrincipal,
  type VerifiedPrincipal,
} from "./verified-session-auth";
import { configuredAuthRepository } from "../repository/configured-auth-repository";
import { databasePersistenceIdentity } from "../repository/sqlite-store";
import { createId } from "../utils/id";
import { getStoredInvoiceFile } from "./storage-service";
import {
  decodeExactStatePayload,
  decryptExactSecret,
  encodeExactStatePayload,
  encryptExactSecret,
  signExactState,
} from "./exact-token-crypto";
import {
  exactOAuthConfigurationStatus,
  exactRedirectUri,
} from "./app-config-service";

type ExactTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
};

type ODataResponse<T> = {
  d?: {
    results?: T[];
    __next?: string;
  };
  value?: T[];
};

type ExactStatePayload = {
  userId: string;
  nonce: string;
  issuedAt: number;
  auth: ExactAuthReference;
};

type ExactAuthReference =
  | {
      kind: "verified";
      userId: string;
      sessionId: string;
      sessionCorrelationId: string;
      requestId: string;
      repositoryIdentityHash: string;
    }
  | {
      kind: "legacy";
      sessionCorrelationId: string;
      requestId: string;
    };

type ExactBookingResult = {
  exactBookingId: string;
  exactDocumentId: string;
  exactAttachmentId: string;
  divisionCode: string;
  journal: "60" | "61";
  financialYear: number;
  period: number;
  attachedFileKey: string;
  bookedAt: string;
};

export type ExactBookingPersistenceHooks = {
  beforeWrite(): Promise<void>;
  recordProgress(progress: {
    exactDocumentId?: string;
    exactAttachmentId?: string;
    exactBookingId?: string;
  }): Promise<void>;
};

export type ExactDuplicatePurchaseBooking = {
  exactBookingId: string;
  yourRef: string;
  totalAmount: number;
  supplierAccountId?: string;
};

const exactDefaultBaseUrl = "https://start.exactonline.nl";
const exactMasterDataResourcePatterns = [
  /\/crm\/accounts(?:[/?(]|$)/i,
  /\/cashflow\/paymentconditions(?:[/?(]|$)/i,
  /\/financial\/journals(?:[/?(]|$)/i,
  /\/financial\/glaccounts(?:[/?(]|$)/i,
  /\/hrm\/costcenters(?:[/?(]|$)/i,
  /\/financial\/costcenters(?:[/?(]|$)/i,
  /\/hrm\/costunits(?:[/?(]|$)/i,
  /\/financial\/costunits(?:[/?(]|$)/i,
  /\/vat\/vatcodes(?:[/?(]|$)/i,
  /\/financial\/vatcodes(?:[/?(]|$)/i,
];

function cleanBaseUrl(value: string | undefined) {
  return (value?.trim() || exactDefaultBaseUrl).replace(/\/+$/, "");
}

export function exactIntegrationMode() {
  const clientId = process.env.EXACT_ONLINE_CLIENT_ID?.trim();
  const clientSecret = process.env.EXACT_ONLINE_CLIENT_SECRET?.trim();
  if (clientId && clientSecret) {
    return "real";
  }

  const explicit = process.env.EXACT_ONLINE_MODE?.trim().toLowerCase();
  if (explicit === "real" || explicit === "mock") {
    return explicit;
  }

  return "mock";
}

export function isRealExactMode() {
  return exactIntegrationMode() === "real";
}

export function isRealExactBookingEnabled() {
  return process.env.EXACT_ONLINE_ENABLE_REAL_BOOKING?.trim().toLowerCase() === "true";
}

export function isMockExactConnection(connection: ExactConnection | null) {
  return (
    !connection ||
    connection.accessTokenCiphertext.startsWith("mock-") ||
    connection.refreshTokenCiphertext.startsWith("mock-")
  );
}

function isExactMasterDataResource(pathOrUrl: string) {
  const path =
    pathOrUrl.startsWith("http") || pathOrUrl.startsWith("https")
      ? new URL(pathOrUrl).pathname
      : pathOrUrl;

  return exactMasterDataResourcePatterns.some((pattern) => pattern.test(path));
}

export function assertExactMasterDataReadOnlyRequest(
  method: string,
  pathOrUrl: string
) {
  const normalizedMethod = method.toUpperCase();
  if (
    normalizedMethod !== "GET" &&
    normalizedMethod !== "HEAD" &&
    isExactMasterDataResource(pathOrUrl)
  ) {
    throw new Error(
      `Blocked ${normalizedMethod} request to Exact Online master data resource ${pathOrUrl}. INTO is read-only for Exact master data.`
    );
  }
}

function exactConfig() {
  const baseUrl = cleanBaseUrl(process.env.EXACT_ONLINE_BASE_URL);
  const clientId = process.env.EXACT_ONLINE_CLIENT_ID?.trim() || "";
  const clientSecret = process.env.EXACT_ONLINE_CLIENT_SECRET?.trim() || "";
  const redirectUri = exactRedirectUri();
  const configuration = exactOAuthConfigurationStatus();

  if (configuration.clientIdLooksLikeEmail) {
    throw new Error(
      "EXACT_ONLINE_CLIENT_ID must be the Exact OAuth app Client ID, not an email address."
    );
  }

  if (isRealExactMode() && !configuration.ready) {
    throw new Error(
      `${configuration.missingEnv.join(", ")} must be configured for real Exact Online OAuth.`
    );
  }

  return { baseUrl, clientId, clientSecret, redirectUri };
}

export async function createExactOAuthState(userId: string, principal: RequestPrincipal) {
  const auth: ExactAuthReference = principal.verificationState === "verified"
    ? (() => {
        if (!principal.sessionId) throw new Error("Verified Exact OAuth requires a persisted session.");
        return {
          kind: "verified" as const,
          userId: principal.actorId,
          sessionId: principal.sessionId,
          sessionCorrelationId: principal.sessionCorrelationId,
          requestId: principal.requestId,
          repositoryIdentityHash: createHash("sha256")
            .update(databasePersistenceIdentity())
            .digest("hex"),
        };
      })()
    : {
        kind: "legacy",
        sessionCorrelationId: principal.sessionCorrelationId,
        requestId: principal.requestId,
      };
  const payload = encodeExactStatePayload({
    userId,
    nonce: createId("exact_state"),
    issuedAt: Date.now(),
    auth,
  } satisfies ExactStatePayload);
  const signature = await signExactState(payload);

  return `${payload}.${signature}`;
}

export async function verifyExactOAuthState(state: string) {
  const parts = state.split(".");
  const [payload, signature] = parts;
  if (parts.length !== 2 || !payload || !signature) {
    throw new Error("Exact OAuth state is missing or invalid.");
  }

  const expected = await signExactState(payload);
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    throw new Error("Exact OAuth state signature is invalid.");
  }

  const decoded = decodeExactStatePayload<ExactStatePayload>(payload);
  const age = Date.now() - decoded.issuedAt;
  if (!Number.isFinite(decoded.issuedAt) || age < -60_000 || age > 15 * 60 * 1000) {
    throw new Error("Exact OAuth state has expired. Start the connection again.");
  }
  const auth = decoded.auth;
  const validAuth = auth && typeof auth.requestId === "string" && auth.requestId.length > 0 &&
    typeof auth.sessionCorrelationId === "string" && auth.sessionCorrelationId.length > 0 &&
    (auth.kind === "legacy" || (
      auth.kind === "verified" &&
      typeof auth.userId === "string" && auth.userId.length > 0 &&
      typeof auth.sessionId === "string" && auth.sessionId.length > 0 &&
      /^[a-f0-9]{64}$/.test(auth.repositoryIdentityHash)
    ));
  if (!decoded.userId || !decoded.nonce || !validAuth) {
    throw new Error("Exact OAuth state is missing or invalid.");
  }

  return decoded;
}

export async function reauthorizeExactOAuthState(state: string, now = Date.now()): Promise<RequestPrincipal> {
  const decoded = await verifyExactOAuthState(state);
  const mode = parseAuthMode();
  if (decoded.auth.kind === "legacy") {
    if (mode === "verified_user") throw new Error("Exact OAuth state is no longer authorized.");
    return Object.freeze({
      actorId: "shared_user",
      actorName: "Shared access",
      accessLevel: "legacy_shared",
      verificationState: "legacy",
      sessionCorrelationId: decoded.auth.sessionCorrelationId,
      requestId: decoded.auth.requestId,
    });
  }
  if (mode === "legacy_password") throw new Error("Exact OAuth state is no longer authorized.");
  const identityHash = createHash("sha256").update(databasePersistenceIdentity()).digest("hex");
  if (identityHash !== decoded.auth.repositoryIdentityHash) {
    throw new Error("Exact OAuth state is no longer authorized.");
  }
  const session = await (await configuredAuthRepository()).findSessionById(decoded.auth.sessionId);
  const correlationHash = createHash("sha256").update(decoded.auth.sessionCorrelationId).digest("base64url");
  if (
    !session || session.userId !== decoded.auth.userId || session.tokenVersion !== 1 ||
    session.revokedAt || Date.parse(session.expiresAt) <= now ||
    session.user.status !== "active" || !session.user.verifiedAt ||
    session.correlationIdHash !== correlationHash
  ) {
    throw new Error("Exact OAuth state is no longer authorized.");
  }
  return Object.freeze({
    actorId: session.user.id,
    actorName: session.user.displayName,
    accessLevel: "verified_user",
    verificationState: "verified",
    sessionCorrelationId: decoded.auth.sessionCorrelationId,
    requestId: decoded.auth.requestId,
    sessionId: session.id,
  } satisfies VerifiedPrincipal);
}

export async function createRealExactAuthorizationUrl(userId: string, principal: RequestPrincipal) {
  const { baseUrl, clientId, redirectUri } = exactConfig();
  const state = await createExactOAuthState(userId, principal);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    force_login: "1",
    state,
  });

  return {
    authorizationUrl: `${baseUrl}/api/oauth2/auth?${params.toString()}`,
    state,
  };
}

async function requestExactToken(params: Record<string, string>) {
  const { baseUrl, clientId, clientSecret, redirectUri } = exactConfig();
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    ...params,
  });
  const response = await fetch(`${baseUrl}/api/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const detail =
      payload.error_description || payload.error || response.statusText;
    throw new Error(`Exact OAuth token request failed: ${detail}`);
  }

  return payload as ExactTokenResponse;
}

function scopesFromTokenResponse(token: ExactTokenResponse) {
  return (token.scope || "")
    .split(/[ ,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

async function connectionFromToken(
  userId: string,
  token: ExactTokenResponse,
  divisionCode = ""
): Promise<ExactConnection> {
  const now = new Date();
  const expiresInSeconds = token.expires_in ?? 600;

  if (!token.refresh_token) {
    throw new Error("Exact OAuth response did not include a refresh token.");
  }

  return {
    id: createId("exact"),
    userId,
    divisionCode,
    status: "connected",
    accessTokenCiphertext: await encryptExactSecret(token.access_token),
    refreshTokenCiphertext: await encryptExactSecret(token.refresh_token),
    expiresAt: new Date(now.getTime() + expiresInSeconds * 1000).toISOString(),
    scopes: scopesFromTokenResponse(token),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

export async function exchangeExactAuthorizationCode(
  userId: string,
  code: string
) {
  const token = await requestExactToken({
    grant_type: "authorization_code",
    code,
  });
  const connection = await connectionFromToken(userId, token);
  const divisionCode = await fetchExactCurrentDivision(connection);

  return {
    ...connection,
    divisionCode,
    updatedAt: new Date().toISOString(),
  };
}

export async function refreshRealExactConnection(connection: ExactConnection) {
  const refreshToken = await decryptExactSecret(connection.refreshTokenCiphertext);
  const token = await requestExactToken({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const now = new Date();
  const expiresInSeconds = token.expires_in ?? 600;

  return {
    ...connection,
    accessTokenCiphertext: await encryptExactSecret(token.access_token),
    refreshTokenCiphertext: token.refresh_token
      ? await encryptExactSecret(token.refresh_token)
      : connection.refreshTokenCiphertext,
    expiresAt: new Date(now.getTime() + expiresInSeconds * 1000).toISOString(),
    scopes: scopesFromTokenResponse(token).length
      ? scopesFromTokenResponse(token)
      : connection.scopes,
    updatedAt: now.toISOString(),
  };
}

async function exactAccessToken(connection: ExactConnection) {
  return decryptExactSecret(connection.accessTokenCiphertext);
}

function odataResults<T>(payload: ODataResponse<T> | T[]): T[] {
  if (Array.isArray(payload)) {
    return payload;
  }

  return payload.d?.results ?? payload.value ?? [];
}

function odataNext(payload: ODataResponse<unknown>) {
  return payload.d?.__next;
}

async function fetchExactJson<T>(
  connection: ExactConnection,
  pathOrUrl: string
): Promise<T> {
  return requestExactJson<T>(connection, pathOrUrl, { method: "GET" });
}

async function requestExactJson<T>(
  connection: ExactConnection,
  pathOrUrl: string,
  options: { method: "GET" | "POST"; body?: unknown }
): Promise<T> {
  const { baseUrl } = exactConfig();
  const accessToken = await exactAccessToken(connection);
  const url = pathOrUrl.startsWith("http")
    ? pathOrUrl
    : `${baseUrl}${pathOrUrl}`;
  assertExactMasterDataReadOnlyRequest(options.method, pathOrUrl);
  const response = await fetch(url, {
    method: options.method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;

  if (!response.ok) {
    const error = normalizeRecord(payload.error);
    const errorMessage = normalizeRecord(error.message);
    const detail =
      valueOf(errorMessage, ["value"]) ||
      valueOf(payload, ["error_description"]) ||
      (typeof payload.error === "string" ? payload.error : "") ||
      response.statusText;
    throw new Error(`Exact API request failed for ${pathOrUrl}: ${detail}`);
  }

  return payload as T;
}

async function fetchExactOData<T>(
  connection: ExactConnection,
  divisionCode: string,
  relativePath: string,
  options: { optional?: boolean; maxPages?: number } = {}
) {
  const maxPages = options.maxPages ?? 10;
  let pathOrUrl = `/api/v1/${divisionCode}${relativePath}`;
  const results: T[] = [];

  for (let page = 0; pathOrUrl && page < maxPages; page += 1) {
    const payload = await fetchExactJson<ODataResponse<T>>(connection, pathOrUrl);
    results.push(...odataResults(payload));
    pathOrUrl = odataNext(payload) ?? "";
  }

  return results;
}

async function fetchFirstAvailable<T>(
  connection: ExactConnection,
  divisionCode: string,
  paths: string[],
  options: { optional?: boolean; maxPages?: number } = {}
) {
  const failures: string[] = [];

  for (const path of paths) {
    try {
      return await fetchExactOData<T>(connection, divisionCode, path, options);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (options.optional) {
    return [];
  }

  throw new Error(failures[0] ?? "Exact API resource could not be loaded.");
}

async function fetchAllAvailable<T>(
  connection: ExactConnection,
  divisionCode: string,
  paths: string[],
  options: { optional?: boolean; maxPages?: number } = {}
) {
  const failures: string[] = [];
  const results: T[] = [];

  for (const path of paths) {
    try {
      results.push(...(await fetchExactOData<T>(connection, divisionCode, path, options)));
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (!results.length && failures.length === paths.length && !options.optional) {
    throw new Error(failures[0] ?? "Exact API resource could not be loaded.");
  }

  return results;
}

function valueOf(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== "") {
      return String(value);
    }
  }

  return "";
}

function booleanValueOf(record: Record<string, unknown>, keys: string[], fallback = true) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      return value !== 0;
    }
    if (typeof value === "string") {
      return !["false", "0", "inactive"].includes(value.toLowerCase());
    }
  }

  return fallback;
}

function numberValueOf(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number") {
      return value;
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
  }

  return undefined;
}

function normalizeRecord(value: unknown) {
  return (value && typeof value === "object" ? value : {}) as Record<
    string,
    unknown
  >;
}

function mapSupplier(value: unknown): ExactSupplierAccount {
  const record = normalizeRecord(value);
  const code = valueOf(record, ["Code", "AccountCode", "SupplierCode", "ID"]);
  const id = valueOf(record, ["ID", "Id", "AccountID", "Account", "Code"]) || code;
  const paymentConditionCode = valueOf(record, [
    "PaymentConditionPurchase",
    "PaymentCondition",
    "PaymentConditionCode",
    "PaymentConditionID",
  ]);
  const defaultGlAccount = valueOf(record, [
    "GLAccountPurchase",
    "PurchaseGLAccount",
    "DefaultGLAccount",
    "GLAccount",
  ]);

  return {
    id,
    code,
    name: valueOf(record, ["Name", "AccountName", "SupplierName"]),
    vatNumber: valueOf(record, ["VATNumber", "VatNumber", "TaxNumber"]),
    iban: valueOf(record, ["IBAN", "Iban", "BankAccountIBAN", "BankAccount"]),
    bicCode: valueOf(record, ["BICCode", "BIC", "BankAccountBIC"]),
    chamberOfCommerceNumber: valueOf(record, [
      "ChamberOfCommerce",
      "ChamberOfCommerceNumber",
      "COCNumber",
    ]),
    address: [
      valueOf(record, ["AddressLine1", "Address", "Street"]),
      valueOf(record, ["Postcode", "ZipCode"]),
      valueOf(record, ["City"]),
    ]
      .filter(Boolean)
      .join(", "),
    city: valueOf(record, ["City"]),
    country: valueOf(record, ["Country", "CountryCode"]),
    isSupplier: booleanValueOf(record, ["IsSupplier", "Supplier"], true),
    paymentConditionCode,
    paymentConditionLabel:
      valueOf(record, [
        "PaymentConditionPurchaseDescription",
        "PaymentConditionDescription",
        "PaymentConditionLabel",
      ]) ||
      paymentConditionCode,
    defaultGlAccount,
    defaultGlAccountName:
      valueOf(record, ["GLAccountPurchaseDescription", "DefaultGLAccountName"]) ||
      defaultGlAccount,
    defaultCostCentre: valueOf(record, ["Costcenter", "CostCenter", "CostCentre"]),
    defaultCostUnit: valueOf(record, ["Costunit", "CostUnit"]),
    isInBodyEntity: /inbody/i.test(
      valueOf(record, ["Name", "AccountName", "SupplierName"])
    ),
  };
}

function mapPaymentCondition(value: unknown): ExactPaymentCondition {
  const record = normalizeRecord(value);
  const code = valueOf(record, ["Code", "ID", "PaymentCondition"]);
  return {
    code,
    label: valueOf(record, ["Description", "Name", "Label"]) || code,
    days: numberValueOf(record, ["Days", "PaymentDays", "TermInDays"]),
    isActive: booleanValueOf(record, ["IsActive", "Active"], true),
  };
}

function mapJournal(value: unknown): ExactJournal {
  const record = normalizeRecord(value);
  const code = valueOf(record, ["Code", "Journal", "ID"]);
  const description = valueOf(record, ["Description", "Name"]) || code;
  const typeValue = valueOf(record, ["Type", "JournalType"]).toLowerCase();
  const type = /purchase|inkoop/.test(`${typeValue} ${description.toLowerCase()}`)
    ? "purchase"
    : "general";
  return {
    code,
    description,
    type,
    isActive: booleanValueOf(record, ["IsActive", "Active"], true),
  };
}

function mapGlAccount(value: unknown): ExactGlAccount {
  const record = normalizeRecord(value);
  const code = valueOf(record, ["Code", "GLAccount", "ID"]);
  return {
    id: valueOf(record, ["ID", "Id"]),
    code,
    name: valueOf(record, ["Description", "Name"]) || code,
    isActive: booleanValueOf(record, ["IsActive", "Active"], true),
  };
}

function mapCostCenter(value: unknown): ExactCostCenter {
  const record = normalizeRecord(value);
  const code = valueOf(record, ["Code", "Costcenter", "CostCenter", "ID"]);
  return {
    code,
    description: valueOf(record, ["Description", "Name"]) || code,
    isActive: booleanValueOf(record, ["IsActive", "Active"], true),
  };
}

function mapCostUnit(value: unknown): ExactCostUnit {
  const record = normalizeRecord(value);
  const code = valueOf(record, ["Code", "Costunit", "CostUnit", "ID"]);
  return {
    code,
    description: valueOf(record, ["Description", "Name"]) || code,
    isActive: booleanValueOf(record, ["IsActive", "Active"], true),
  };
}

function mapVatCode(value: unknown): ExactVatCode {
  const record = normalizeRecord(value);
  const code = valueOf(record, ["Code", "VATCode", "ID"]);
  const description = valueOf(record, ["Description", "Name"]) || code;
  return {
    code,
    description,
    percentage: numberValueOf(record, ["Percentage", "VATPercentage", "Rate"]) ?? 0,
    type: /sales/i.test(valueOf(record, ["Type", "VATType", "TaxType"]))
      ? "sales"
      : "purchase",
    isActive: booleanValueOf(record, ["IsActive", "Active"], true),
  };
}

function normalizeExactDate(value: string) {
  const exactTimestamp = value.match(/^\/Date\((\d+)(?:[+-]\d+)?\)\/$/);
  if (exactTimestamp) {
    return new Date(Number(exactTimestamp[1])).toISOString().slice(0, 10);
  }

  return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : value;
}

function mapHistory(
  value: unknown,
  headerValue?: unknown
): ExactHistoricalPurchaseBooking | null {
  const record = normalizeRecord(value);
  const header = normalizeRecord(headerValue);
  const lineValue = (keys: string[]) => valueOf(record, keys);
  const headerValueFor = (keys: string[]) => valueOf(header, keys);
  const lineNumber = (keys: string[]) => numberValueOf(record, keys);
  const headerNumber = (keys: string[]) => numberValueOf(header, keys);
  const supplierAccountId = lineValue([
    "Supplier",
    "SupplierID",
    "Account",
    "AccountID",
  ]) || headerValueFor(["Supplier", "SupplierID", "Account", "AccountID"]);
  const glAccount = lineValue(["GLAccount", "GeneralLedgerAccount"]);
  if (!supplierAccountId || !glAccount) {
    return null;
  }

  const entryId =
    lineValue(["EntryID", "Entry", "PurchaseEntry", "HeaderID"]) ||
    headerValueFor(["EntryID", "ID", "EntryNumber"]);
  const lineId = lineValue(["ID", "LineID"]);
  const description =
    lineValue(["Description", "LineDescription"]) ||
    headerValueFor(["Description"]) ||
    headerValueFor(["YourRef", "InvoiceNumber"]);
  const invoiceDate = headerValueFor([
    "EntryDate",
    "InvoiceDate",
    "DocumentDate",
    "Date",
  ]) || lineValue(["EntryDate", "InvoiceDate", "Date"]);
  const accrualFrom = lineValue(["From", "DateFrom", "AccrualFrom"]);
  const accrualTo = lineValue(["To", "DateTo", "AccrualTo"]);

  return {
    id: lineId || entryId || createId("exact_hist"),
    entryId: entryId || undefined,
    lineId: lineId || undefined,
    supplierAccountId,
    yourRef:
      headerValueFor(["YourRef", "Reference", "InvoiceNumber"]) ||
      lineValue(["YourRef", "Reference", "InvoiceNumber"]),
    invoiceNumber:
      headerValueFor(["InvoiceNumber", "YourRef", "Reference"]) ||
      lineValue(["InvoiceNumber", "YourRef", "Reference"]),
    invoiceDate: invoiceDate ? normalizeExactDate(invoiceDate) : undefined,
    description: description || undefined,
    totalAmount:
      headerNumber([
        "AmountDC",
        "AmountFC",
        "Amount",
        "TotalAmount",
        "InvoiceAmount",
        "AmountVATIncl",
      ]) ??
      lineNumber(["TotalAmount", "InvoiceAmount", "AmountVATIncl"]),
    lineAmount: lineNumber(["AmountFC", "AmountDC", "Amount"]),
    vatAmount: lineNumber(["VATAmountFC", "VATAmountDC", "VATAmount"]),
    vatPercentage: lineNumber(["VATPercentage", "VATRate", "Percentage"]),
    currency:
      headerValueFor(["Currency", "CurrencyCode"]) ||
      lineValue(["Currency", "CurrencyCode"]) ||
      undefined,
    paymentConditionCode:
      headerValueFor([
        "PaymentCondition",
        "PaymentConditionCode",
        "PaymentConditionPurchase",
      ]) ||
      lineValue(["PaymentCondition", "PaymentConditionCode"]) ||
      undefined,
    descriptionKey: description
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-"),
    glAccount,
    vatCode: lineValue(["VATCode", "VatCode"]) || "6",
    costCentre: lineValue(["Costcenter", "CostCenter", "CostCentre"]),
    costUnit: lineValue(["Costunit", "CostUnit"]),
    accrualFrom: accrualFrom ? normalizeExactDate(accrualFrom) : undefined,
    accrualTo: accrualTo ? normalizeExactDate(accrualTo) : undefined,
  };
}

function odataString(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function duplicateReferenceForInvoice(invoice: UploadedInvoice) {
  return (
    invoice.purchaseJournal?.yourRef ||
    invoice.extractedData.referenceCode ||
    invoice.extractedData.invoiceNumber ||
    ""
  ).trim();
}

function duplicateAmountForInvoice(invoice: UploadedInvoice) {
  return invoice.extractedData.grossAmount || invoice.purchaseJournal?.totals.grossAmount || 0;
}

function mapDuplicateCandidate(
  value: unknown,
  expectedRef: string,
  expectedAmount: number,
  expectedSupplier?: string
): ExactDuplicatePurchaseBooking | null {
  const record = normalizeRecord(value);
  const yourRef = valueOf(record, ["YourRef", "Reference", "InvoiceNumber"]);
  const supplierAccountId = valueOf(record, [
    "Supplier",
    "SupplierID",
    "Account",
    "AccountID",
  ]);
  const totalAmount = numberValueOf(record, [
    "AmountDC",
    "AmountFC",
    "Amount",
    "TotalAmount",
    "InvoiceAmount",
    "AmountVATIncl",
  ]);

  if (yourRef.trim().toLowerCase() !== expectedRef.trim().toLowerCase()) {
    return null;
  }
  if (expectedSupplier && supplierAccountId !== expectedSupplier) {
    return null;
  }

  return {
    exactBookingId:
      valueOf(record, ["ID", "EntryID", "EntryNumber", "EntryNumberString"]) ||
      createId("exact_duplicate"),
    yourRef,
    totalAmount: totalAmount ?? expectedAmount,
    supplierAccountId: supplierAccountId || expectedSupplier,
  };
}

export async function findRealExactPurchaseBookingDuplicate(
  connection: ExactConnection,
  invoice: UploadedInvoice
): Promise<ExactDuplicatePurchaseBooking | null> {
  const yourRef = duplicateReferenceForInvoice(invoice);
  const totalAmount = duplicateAmountForInvoice(invoice);
  if (!yourRef) {
    return null;
  }

  const divisionCode = connection.divisionCode || (await fetchExactCurrentDivision(connection));
  const expectedSupplier = invoice.purchaseJournal?.supplierResolution.selectedAccountId;
  const filter = encodeURIComponent(`YourRef eq ${odataString(yourRef)}`);
  const candidates = await fetchAllAvailable<Record<string, unknown>>(
    connection,
    divisionCode,
    [
      `/purchaseentry/PurchaseEntries?$filter=${filter}&$top=25`,
      `/purchaseentry/PurchaseEntryLines?$filter=${filter}&$top=25`,
    ],
    { optional: true, maxPages: 1 }
  );

  for (const candidate of candidates) {
    const duplicate = mapDuplicateCandidate(
      candidate,
      yourRef,
      totalAmount,
      expectedSupplier
    );
    if (duplicate) {
      return duplicate;
    }
  }

  return null;
}

export async function fetchExactCurrentDivision(connection: ExactConnection) {
  const payload = await fetchExactJson<ODataResponse<Record<string, unknown>>>(
    connection,
    "/api/v1/current/Me"
  );
  const [me] = odataResults(payload);
  const division = valueOf(normalizeRecord(me), [
    "CurrentDivision",
    "Division",
    "DivisionCode",
  ]);

  if (!division) {
    throw new Error("Exact Online did not return the current division.");
  }

  return division;
}

export async function syncRealExactMasterData(
  connection: ExactConnection
): Promise<ExactMasterDataCache> {
  const divisionCode = connection.divisionCode || (await fetchExactCurrentDivision(connection));
  const syncedAt = new Date();

  const [
    suppliersRaw,
    paymentConditionsRaw,
    journalsRaw,
    glAccountsRaw,
    costCentersRaw,
    costUnitsRaw,
    vatCodesRaw,
    historicalLinesRaw,
    historicalEntriesRaw,
  ] = await Promise.all([
    fetchFirstAvailable(connection, divisionCode, [
      "/crm/Accounts?$filter=IsSupplier eq true&$top=500",
      "/crm/Accounts?$top=500",
    ]),
    fetchFirstAvailable(connection, divisionCode, [
      "/cashflow/PaymentConditions?$top=500",
    ]),
    fetchFirstAvailable(connection, divisionCode, [
      "/financial/Journals?$top=500",
    ]),
    fetchFirstAvailable(connection, divisionCode, [
      "/financial/GLAccounts?$top=500",
    ]),
    fetchFirstAvailable(
      connection,
      divisionCode,
      ["/hrm/Costcenters?$top=500", "/financial/Costcenters?$top=500"],
      { optional: true }
    ),
    fetchFirstAvailable(
      connection,
      divisionCode,
      ["/hrm/Costunits?$top=500", "/financial/Costunits?$top=500"],
      { optional: true }
    ),
    fetchFirstAvailable(connection, divisionCode, [
      "/vat/VATCodes?$top=500",
      "/financial/VATCodes?$top=500",
    ]),
    fetchFirstAvailable(
      connection,
      divisionCode,
      ["/purchaseentry/PurchaseEntryLines?$top=500"],
      { optional: true, maxPages: 3 }
    ),
    fetchFirstAvailable(
      connection,
      divisionCode,
      ["/purchaseentry/PurchaseEntries?$top=500"],
      { optional: true, maxPages: 3 }
    ),
  ]);

  const historicalHeaders = new Map(
    historicalEntriesRaw
      .map((entry) => {
        const record = normalizeRecord(entry);
        const id = valueOf(record, ["EntryID", "ID", "EntryNumber"]);
        return id ? ([id, entry] as const) : null;
      })
      .filter((entry): entry is readonly [string, unknown] => Boolean(entry))
  );
  const historicalPurchaseBookings = historicalLinesRaw
    .map((line) => {
      const record = normalizeRecord(line);
      const entryId = valueOf(record, [
        "EntryID",
        "Entry",
        "PurchaseEntry",
        "HeaderID",
      ]);
      return mapHistory(line, historicalHeaders.get(entryId));
    })
    .filter((item): item is ExactHistoricalPurchaseBooking => Boolean(item));
  const paymentConditions = paymentConditionsRaw
    .map(mapPaymentCondition)
    .filter((condition) => condition.code);
  const paymentConditionLabels = new Map(
    paymentConditions.map((condition) => [condition.code, condition.label])
  );
  const suppliers = suppliersRaw
    .map(mapSupplier)
    .filter((supplier) => supplier.name)
    .map((supplier) => ({
      ...supplier,
      paymentConditionLabel:
        paymentConditionLabels.get(supplier.paymentConditionCode) ||
        supplier.paymentConditionLabel,
    }));

  return {
    source: "exact-online",
    divisionCode,
    lastSyncedAt: syncedAt.toISOString(),
    staleAfter: new Date(syncedAt.getTime() + 30 * 60 * 1000).toISOString(),
    suppliers,
    paymentConditions,
    journals: journalsRaw.map(mapJournal).filter((journal) => journal.code),
    glAccounts: glAccountsRaw.map(mapGlAccount).filter((account) => account.code),
    costCenters: costCentersRaw
      .map(mapCostCenter)
      .filter((costCenter) => costCenter.code),
    costUnits: costUnitsRaw.map(mapCostUnit).filter((costUnit) => costUnit.code),
    vatCodes: vatCodesRaw.map(mapVatCode).filter((vatCode) => vatCode.code),
    historicalPurchaseBookings,
  };
}

export async function createRealExactPurchaseBooking(
  connection: ExactConnection,
  invoice: UploadedInvoice,
  masterData: ExactMasterDataCache,
  persistence?: ExactBookingPersistenceHooks
): Promise<ExactBookingResult> {
  assertInvoiceBookingAllowed(invoice);
  if (!isRealExactBookingEnabled()) {
    throw new Error(
      "Real Exact Online booking is disabled. Set EXACT_ONLINE_ENABLE_REAL_BOOKING=true only after validating the purchase-entry payload with your Exact Online division."
    );
  }
  if (!persistence) {
    throw new Error("Durable booking persistence is required before writing to Exact Online.");
  }

  const booking = invoice.purchaseJournal;
  if (!booking?.attachmentStorageKey) {
    throw new Error("Original invoice attachment is required for Exact Online booking.");
  }

  const originalFile = await getStoredInvoiceFile(booking.attachmentStorageKey, {
    fileName: invoice.fileName,
    fileType: invoice.fileType,
  });
  if (!originalFile) {
    throw new Error("Original invoice file is not available in storage.");
  }

  const supplierId = booking.supplierResolution.selectedAccountId;
  if (!supplierId) {
    throw new Error("A resolved Exact supplier is required for booking.");
  }

  const purchaseEntryLines = booking.lines.map((line) => {
    if (!isIntoPurchaseVatCode(line.vatCode)) {
      throw new Error(`Unsupported purchase VAT code ${line.vatCode}.`);
    }

    const glAccount = masterData.glAccounts.find(
      (account) => account.code === line.finalSelectedAccount && account.isActive
    );
    if (!glAccount?.id) {
      throw new Error(
        `G/L account ${line.finalSelectedAccount} is missing its Exact Online ID. Sync Exact master data again.`
      );
    }

    return {
      AmountFC: line.amount,
      Description: line.description,
      GLAccount: glAccount.id,
      VATCode: line.vatCode,
      VATAmountFC: line.vatAmount,
      ...(line.costCentre ? { CostCenter: line.costCentre } : {}),
      ...(line.costUnit ? { CostUnit: line.costUnit } : {}),
      ...(line.from ? { From: exactDateValue(line.from) } : {}),
      ...(line.to ? { To: exactDateValue(line.to) } : {}),
    };
  });

  const divisionCode = connection.divisionCode || (await fetchExactCurrentDivision(connection));
  const documentType = exactPurchaseDocumentType();
  const documentTypes = await fetchExactOData<Record<string, unknown>>(
    connection,
    divisionCode,
    `/documents/DocumentTypes?$filter=ID eq ${documentType}&$top=1`,
    { maxPages: 1 }
  );
  const documentTypeRecord = documentTypes.find(
    (record) => Number(record.ID) === documentType
  );
  if (
    !documentTypeRecord ||
    !booleanValueOf(documentTypeRecord, ["DocumentIsCreatable", "IsCreatable"], false)
  ) {
    throw new Error(
      `Exact document type ${documentType} is missing or cannot be used to create purchase invoice documents.`
    );
  }

  await persistence.beforeWrite();
  const documentResponse = await requestExactJson<Record<string, unknown>>(
    connection,
    `/api/v1/${divisionCode}/documents/Documents`,
    {
      method: "POST",
      body: {
        Account: supplierId,
        AmountFC: invoice.extractedData.grossAmount ?? booking.totals.grossAmount,
        Currency: booking.currency,
        DocumentDate: exactDateValue(invoice.extractedData.invoiceDate),
        Subject: `Purchase invoice ${booking.yourRef} - ${invoice.extractedData.supplierName}`.slice(
          0,
          255
        ),
        Type: documentType,
      },
    }
  );
  const exactDocumentId = responseValue(documentResponse, ["ID", "Document"]);
  if (!exactDocumentId) {
    throw new Error("Exact Online created no usable document reference.");
  }
  await persistence.recordProgress({ exactDocumentId });

  const attachmentResponse = await requestExactJson<Record<string, unknown>>(
    connection,
    `/api/v1/${divisionCode}/documents/DocumentAttachments`,
    {
      method: "POST",
      body: {
        Attachment: Buffer.from(originalFile.bytes).toString("base64"),
        Document: exactDocumentId,
        FileName: invoice.fileName,
      },
    }
  );
  const exactAttachmentId =
    responseValue(attachmentResponse, ["ID", "AttachmentID"]) ||
    `${exactDocumentId}/${invoice.fileName}`;
  await persistence.recordProgress({ exactAttachmentId });

  const purchaseEntryResponse = await requestExactJson<Record<string, unknown>>(
    connection,
    `/api/v1/${divisionCode}/purchaseentry/PurchaseEntries`,
    {
      method: "POST",
      body: {
        Currency: booking.currency,
        Description: booking.description,
        Document: exactDocumentId,
        EntryDate: exactDateValue(invoice.extractedData.invoiceDate),
        ...(invoice.extractedData.dueDate
          ? { DueDate: exactDateValue(invoice.extractedData.dueDate) }
          : {}),
        Journal: booking.journal,
        PaymentCondition: booking.paymentConditionCode,
        PurchaseEntryLines: purchaseEntryLines,
        Supplier: supplierId,
        VATAmountFC: booking.totals.vatAmount,
        YourRef: booking.yourRef,
      },
    }
  );
  const exactBookingId = responseValue(purchaseEntryResponse, [
    "EntryID",
    "ID",
    "EntryNumber",
  ]);
  if (!exactBookingId) {
    throw new Error("Exact Online created no usable purchase entry reference.");
  }
  await persistence.recordProgress({ exactBookingId });

  return {
    exactBookingId,
    exactDocumentId,
    exactAttachmentId,
    divisionCode,
    journal: booking.journal,
    financialYear: booking.financialYear,
    period: booking.period,
    attachedFileKey: booking.attachmentStorageKey,
    bookedAt: new Date().toISOString(),
  };
}

function exactDateValue(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Exact booking date ${value || "(empty)"} is invalid.`);
  }
  return `${value}T00:00:00`;
}

function exactPurchaseDocumentType() {
  const configured = Number.parseInt(
    process.env.EXACT_ONLINE_DOCUMENT_TYPE?.trim() || "55",
    10
  );
  if (!Number.isInteger(configured) || configured <= 0) {
    throw new Error("EXACT_ONLINE_DOCUMENT_TYPE must be a positive number.");
  }
  return configured;
}

function responseValue(response: Record<string, unknown>, keys: string[]) {
  const entity = normalizeRecord(response.d ?? response);
  return valueOf(entity, keys);
}
