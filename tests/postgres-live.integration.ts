import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PostgresAuthRepository } from "../lib/repository/postgres-auth-repository";
import { PostgresLearningRepository } from "../lib/repository/postgres-learning-repository";
import { LearningGenerationConflictError } from "../lib/repository/learning-repository";
import { loadStoreSnapshot, withPostgresStoreTransaction } from "../lib/repository/postgres-store";
import { executeInvoiceBooking } from "../lib/repository/invoice-booking";
import { withPersistentStoreForTest } from "../lib/repository/persistent-request";
import { createUploadedInvoice, flushStoreToPersistence, getInvoice, getStore, hydrateStoreFromPersistence, persistStoreSoon } from "../lib/repository/invoice-store";
import { createMockExactConnection } from "../lib/services/exact-online-service";
import { createMockExactMasterData } from "../lib/services/exact-master-data-service";
import { migratePostgresReleaseSchema } from "../lib/repository/release-migrations";
import {
  createUserInvitation,
  verifyUserInvitation,
} from "../lib/services/verified-session-auth";

function integrationDatabaseUrl() {
  const url = process.env.INTO_POSTGRES_INTEGRATION_DATABASE_URL?.trim();
  assert.ok(url, "INTO_POSTGRES_INTEGRATION_DATABASE_URL is required.");
  const parsed = new URL(url);
  assert.match(parsed.hostname, /\.neon\.tech$/);
  const configuredUrl = process.env.DATABASE_URL?.trim();
  if (configuredUrl) {
    assert.notEqual(
      parsed.hostname.replace(/-pooler(?=\.)/, ""),
      new URL(configuredUrl).hostname.replace(/-pooler(?=\.)/, ""),
      "Integration tests require a separate Neon endpoint from DATABASE_URL."
    );
  }
  return url;
}

test("real PostgreSQL booking persists a no-repost lock across a failed provider and restart", async () => {
  const url = integrationDatabaseUrl();
  const keys = ["DATABASE_URL", "DATABASE_MODE", "LEARNING_V2_ENABLED"];
  const previous = keys.map((key) => process.env[key]);
  process.env.DATABASE_URL = url;
  process.env.DATABASE_MODE = "postgres";
  process.env.LEARNING_V2_ENABLED = "false";
  let original: Record<string, unknown> | undefined;
  let captured = false;
  try {
    await migratePostgresReleaseSchema();
    original = (await withPostgresStoreTransaction((query) => query("SELECT payload, revision FROM into_runtime_store WHERE id='company'")))[0];
    captured = true;
    await hydrateStoreFromPersistence(true);
    getStore().exactConnections = [createMockExactConnection("company_connection")];
    getStore().exactMasterDataCaches = [{ userId: "company_connection", cache: createMockExactMasterData() }];
    const invoice = createUploadedInvoice({ fileName: "pg-booking-test.pdf", fileType: "application/pdf", fileSize: 10, storageKey: `pg-booking-test-${randomUUID()}` });
    invoice.status = "Ready to Book";
    persistStoreSoon();
    await flushStoreToPersistence();
    let writes = 0;
    await withPersistentStoreForTest(async () => {
      await assert.rejects(executeInvoiceBooking({ invoiceId: invoice.id, expectedRevision: invoice.revision, requestKey: "pg-booking" }, async (_c, _i, _m, hooks) => {
        await hooks!.beforeWrite();
        assert.equal((await loadStoreSnapshot())!.invoices.find((item) => item.id === invoice.id)?.bookingOperation?.state, "reserved");
        writes += 1;
        await hooks!.recordProgress({ exactDocumentId: "pg-partial-document" });
        throw new Error("test timeout");
      }), /reconciliation/i);
    });
    await hydrateStoreFromPersistence(true);
    const restored = getInvoice(invoice.id)!;
    assert.equal(restored.bookingOperation?.state, "uncertain");
    assert.equal(restored.bookingOperation?.exactDocumentId, "pg-partial-document");
    await withPersistentStoreForTest(async () => {
      await assert.rejects(executeInvoiceBooking({ invoiceId: invoice.id, expectedRevision: restored.revision, requestKey: "pg-retry" }, async () => { writes += 1; throw new Error("must not retry"); }), /reconciliation/i);
    });
    assert.equal(writes, 1);
  } finally {
    try {
      assert.equal(process.env.DATABASE_URL, url, "Test cleanup must stay on the disposable endpoint.");
      if (captured) {
        // Restore the disposable database's prior singleton, not a production snapshot.
        await withPostgresStoreTransaction(async (query) => {
          await query("SELECT revision FROM into_runtime_store WHERE id='company' FOR UPDATE");
          if (original) {
            await query("UPDATE into_runtime_store SET payload=$1::jsonb, revision=revision+1, updated_at=now() WHERE id='company'", [JSON.stringify(original.payload)]);
          } else await query("DELETE FROM into_runtime_store WHERE id='company'");
        });
      }
    } finally {
      keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
    }
  }
});

