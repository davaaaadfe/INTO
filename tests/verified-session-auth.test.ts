import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { SqliteAuthRepository } from "../lib/repository/auth-repository";
import {
  digestVerifiedSessionToken,
  issueVerifiedSession,
  parseAuthMode,
  RequestAuthenticationError,
  revokeVerifiedSession,
  requireSameOrigin,
  resolveVerifiedPrincipal,
} from "../lib/services/verified-session-auth";
import { GET as listInvoices } from "../app/api/invoices/route";

function databasePath() {
  return resolve(".tmp", `verified-session-${crypto.randomUUID()}.sqlite`);
}

async function repositoryWithActiveUser() {
  const path = databasePath();
  const repository = new SqliteAuthRepository(path);
  await repository.migrate();
  await repository.upsertLegacyUsers([{
    id: "verified-user",
    email: "verified@example.test",
    displayName: "Verified User",
    status: "active",
    accessLevel: "verified_user",
    verifiedAt: "2026-08-10T00:00:00.000Z",
  }], "2026-08-10T00:00:00.000Z");
  return { path, repository };
}

test("auth mode parsing defaults invalid configuration to legacy_password", () => {
  assert.equal(parseAuthMode(undefined), "legacy_password");
  assert.equal(parseAuthMode("dual"), "dual");
  assert.equal(parseAuthMode("verified_user"), "verified_user");
  assert.equal(parseAuthMode("verified-user"), "legacy_password");
});

