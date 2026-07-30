import { neon } from "@neondatabase/serverless";
import { Buffer } from "node:buffer";
import type { IntoStore } from "./invoice-store";
import { migrateStoreSnapshot } from "./store-migrations";
import {
  CURRENT_SNAPSHOT_SCHEMA_VERSION,
  databaseMode,
  SnapshotRevisionConflictError,
} from "./sqlite-store";

const snapshotId = "company";

type VersionedStore = IntoStore & {
  schemaVersion?: number;
  revision?: number;
};

function databaseUrl() {
  return process.env.DATABASE_URL?.trim() ?? "";
}

export function isPostgresPersistenceEnabled() {
  return databaseMode() === "postgres" && Boolean(databaseUrl());
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
      revision integer NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  await sql`
    ALTER TABLE into_runtime_store
    ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0
  `;
  return sql;
}

async function invoiceFileSqlClient() {
  const sql = await sqlClient();
  await sql`
    CREATE TABLE IF NOT EXISTS into_temp_invoice_files (
      storage_key text PRIMARY KEY,
      original_file_name text NOT NULL,
      stored_file_name text NOT NULL,
      file_type text NOT NULL,
      file_size bigint NOT NULL,
      checksum text NOT NULL,
      content_base64 text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  return sql;
}

export async function savePostgresTemporaryInvoiceFile(input: {
  storageKey: string;
  originalFileName: string;
  storedFileName: string;
  fileType: string;
  fileSize: number;
  checksum: string;
  bytes: Uint8Array;
}) {
  const sql = await invoiceFileSqlClient();
  const contentBase64 = Buffer.from(input.bytes).toString("base64");
  await sql`
    INSERT INTO into_temp_invoice_files (
      storage_key,
      original_file_name,
      stored_file_name,
      file_type,
      file_size,
      checksum,
      content_base64
    )
    VALUES (
      ${input.storageKey},
      ${input.originalFileName},
      ${input.storedFileName},
      ${input.fileType},
      ${input.fileSize},
      ${input.checksum},
      ${contentBase64}
    )
    ON CONFLICT (storage_key)
    DO UPDATE SET
      original_file_name = EXCLUDED.original_file_name,
      stored_file_name = EXCLUDED.stored_file_name,
      file_type = EXCLUDED.file_type,
      file_size = EXCLUDED.file_size,
      checksum = EXCLUDED.checksum,
      content_base64 = EXCLUDED.content_base64
  `;
}

export async function loadPostgresTemporaryInvoiceFile(storageKey: string) {
  const sql = await invoiceFileSqlClient();
  const rows = await sql`
    SELECT
      original_file_name,
      stored_file_name,
      file_type,
      file_size,
      checksum,
      content_base64
    FROM into_temp_invoice_files
    WHERE storage_key = ${storageKey}
    LIMIT 1
  `;
  const row = rows[0] as
    | {
        original_file_name: string;
        stored_file_name: string;
        file_type: string;
        file_size: string | number;
        checksum: string;
        content_base64: string;
      }
    | undefined;

  if (!row) {
    return null;
  }

  return {
    storageKey,
    originalFileName: row.original_file_name,
    storedFileName: row.stored_file_name,
    fileType: row.file_type,
    fileSize: Number(row.file_size),
    checksum: row.checksum,
    bytes: new Uint8Array(Buffer.from(row.content_base64, "base64")),
  };
}

export async function deletePostgresTemporaryInvoiceFile(storageKey: string) {
  const sql = await invoiceFileSqlClient();
  const rows = await sql`
    DELETE FROM into_temp_invoice_files
    WHERE storage_key = ${storageKey}
    RETURNING storage_key
  `;
  return rows.length > 0;
}

export async function loadStoreSnapshot() {
  if (!isPostgresPersistenceEnabled()) {
    return null;
  }

  const sql = await sqlClient();
  const rows = await sql`
    SELECT payload, revision
    FROM into_runtime_store
    WHERE id = ${snapshotId}
    LIMIT 1
  `;

  if (!rows[0]?.payload) {
    return null;
  }
  const store = rows[0].payload as VersionedStore;
  store.schemaVersion ??= 1;
  store.revision = Number(rows[0].revision ?? store.revision ?? 0);
  return migrateStoreSnapshot(store);
}

export async function loadStoreRevision() {
  if (!isPostgresPersistenceEnabled()) {
    return null;
  }

  const sql = await sqlClient();
  const rows = await sql`
    SELECT revision
    FROM into_runtime_store
    WHERE id = ${snapshotId}
    LIMIT 1
  `;
  return rows[0] ? Number(rows[0].revision) : null;
}

export async function saveStoreSnapshot(store: IntoStore) {
  if (!isPostgresPersistenceEnabled()) {
    return;
  }

  const sql = await sqlClient();
  Object.assign(store, migrateStoreSnapshot(store));
  const versioned = store as VersionedStore;
  const expectedRevision = versioned.revision ?? 0;
  const nextRevision = expectedRevision + 1;
  const nextStore = {
    ...versioned,
    schemaVersion: CURRENT_SNAPSHOT_SCHEMA_VERSION,
    revision: nextRevision,
  };
  const rows =
    expectedRevision === 0
      ? await sql`
          INSERT INTO into_runtime_store (id, payload, revision, updated_at)
          VALUES (
            ${snapshotId},
            ${JSON.stringify(nextStore)}::jsonb,
            ${nextRevision},
            now()
          )
          ON CONFLICT (id) DO UPDATE SET
            payload = EXCLUDED.payload,
            revision = EXCLUDED.revision,
            updated_at = now()
          WHERE into_runtime_store.revision = ${expectedRevision}
          RETURNING revision
        `
      : await sql`
          UPDATE into_runtime_store SET
            payload = ${JSON.stringify(nextStore)}::jsonb,
            revision = ${nextRevision},
            updated_at = now()
          WHERE id = ${snapshotId} AND revision = ${expectedRevision}
          RETURNING revision
        `;
  if (!rows.length) {
    throw new SnapshotRevisionConflictError(
      "INTO data changed in another request. Reload and try again."
    );
  }
  versioned.schemaVersion = CURRENT_SNAPSHOT_SCHEMA_VERSION;
  versioned.revision = nextRevision;
}