test("real PostgreSQL migrations and rollback are transactional", async () => {
  const url = integrationDatabaseUrl();
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
      assert.ok(process.env.DATABASE_URL === url, "Cleanup database URL changed.");
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
  const url = integrationDatabaseUrl();

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
  const url = integrationDatabaseUrl();

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
      assert.ok(process.env.DATABASE_URL === url, "Cleanup database URL changed.");
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
  const url = integrationDatabaseUrl();
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

    const competingTruths = ["FINAL-C", "FINAL-D"];
    const replacements = await Promise.allSettled(competingTruths.map((referenceCode) =>
      new PostgresLearningRepository(url).saveExample({
        ...example,
        id: `example-${identity}-${referenceCode}`,
        finalFields: { referenceCode },
        requestId: `learn-${identity}-${referenceCode}`,
      })
    ));
    assert.ok(replacements.some((result) => result.status === "fulfilled"));
    for (const [index, result] of replacements.entries()) {
      if (result.status === "fulfilled") {
        assert.equal(result.value.created, true);
        assert.deepEqual(result.value.example.finalFields, { referenceCode: competingTruths[index] });
      } else {
        assert.ok(result.reason instanceof LearningGenerationConflictError);
      }
    }
    assert.equal((await repository.listExamples(scope)).length, 1);
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
    const rebuild = {
      ...scope,
      generation: profile.generation,
      modelVersion: pattern.modelVersion,
      patterns: [{ ...pattern, supportCount: 5, successCount: 4 }],
      updatedAt: "2026-09-04T07:01:00.000Z",
    };
    await repository.replaceDerivedPatterns(rebuild);
    await repository.replaceDerivedPatterns(rebuild);
    const patterns = await repository.listPatterns(scope);
    assert.equal(patterns.length, 1);
    assert.equal(Number(patterns[0]?.support_count), 5);
    assert.equal(Number(patterns[0]?.success_count), 4);
    assert.equal(Number(patterns[0]?.correction_count), 1);
    await repository.replaceDerivedPatterns({ ...rebuild, patterns: [] });
    assert.equal((await repository.listPatterns(scope)).length, 0);
    const inactivePatterns = await repository.listPatterns(scope, true);
    assert.equal(inactivePatterns.length, 1);
    assert.equal(inactivePatterns[0]?.active, false);
    await repository.replaceDerivedPatterns(rebuild);
    assert.equal((await repository.listPatterns(scope)).length, 1);

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

    await repository.updateProfileConfidence({
      ...scope,
      generation: profile.generation,
      score: 82,
      driftState: "possible",
      updatedAt: createdAt,
    });
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
    const resetProfile = await repository.getProfile(scope);
    assert.equal(resetProfile?.generation, profile.generation + 1);
    assert.equal(resetProfile?.confidenceScore, 35);
    assert.equal(resetProfile?.learnedCount, 0);
    assert.equal(resetProfile?.evidenceRevision, 0);
    assert.equal(resetProfile?.derivedEvidenceRevision, 0);
    assert.equal(resetProfile?.driftState, "none");
    assert.equal(resetProfile?.lastLearnedAt, undefined);
    const resetEvents = (await repository.listEvents(scope)).filter((item) => item.type === "reset");
    assert.equal(resetEvents.length, 1);
    assert.equal(resetEvents[0]?.generation, profile.generation + 1);
    assert.equal((await repository.listExamples(scope)).length, 0);
    assert.equal((await repository.listPatterns(scope)).length, 0);

    const historyAfterReset = await repository.listExamples(scope, true);
    await assert.rejects(
      repository.saveExample({
        ...example,
        id: `example-${identity}-stale`,
        finalFields: { referenceCode: "STALE" },
        requestId: `learn-${identity}-stale`,
      }),
      LearningGenerationConflictError
    );
    assert.deepEqual(await repository.listExamples(scope, true), historyAfterReset);

    // Historical generations must remain read-only even if legacy evidence is active.
    await withPostgresStoreTransaction((query) => query(
      "UPDATE supplier_learning_examples SET active=true WHERE company_id=$1 AND id=$2",
      [scope.companyId, `example-${identity}-b`]
    ));
    const historicalEvidence = await repository.listExamples(scope, true);
    const staleWrites = [];
    for (const referenceCode of ["FINAL-B", "STALE"]) {
      const [result] = await Promise.allSettled([repository.saveExample({
        ...example,
        id: `example-${identity}-stale-${referenceCode}`,
        finalFields: { referenceCode },
        requestId: `learn-${identity}-stale-${referenceCode}`,
      })]);
      staleWrites.push(result.status === "rejected" && result.reason instanceof LearningGenerationConflictError);
    }
    assert.deepEqual({
      rejectedStaleWrites: staleWrites,
      historicalEvidence: await repository.listExamples(scope, true),
    }, {
      rejectedStaleWrites: [true, true],
      historicalEvidence,
    });
    assert.deepEqual(await repository.getProfile(scope), resetProfile);
    assert.equal((await repository.listEvents(scope)).filter((item) => item.type === "reset").length, 1);
  } finally {
    try {
      assert.ok(process.env.DATABASE_URL === url, "Cleanup database URL changed.");
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