test("unsafe verified flows require configured exact origins and reject forwarded-host spoofing", () => {
  const previousOrigins = process.env.INTO_TRUSTED_ORIGINS;
  const previousContext = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  delete process.env.INTO_TRUSTED_ORIGINS;
  try {
    assert.throws(
      () => requireSameOrigin(new Request("https://into.example.test/api/invoices", {
        method: "POST",
        headers: { origin: "https://attacker.example.test", "x-forwarded-host": "attacker.example.test", "x-forwarded-proto": "https" },
      })),
      (error: unknown) => error instanceof RequestAuthenticationError && error.status === 403
    );
    process.env.INTO_TRUSTED_ORIGINS = "https://into.example.test";
    assert.doesNotThrow(() => requireSameOrigin(new Request("https://into.example.test/api/invoices", {
      method: "POST", headers: { origin: "https://into.example.test" },
    })));
    assert.throws(() => requireSameOrigin(new Request("https://into.example.test/api/invoices", {
      method: "POST", headers: { origin: "https://into.example.test.attacker" },
    })), RequestAuthenticationError);
  } finally {
    if (previousOrigins === undefined) delete process.env.INTO_TRUSTED_ORIGINS;
    else process.env.INTO_TRUSTED_ORIGINS = previousOrigins;
    if (previousContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previousContext;
  }
});

test("every protected API route uses the persistent request wrapper", async () => {
  const routes = await routeFiles(resolve("app", "api"));
  const publicRoutes = new Set(["access/login/route.ts", "access/logout/route.ts", "access/verify/route.ts", "exact/callback/route.ts"]);
  for (const route of routes) {
    const relative = route.replace(/\\/g, "/").replace(/^.*app\/api\//, "");
    if (publicRoutes.has(relative)) continue;
    assert.match(
      await readFile(route, "utf8"),
      /withPersistentStore\(|withMachinePersistentStore\(|withVerifiedPersistentRequest\(|resolveRequestPrincipal\(/,
      relative
    );
  }
});

async function routeFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => entry.isDirectory()
    ? routeFiles(resolve(directory, entry.name))
    : entry.name === "route.ts" ? [resolve(directory, entry.name)] : []));
  return nested.flat();
}

test("verified session expiry, revocation, and last-seen writes fail closed", async () => {
  const { path, repository } = await repositoryWithActiveUser();
  const now = Date.UTC(2026, 7, 10, 10, 0, 0);
  try {
    const issued = await issueVerifiedSession(repository, "verified-user", now);
    const request = new Request("https://into.example.test/api/invoices", {
      headers: { cookie: `into_verified_session=${issued.token}` },
    });
    await resolveVerifiedPrincipal(request, { repository, now: now + 1_000 });
    let database = new DatabaseSync(path, { readOnly: true });
    const beforeCadence = database.prepare("SELECT last_seen_at FROM into_auth_sessions WHERE id = ?")
      .get(issued.sessionId) as { last_seen_at?: string } | undefined;
    assert.equal(beforeCadence?.last_seen_at, new Date(now).toISOString());
    database.close();

    await resolveVerifiedPrincipal(request, { repository, now: now + 16 * 60 * 1_000 });
    database = new DatabaseSync(path, { readOnly: true });
    const afterCadence = database.prepare("SELECT last_seen_at FROM into_auth_sessions WHERE id = ?")
      .get(issued.sessionId) as { last_seen_at?: string } | undefined;
    assert.equal(afterCadence?.last_seen_at, new Date(now + 16 * 60 * 1_000).toISOString());
    database.close();

    assert.equal(await revokeVerifiedSession(repository, issued.token, now + 17 * 60 * 1_000), true);
    assert.equal(await revokeVerifiedSession(repository, issued.token, now + 18 * 60 * 1_000), false);
    await assert.rejects(
      resolveVerifiedPrincipal(request, { repository, now: now + 19 * 60 * 1_000 }),
      (error: unknown) => error instanceof RequestAuthenticationError && error.status === 401
    );

    const expired = await issueVerifiedSession(repository, "verified-user", now);
    await assert.rejects(
      resolveVerifiedPrincipal(requestFor(expired.token), {
        repository,
        now: now + 12 * 60 * 60 * 1_000,
      }),
      (error: unknown) => error instanceof RequestAuthenticationError && error.status === 401
    );
  } finally {
    repository.close();
    await rm(path, { force: true });
  }
});

function requestFor(token: string) {
  return new Request("https://into.example.test/api/invoices", {
    headers: { cookie: `into_verified_session=${token}` },
  });
}

test("verified sessions persist only a digest and resolve an immutable principal", async () => {
  const { path, repository } = await repositoryWithActiveUser();
  const now = Date.UTC(2026, 7, 10, 10, 0, 0);
  try {
    const issued = await issueVerifiedSession(repository, "verified-user", now);
    assert.match(issued.token, /^v1\.[A-Za-z0-9_-]{32,}$/);
    assert.notEqual(issued.token, digestVerifiedSessionToken(issued.token));

    const database = new DatabaseSync(path, { readOnly: true });
    const stored = database.prepare(
      "SELECT token_digest, correlation_id_hash FROM into_auth_sessions WHERE id = ?"
    ).get(issued.sessionId) as { token_digest: string; correlation_id_hash: string };
    database.close();
    assert.equal(stored.token_digest, digestVerifiedSessionToken(issued.token));
    assert.equal(JSON.stringify(stored).includes(issued.token), false);

    const principal = await resolveVerifiedPrincipal(
      new Request("https://into.example.test/api/invoices", {
        headers: { cookie: `into_verified_session=${issued.token}`, "idempotency-key": "request-1" },
      }),
      { repository, now: now + 1_000 }
    );
    assert.deepEqual(principal, {
      actorId: "verified-user",
      actorName: "Verified User",
      accessLevel: "verified_user",
      verificationState: "verified",
      sessionCorrelationId: issued.correlationId,
      requestId: "request-1",
      sessionId: issued.sessionId,
    });
  } finally {
    repository.close();
    await rm(path, { force: true });
  }
});

test("protected handlers reject direct calls without middleware", async () => {
  const previousPassword = process.env.INTO_ACCESS_PASSWORD;
  const previousMode = process.env.AUTH_MODE;
  process.env.INTO_ACCESS_PASSWORD = "test-password";
  process.env.AUTH_MODE = "legacy_password";
  try {
    const response = await listInvoices(new Request("https://into.example.test/api/invoices"));
    assert.ok(response instanceof Response);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Authentication required." });
  } finally {
    if (previousPassword === undefined) delete process.env.INTO_ACCESS_PASSWORD;
    else process.env.INTO_ACCESS_PASSWORD = previousPassword;
    if (previousMode === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = previousMode;
  }
});
