import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { exactRedirectUri } from "../lib/services/app-config-service";
import {
  getCompanyConnectionUserId,
  disconnectExactConnection,
  setExactConnection,
} from "../lib/repository/invoice-store";
import { createMockExactConnection } from "../lib/services/exact-online-service";
import { getSetupStatus } from "../lib/services/setup-status-service";

const envKeys = [
  "NODE_ENV",
  "APP_URL",
  "NEXT_PUBLIC_APP_URL",
  "VERCEL_URL",
  "VERCEL_ENV",
  "VERCEL_PROJECT_PRODUCTION_URL",
  "DATABASE_URL",
  "STORAGE_PROVIDER",
  "STORAGE_MODE",
  "TEMP_INVOICE_STORAGE_PATH",
  "TEMP_INVOICE_RETENTION_DAYS",
  "S3_ENDPOINT",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_REGION",
  "EXACT_ONLINE_MODE",
  "EXACT_ONLINE_CLIENT_ID",
  "EXACT_ONLINE_CLIENT_SECRET",
  "EXACT_ONLINE_REDIRECT_URI",
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
}

test("derives OAuth callback URLs from Vercel deployment host", async () => {
  await withEnv({ VERCEL_URL: "into-example.vercel.app" }, () => {
    assert.equal(
      exactRedirectUri(),
      "https://into-example.vercel.app/api/exact/callback"
    );
  });
});

test("setup status identifies preview deployments and keeps stable callback URLs", async () => {
  await withEnv(
    {
      NEXT_PUBLIC_APP_URL: "https://into.example.com",
      VERCEL_ENV: "preview",
      VERCEL_URL: "into-git-feature-into1.vercel.app",
    },
    async () => {
      resetSharedConnections();
      const status = await getSetupStatus();

      assert.equal(status.appUrl, "https://into.example.com");
      assert.equal(
        status.exactCallbackUrl,
        "https://into.example.com/api/exact/callback"
      );
      assert.equal(status.isPreviewDeployment, true);
      assert.match(
        status.previewDeploymentMessage ?? "",
        /Vercel preview deployment/
      );
      assert.doesNotMatch(JSON.stringify(status), /Outlook|Microsoft|mailbox|\/api\/outlook/);
      resetSharedConnections();
    }
  );
});

test("setup status reports friendly readiness without exposing secret values", async () => {
  await withEnv(
    {
      APP_URL: "https://into.example.com",
      EXACT_ONLINE_CLIENT_ID: "exact-client-id-secret-value",
      OAUTH_TOKEN_ENCRYPTION_KEY: "encryption-secret-value",
      OAUTH_STATE_SECRET: "state-secret-value",
    },
    async () => {
      resetSharedConnections();
      const status = await getSetupStatus();
      const serialized = JSON.stringify(status);

      assert.match(serialized, /Shared Exact Online connection/);
      assert.match(serialized, /Ask the system owner/);
      assert.doesNotMatch(serialized, /exact-client-id-secret-value/);
      assert.doesNotMatch(serialized, /encryption-secret-value/);
      assert.doesNotMatch(serialized, /state-secret-value/);
      assert.doesNotMatch(serialized, /accessTokenCiphertext/);
      assert.doesNotMatch(serialized, /refreshTokenCiphertext/);
      assert.doesNotMatch(serialized, /Outlook|Microsoft|mailbox|MICROSOFT_|\/api\/outlook/);
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
    assert.equal(JSON.stringify(checks).includes("Outlook"), false);
    assert.equal(JSON.stringify(checks).includes("Microsoft"), false);
    resetSharedConnections();
  });
});

test("setup status does not mark shared integrations ready before they are connected", async () => {
  await withEnv({ APP_URL: "https://into.example.com" }, async () => {
    resetSharedConnections();
    const checks = (await getSetupStatus()).checks;
    const exact = checks.find((check) => check.id === "shared-exact");
    const upload = checks.find((check) => check.id === "invoice-upload");
    const reviewQueue = checks.find((check) => check.id === "review-queue");
    const masterData = checks.find((check) => check.id === "exact-master-sync");
    const booking = checks.find((check) => check.id === "invoice-booking");

    assert.equal(exact?.status, "warning");
    assert.match(exact?.message ?? "", /not connected to Exact Online yet/);
    assert.deepEqual(exact?.missingEnv, [
      "EXACT_ONLINE_CLIENT_ID",
      "EXACT_ONLINE_CLIENT_SECRET",
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

test("setup status folds missing production database into the review queue readiness item", async () => {
  await withEnv(
    {
      NODE_ENV: "production",
      APP_URL: "https://into.example.com",
      STORAGE_PROVIDER: "memory",
    },
    async () => {
      resetSharedConnections();
      const checks = (await getSetupStatus()).checks;
      const ids = checks.map((check) => check.id);
      const reviewQueue = checks.find((check) => check.id === "review-queue");

      assert.equal(ids.includes("database"), false);
      assert.equal(reviewQueue?.status, "warning");
      assert.match(reviewQueue?.message ?? "", /production record storage/);
      assert.deepEqual(reviewQueue?.missingEnv, ["DATABASE_URL"]);
      assert.doesNotMatch(reviewQueue?.message ?? "", /DATABASE_URL/);
      resetSharedConnections();
    }
  );
});

test("setup status uses local temporary invoice storage without requiring S3", async () => {
  const storagePath = `storage/tmp-tests/setup-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
  await withEnv(
    {
      NODE_ENV: "production",
      APP_URL: "https://into.example.com",
      STORAGE_MODE: "local_temp",
      TEMP_INVOICE_STORAGE_PATH: storagePath,
    },
    async () => {
      resetSharedConnections();
      const checks = (await getSetupStatus()).checks;
      const ids = checks.map((check) => check.id);
      const upload = checks.find((check) => check.id === "invoice-upload");

      assert.equal(ids.includes("storage"), false);
      assert.equal(upload?.status, "ok");
      assert.match(upload?.details.join(" ") ?? "", /Temporary local invoice storage is ready/);
      assert.deepEqual(upload?.missingEnv, []);
      assert.doesNotMatch(JSON.stringify(upload), /S3_/);
      resetSharedConnections();
    }
  );
  await rm(storagePath, { recursive: true, force: true });
});

test("setup status marks checklist ready when shared connections and Exact data are available", async () => {
  await withEnv(
    {
      APP_URL: "https://into.example.com",
      EXACT_ONLINE_MODE: "mock",
    },
    async () => {
      resetSharedConnections();
      const companyConnectionUserId = getCompanyConnectionUserId();

      setExactConnection(createMockExactConnection(companyConnectionUserId));

      const checks = (await getSetupStatus()).checks;

      assert.deepEqual(
        checks.map((check) => [check.id, check.status]),
        [
          ["shared-exact", "ok"],
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
