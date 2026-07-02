import test from "node:test";
import assert from "node:assert/strict";
import { exactRedirectUri, microsoftRedirectUri } from "../lib/services/app-config-service";
import {
  disconnectExactConnection,
  disconnectOutlookConnection,
  getCompanyConnectionUserId,
  setExactConnection,
  setOutlookConnection,
} from "../lib/repository/invoice-store";
import { createMockExactConnection } from "../lib/services/exact-online-service";
import { createMockOutlookConnection } from "../lib/services/outlook-service";
import { getSetupStatus } from "../lib/services/setup-status-service";

const envKeys = [
  "APP_URL",
  "VERCEL_URL",
  "VERCEL_PROJECT_PRODUCTION_URL",
  "EXACT_ONLINE_MODE",
  "EXACT_ONLINE_CLIENT_ID",
  "EXACT_ONLINE_CLIENT_SECRET",
  "EXACT_ONLINE_REDIRECT_URI",
  "MICROSOFT_OUTLOOK_MODE",
  "MICROSOFT_CLIENT_ID",
  "MICROSOFT_CLIENT_SECRET",
  "MICROSOFT_REDIRECT_URI",
  "OAUTH_TOKEN_ENCRYPTION_KEY",
  "OAUTH_STATE_SECRET",
];

async function withEnv(
  values: Record<string, string | undefined>,
  run: () => void | Promise<void>
) {
  const previous = new Map(envKeys.map((key) => [key, process.env[key]]));

  for (const key of envKeys) {
    delete process.env[key];
  }

  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    await run();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function resetSharedConnections() {
  disconnectExactConnection();
  disconnectOutlookConnection();
}

test("derives OAuth callback URLs from Vercel deployment host", async () => {
  await withEnv({ VERCEL_URL: "into-example.vercel.app" }, () => {
    assert.equal(
      exactRedirectUri(),
      "https://into-example.vercel.app/api/exact/callback"
    );
    assert.equal(
      microsoftRedirectUri(),
      "https://into-example.vercel.app/api/outlook/callback"
    );
  });
});

test("setup status reports friendly readiness without exposing secret values", async () => {
  await withEnv(
    {
      APP_URL: "https://into.example.com",
      EXACT_ONLINE_CLIENT_ID: "exact-client-id-secret-value",
      MICROSOFT_CLIENT_SECRET: "microsoft-client-secret-value",
      OAUTH_TOKEN_ENCRYPTION_KEY: "encryption-secret-value",
      OAUTH_STATE_SECRET: "state-secret-value",
    },
    async () => {
      resetSharedConnections();
      const status = await getSetupStatus();
      const serialized = JSON.stringify(status);

      assert.match(serialized, /Shared Exact Online connection/);
      assert.match(serialized, /Shared Outlook invoice mailbox/);
      assert.match(serialized, /Ask the system owner/);
      assert.doesNotMatch(serialized, /exact-client-id-secret-value/);
      assert.doesNotMatch(serialized, /microsoft-client-secret-value/);
      assert.doesNotMatch(serialized, /encryption-secret-value/);
      assert.doesNotMatch(serialized, /state-secret-value/);
      assert.doesNotMatch(serialized, /accessTokenCiphertext/);
      assert.doesNotMatch(serialized, /refreshTokenCiphertext/);
      resetSharedConnections();
    }
  );
});

test("setup status omits developer infrastructure checks from the user checklist", async () => {
  await withEnv({ APP_URL: "https://into.example.com" }, async () => {
    resetSharedConnections();
    const checks = (await getSetupStatus()).checks;
    const ids = checks.map((check) => check.id);

    assert.deepEqual(ids, [
      "shared-exact",
      "shared-outlook",
      "invoice-upload",
      "review-queue",
      "exact-master-sync",
      "invoice-booking",
    ]);
    assert.equal(ids.includes("database"), false);
    assert.equal(ids.includes("storage"), false);
    assert.equal(ids.includes("environment"), false);
    assert.equal(JSON.stringify(checks).includes("DATABASE_URL"), false);
    assert.equal(JSON.stringify(checks).includes("S3_BUCKET"), false);
    resetSharedConnections();
  });
});

test("setup status does not mark shared integrations ready before they are connected", async () => {
  await withEnv({ APP_URL: "https://into.example.com" }, async () => {
    resetSharedConnections();
    const checks = (await getSetupStatus()).checks;
    const exact = checks.find((check) => check.id === "shared-exact");
    const outlook = checks.find((check) => check.id === "shared-outlook");
    const upload = checks.find((check) => check.id === "invoice-upload");
    const reviewQueue = checks.find((check) => check.id === "review-queue");
    const masterData = checks.find((check) => check.id === "exact-master-sync");
    const booking = checks.find((check) => check.id === "invoice-booking");

    assert.equal(exact?.status, "warning");
    assert.equal(outlook?.status, "warning");
    assert.match(exact?.message ?? "", /not connected to Exact Online yet/);
    assert.match(outlook?.message ?? "", /not connected to the invoice mailbox yet/);
    assert.deepEqual(exact?.missingEnv, [
      "EXACT_ONLINE_CLIENT_ID",
      "EXACT_ONLINE_CLIENT_SECRET",
      "OAUTH_TOKEN_ENCRYPTION_KEY",
      "OAUTH_STATE_SECRET",
    ]);
    assert.deepEqual(outlook?.missingEnv, [
      "MICROSOFT_CLIENT_ID",
      "MICROSOFT_CLIENT_SECRET",
      "OAUTH_TOKEN_ENCRYPTION_KEY",
      "OAUTH_STATE_SECRET",
    ]);
    assert.equal(upload?.status, "ok");
    assert.equal(reviewQueue?.status, "ok");
    assert.equal(masterData?.status, "warning");
    assert.equal(booking?.status, "warning");
    resetSharedConnections();
  });
});

test("setup status marks checklist ready when shared connections and Exact data are available", async () => {
  await withEnv(
    {
      APP_URL: "https://into.example.com",
      EXACT_ONLINE_MODE: "mock",
      MICROSOFT_OUTLOOK_MODE: "mock",
    },
    async () => {
      resetSharedConnections();
      const companyConnectionUserId = getCompanyConnectionUserId();

      setExactConnection(createMockExactConnection(companyConnectionUserId));
      setOutlookConnection(createMockOutlookConnection(companyConnectionUserId));

      const checks = (await getSetupStatus()).checks;

      assert.deepEqual(
        checks.map((check) => [check.id, check.status]),
        [
          ["shared-exact", "ok"],
          ["shared-outlook", "ok"],
          ["invoice-upload", "ok"],
          ["review-queue", "ok"],
          ["exact-master-sync", "ok"],
          ["invoice-booking", "ok"],
        ]
      );
      resetSharedConnections();
    }
  );
});
