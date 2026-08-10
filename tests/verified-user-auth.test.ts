import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteAuthRepository } from "../lib/repository/auth-repository";
import {
  addAuditEvent,
  createUploadedInvoice,
  getStore,
} from "../lib/repository/invoice-store";

test("scrypt credentials are versioned, salted, bounded, and verify without retaining the password", async () => {
  const auth = await import("../lib/services/verified-session-auth");

  assert.equal(typeof auth.createPasswordCredential, "function");
  assert.equal(typeof auth.verifyPasswordCredential, "function");

  const credential = await auth.createPasswordCredential("correct horse battery staple");
  assert.equal(credential.algorithm, "scrypt");
  assert.equal(credential.version, 1);
  assert.match(credential.hash, /^[A-Za-z0-9_-]+$/);
  assert.match(credential.salt, /^[A-Za-z0-9_-]+$/);
  assert.equal(JSON.stringify(credential).includes("correct horse battery staple"), false);
  assert.equal(await auth.verifyPasswordCredential("correct horse battery staple", credential), true);
  assert.equal(await auth.verifyPasswordCredential("wrong password", credential), false);

  await assert.rejects(auth.createPasswordCredential("short"), /between 12 and 1024/);
  await assert.rejects(auth.createPasswordCredential("x".repeat(1025)), /between 12 and 1024/);
  await assert.rejects(
    auth.verifyPasswordCredential("correct horse battery staple", { ...credential, version: 2 as unknown as 1 }),
    /Unsupported credential version/
  );
});

test("SQLite invitation replay and consumption are atomic and secret-safe", async () => {
  const path = resolve("data/tmp-tests", `verified-auth-${crypto.randomUUID()}.sqlite`);
  const repository = new SqliteAuthRepository(path);
  try {
    await repository.migrate();
    assert.equal(typeof repository.createOrReplayInvitation, "function");
    assert.equal(typeof repository.consumeInvitation, "function");

    const invitation = {
      id: "invitation-1",
      userId: "invited-user",
      email: "person@example.test",
      displayName: "Person",
      tokenDigest: "invitation-token-digest",
      expiresAt: "2026-08-11T00:00:00.000Z",
      inviterActorId: "verified-user",
      inviterSessionId: "session-correlation",
      requestId: "request-1",
      idempotencyKey: "invite-key",
      requestFingerprint: "fingerprint-1",
      timestamp: "2026-08-10T00:00:00.000Z",
    };
    assert.equal((await repository.createOrReplayInvitation(invitation)).state, "created");
    const replay = await repository.createOrReplayInvitation({
      ...invitation,
      id: "ignored-replay-id",
      tokenDigest: "ignored-replay-digest",
    });
    assert.equal(replay.state, "replayed");
    assert.equal(replay.invitation.id, "invitation-1");
    assert.equal((await repository.createOrReplayInvitation({
      ...invitation,
      id: "conflict-id",
      requestFingerprint: "different-fingerprint",
    })).state, "conflict");

    const auth = await import("../lib/services/verified-session-auth");
    const password = await auth.createPasswordCredential("correct horse battery staple");
    const session = {
      id: "verified-session-1",
      userId: "invited-user",
      tokenDigest: "session-token-digest",
      correlationIdHash: "session-correlation-hash",
      tokenVersion: 1,
      issuedAt: "2026-08-10T00:05:00.000Z",
      expiresAt: "2026-08-10T12:05:00.000Z",
      revokedAt: null,
      lastSeenAt: "2026-08-10T00:05:00.000Z",
    } as const;
    const consume = () => repository.consumeInvitation({
      tokenDigest: invitation.tokenDigest,
      displayName: "Verified Person",
      credential: password,
      session,
      requestId: "verify-request",
      timestamp: "2026-08-10T00:05:00.000Z",
    });
    const outcomes = await Promise.all([consume(), consume()]);
    assert.deepEqual(outcomes.map((outcome) => outcome.state).sort(), ["consumed", "gone"]);
    assert.equal((await repository.listUsers())[0]?.status, "active");
    const stored = await repository.findUserCredentialByEmail("PERSON@example.test");
    assert.equal(stored?.user.verifiedAt, "2026-08-10T00:05:00.000Z");
    assert.equal(await auth.verifyPasswordCredential("correct horse battery staple", stored!.credential), true);

    const database = new DatabaseSync(path, { readOnly: true });
    const rows = JSON.stringify({
      invitations: database.prepare("SELECT * FROM into_auth_invitations").all(),
      credentials: database.prepare("SELECT * FROM into_auth_credentials").all(),
      sessions: database.prepare("SELECT * FROM into_auth_sessions").all(),
      events: database.prepare("SELECT * FROM into_auth_events").all(),
    });
    database.close();
    assert.equal(rows.includes("correct horse battery staple"), false);
    assert.equal(rows.includes("raw-invitation-token"), false);
    assert.equal(rows.includes("raw-session-token"), false);
    assert.equal(await repository.countRows("into_auth_sessions"), 1);
  } finally {
    repository.close();
    await rm(path, { force: true });
    await rm(`${path}-shm`, { force: true });
    await rm(`${path}-wal`, { force: true });
  }
});

