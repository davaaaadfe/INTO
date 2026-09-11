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
  listAuditEvents,
  refreshExactConnectionForUser,
  setExactConnection,
} from "../lib/repository/invoice-store";
import {
  createRealExactAuthorizationUrl,
  createExactOAuthState,
  exactIntegrationMode,
  reauthorizeExactOAuthState,
  verifyExactOAuthState,
} from "../lib/services/exact-api-client";
import {
  decryptExactSecret,
  encodeExactStatePayload,
  signExactState,
} from "../lib/services/exact-token-crypto";
import {
  accessSessionCorrelationId,
  createIntoAccessSession,
  INTO_ACCESS_COOKIE_NAME,
} from "../lib/services/into-access-auth";

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
  "AUTH_MODE",
  "INTO_ACCESS_PASSWORD",
  "DATABASE_MODE",
  "LOCAL_DATABASE_PATH",
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

function sharedPrincipal(token: string) {
  return {
    actorId: "shared_user",
    actorName: "Shared access",
    accessLevel: "legacy_shared",
    verificationState: "legacy",
    sessionCorrelationId: accessSessionCorrelationId(token),
    requestId: "shared-exact-request",
  } as const;
}

function sharedHeaders(token: string) {
  return {
    cookie: `${INTO_ACCESS_COOKIE_NAME}=${token}`,
    "idempotency-key": "shared-exact-request",
  };
}

