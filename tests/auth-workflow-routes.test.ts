import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { proxy } from "../proxy";
import { setConfiguredAuthRepositoryFactoryForTest, closeConfiguredAuthRepository } from "../lib/repository/configured-auth-repository";
import { POST as login } from "../app/api/access/login/route";
import { POST as logout } from "../app/api/access/logout/route";
import { GET as session } from "../app/api/access/session/route";
import { POST as verify } from "../app/api/access/verify/route";
import { GET as users } from "../app/api/users/route";
import { POST as invite } from "../app/api/users/invitations/route";
import { PATCH as changeUser } from "../app/api/users/[id]/route";
import { createIntoAccessSession, verifyIntoAccessSession } from "../lib/services/into-access-auth";
import { resolveRequestPrincipal, withVerifiedPersistentRequest } from "../lib/services/verified-session-auth";

const password = "shared-password-for-route-tests";
const origin = "https://into.example.test";
const environment = process.env as Record<string, string | undefined>;
const keys = ["AUTH_MODE", "INTO_ACCESS_PASSWORD", "INTO_TRUSTED_ORIGINS", "INTO_TRUSTED_SOURCE_HEADER", "NODE_ENV"];
const originals = keys.map((key) => environment[key]);
test.beforeEach(() => {
  environment.INTO_ACCESS_PASSWORD = password;
  environment.INTO_TRUSTED_ORIGINS = origin;
  environment.INTO_TRUSTED_SOURCE_HEADER = "x-test-source";
  environment.NODE_ENV = "production";
  closeConfiguredAuthRepository();
  setConfiguredAuthRepositoryFactoryForTest(() => { throw new Error("Auth database must not be opened."); });
});
test.afterEach(() => {
  closeConfiguredAuthRepository();
  setConfiguredAuthRepositoryFactoryForTest(undefined);
  keys.forEach((key, index) => { if (originals[index] === undefined) delete environment[key]; else environment[key] = originals[index]; });
});
function request(path: string, body?: unknown, cookie?: string, source = "normal") {
  return new Request(origin + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { origin, "content-type": "application/json", "x-test-source": source, ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("password-only login and session are independent of AUTH_MODE and the auth database", async () => {
  for (const mode of ["legacy_password", "dual", "verified_user", undefined, "invalid"]) {
    if (mode === undefined) delete environment.AUTH_MODE; else environment.AUTH_MODE = mode;
    const response = await login(request("/api/access/login", { password }));
    assert.equal(response.status, 200, String(mode));
    assert.deepEqual(await response.json(), { ok: true });
    const token = response.headers.get("set-cookie")?.match(/into_access_session=([^;]+)/)?.[1];
    assert.ok(token);
    assert.equal(verifyIntoAccessSession(token), true);
    assert.match(response.headers.get("set-cookie")!, /HttpOnly/i);
    assert.match(response.headers.get("set-cookie")!, /Secure/i);
    assert.doesNotMatch(token, new RegExp(password));
    const cookie = `into_access_session=${token}`;
    const current = await session(request("/api/access/session", undefined, cookie));
    assert.equal(current.status, 200);
    assert.deepEqual(await current.json(), { authenticated: true });
    assert.equal(proxy(new NextRequest(origin + "/api/invoices", { headers: { cookie } })).headers.get("x-middleware-next"), "1");
  }
});

test("old personal cookies, missing passwords and malformed credentials cannot unlock INTO", async () => {
  environment.AUTH_MODE = "verified_user";
  const oldCookie = `into_verified_session=v1.${"A".repeat(43)}`;
  assert.equal((await session(request("/api/access/session", undefined, oldCookie))).status, 401);
  assert.equal(proxy(new NextRequest(origin + "/api/invoices", { headers: { cookie: oldCookie } })).status, 401);
  assert.equal((await login(request("/api/access/login", { email: "someone@example.test", password: "wrong" }, oldCookie))).status, 401);
  assert.equal((await login(request("/api/access/login", { email: "ignored@example.test", id: "ignored", displayName: "Ignored", password }))).status, 200);
  for (const body of [null, [], 42, {}, { password: 42 }, { password: "x".repeat(1025) }]) {
    assert.equal((await login(request("/api/access/login", body))).status, 422);
  }
  delete environment.INTO_ACCESS_PASSWORD;
  assert.equal((await login(request("/api/access/login", { password }))).status, 503);
  assert.equal((await session(request("/api/access/session", undefined, oldCookie))).status, 503);
  assert.equal(proxy(new NextRequest(origin + "/api/invoices", { headers: { cookie: oldCookie } })).status, 503);
});

test("each password session gets shared access and its own opaque audit correlation", async () => {
  const first = createIntoAccessSession();
  const second = createIntoAccessSession();
  const a = await resolveRequestPrincipal(request("/api/invoices", undefined, `into_access_session=${first}`));
  const b = await resolveRequestPrincipal(request("/api/invoices", undefined, `into_access_session=${second}`));
  assert.equal(a.actorId, "shared_user");
  assert.equal(a.actorName, "Shared access");
  assert.notEqual(a.sessionCorrelationId, b.sessionCorrelationId);
  assert.match(a.sessionCorrelationId, /^session_/);
  assert.doesNotMatch(JSON.stringify(a), new RegExp(first.replaceAll(".", "\\.")));
  for (const path of ["/api/invoices", "/api/invoices/test/learn", "/api/suppliers/test/learning/reset", "/api/exact/disconnect"]) {
    const response = await withVerifiedPersistentRequest(request(path, {}, `into_access_session=${first}`), () => Response.json({ access: "full" }));
    assert.equal(response.status, 200, path);
  }
  environment.INTO_ACCESS_PASSWORD = "rotated-shared-password";
  assert.equal((await session(request("/api/access/session", undefined, `into_access_session=${first}`))).status, 401);
});

test("password login, logout and unsafe authenticated requests reject missing or foreign origins", async () => {
  const cookie = `into_access_session=${createIntoAccessSession()}`;
  for (const originValue of [undefined, "https://attacker.example.test"]) {
    const headers = { "content-type": "application/json", cookie, ...(originValue ? { origin: originValue } : {}) };
    assert.equal((await login(new Request(origin + "/api/access/login", { method: "POST", headers, body: JSON.stringify({ password }) }))).status, 403);
    assert.equal((await logout(new Request(origin + "/api/access/logout", { method: "POST", headers }))).status, 403);
    const response = await withVerifiedPersistentRequest(new Request(origin + "/api/invoices", { method: "POST", headers }), () => Response.json({ unexpected: true }));
    assert.equal(response.status, 403);
  }
  const response = await logout(request("/api/access/logout", {}, cookie + "; into_verified_session=old"));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie")!, /into_access_session=;/);
  assert.match(response.headers.get("set-cookie")!, /into_verified_session=;/);
});

test("retired user and invitation APIs do not expose or mutate personal records", async () => {
  const cookie = `into_access_session=${createIntoAccessSession()}`;
  const responses = [
    await users(request("/api/users", undefined, cookie)),
    await invite(request("/api/users/invitations", {}, cookie)),
    await changeUser(new Request(origin + "/api/users/old-user", { method: "PATCH", headers: { origin, cookie }, body: "{}" })),
    await verify(),
  ];
  for (const response of responses) {
    assert.equal(response.status, 404);
    assert.doesNotMatch(await response.text(), /email|displayName|userId|scrypt|token_digest/);
  }
});

test("repeated password guesses are bounded and never issue a session", async () => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await login(request("/api/access/login", { password: "wrong" }, undefined, "rate-limited-source"));
    assert.equal(response.status, 401);
    assert.equal(response.headers.has("set-cookie"), false);
  }
  const limited = await login(request("/api/access/login", { password }, undefined, "rate-limited-source"));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.has("set-cookie"), false);
  assert.ok(limited.headers.get("retry-after"));
  assert.equal((await login(request("/api/access/login", { password }, undefined, "another-source"))).status, 200);
});