test("SQLite user status CAS prevents stale writes and final-active-user lockout", async () => {
  const path = resolve("data/tmp-tests", `verified-status-${crypto.randomUUID()}.sqlite`);
  const repository = new SqliteAuthRepository(path);
  try {
    await repository.migrate();
    await repository.upsertLegacyUsers([{
      id: "only-user",
      email: "only@example.test",
      displayName: "Only User",
      status: "active",
      accessLevel: "verified_user",
      verifiedAt: "2026-08-10T00:00:00.000Z",
    }], "2026-08-10T00:00:00.000Z");
    assert.equal(typeof repository.updateUserStatus, "function");
    assert.equal(await repository.countActiveUsers(), 1);
    assert.equal((await repository.updateUserStatus({
      actorId: "only-user",
      targetId: "only-user",
      expectedVersion: 1,
      status: "disabled",
      requestId: "disable-1",
      sessionId: "session-1",
      timestamp: "2026-08-10T00:10:00.000Z",
    })).state, "final_active");

    await repository.upsertLegacyUsers([{
      id: "other-user",
      email: "other@example.test",
      displayName: "Other User",
      status: "active",
      accessLevel: "verified_user",
      verifiedAt: "2026-08-10T00:00:00.000Z",
    }], "2026-08-10T00:00:00.000Z");
    assert.equal((await repository.updateUserStatus({
      actorId: "other-user",
      targetId: "only-user",
      expectedVersion: 99,
      status: "disabled",
      requestId: "disable-stale",
      sessionId: "session-2",
      timestamp: "2026-08-10T00:11:00.000Z",
    })).state, "conflict");
    const updated = await repository.updateUserStatus({
      actorId: "only-user",
      targetId: "only-user",
      expectedVersion: 1,
      status: "disabled",
      requestId: "disable-2",
      sessionId: "session-1",
      timestamp: "2026-08-10T00:12:00.000Z",
    });
    assert.equal(updated.state, "updated");
    assert.equal(updated.user?.status, "disabled");
    assert.equal(updated.user?.version, 2);
    assert.equal(await repository.countActiveUsers(), 1);
  } finally {
    repository.close();
    await rm(path, { force: true });
  }
});