test("production rejects the unauthenticated mock Exact callback", async () => {
  await withExactEnv(
    {
      NODE_ENV: "production",
      DATABASE_MODE: "memory",
      EXACT_ONLINE_MODE: "mock",
    },
    async () => {
      disconnectExactConnection();
      const response = await exactCallback(
        new Request("https://into.example.test/api/exact/callback?code=mock")
      );

      assert.equal(response.status, 503);
      assert.equal(getExactConnection(), null);
    }
  );
});

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
      AUTH_MODE: "verified_user",
      INTO_ACCESS_PASSWORD: "test-only-shared-password",
      DATABASE_MODE: "memory",
    },
    async () => {
      const token = createIntoAccessSession();
      const initiatingPrincipal = sharedPrincipal(token);
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

        const connectResponse = await exactConnect(new Request("http://localhost/api/exact/connect", {
          method: "POST",
          headers: { origin: "http://localhost", ...sharedHeaders(token) },
        }));
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

        const callbackAuthorization = authorization;
        const decodedState = await verifyExactOAuthState(callbackAuthorization.state);
        assert.equal("principal" in decodedState, false);
        assert.deepEqual(decodedState.auth, {
          kind: "shared",
          sessionCorrelationId: initiatingPrincipal.sessionCorrelationId,
          requestId: initiatingPrincipal.requestId,
        });
        assert.doesNotMatch(JSON.stringify(decodedState), /repositoryIdentityHash|displayName|email/);
        await assert.rejects(
          verifyExactOAuthState(`${callbackAuthorization.state.slice(0, -1)}x`),
          /signature is invalid/
        );
        const callbackResponse = await exactCallback(
          new Request(
            `https://into.example.com/api/exact/callback?code=authorization-code&state=${encodeURIComponent(
              callbackAuthorization.state
            )}`,
            { headers: sharedHeaders(token) }
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
        const callbackEvents = listAuditEvents().filter((event) =>
          (event.type === "connection_connected" || event.type === "sync_operation") &&
          event.metadata?.requestId === initiatingPrincipal.requestId
        );
        assert.equal(callbackEvents.length >= 2, true);
        assert.equal(callbackEvents.every((event) => event.userId === initiatingPrincipal.actorId), true);
        assert.equal(callbackEvents.every((event) => event.userName === initiatingPrincipal.actorName), true);
        assert.equal(callbackEvents.every((event) => event.metadata?.requestId === initiatingPrincipal.requestId), true);
        assert.deepEqual(
          callbackEvents.map((event) => event.metadata?.sessionCorrelationId),
          callbackEvents.map(() => initiatingPrincipal.sessionCorrelationId)
        );
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

        const statusResponse = await exactStatus(new Request("http://localhost/api/exact/status", {
          headers: sharedHeaders(token),
        }));
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

test("Exact OAuth state requires the initiating shared password session regardless of old auth mode", async () => {
  await withExactEnv({
    NODE_ENV: "test",
    EXACT_ONLINE_MODE: "real",
    EXACT_ONLINE_BASE_URL: "https://exact.test",
    EXACT_ONLINE_CLIENT_ID: "exact-client-id",
    EXACT_ONLINE_CLIENT_SECRET: "exact-client-secret",
    EXACT_ONLINE_REDIRECT_URI: "https://into.example.test/api/exact/callback",
    OAUTH_TOKEN_ENCRYPTION_KEY: "test-token-encryption-key",
    OAUTH_STATE_SECRET: "test-oauth-state-secret",
    AUTH_MODE: "legacy_password",
    INTO_ACCESS_PASSWORD: "test-only-shared-password",
    DATABASE_MODE: "memory",
  }, async () => {
    const token = createIntoAccessSession();
    const principal = sharedPrincipal(token);
    const state = await createExactOAuthState(getCompanyConnectionUserId(), principal);
    const request = new Request("https://into.example.test/api/exact/callback", {
      headers: { ...sharedHeaders(token), "idempotency-key": "callback-request" },
    });
    const decoded = await verifyExactOAuthState(state);
    const historicalStatePayload = encodeExactStatePayload({
      ...decoded,
      auth: {
        kind: "verified", userId: "retired-user", sessionId: "retired-session",
        sessionCorrelationId: "verified-session", requestId: "retired-request",
        repositoryIdentityHash: "a".repeat(64),
      },
    });
    const historicalState = `${historicalStatePayload}.${await signExactState(historicalStatePayload)}`;
    const legacyStatePayload = encodeExactStatePayload({
      ...decoded, auth: { ...decoded.auth, kind: "legacy" },
    });
    const legacyState = `${legacyStatePayload}.${await signExactState(legacyStatePayload)}`;
    const expiredPayload = encodeExactStatePayload({
      ...decoded, issuedAt: Date.now() - 16 * 60 * 1000,
    });
    const expiredState = `${expiredPayload}.${await signExactState(expiredPayload)}`;
    const futurePayload = encodeExactStatePayload({
      ...decoded, issuedAt: Date.now() + 2 * 60 * 1000,
    });
    const futureState = `${futurePayload}.${await signExactState(futurePayload)}`;
    const validCookie = sharedHeaders(token).cookie;
    const blockedCallbacks = [
      { state, cookie: undefined },
      { state, cookie: sharedHeaders(createIntoAccessSession()).cookie },
      { state, cookie: `${INTO_ACCESS_COOKIE_NAME}=expired.invalid.session` },
      { state, cookie: "into_verified_session=v1.retired-personal-session" },
      { state: historicalState, cookie: validCookie },
      { state: legacyState, cookie: validCookie },
      { state: expiredState, cookie: validCookie },
      { state: futureState, cookie: validCookie },
      { state: `${state}.invalid`, cookie: validCookie },
    ];
    let tokenExchanges = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      tokenExchanges += 1;
      return Response.json({ access_token: "must-not-be-issued" });
    }) as typeof fetch;
    try {
      for (const blocked of blockedCallbacks) {
        const response = await exactCallback(new Request(
          `https://into.example.test/api/exact/callback?code=blocked&state=${encodeURIComponent(blocked.state)}`,
          { headers: blocked.cookie ? { cookie: blocked.cookie } : {} }
        ));
        assert.equal(tokenExchanges, 0);
        assert.equal(response.headers.get("location"), "https://into.example.test/?exact=error");
      }
      assert.equal(tokenExchanges, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal((await verifyExactOAuthState(state)).auth.kind, "shared");
    for (const mode of ["legacy_password", "dual", "verified_user", "obsolete-mode"]) {
      process.env.AUTH_MODE = mode;
      const authorized = await reauthorizeExactOAuthState(state, request);
      assert.deepEqual(authorized, principal);
      assert.equal(Object.isFrozen(authorized), true);
    }
    process.env.DATABASE_MODE = "postgres";
    process.env.DATABASE_URL = "postgres://unavailable.example.test/auth";
    assert.deepEqual(await reauthorizeExactOAuthState(state, request), principal);
    process.env.INTO_ACCESS_PASSWORD = "rotated-shared-password";
    await assert.rejects(reauthorizeExactOAuthState(state, request));
    delete process.env.INTO_ACCESS_PASSWORD;
    await assert.rejects(reauthorizeExactOAuthState(state, request));
  });
});

test("Exact OAuth creation rejects personal-user principals", async () => {
  await withExactEnv({ OAUTH_STATE_SECRET: "test-oauth-state-secret" }, async () => {
    await assert.rejects(createExactOAuthState(getCompanyConnectionUserId(), {
      actorId: "retired-user", actorName: "Retired Person", accessLevel: "verified_user",
      verificationState: "verified", sessionId: "retired-session",
      sessionCorrelationId: "retired-correlation", requestId: "retired-request",
    }), /shared password session/i);
  });
});

test("development mock callback requires a shared password session", async () => {
  await withExactEnv({
    NODE_ENV: "development", DATABASE_MODE: "memory", EXACT_ONLINE_MODE: "mock",
    INTO_ACCESS_PASSWORD: "test-only-shared-password",
  }, async () => {
    disconnectExactConnection();
    const response = await exactCallback(new Request("http://localhost/api/exact/callback?code=mock"));
    assert.equal(response.status, 401);
    assert.equal(getExactConnection(), null);
  });
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
        createRealExactAuthorizationUrl(getCompanyConnectionUserId(), {
          actorId: "shared_user",
          actorName: "Shared access",
          accessLevel: "legacy_shared",
          verificationState: "legacy",
          sessionCorrelationId: "legacy-test-session",
          requestId: "legacy-test-request",
        } as const),
        /OAuth app Client ID, not an email address/
      );
    }
  );
});
