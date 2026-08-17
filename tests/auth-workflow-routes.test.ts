import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { SqliteAuthRepository } from "../lib/repository/auth-repository";
import {
  closeConfiguredAuthRepository,
  setConfiguredAuthRepositoryFactoryForTest,
} from "../lib/repository/configured-auth-repository";
import {
  createUserInvitation,
  verifyUserInvitation,
} from "../lib/services/verified-session-auth";
import { POST as login } from "../app/api/access/login/route";
import { createIntoAccessSession } from "../lib/services/into-access-auth";

test("login mode matrix issues verified cookies and keeps credential failures generic", async () => {
  const path = resolve("data/tmp-tests", `auth-routes-${crypto.randomUUID()}.sqlite`);
  const repository = new SqliteAuthRepository(path);
  const environment = process.env as Record<string, string | undefined>;
  const previous = {
    mode: process.env.AUTH_MODE,
    password: process.env.INTO_ACCESS_PASSWORD,
    secret: process.env.INTO_INVITATION_SECRET,
  };
  environment.INTO_ACCESS_PASSWORD = "legacy test password";
  environment.INTO_INVITATION_SECRET = "test-only-invitation-secret-at-least-32-bytes";
  try {
    await repository.migrate();
    const invitationNow = Date.UTC(2026, 7, 10);
    const invitation = await createUserInvitation(repository, {
      actorId: "bootstrap", actorName: "Bootstrap", accessLevel: "verified_user",
      verificationState: "verified", sessionCorrelationId: "bootstrap-session", requestId: "invite-1",
    }, {
      email: "person@example.test", name: "Person", requestKey: "invite-key",
    }, "https://into.example.test", invitationNow);
    await verifyUserInvitation(repository, {
      token: new URL(invitation.verificationUrl).searchParams.get("token")!,
      displayName: "Person", password: "correct horse battery staple", requestId: "verify-1",
    }, invitationNow + 1_000);

    setConfiguredAuthRepositoryFactoryForTest(() => repository);
    closeConfiguredAuthRepository();
    environment.AUTH_MODE = "verified_user";
    const correct = await login(new Request("https://into.example.test/api/access/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://into.example.test" },
      body: JSON.stringify({ email: "PERSON@example.test", password: "correct horse battery staple" }),
    }));
    assert.equal(correct.status, 200);
    assert.match(correct.headers.get("set-cookie") ?? "", /into_verified_session=v1\./);
    assert.doesNotMatch(correct.headers.get("set-cookie") ?? "", /correct horse battery staple/);

    const failures = await Promise.all([
      { email: "missing@example.test", password: "wrong password" },
      { email: "person@example.test", password: "wrong password" },
    ].map((body) => login(new Request("https://into.example.test/api/access/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://into.example.test" },
      body: JSON.stringify(body),
    }))));
    assert.deepEqual(failures.map((response) => response.status), [401, 401]);
    assert.deepEqual(await failures[0]!.json(), await failures[1]!.json());

    const crossOrigin = await login(new Request("https://into.example.test/api/access/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://attacker.example.test" },
      body: JSON.stringify({ email: "person@example.test", password: "correct horse battery staple" }),
    }));
    assert.equal(crossOrigin.status, 403);

    environment.AUTH_MODE = "legacy_password";
    const legacy = await login(new Request("https://into.example.test/api/access/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "legacy test password" }),
    }));
    assert.equal(legacy.status, 200);
    assert.match(legacy.headers.get("set-cookie") ?? "", /into_access_session=/);

    const legacyEmailLogin = await login(new Request("https://into.example.test/api/access/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://into.example.test" },
      body: JSON.stringify({ email: "person@example.test", password: "correct horse battery staple" }),
    }));
    assert.equal(legacyEmailLogin.status, 403);
  } finally {
    closeConfiguredAuthRepository();
    setConfiguredAuthRepositoryFactoryForTest(undefined);
    if (previous.mode === undefined) delete environment.AUTH_MODE; else environment.AUTH_MODE = previous.mode;
    if (previous.password === undefined) delete environment.INTO_ACCESS_PASSWORD; else environment.INTO_ACCESS_PASSWORD = previous.password;
    if (previous.secret === undefined) delete environment.INTO_INVITATION_SECRET; else environment.INTO_INVITATION_SECRET = previous.secret;
    try { repository.close(); } catch { /* configured repository already closed it */ }
    await rm(path, { force: true });
  }
});

