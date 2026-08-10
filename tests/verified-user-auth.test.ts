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
      { requestId: "login-failure-request", sourceHash: "trusted-source-hash" }
    ).catch(() => undefined);
    const database = new DatabaseSync(path, { readOnly: true });
    const failureEvent = database.prepare(
      "SELECT request_id, metadata_json FROM into_auth_events WHERE type = 'login_failed' ORDER BY created_at DESC LIMIT 1"
    ).get() as { request_id: string; metadata_json: string } | undefined;
    database.close();
    assert.equal(failureEvent?.request_id, "login-failure-request");
    assert.match(failureEvent?.metadata_json ?? "", /sourceHash/);
    assert.match(failureEvent?.metadata_json ?? "", /trusted-source-hash/);
    assert.equal(failureEvent?.metadata_json.includes("https://into.example.test"), false);
  } finally {
    if (previousSecret === undefined) delete process.env.INTO_INVITATION_SECRET;
    else process.env.INTO_INVITATION_SECRET = previousSecret;
    repository.close();
    await rm(path, { force: true });
  }
});

test("known and unknown login failures share bounded memory limits without durable unknown identity state", async () => {
  const path = resolve("data/tmp-tests", `verified-throttle-${crypto.randomUUID()}.sqlite`);
  const repository = new SqliteAuthRepository(path);
  const previousSecret = process.env.INTO_INVITATION_SECRET;
  process.env.INTO_INVITATION_SECRET = "test-only-invitation-secret-at-least-32-bytes";
  try {
    await repository.migrate();
    const service = await import("../lib/services/verified-session-auth");
    const invitation = await service.createUserInvitation(repository, {
      actorId: "inviter", actorName: "Inviter", accessLevel: "verified_user",
      verificationState: "verified", sessionCorrelationId: "session", requestId: "invite",
    }, {
      email: "known@example.test", name: "Known", requestKey: "known-invite",
    }, "https://into.example.test", Date.UTC(2026, 7, 10));
    await service.verifyUserInvitation(repository, {
      token: new URL(invitation.verificationUrl).searchParams.get("token")!,
      displayName: "Known", password: "correct horse battery staple", requestId: "verify",
    }, Date.UTC(2026, 7, 10, 0, 1));

    let passwordVerifications = 0;
    service.setPasswordVerificationObserverForTests(() => { passwordVerifications += 1; });
    for (const [email, sourceHash] of [
      ["known@example.test", "known-source"],
      ["missing@example.test", "unknown-source"],
    ] as const) {
      const statuses: number[] = [];
      const workFactors: number[] = [];
      for (let attempt = 1; attempt <= 6; attempt += 1) {
        passwordVerifications = 0;
        await service.loginVerifiedUser(
          repository,
          email,
          "wrong password",
          Date.UTC(2026, 7, 10, 1, attempt),
          { requestId: `${email}:${attempt}`, sourceHash }
        ).catch((error: InstanceType<typeof service.LoginError>) => statuses.push(error.status));
        workFactors.push(passwordVerifications);
      }
      assert.deepEqual(statuses, [401, 401, 401, 401, 429, 429]);
      assert.deepEqual(workFactors, [1, 1, 1, 1, 0, 0]);
    }

    const aggregateStatuses: number[] = [];
    const aggregateWork: number[] = [];
    for (let attempt = 1; attempt <= 13; attempt += 1) {
      passwordVerifications = 0;
      await service.loginVerifiedUser(
        repository,
        `unique-${attempt}@example.test`,
        "wrong password",
        Date.UTC(2026, 7, 10, 2, attempt),
        { requestId: `aggregate:${attempt}`, sourceHash: "aggregate-source" }
      ).catch((error: InstanceType<typeof service.LoginError>) => aggregateStatuses.push(error.status));
      aggregateWork.push(passwordVerifications);
    }
    assert.deepEqual(aggregateStatuses, [...Array(12).fill(401), 429]);
    assert.deepEqual(aggregateWork, [...Array(12).fill(1), 0]);

    const database = new DatabaseSync(path, { readOnly: true });
    const tables = database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    ).all() as Array<{ name: string }>;
    const unknownEvents = database.prepare(
      "SELECT COUNT(*) AS count FROM into_auth_events WHERE type = 'login_failed' AND target_user_id IS NULL"
    ).get() as { count: number };
    const knownEvents = database.prepare(
      "SELECT COUNT(*) AS count FROM into_auth_events WHERE type = 'login_failed' AND target_user_id IS NOT NULL"
    ).get() as { count: number };
    const knownCredential = database.prepare(
      "SELECT failed_attempts FROM into_auth_credentials WHERE user_id = ?"
    ).get((await repository.listUsers()).find((user) => user.email === "known@example.test")!.id) as {
      failed_attempts: number;
    };
    database.close();
    assert.equal(tables.some((table) => table.name === "into_auth_login_throttles"), false);
    assert.equal(unknownEvents.count, 0);
    assert.equal(knownEvents.count, 1);
    assert.equal(knownCredential.failed_attempts, 4);
  } finally {
    const service = await import("../lib/services/verified-session-auth");
    service.setPasswordVerificationObserverForTests(undefined);
    if (previousSecret === undefined) delete process.env.INTO_INVITATION_SECRET;
    else process.env.INTO_INVITATION_SECRET = previousSecret;
    repository.close();
    await rm(path, { force: true });
  }
});

