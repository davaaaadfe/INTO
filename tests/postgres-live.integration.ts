import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PostgresAuthRepository } from "../lib/repository/postgres-auth-repository";
import { PostgresLearningRepository } from "../lib/repository/postgres-learning-repository";
import { withPostgresStoreTransaction } from "../lib/repository/postgres-store";
import { migratePostgresReleaseSchema } from "../lib/repository/release-migrations";
import {
  createUserInvitation,
  verifyUserInvitation,
} from "../lib/services/verified-session-auth";

test("real PostgreSQL migrations and rollback are transactional", async () => {
  const url = process.env.INTO_POSTGRES_INTEGRATION_DATABASE_URL?.trim();
  assert.ok(url, "INTO_POSTGRES_INTEGRATION_DATABASE_URL is required.");
  const parsed = new URL(url);
  assert.match(parsed.hostname, /\.neon\.tech$/);

  const previousUrl = process.env.DATABASE_URL;
  const previousMode = process.env.DATABASE_MODE;
  process.env.DATABASE_URL = url;
  process.env.DATABASE_MODE = "postgres";

  try {
    const auth = new PostgresAuthRepository(url);
    const learning = new PostgresLearningRepository(url);
    await auth.migrate();
    await learning.migrate();
    assert.equal(await auth.schemaVersion(), 7);
    assert.equal(await learning.schemaVersion(), 3);

    await withPostgresStoreTransaction(async (query) => {
      await query(`CREATE TABLE IF NOT EXISTS into_transaction_probe (
        id text PRIMARY KEY,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
      await query("DELETE FROM into_transaction_probe");
    });

    await assert.rejects(
      withPostgresStoreTransaction(async (query) => {
        await query(
          "INSERT INTO into_transaction_probe (id) VALUES ($1)",
          ["must-roll-back"]
        );
        throw new Error("rollback probe");
      }),
      /rollback probe/
    );

    const rows = await withPostgresStoreTransaction((query) =>
      query("SELECT COUNT(*)::integer AS count FROM into_transaction_probe")
    );
    assert.equal(Number(rows[0]?.count), 0);
  } finally {
    try {
      await withPostgresStoreTransaction((query) =>
        query("DROP TABLE IF EXISTS into_transaction_probe")
      );
    } finally {
      if (previousUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousUrl;
      if (previousMode === undefined) delete process.env.DATABASE_MODE;
      else process.env.DATABASE_MODE = previousMode;
    }
  }
});

test("the release migration command prepares and verifies every production schema", async () => {
  const url = process.env.INTO_POSTGRES_INTEGRATION_DATABASE_URL?.trim();
  assert.ok(url, "INTO_POSTGRES_INTEGRATION_DATABASE_URL is required.");
  const parsed = new URL(url);
  assert.match(parsed.hostname, /\.neon\.tech$/);

  const previousUrl = process.env.DATABASE_URL;
  const previousMode = process.env.DATABASE_MODE;
  process.env.DATABASE_URL = url;
  process.env.DATABASE_MODE = "postgres";
  try {
    assert.deepEqual(await migratePostgresReleaseSchema(), {
      authSchemaVersion: 7,
      learningSchemaVersion: 3,
      runtimeStoreReady: true,
      temporaryInvoiceFilesReady: true,
    });
  } finally {
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    if (previousMode === undefined) delete process.env.DATABASE_MODE;
    else process.env.DATABASE_MODE = previousMode;
  }
});

test("real PostgreSQL invitation verification creates the credential and session atomically", async () => {
  const url = process.env.INTO_POSTGRES_INTEGRATION_DATABASE_URL?.trim();
  assert.ok(url, "INTO_POSTGRES_INTEGRATION_DATABASE_URL is required.");

  const previousUrl = process.env.DATABASE_URL;
  const previousMode = process.env.DATABASE_MODE;
  const previousInvitationSecret = process.env.INTO_INVITATION_SECRET;
  process.env.DATABASE_URL = url;
  process.env.DATABASE_MODE = "postgres";
  process.env.INTO_INVITATION_SECRET = "postgres-live-invitation-secret-at-least-32-bytes";

  const repository = new PostgresAuthRepository(url);
  const identity = randomUUID();
  const email = `postgres-live-${identity}@example.invalid`;

  try {
    await repository.migrate();
    const invitation = await createUserInvitation(repository, {
      actorId: "shared_user",
      actorName: "Shared access",
      accessLevel: "legacy_shared",
      verificationState: "legacy",
      sessionCorrelationId: `postgres-live-session-${identity}`,
      requestId: `postgres-live-invite-${identity}`,
    }, {
      email,
      name: "PostgreSQL live test",
      requestKey: `postgres-live-invite-${identity}`,
    }, "https://into.example.test");
    const token = new URL(invitation.verificationUrl).searchParams.get("token");
    assert.ok(token);

    const verified = await verifyUserInvitation(repository, {
      token,
      displayName: "PostgreSQL live test",
      password: "postgres-live-password-123",
      requestId: `postgres-live-verify-${identity}`,
    });

    assert.equal(verified.user.status, "active");
    assert.ok(verified.user.verifiedAt);
    assert.ok(await repository.findUserCredentialByEmail(email));
    assert.ok(await repository.findSessionById(verified.session.sessionId));
  } finally {
    try {
      await withPostgresStoreTransaction(async (query) => {
        const users = await query(
          "SELECT id FROM into_auth_users WHERE email = $1",
          [email]
        );
        const userId = users[0]?.id;
        if (!userId) return;
        await query("DELETE FROM into_auth_events WHERE target_user_id = $1", [userId]);
        await query("DELETE FROM into_auth_sessions WHERE user_id = $1", [userId]);
        await query("DELETE FROM into_auth_credentials WHERE user_id = $1", [userId]);
        await query("DELETE FROM into_auth_invitations WHERE user_id = $1", [userId]);
        await query("DELETE FROM into_auth_users WHERE id = $1", [userId]);
      });
    } finally {
      if (previousUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousUrl;
      if (previousMode === undefined) delete process.env.DATABASE_MODE;
      else process.env.DATABASE_MODE = previousMode;
      if (previousInvitationSecret === undefined) delete process.env.INTO_INVITATION_SECRET;
      else process.env.INTO_INVITATION_SECRET = previousInvitationSecret;
    }
  }
});

test("real PostgreSQL learning writes replay, replace, and reset concurrently", async () => {
  const url = process.env.INTO_POSTGRES_INTEGRATION_DATABASE_URL?.trim();
  assert.ok(url, "INTO_POSTGRES_INTEGRATION_DATABASE_URL is required.");
  const previousUrl = process.env.DATABASE_URL;
  const previousMode = process.env.DATABASE_MODE;
  process.env.DATABASE_URL = url;
  process.env.DATABASE_MODE = "postgres";
  const identity = randomUUID();
  const scope = {
    companyId: `postgres-live-${identity}`,
    divisionCode: "test",
    supplierAccountId: `supplier-${identity}`,
  };
  const createdAt = "2026-09-04T07:00:00.000Z";
  const repository = new PostgresLearningRepository(url);

  try {
    await repository.migrate();
    const profile = await repository.ensureProfile({
      ...scope,
      fallbackSupplierCode: "LIVE",
      createdAt,
    });
    const example = {
      ...scope,
      id: `example-${identity}-a`,
      generation: profile.generation,
      invoiceId: `invoice-${identity}-a`,
      contentHash: `sha256:${identity}`,
      originalFilename: "sanitized.pdf",
      originalPrediction: { referenceCode: "ORIGINAL" },
      finalFields: { referenceCode: "FINAL-A" },
      bookingLines: [],
      observationState: { referenceCode: "observed" as const },
      fingerprint: "layout-live",
      fingerprintVersion: "layout-v1",
      formatSignature: "invoice number:<value>",
      formatCluster: "cluster-live",
      validationResult: { valid: true },
      processingPurpose: "learning_only" as const,
      source: "explicit_learn" as const,
      trustState: "trusted" as const,
      trigger: "learn" as const,
      actorId: "verified-live",
      sessionCorrelationId: `session-${identity}`,
      requestId: `learn-${identity}-a`,
      createdAt,
    };

    assert.equal((await repository.saveExample(example)).created, true);
    assert.equal((await repository.saveExample(example)).created, false);
    assert.equal(
      (await repository.saveExample({
        ...example,
        id: `example-${identity}-b`,
        invoiceId: `invoice-${identity}-b`,
        finalFields: { referenceCode: "FINAL-B" },
        requestId: `learn-${identity}-b`,
      })).created,
      true
    );
    const examples = await repository.listExamples(scope, true);
    assert.equal(examples.length, 2);
    assert.equal(examples.filter((item) => item.active).length, 1);
    assert.equal(examples.find((item) => item.active)?.id, `example-${identity}-b`);
    assert.equal((await repository.getProfile(scope))?.learnedCount, 1);

    const pattern = {
      ...scope,
      id: `pattern-${identity}`,
      generation: profile.generation,
      formatCluster: "cluster-live",
      field: "referenceCode",
      patternKey: "field:referenceCode",
      supportCount: 2,
      successCount: 1,
      correctionCount: 1,
      driftState: "none" as const,
      modelVersion: "pattern-live-v1",
      createdAt,
    };
    await repository.replaceDerivedPatterns({
      ...scope,
      generation: profile.generation,
      modelVersion: pattern.modelVersion,
      patterns: [pattern],
      updatedAt: createdAt,
    });
    await repository.replaceDerivedPatterns({
      ...scope,
      generation: profile.generation,
      modelVersion: pattern.modelVersion,
      patterns: [{ ...pattern, supportCount: 5, successCount: 4 }],
      updatedAt: "2026-09-04T07:01:00.000Z",
    });
    const patterns = await repository.listPatterns(scope);
    assert.equal(patterns.length, 1);
    assert.equal(Number(patterns[0]?.support_count), 5);
    assert.equal(Number(patterns[0]?.success_count), 4);

    const event = {
      ...scope,
      id: `event-${identity}-a`,
      generation: profile.generation,
      type: "confirmation" as const,
      idempotencyKey: `confirmation:${identity}`,
      actorId: "verified-live",
      sessionCorrelationId: `session-${identity}`,
      requestId: `confirmation-${identity}`,
      metadata: { outcome: "confirmed" },
      createdAt,
    };
    await repository.saveEvent(event);
    await repository.saveEvent({ ...event, id: `event-${identity}-b` });
    assert.equal(
      (await repository.listEvents(scope)).filter(
        (item) => item.idempotencyKey === event.idempotencyKey
      ).length,
      1
    );

    const resets = await Promise.allSettled([
      repository.resetSupplier({
        ...scope,
        expectedGeneration: profile.generation,
        actorId: "verified-live-a",
        sessionCorrelationId: `session-${identity}-a`,
        requestId: `reset-${identity}-a`,
        createdAt: "2026-09-04T07:02:00.000Z",
      }),
      repository.resetSupplier({
        ...scope,
        expectedGeneration: profile.generation,
        actorId: "verified-live-b",
        sessionCorrelationId: `session-${identity}-b`,
        requestId: `reset-${identity}-b`,
        createdAt: "2026-09-04T07:02:00.000Z",
      }),
    ]);
    assert.equal(resets.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(resets.filter((result) => result.status === "rejected").length, 1);
    assert.equal((await repository.getProfile(scope))?.generation, profile.generation + 1);
    assert.equal((await repository.listExamples(scope)).length, 0);
    assert.equal((await repository.listPatterns(scope)).length, 0);
  } finally {
    try {
      await withPostgresStoreTransaction(async (query) => {
        await query("DELETE FROM supplier_learning_events WHERE company_id = $1", [scope.companyId]);
        await query("DELETE FROM supplier_learning_patterns WHERE company_id = $1", [scope.companyId]);
        await query("DELETE FROM supplier_learning_examples WHERE company_id = $1", [scope.companyId]);
        await query("DELETE FROM supplier_identity_aliases WHERE company_id = $1", [scope.companyId]);
        await query("DELETE FROM supplier_learning_profiles WHERE company_id = $1", [scope.companyId]);
      });
    } finally {
      if (previousUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousUrl;
      if (previousMode === undefined) delete process.env.DATABASE_MODE;
      else process.env.DATABASE_MODE = previousMode;
    }
  }
});
