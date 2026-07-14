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
import { createId } from "../utils/id";
import {
  decodeExactStatePayload,
  decryptExactSecret,
  encodeExactStatePayload,
  encryptExactSecret,
  signExactState,
} from "./exact-token-crypto";
import { exactRedirectUri } from "./app-config-service";

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
};

type ExactBookingResult = {
  exactBookingId: string;
  divisionCode: string;
  journal: "60" | "61";
  financialYear: number;
  period: number;
  attachedFileKey: string;
  bookedAt: string;
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
  /\/crm\/paymentconditions(?:[/?(]|$)/i,
  /\/financial\/paymentconditions(?:[/?(]|$)/i,
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
  return (value || exactDefaultBaseUrl).replace(/\/+$/, "");
}

export function exactIntegrationMode() {
  const explicit = process.env.EXACT_ONLINE_MODE?.toLowerCase();
  if (explicit === "real" || explicit === "mock") {
    return explicit;
  }

  return process.env.EXACT_ONLINE_CLIENT_ID &&
    process.env.EXACT_ONLINE_CLIENT_SECRET
    ? "real"
    : "mock";
}

export function isRealExactMode() {
  return exactIntegrationMode() === "real";
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
  const clientId = process.env.EXACT_ONLINE_CLIENT_ID || "";
  const clientSecret = process.env.EXACT_ONLINE_CLIENT_SECRET || "";
  const redirectUri = exactRedirectUri();

  if (isRealExactMode() && (!clientId || !clientSecret || !redirectUri)) {
    throw new Error(
      "EXACT_ONLINE_CLIENT_ID, EXACT_ONLINE_CLIENT_SECRET, and EXACT_ONLINE_REDIRECT_URI are required for real Exact Online."
    );
  }

  return { baseUrl, clientId, clientSecret, redirectUri };
}

export async function createExactOAuthState(userId: string) {
  const payload = encodeExactStatePayload({
    userId,
    nonce: createId("exact_state"),
    issuedAt: Date.now(),
  } satisfies ExactStatePayload);
  const signature = await signExactState(payload);

  return `${payload}.${signature}`;
}

export async function verifyExactOAuthState(state: string) {
  const [payload, signature] = state.split(".");
  if (!payload || !signature) {
    throw new Error("Exact OAuth state is missing or invalid.");
  }

  const expected = await signExactState(payload);
  if (signature !== expected) {
    throw new Error("Exact OAuth state signature is invalid.");
  }

  const decoded = decodeExactStatePayload<ExactStatePayload>(payload);
  if (Date.now() - decoded.issuedAt > 15 * 60 * 1000) {
    throw new Error("Exact OAuth state has expired. Start the connection again.");
  }

  return decoded;
}

export async function createRealExactAuthorizationUrl(userId: string) {
  const { baseUrl, clientId, redirectUri } = exactConfig();
  const state = await createExactOAuthState(userId);
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
  const { baseUrl } = exactConfig();
  const accessToken = await exactAccessToken(connection);
  const url = pathOrUrl.startsWith("http")
    ? pathOrUrl
    : `${baseUrl}${pathOrUrl}`;
  assertExactMasterDataReadOnlyRequest("GET", pathOrUrl);
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const detail =
      payload.error?.message?.value ||
      payload.error_description ||
      payload.error ||
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
    country: valueOf(record, ["Country", "CountryCode"]),
    paymentConditionCode,
    paymentConditionLabel:
      valueOf(record, ["PaymentConditionDescription", "PaymentConditionLabel"]) ||
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

function mapHistory(value: unknown): ExactHistoricalPurchaseBooking | null {
  const record = normalizeRecord(value);
  const supplierAccountId = valueOf(record, [
    "Supplier",
    "SupplierID",
    "Account",
    "AccountID",
  ]);
  const glAccount = valueOf(record, ["GLAccount", "GeneralLedgerAccount"]);
  if (!supplierAccountId || !glAccount) {
    return null;
  }

  return {
    id: valueOf(record, ["ID", "EntryID", "EntryNumber"]) || createId("exact_hist"),
    supplierAccountId,
    yourRef: valueOf(record, ["YourRef", "Reference", "InvoiceNumber"]),
    invoiceNumber: valueOf(record, ["InvoiceNumber", "YourRef", "Reference"]),
    totalAmount: numberValueOf(record, [
      "AmountDC",
      "AmountFC",
      "Amount",
      "TotalAmount",
      "InvoiceAmount",
      "AmountVATIncl",
    ]),
    descriptionKey: valueOf(record, ["Description", "YourRef", "InvoiceNumber"])
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-"),
    glAccount,
    vatCode: valueOf(record, ["VATCode", "VatCode"]) || "6",
    costCentre: valueOf(record, ["Costcenter", "CostCenter", "CostCentre"]),
    costUnit: valueOf(record, ["Costunit", "CostUnit"]),
    accrualFrom: valueOf(record, ["From", "DateFrom", "AccrualFrom"]),
    accrualTo: valueOf(record, ["To", "DateTo", "AccrualTo"]),
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
    historicalRaw,
  ] = await Promise.all([
    fetchFirstAvailable(connection, divisionCode, [
      "/crm/Accounts?$filter=IsSupplier eq true&$top=500",
      "/crm/Accounts?$top=500",
    ]),
    fetchFirstAvailable(connection, divisionCode, [
      "/crm/PaymentConditions?$top=500",
      "/financial/PaymentConditions?$top=500",
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
      [
        "/purchaseentry/PurchaseEntryLines?$top=500",
        "/purchaseentry/PurchaseEntries?$top=500",
      ],
      { optional: true, maxPages: 3 }
    ),
  ]);

  const historicalPurchaseBookings = historicalRaw
    .map(mapHistory)
    .filter((item): item is ExactHistoricalPurchaseBooking => Boolean(item));

  return {
    source: "exact-online",
    divisionCode,
    lastSyncedAt: syncedAt.toISOString(),
    staleAfter: new Date(syncedAt.getTime() + 30 * 60 * 1000).toISOString(),
    suppliers: suppliersRaw.map(mapSupplier).filter((supplier) => supplier.name),
    paymentConditions: paymentConditionsRaw
      .map(mapPaymentCondition)
      .filter((condition) => condition.code),
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
  masterData: ExactMasterDataCache
): Promise<ExactBookingResult> {
  void connection;
  void invoice;
  void masterData;

  if (process.env.EXACT_ONLINE_ENABLE_REAL_BOOKING !== "true") {
    throw new Error(
      "Real Exact Online booking is disabled. Set EXACT_ONLINE_ENABLE_REAL_BOOKING=true only after validating the purchase-entry payload with your Exact Online division."
    );
  }

  throw new Error(
    "Real Exact Online purchase-entry posting adapter is not implemented yet. INTO is connected to Exact for OAuth and master-data sync."
  );
}