test("invitation, verification, session, users, status, and logout handlers are safe end to end", async () => {
  const path = resolve("data/tmp-tests", `auth-workflow-${crypto.randomUUID()}.sqlite`);
  const repository = new SqliteAuthRepository(path);
  const environment = process.env as Record<string, string | undefined>;
  const previous = {
    mode: process.env.AUTH_MODE,
    password: process.env.INTO_ACCESS_PASSWORD,
    secret: process.env.INTO_INVITATION_SECRET,
    sourceHeader: process.env.INTO_TRUSTED_SOURCE_HEADER,
  };
  environment.AUTH_MODE = "dual";
  environment.INTO_ACCESS_PASSWORD = "legacy test password";
  environment.INTO_INVITATION_SECRET = "test-only-invitation-secret-at-least-32-bytes";
  environment.INTO_TRUSTED_SOURCE_HEADER = "x-test-source";
  try {
    await repository.migrate();
    setConfiguredAuthRepositoryFactoryForTest(() => repository);
    closeConfiguredAuthRepository();
    const invitationRoute = await import("../app/api/users/invitations/route");
    const verifyRoute = await import("../app/api/access/verify/route");
    assert.deepEqual(Object.keys(verifyRoute).sort(), ["POST"]);
    const sessionRoute = await import("../app/api/access/session/route");
    const usersRoute = await import("../app/api/users/route");
    const statusRoute = await import("../app/api/users/[id]/route");
    const logoutRoute = await import("../app/api/access/logout/route");
    const legacyCookie = createIntoAccessSession();

    const bootstrapSession = await sessionRoute.GET(new Request("https://into.example.test/api/access/session", {
      headers: { cookie: `into_access_session=${legacyCookie}` },
    }));
    assert.equal(bootstrapSession.status, 200);
    assert.deepEqual(await bootstrapSession.json(), {
      mode: "dual",
      legacy: true,
      user: null,
      capabilities: { canInviteUsers: true },
    });

    const crossOriginInvitation = await invitationRoute.POST(new Request("https://into.example.test/api/users/invitations", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.example.test",
        cookie: `into_access_session=${legacyCookie}`,
      },
      body: JSON.stringify({ email: "person@example.test", name: "Person", requestKey: "invite-cross-origin" }),
    }));
    assert.equal(crossOriginInvitation.status, 403);

    const invited = await invitationRoute.POST(new Request("https://into.example.test/api/users/invitations", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://into.example.test",
        cookie: `into_access_session=${legacyCookie}`,
      },
      body: JSON.stringify({ email: "person@example.test", name: "Person", requestKey: "invite-1" }),
    }));
    assert.equal(invited.status, 201);
    const invitationBody = await invited.json() as { verificationUrl: string };
    assert.match(invitationBody.verificationUrl, /\/verify\?token=v1\./);

    const verified = await verifyRoute.POST(new Request("https://into.example.test/api/access/verify", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://into.example.test" },
      body: JSON.stringify({
        token: new URL(invitationBody.verificationUrl).searchParams.get("token"),
        displayName: "Person",
        password: "correct horse battery staple",
      }),
    }));
    assert.equal(verified.status, 200);
    const verifiedCookie = (verified.headers.get("set-cookie") ?? "").match(/into_verified_session=([^;]+)/)?.[1];
    assert.ok(verifiedCookie);

    const session = await sessionRoute.GET(new Request("https://into.example.test/api/access/session", {
      headers: { cookie: `into_verified_session=${verifiedCookie}` },
    }));
    assert.equal(session.status, 200);
    const sessionBody = await session.json() as { user: Record<string, unknown> };
    assert.deepEqual(Object.keys(sessionBody.user).sort(), ["displayName", "email", "id", "status", "version"]);

    const users = await usersRoute.GET(new Request("https://into.example.test/api/users", {
      headers: { cookie: `into_verified_session=${verifiedCookie}` },
    }));
    assert.equal(users.status, 200);
    const usersText = await users.text();
    assert.match(usersText, /person@example\.test/);
    assert.doesNotMatch(usersText, /permissions|scrypt|token_digest|locked_at/);
    const user = (JSON.parse(usersText) as { users: Array<{ id: string; version: number }> }).users[0]!;
    const secondInvitation = await createUserInvitation(repository, {
      actorId: user.id, actorName: "Person", accessLevel: "verified_user",
      verificationState: "verified", sessionCorrelationId: "verified-session", requestId: "invite-2",
    }, {
      email: "second@example.test", name: "Second", requestKey: "invite-2",
    }, "https://into.example.test");

    const crossOriginStatus = await statusRoute.PATCH(new Request(`https://into.example.test/api/users/${user.id}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.example.test",
        cookie: `into_verified_session=${verifiedCookie}`,
      },
      body: JSON.stringify({ expectedVersion: user.version, status: "disabled" }),
    }), { params: Promise.resolve({ id: user.id }) });
    assert.equal(crossOriginStatus.status, 403);

    const finalActive = await statusRoute.PATCH(new Request(`https://into.example.test/api/users/${user.id}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        origin: "https://into.example.test",
        cookie: `into_verified_session=${verifiedCookie}`,
      },
      body: JSON.stringify({ expectedVersion: user.version, status: "disabled" }),
    }), { params: Promise.resolve({ id: user.id }) });
    assert.equal(finalActive.status, 422);

    const invalidVersion = await statusRoute.PATCH(new Request(`https://into.example.test/api/users/${user.id}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        origin: "https://into.example.test",
        cookie: `into_verified_session=${verifiedCookie}`,
      },
      body: JSON.stringify({ expectedVersion: 0, status: "disabled" }),
    }), { params: Promise.resolve({ id: user.id }) });
    assert.equal(invalidVersion.status, 422);

    const crossOriginLogout = await logoutRoute.POST(new Request("https://into.example.test/api/access/logout", {
      method: "POST",
      headers: { origin: "https://attacker.example.test", cookie: `into_verified_session=${verifiedCookie}` },
    }));
    assert.equal(crossOriginLogout.status, 403);

    const logout = await logoutRoute.POST(new Request("https://into.example.test/api/access/logout", {
      method: "POST",
      headers: { origin: "https://into.example.test", cookie: `into_verified_session=${verifiedCookie}` },
    }));
    assert.equal(logout.status, 200);
    const cleared = logout.headers.get("set-cookie") ?? "";
    assert.match(cleared, /into_verified_session=;/);
    assert.match(cleared, /into_access_session=;/);
    const revoked = await sessionRoute.GET(new Request("https://into.example.test/api/access/session", {
      headers: { cookie: `into_verified_session=${verifiedCookie}` },
    }));
    assert.equal(revoked.status, 401);

    let limited!: Response;
    const abusedToken = `v1.${"A".repeat(43)}`;
    for (let attempt = 0; attempt < 11; attempt += 1) {
      limited = await verifyRoute.POST(new Request("https://into.example.test/api/access/verify", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://into.example.test" },
        body: JSON.stringify({ token: abusedToken, displayName: "Abuse", password: "short" }),
      }));
    }
    assert.equal(limited.status, 429);

    const unrelatedVerification = await verifyRoute.POST(new Request("https://into.example.test/api/access/verify", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://into.example.test" },
      body: JSON.stringify({
        token: new URL(secondInvitation.verificationUrl).searchParams.get("token"),
        displayName: "Second",
        password: "another correct password",
      }),
    }));
    assert.equal(unrelatedVerification.status, 200);

    let aggregateLimited!: Response;
    for (let attempt = 0; attempt < 51; attempt += 1) {
      aggregateLimited = await verifyRoute.POST(new Request("https://into.example.test/api/access/verify", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://into.example.test",
          "x-test-source": "aggregate-verification-source",
        },
        body: JSON.stringify({
          token: `v1.${attempt.toString(36).padStart(43, "B")}`,
          displayName: "Aggregate abuse",
          password: "short",
        }),
      }));
    }
    assert.equal(aggregateLimited.status, 429);

    const closedBootstrapSession = await sessionRoute.GET(new Request("https://into.example.test/api/access/session", {
      headers: { cookie: `into_access_session=${legacyCookie}` },
    }));
    assert.deepEqual((await closedBootstrapSession.json() as { capabilities: unknown }).capabilities, {
      canInviteUsers: false,
    });

    environment.AUTH_MODE = "legacy_password";
    const legacyVerification = await verifyRoute.POST(new Request("https://into.example.test/api/access/verify", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://into.example.test" },
      body: JSON.stringify({ token: abusedToken, displayName: "Blocked", password: "correct password value" }),
    }));
    assert.equal(legacyVerification.status, 403);
  } finally {
    closeConfiguredAuthRepository();
    setConfiguredAuthRepositoryFactoryForTest(undefined);
    if (previous.mode === undefined) delete environment.AUTH_MODE; else environment.AUTH_MODE = previous.mode;
    if (previous.password === undefined) delete environment.INTO_ACCESS_PASSWORD; else environment.INTO_ACCESS_PASSWORD = previous.password;
    if (previous.secret === undefined) delete environment.INTO_INVITATION_SECRET; else environment.INTO_INVITATION_SECRET = previous.secret;
    if (previous.sourceHeader === undefined) delete environment.INTO_TRUSTED_SOURCE_HEADER; else environment.INTO_TRUSTED_SOURCE_HEADER = previous.sourceHeader;
    try { repository.close(); } catch { /* configured repository already closed it */ }
    await rm(path, { force: true });
  }
});

test("logout keeps legacy defaults backward compatible and trusts only configured server origins", async () => {
  const environment = process.env as Record<string, string | undefined>;
  const previous = {
    mode: environment.AUTH_MODE,
    appUrl: environment.APP_URL,
    origins: environment.INTO_TRUSTED_ORIGINS,
  };
  const logoutRoute = await import("../app/api/access/logout/route");
  try {
    environment.AUTH_MODE = "legacy_password";
    delete environment.APP_URL;
    delete environment.INTO_TRUSTED_ORIGINS;
    const legacy = await logoutRoute.POST(new Request("https://deployment.example.test/api/access/logout", {
      method: "POST",
      headers: { cookie: "into_access_session=stale" },
    }));
    assert.equal(legacy.status, 200);
    assert.match(legacy.headers.get("set-cookie") ?? "", /into_access_session=;/);

    environment.AUTH_MODE = "dual";
    environment.APP_URL = "https://trusted.example.test";
    const trusted = await logoutRoute.POST(new Request("https://deployment.example.test/api/access/logout", {
      method: "POST",
      headers: { origin: "https://trusted.example.test" },
    }));
    assert.equal(trusted.status, 200);

    const untrusted = await logoutRoute.POST(new Request("https://deployment.example.test/api/access/logout", {
      method: "POST",
      headers: { origin: "https://attacker.example.test" },
    }));
    assert.equal(untrusted.status, 403);
  } finally {
    if (previous.mode === undefined) delete environment.AUTH_MODE; else environment.AUTH_MODE = previous.mode;
    if (previous.appUrl === undefined) delete environment.APP_URL; else environment.APP_URL = previous.appUrl;
    if (previous.origins === undefined) delete environment.INTO_TRUSTED_ORIGINS; else environment.INTO_TRUSTED_ORIGINS = previous.origins;
  }
});
