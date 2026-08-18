import assert from "node:assert/strict";
import test from "node:test";
import { PostgresAuthRepository } from "../lib/repository/postgres-auth-repository";
import { PostgresLearningRepository } from "../lib/repository/postgres-learning-repository";
import { withPostgresStoreTransaction } from "../lib/repository/postgres-store";

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
