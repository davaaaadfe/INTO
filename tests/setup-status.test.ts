import test from "node:test";
import assert from "node:assert/strict";
import {
  exactRedirectUri,
  getSetupStatus,
  microsoftRedirectUri,
} from "../lib/services/app-config-service";

const envKeys = [
  "APP_URL",
  "VERCEL_URL",
  "VERCEL_PROJECT_PRODUCTION_URL",
  "EXACT_ONLINE_CLIENT_ID",
  "EXACT_ONLINE_CLIENT_SECRET",
  "EXACT_ONLINE_REDIRECT_URI",
  "MICROSOFT_CLIENT_ID",
  "MICROSOFT_CLIENT_SECRET",
  "MICROSOFT_REDIRECT_URI",
  "OAUTH_TOKEN_ENCRYPTION_KEY",
  "OAUTH_STATE_SECRET",
];

function withEnv(values: Record<string, string | undefined>, run: () => void) {
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
    run();
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

test("derives OAuth callback URLs from Vercel deployment host", () => {
  withEnv({ VERCEL_URL: "into-example.vercel.app" }, () => {
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

test("setup status reports missing variable names without exposing secret values", () => {
  withEnv(
    {
      APP_URL: "https://into.example.com",
      EXACT_ONLINE_CLIENT_ID: "exact-client-id-secret-value",
      MICROSOFT_CLIENT_SECRET: "microsoft-client-secret-value",
      OAUTH_TOKEN_ENCRYPTION_KEY: "encryption-secret-value",
      OAUTH_STATE_SECRET: "state-secret-value",
    },
    () => {
      const status = getSetupStatus();
      const serialized = JSON.stringify(status);

      assert.match(serialized, /EXACT_ONLINE_CLIENT_SECRET/);
      assert.match(serialized, /MICROSOFT_CLIENT_ID/);
      assert.doesNotMatch(serialized, /exact-client-id-secret-value/);
      assert.doesNotMatch(serialized, /microsoft-client-secret-value/);
      assert.doesNotMatch(serialized, /encryption-secret-value/);
      assert.doesNotMatch(serialized, /state-secret-value/);
    }
  );
});

test("setup status allows database-free mode", () => {
  withEnv({ APP_URL: "https://into.example.com" }, () => {
    const database = getSetupStatus().checks.find((check) => check.id === "database");

    assert.equal(database?.status, "ok");
    assert.equal(database?.label, "Database-Free Mode");
    assert.equal(database?.missingEnv.includes("DATABASE_URL"), false);
    assert.match(database?.message ?? "", /No database is required/);
  });
});