test("verified-user auth service derives invitation tokens and enforces generic login failures", async () => {
  const path = resolve("data/tmp-tests", `verified-service-${crypto.randomUUID()}.sqlite`);
  const repository = new SqliteAuthRepository(path);
  const previousSecret = process.env.INTO_INVITATION_SECRET;
  process.env.INTO_INVITATION_SECRET = "test-only-invitation-secret-at-least-32-bytes";
  try {
    await repository.migrate();
    const service = await import("../lib/services/verified-session-auth");
    assert.equal(typeof service.createUserInvitation, "function");
    assert.equal(typeof service.verifyUserInvitation, "function");
    assert.equal(typeof service.loginVerifiedUser, "function");

    const principal = {
      actorId: "inviter",
      actorName: "Inviter",
      accessLevel: "verified_user",
      verificationState: "verified",
      sessionCorrelationId: "session-correlation",
      requestId: "request-1",
    } as const;
    const created = await service.createUserInvitation(repository, principal, {
      email: "PERSON@Example.test",
      name: "Person",
      requestKey: "invite-key",
    }, "https://into.example.test", Date.UTC(2026, 7, 10));
    assert.equal(created.state, "created");
    assert.match(created.verificationUrl, /^https:\/\/into\.example\.test\/verify\?token=v1\./);
    const replay = await service.createUserInvitation(repository, principal, {
      email: "person@example.test",
      name: "Person",
      requestKey: "invite-key",
    }, "https://into.example.test", Date.UTC(2026, 7, 10));
    assert.equal(replay.verificationUrl, created.verificationUrl);
    await assert.rejects(service.createUserInvitation(repository, principal, {
      email: "other@example.test",
      name: "Other",
      requestKey: "invite-key",
    }, "https://into.example.test", Date.UTC(2026, 7, 10)), service.InvitationConflictError);

    const token = new URL(created.verificationUrl).searchParams.get("token")!;
    const verified = await service.verifyUserInvitation(repository, {
      token,
      displayName: "Verified Person",
      password: "correct horse battery staple",
      requestId: "verify-request",
    }, Date.UTC(2026, 7, 10, 0, 5));
    assert.equal(verified.user.status, "active");
    assert.match(verified.session.token, /^v1\./);
    await assert.rejects(service.verifyUserInvitation(repository, {
      token,
      displayName: "Verified Person",
      password: "correct horse battery staple",
      requestId: "verify-replay",
    }, Date.UTC(2026, 7, 10, 0, 6)), service.InvitationGoneError);

    for (const email of ["missing@example.test", "person@example.test"]) {
      await assert.rejects(
        service.loginVerifiedUser(repository, email, "wrong password", Date.UTC(2026, 7, 10, 1)),
        (error: unknown) => error instanceof service.LoginError && error.status === 401 && error.message === "Invalid email or password."
      );
    }
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await service.loginVerifiedUser(repository, "person@example.test", "wrong password", Date.UTC(2026, 7, 10, 1, attempt + 1)).catch(() => undefined);
    }
    await assert.rejects(
      service.loginVerifiedUser(repository, "person@example.test", "correct horse battery staple", Date.UTC(2026, 7, 10, 1, 6)),
      (error: unknown) => error instanceof service.LoginError && error.status === 429
    );
    const login = await service.loginVerifiedUser(
      repository,
      "person@example.test",
      "correct horse battery staple",
      Date.UTC(2026, 7, 10, 1, 30)
    );
    assert.equal(login.user.id, verified.user.id);
    assert.match(login.session.token, /^v1\./);

    await service.loginVerifiedUser(
      repository,
      "person@example.test",
      "wrong password",
      Date.UTC(2026, 7, 10, 1, 31),
      { requestId: "login-failure-request", requestSource: "https://into.example.test" }
    ).catch(() => undefined);
    const database = new DatabaseSync(path, { readOnly: true });
    const failureEvent = database.prepare(
      "SELECT request_id, metadata_json FROM into_auth_events WHERE type = 'login_failed' ORDER BY created_at DESC LIMIT 1"
    ).get() as { request_id: string; metadata_json: string } | undefined;
    database.close();
    assert.equal(failureEvent?.request_id, "login-failure-request");
    assert.match(failureEvent?.metadata_json ?? "", /sourceHash/);
    assert.equal(failureEvent?.metadata_json.includes("https://into.example.test"), false);
  } finally {
    if (previousSecret === undefined) delete process.env.INTO_INVITATION_SECRET;
    else process.env.INTO_INVITATION_SECRET = previousSecret;
    repository.close();
    await rm(path, { force: true });
  }
});

test("verified request context attributes uploads and audit events without mutating the shared runtime user", async () => {
  const persistent = await import("../lib/repository/persistent-request");
  assert.equal(typeof persistent.withRequestPrincipalContext, "function");
  const store = getStore();
  const previousInvoices = store.invoices;
  const previousEvents = store.auditEvents;
  store.invoices = [];
  store.auditEvents = [];
  try {
    await persistent.withRequestPrincipalContext({
      actorId: "verified-actor",
      actorName: "Verified Actor",
      accessLevel: "verified_user",
      verificationState: "verified",
      sessionCorrelationId: "verified-session-correlation",
      requestId: "verified-request",
    }, () => {
      const invoice = createUploadedInvoice({
        fileName: "actor-test.pdf",
        fileType: "application/pdf",
        fileSize: 10,
        storageKey: "actor-test",
      });
      assert.equal(invoice.uploadedByUserId, "verified-actor");
      assert.equal(invoice.uploadedByName, "Verified Actor");
      addAuditEvent({ type: "sync_operation", message: "Actor propagation test." });
    });
    assert.equal(store.currentUserId, "shared_user");
    assert.equal(store.auditEvents.every((event) => event.userId === "verified-actor"), true);
    assert.equal(store.auditEvents.every((event) => event.userName === "Verified Actor"), true);
    assert.equal(store.auditEvents.every((event) => event.metadata?.requestId === "verified-request"), true);
    assert.equal(store.auditEvents.every((event) => event.metadata?.sessionCorrelationId === "verified-session-correlation"), true);
  } finally {
    store.invoices = previousInvoices;
    store.auditEvents = previousEvents;
  }
});
