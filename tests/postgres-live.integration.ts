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
