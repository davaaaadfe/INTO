import { neon } from "@neondatabase/serverless";
import type { IntoStore } from "./invoice-store";

const snapshotId = "company";

function databaseUrl() {
  return process.env.DATABASE_URL?.trim() ?? "";
}

export function isPostgresPersistenceEnabled() {
  return process.env.NODE_ENV === "production" && Boolean(databaseUrl());
}

async function sqlClient() {
  const url = databaseUrl();
  if (!url) {
    throw new Error("DATABASE_URL is required for PostgreSQL persistence.");
  }

  const sql = neon(url);
  await sql`
    CREATE TABLE IF NOT EXISTS into_runtime_store (
      id text PRIMARY KEY,
      payload jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  return sql;
}

export async function loadStoreSnapshot() {
  if (!isPostgresPersistenceEnabled()) {
    return null;
  }

  const sql = await sqlClient();
  const rows = await sql`
    SELECT payload
    FROM into_runtime_store
    WHERE id = ${snapshotId}
    LIMIT 1
  `;

  return (rows[0]?.payload as IntoStore | undefined) ?? null;
}

export async function saveStoreSnapshot(store: IntoStore) {
  if (!isPostgresPersistenceEnabled()) {
    return;
  }

  const sql = await sqlClient();
  await sql`
    INSERT INTO into_runtime_store (id, payload, updated_at)
    VALUES (${snapshotId}, ${JSON.stringify(store)}::jsonb, now())
    ON CONFLICT (id)
    DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()
  `;
}