test("malformed login identities never reach repository canonicalization and match unknown work and status", async () => {
  const path = resolve("data/tmp-tests", `verified-malformed-${crypto.randomUUID()}.sqlite`);
  const repository = new SqliteAuthRepository(path);
  const service = await import("../lib/services/verified-session-auth");
  let lookups = 0;
  const trap = new Proxy(repository, {
    get(target, property, receiver) {
      if (property === "findUserCredentialByEmail") {
        return async () => {
          lookups += 1;
          throw new Error("repository canonicalizer must not receive malformed input");
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  let work = 0;
  service.setPasswordVerificationObserverForTests(() => { work += 1; });
  try {
    await repository.migrate();
    service.resetLoginLimiterForTests();
    const statuses: number[] = [];
    const workFactors: number[] = [];
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      work = 0;
      await service.loginVerifiedUser(trap, "", "wrong password", Date.UTC(2026, 7, 10, 3, attempt), {
        requestId: `malformed:${attempt}`,
        sourceHash: "malformed-source",
      }).catch((error: InstanceType<typeof service.LoginError>) => statuses.push(error.status));
      workFactors.push(work);
    }
    assert.deepEqual(statuses, [401, 401, 401, 401, 429, 429]);
    assert.deepEqual(workFactors, [1, 1, 1, 1, 0, 0]);
    assert.equal(lookups, 0);

    service.resetLoginLimiterForTests();
    work = 0;
    await assert.rejects(
      service.loginVerifiedUser(trap, " X".repeat(100_000), "wrong password", Date.UTC(2026, 7, 10, 4), {
        requestId: "oversized-malformed",
        sourceHash: "oversized-source",
      }),
      (error: InstanceType<typeof service.LoginError>) => error.status === 401
    );
    assert.equal(work, 1);
    assert.equal(lookups, 0);
  } finally {
    service.setPasswordVerificationObserverForTests(undefined);
    repository.close();
    await rm(path, { force: true });
  }
});

test("persisted credential locks survive repository restart without enumerating wrong passwords", async () => {
  const path = resolve("data/tmp-tests", `verified-lock-restart-${crypto.randomUUID()}.sqlite`);
  let repository = new SqliteAuthRepository(path);
  const previousSecret = process.env.INTO_INVITATION_SECRET;
  process.env.INTO_INVITATION_SECRET = "test-only-invitation-secret-at-least-32-bytes";
  const service = await import("../lib/services/verified-session-auth");
  let work = 0;
  service.setPasswordVerificationObserverForTests(() => { work += 1; });
  try {
    await repository.migrate();
    const invitation = await service.createUserInvitation(repository, {
      actorId: "inviter", actorName: "Inviter", accessLevel: "verified_user",
      verificationState: "verified", sessionCorrelationId: "session", requestId: "invite-lock",
    }, {
      email: "locked@example.test", name: "Locked", requestKey: "locked-invite",
    }, "https://into.example.test", Date.UTC(2026, 7, 10));
    await service.verifyUserInvitation(repository, {
      token: new URL(invitation.verificationUrl).searchParams.get("token")!,
      displayName: "Locked", password: "correct horse battery staple", requestId: "verify-lock",
    }, Date.UTC(2026, 7, 10, 0, 1));
    service.resetLoginLimiterForTests();
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await assert.rejects(service.loginVerifiedUser(
        repository, "locked@example.test", "wrong password", Date.UTC(2026, 7, 10, 1, attempt),
        { requestId: `lock:${attempt}`, sourceHash: "lock-source" }
      ), (error: InstanceType<typeof service.LoginError>) => error.status === 401);
    }

    repository.close();
    repository = new SqliteAuthRepository(path);
    service.resetLoginLimiterForTests();
    work = 0;
    await assert.rejects(service.loginVerifiedUser(
      repository, "locked@example.test", "correct horse battery staple", Date.UTC(2026, 7, 10, 1, 10),
      { requestId: "locked-correct", sourceHash: "restart-source" }
    ), (error: InstanceType<typeof service.LoginError>) => error.status === 429);
    assert.equal(work, 1);

    service.resetLoginLimiterForTests();
    work = 0;
    await assert.rejects(service.loginVerifiedUser(
      repository, "locked@example.test", "wrong password", Date.UTC(2026, 7, 10, 1, 11),
      { requestId: "locked-wrong", sourceHash: "restart-source" }
    ), (error: InstanceType<typeof service.LoginError>) => error.status === 401);
    assert.equal(work, 1);

    service.resetLoginLimiterForTests();
    work = 0;
    const login = await service.loginVerifiedUser(
      repository, "locked@example.test", "correct horse battery staple", Date.UTC(2026, 7, 10, 1, 27),
      { requestId: "expired-correct", sourceHash: "restart-source" }
    );
    assert.equal(login.user.email, "locked@example.test");
    assert.equal(work, 1);
    const credential = await repository.findUserCredentialByEmail("locked@example.test");
    assert.deepEqual({ failedAttempts: credential?.failedAttempts, lockedAt: credential?.lockedAt }, {
      failedAttempts: 0,
      lockedAt: null,
    });
  } finally {
    service.setPasswordVerificationObserverForTests(undefined);
    if (previousSecret === undefined) delete process.env.INTO_INVITATION_SECRET;
    else process.env.INTO_INVITATION_SECRET = previousSecret;
    repository.close();
    await rm(path, { force: true });
  }
});

test("login source hashing ignores forwarded headers unless the exact header is configured", async () => {
  const service = await import("../lib/services/verified-session-auth");
  const environment = process.env as Record<string, string | undefined>;
  const previous = environment.INTO_TRUSTED_SOURCE_HEADER;
  try {
    delete environment.INTO_TRUSTED_SOURCE_HEADER;
    const request = new Request("https://into.example.test/api/access/login", {
      headers: { "x-forwarded-for": "203.0.113.7", "x-real-ip": "203.0.113.8" },
    });
    assert.equal(service.trustedRequestSourceHash(request), null);
    environment.INTO_TRUSTED_SOURCE_HEADER = "x-real-ip";
    const hash = service.trustedRequestSourceHash(request);
    assert.match(hash ?? "", /^[A-Za-z0-9_-]{40,}$/);
    assert.notEqual(hash, "203.0.113.8");
  } finally {
    if (previous === undefined) delete environment.INTO_TRUSTED_SOURCE_HEADER;
    else environment.INTO_TRUSTED_SOURCE_HEADER = previous;
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

test("general audit records field classification without raw correction or evidence values", () => {
  const store = getStore();
  const previousEvents = store.auditEvents;
  store.auditEvents = [];
  try {
    const event = addAuditEvent({
      type: "invoice_field_edited",
      message: "Changed new-sensitive-line-description from old-sensitive-document-text.",
      field: "bookingLines",
      oldValue: { rawText: "old-sensitive-document-text" },
      newValue: [{ description: "new-sensitive-line-description", amount: 42 }],
      metadata: {
        decision: "review",
        documentAnalysis: { content: "sensitive-document-content" },
        extractionEvidence: [{ value: "sensitive-evidence-value" }],
      },
    });
    assert.equal(event.oldValue, undefined);
    assert.equal(event.newValue, undefined);
    assert.equal(event.metadata?.decision, "review");
    assert.equal(event.metadata?.changeClassification, "field_changed");
    assert.doesNotMatch(JSON.stringify(event), /old-sensitive|new-sensitive|sensitive-document|sensitive-evidence/);
  } finally {
    store.auditEvents = previousEvents;
  }
});
