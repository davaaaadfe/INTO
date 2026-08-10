import test from "node:test";
import assert from "node:assert/strict";
import { GET as exactCallback } from "../app/api/exact/callback/route";
import { POST as exactConnect } from "../app/api/exact/connect/route";
import { GET as exactStatus } from "../app/api/exact/status/route";
import {
  disconnectExactConnection,
  getCompanyConnectionUserId,
  getExactConnection,
  getExactMasterData,
  refreshExactConnectionForUser,
  setExactConnection,
} from "../lib/repository/invoice-store";
import {
  createRealExactAuthorizationUrl,
  exactIntegrationMode,
} from "../lib/services/exact-api-client";
import { decryptExactSecret } from "../lib/services/exact-token-crypto";

const envKeys = [
  "NODE_ENV",
  "DATABASE_URL",
  "EXACT_ONLINE_MODE",
  "EXACT_ONLINE_BASE_URL",
  "EXACT_ONLINE_CLIENT_ID",
  "EXACT_ONLINE_CLIENT_SECRET",
  "EXACT_ONLINE_REDIRECT_URI",
  "OAUTH_TOKEN_ENCRYPTION_KEY",
  "OAUTH_STATE_SECRET",
];

async function withExactEnv(
  values: Record<string, string | undefined>,
  run: () => Promise<void>
) {
  const previous = new Map(envKeys.map((key) => [key, process.env[key]]));

  for (const key of envKeys) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }

  try {
    await run();
  } finally {
    disconnectExactConnection();
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function exactResponse(records: unknown[]) {
  return Response.json({ d: { results: records } });
}

test("uses Vercel Exact credentials for OAuth, encrypted tokens, refresh, and master-data sync", async () => {
  await withExactEnv(
    {
      NODE_ENV: "production",
      EXACT_ONLINE_MODE: "mock",
      EXACT_ONLINE_BASE_URL: " https://exact.test/ ",
      EXACT_ONLINE_CLIENT_ID: " exact-oauth-app-client-id ",
      EXACT_ONLINE_CLIENT_SECRET: " exact-client-secret ",
      EXACT_ONLINE_REDIRECT_URI:
        " https://into.example.com/api/exact/callback ",
      OAUTH_TOKEN_ENCRYPTION_KEY: "test-token-encryption-key",
    },
    async () => {
      const originalFetch = globalThis.fetch;
      const tokenRequests: URLSearchParams[] = [];
      const exactApiRequests: string[] = [];

      globalThis.fetch = (async (input, init) => {
        const url = new URL(
          typeof input === "string" || input instanceof URL
            ? input.toString()
            : input.url
        );

        if (url.pathname.startsWith("/api/v1/")) {
          exactApiRequests.push(url.pathname);
        }

        if (url.pathname === "/api/oauth2/token") {
          const body = new URLSearchParams(String(init?.body ?? ""));
          tokenRequests.push(body);
          const isRefresh = body.get("grant_type") === "refresh_token";
          return Response.json({
            access_token: isRefresh ? "refreshed-access-token" : "initial-access-token",
            refresh_token: isRefresh
              ? "refreshed-refresh-token"
              : "initial-refresh-token",
            expires_in: 600,
          });
        }

        if (url.pathname === "/api/v1/current/Me") {
          return exactResponse([{ CurrentDivision: 123456 }]);
        }
        if (/\/crm\/Accounts$/i.test(url.pathname)) {
          return exactResponse([
            {
              ID: "supplier-id",
              Code: "SUP-001",
              Name: "Example Supplier",
              PaymentConditionPurchase: "30",
            },
          ]);
        }
        if (/\/cashflow\/PaymentConditions$/i.test(url.pathname)) {
          return exactResponse([
            { Code: "30", Description: "30 days", PaymentDays: 30 },
          ]);
        }
        if (/\/Journals$/i.test(url.pathname)) {
          return exactResponse([{ Code: "60", Description: "Purchases" }]);
        }
        if (/\/GLAccounts$/i.test(url.pathname)) {
          return exactResponse([
            { ID: "gl-account-id", Code: "4420", Description: "Software" },
          ]);
        }
        if (/\/Costcenters$/i.test(url.pathname)) {
          return exactResponse([{ Code: "FIN", Description: "Finance" }]);
        }
        if (/\/Costunits$/i.test(url.pathname)) {
          return exactResponse([{ Code: "EU", Description: "Europe" }]);
        }
        if (/\/VATCodes$/i.test(url.pathname)) {
          return exactResponse([
            { Code: "4", Description: "Domestic high", Percentage: 21 },
          ]);
        }
        if (/\/PurchaseEntryLines$/i.test(url.pathname)) {
          return exactResponse([
            {
              ID: "history-line-id",
              EntryID: "history-entry-id",
              Supplier: "supplier-id",
              GLAccount: "4420",
              YourRef: "INV-001",
              Description: "Managed security subscription",
              AmountFC: 100,
              VATAmountFC: 21,
              VATPercentage: 21,
              VATCode: "4",
              CostCenter: "FIN",
              CostUnit: "EU",
              From: "2025-01-01",
              To: "2025-12-31",
            },
          ]);
        }
        if (/\/PurchaseEntries$/i.test(url.pathname)) {
          return exactResponse([
            {
              EntryID: "history-entry-id",
              Supplier: "supplier-id",
              YourRef: "INV-001",
              Description: "Managed security subscription",
              AmountFC: 121,
              Currency: "EUR",
              PaymentCondition: "30",
              EntryDate: "2025-01-15T00:00:00",
            },
          ]);
        }

        return new Response("Not found", { status: 404 });
      }) as typeof fetch;

      try {
        assert.equal(exactIntegrationMode(), "real");

        const connectResponse = await exactConnect(new Request("http://localhost/api/exact/connect", { method: "POST" }));
        assert.equal(connectResponse.status, 200);
        const authorization = await connectResponse.json();
        assert.equal(authorization.mode, "real");
        assert.equal(authorization.requiresRedirect, true);
        assert.equal(authorization.masterDataReadOnly, true);
        const authorizationUrl = new URL(authorization.authorizationUrl);
        assert.equal(authorizationUrl.origin, "https://exact.test");
        assert.equal(
          authorizationUrl.searchParams.get("client_id"),
          "exact-oauth-app-client-id"
        );
        assert.equal(
          authorizationUrl.searchParams.get("redirect_uri"),
          "https://into.example.com/api/exact/callback"
        );
        assert.doesNotMatch(authorization.authorizationUrl, /exact-client-secret/);

        const callbackResponse = await exactCallback(
          new Request(
            `https://into.example.com/api/exact/callback?code=authorization-code&state=${encodeURIComponent(
              authorization.state
            )}`
          )
        );
        assert.equal(callbackResponse.status, 302);
        assert.equal(
          callbackResponse.headers.get("location"),
          "https://into.example.com/?exact=connected"
        );

        const stored = getExactConnection();
        assert.ok(stored);
        assert.match(stored.accessTokenCiphertext, /^v1\./);
        assert.match(stored.refreshTokenCiphertext, /^v1\./);
        assert.notEqual(stored.accessTokenCiphertext, "initial-access-token");
        assert.equal(
          await decryptExactSecret(stored.accessTokenCiphertext),
          "initial-access-token"
        );

        const masterData = getExactMasterData();
        assert.ok(masterData);
        assert.equal(masterData.suppliers.length, 1);
        assert.equal(masterData.suppliers[0]?.paymentConditionCode, "30");
        assert.equal(masterData.suppliers[0]?.paymentConditionLabel, "30 days");
        assert.equal(masterData.paymentConditions.length, 1);
        assert.equal(masterData.paymentConditions[0]?.days, 30);
        assert.equal(masterData.journals.length, 1);
        assert.equal(masterData.glAccounts.length, 1);
        assert.equal(masterData.glAccounts[0]?.id, "gl-account-id");
        assert.equal(masterData.vatCodes.length, 1);
        assert.equal(masterData.costCenters.length, 1);
        assert.equal(masterData.costUnits.length, 1);
        assert.equal(masterData.historicalPurchaseBookings.length, 1);
        assert.deepEqual(masterData.historicalPurchaseBookings[0], {
          id: "history-line-id",
          entryId: "history-entry-id",
          lineId: "history-line-id",
          supplierAccountId: "supplier-id",
          yourRef: "INV-001",
          invoiceNumber: "INV-001",
          invoiceDate: "2025-01-15",
          description: "Managed security subscription",
          totalAmount: 121,
          lineAmount: 100,
          vatAmount: 21,
          vatPercentage: 21,
          currency: "EUR",
          paymentConditionCode: "30",
          descriptionKey: "managed-security-subscription",
          glAccount: "4420",
          vatCode: "4",
          costCentre: "FIN",
          costUnit: "EU",
          accrualFrom: "2025-01-01",
          accrualTo: "2025-12-31",
        });
        assert.ok(
          exactApiRequests.includes(
            "/api/v1/123456/cashflow/PaymentConditions"
          )
        );
        assert.equal(
          exactApiRequests.some((path) =>
            /\/(?:crm|financial)\/PaymentConditions$/i.test(path)
          ),
          false
        );

        const statusResponse = await exactStatus(new Request("http://localhost/api/exact/status"));
        const status = await statusResponse.json();
        const serializedStatus = JSON.stringify(status);
        assert.equal(status.configuration.ready, true);
        assert.equal(status.configuration.mode, "real");
        assert.equal("accessTokenCiphertext" in status.connection, false);
        assert.doesNotMatch(serializedStatus, /exact-client-secret/);
        assert.doesNotMatch(serializedStatus, /initial-access-token/);

        setExactConnection({
          ...stored,
          expiresAt: new Date(0).toISOString(),
        });
        const refreshed = await refreshExactConnectionForUser();
        assert.ok(refreshed);
        assert.equal(
          await decryptExactSecret(refreshed.accessTokenCiphertext),
          "refreshed-access-token"
        );
        assert.equal(tokenRequests[0]?.get("grant_type"), "authorization_code");
        assert.equal(tokenRequests[1]?.get("grant_type"), "refresh_token");
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  );
});

test("rejects an email address used as the Exact OAuth Client ID", async () => {
  await withExactEnv(
    {
      NODE_ENV: "production",
      EXACT_ONLINE_CLIENT_ID: "person@example.com",
      EXACT_ONLINE_CLIENT_SECRET: "exact-client-secret",
      EXACT_ONLINE_REDIRECT_URI: "https://into.example.com/api/exact/callback",
      OAUTH_TOKEN_ENCRYPTION_KEY: "test-token-encryption-key",
    },
    async () => {
      await assert.rejects(
        createRealExactAuthorizationUrl(getCompanyConnectionUserId()),
        /OAuth app Client ID, not an email address/
      );
    }
  );
});
