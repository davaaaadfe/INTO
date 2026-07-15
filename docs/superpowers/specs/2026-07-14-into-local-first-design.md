# INTO Local-First Design

## Objective

Make INTO run as a durable local application without requiring Vercel, PostgreSQL, S3, Outlook, or Microsoft services. The local app must keep invoice records in SQLite, keep original invoice files on the local filesystem, connect to Exact Online through OAuth, sync Exact master data, and book validated purchase invoices with their original attachment.

## Confirmed Decisions

- Local persistence uses one complete JSON snapshot stored in SQLite rather than mapping the current repository to many normalized tables.
- Original invoice files are stored unchanged on the local filesystem.
- Exact Online credentials already configured in Vercel remain unchanged. Local INTO uses a separate ignored `.env.local` and a separate encrypted OAuth connection record.
- The first real booking test will use the live Exact company because no test company is available.
- Real booking remains disabled by default and is enabled only for one controlled validation using `EXACT_ONLINE_ENABLE_REAL_BOOKING=true`.
- Outlook and Microsoft mailbox ingestion remain removed.

## Runtime Modes

### Local mode

Local mode is selected with:

```dotenv
DATABASE_MODE=sqlite
STORAGE_MODE=local
LOCAL_DATABASE_PATH=data/into.sqlite
LOCAL_INVOICE_STORAGE_PATH=storage/invoices
```

When these values are absent outside Vercel, INTO defaults to SQLite and local filesystem storage. `DATABASE_URL` and S3 settings are not required.

### Hosted mode

Existing PostgreSQL persistence remains available only when explicitly selected for a hosted deployment. Vercel must never treat local filesystem storage as durable. If Vercel is configured with `STORAGE_MODE=local`, the system-owner status reports that local files may disappear and blocks uploads rather than accepting files that later cannot be previewed.

## SQLite Persistence

Use Node's built-in `node:sqlite` API. The repository already requires Node `>=22.13.0`, which includes this API.

The database file is resolved relative to the project root unless `LOCAL_DATABASE_PATH` is absolute. INTO creates the parent directory automatically and opens the database with WAL mode and a busy timeout.

SQLite contains one runtime table:

```sql
CREATE TABLE IF NOT EXISTS into_runtime_store (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

The `company` row contains the complete serialized `IntoStore`. This includes:

- invoices and upload metadata
- extracted invoice data and line items
- validation status and validation errors
- duplicate detection and resolution history
- booking attempts and Exact booking references
- audit events
- correction-learning rules
- encrypted Exact OAuth connection data
- Exact master data cache and last-sync timestamps

`withPersistentStore()` selects the configured persistence provider, hydrates the runtime store before a request, and flushes it after the request. Tests and explicit memory mode may continue using the in-memory store, but normal local operation always persists to SQLite.

No raw OAuth token or client secret is stored in plaintext. Existing token encryption remains unchanged; SQLite stores only ciphertext.

## Local Invoice Files

`STORAGE_MODE=local` stores files under `LOCAL_INVOICE_STORAGE_PATH`, defaulting to `storage/invoices`.

For every accepted upload, INTO:

1. Validates that the extension is PDF, JPG, JPEG, PNG, XML, or UBL.
2. Reads the original bytes without transformation.
3. Calculates a SHA-256 checksum.
4. Creates a generated storage filename containing a unique ID and a sanitized original filename.
5. Creates the storage directory recursively.
6. Writes the original bytes once.
7. Saves the invoice ID, original filename, generated storage path, MIME type, byte size, and checksum in the SQLite snapshot.

The server-generated path is the only path accepted by preview, download, re-read, and booking operations. Browser-supplied paths are never trusted.

Files remain available while an invoice is uploaded, reading, invalid, under review, ready, or in a failed booking state. A file is deleted only after Exact confirms both the attachment and purchase booking, or after an explicit invoice cancellation/cleanup action. The invoice metadata and audit trail remain in SQLite after deletion.

## Preview and Download

The active preview and download route loads the invoice by ID from SQLite, then loads its original file from the stored local path. PDF and image responses preserve their original MIME types and bytes. XML and UBL are served as XML for readable browser display.

If the record or file is absent, the route returns plain text with status 404:

> Original invoice file could not be found. Please re-upload or re-read this invoice.

The server logs only the invoice ID, original filename, expected storage path, and local file status. It never returns raw JSON errors in the preview pane.

Old demo records that point to unavailable files remain marked `missing`. They do not affect new uploads and can be replaced by re-uploading the original invoice.

## Exact OAuth and Master Data

Local Exact configuration belongs in ignored `.env.local`:

```dotenv
EXACT_ONLINE_MODE=real
EXACT_ONLINE_CLIENT_ID=
EXACT_ONLINE_CLIENT_SECRET=
EXACT_ONLINE_REDIRECT_URI=https://public-https-host/api/exact/callback
OAUTH_TOKEN_ENCRYPTION_KEY=
OAUTH_STATE_SECRET=
EXACT_ONLINE_ENABLE_REAL_BOOKING=false
```

The Client ID is the Exact OAuth application Client ID, never an email address. INTO never asks for or stores an Exact username or password.

Exact requires a public HTTPS callback. The local server therefore uses either a temporary HTTPS tunnel or a company HTTPS domain pointing to the machine. The callback in `.env.local` must exactly match the callback registered in the Exact OAuth application.

The current state-signing, authorization-code exchange, token encryption, refresh-token rotation, and division lookup remain server-side. Refreshed encrypted tokens are flushed to SQLite before the request completes.

Master-data sync retrieves and caches:

- suppliers
- payment conditions
- purchase journals
- G/L accounts
- VAT codes
- cost centers
- cost units
- historical purchase bookings used for duplicate and suggestion logic

Exact remains the read-only source of truth for master data.

## Real Exact Booking

The existing repository has no real purchase-entry posting adapter. Implementation must add one behind `EXACT_ONLINE_ENABLE_REAL_BOOKING=true`.

The booking operation is staged to avoid creating an invoice booking without its required attachment:

1. Refresh the Exact token if necessary and persist the rotated encrypted token.
2. Validate all required booking fields, exact-cent totals, supported VAT codes, selected Exact master-data IDs, and duplicate supplier/reference history.
3. Load the original local file and verify its checksum.
4. Create the Exact document record for the supplier invoice.
5. Upload the original file as an Exact document attachment.
6. Post the purchase entry with the Exact document ID and validated booking lines.
7. Save the Exact entry ID/reference in SQLite and append a successful audit event.
8. Delete the local file and record `deleted_after_booking` only after steps 5 and 6 succeed.

If document creation or attachment upload fails, no purchase entry is posted and the local file remains. If attachment succeeds but purchase-entry creation fails, the failed booking attempt stores the Exact document ID so a retry can reuse it rather than create repeated documents. Provider responses are sanitized before persistence and logs never contain tokens, secrets, or attachment bytes.

Before enabling live posting, automated contract tests must verify the document, attachment, and purchase-entry requests against mocked Exact HTTP responses. The first live-company validation uses one controlled invoice and the per-invoice Book action. Bulk booking is not part of that validation.

## Setup Status

For local SQLite and local filesystem mode, system status reports:

- `Local SQLite database is ready.`
- `Local invoice storage is ready.`
- shared Exact connection status
- Exact master-data last-sync timestamp

It does not report missing `DATABASE_URL`, S3, Vercel, Outlook, or Microsoft configuration.

When running on Vercel with local storage, only the system-owner diagnostics show:

> Local file storage on Vercel is not durable. Run INTO locally or configure durable external storage.

Normal invoice users do not see infrastructure diagnostics.

## Configuration and Repository Hygiene

`.gitignore` must include:

```gitignore
data/
storage/
*.sqlite
*.sqlite-shm
*.sqlite-wal
.env*
!.env.example
```

The repository never commits invoice files, SQLite databases, OAuth secrets, or local environment files.

`.env.example` and local setup documentation describe local-first defaults and explain that Vercel environment variables do not automatically exist in the local process.

## Error Handling

- SQLite open/write errors block mutations and return a friendly local-database error.
- File-write failure prevents creation of an invoice record.
- If file storage succeeds but later processing fails, the invoice remains available for re-read and retry.
- Missing local files use the existing friendly preview message and a structured server log.
- Exact OAuth and sync failures retain the last valid encrypted connection/cache when safe.
- Exact booking failure records a failed attempt, retains the local file, and keeps the invoice retryable.
- Attachment failure never marks an invoice Booked.

## Verification

Automated tests must prove:

- SQLite creates `data/into.sqlite` and persists the complete store across close/reopen.
- Upload metadata, audit events, Exact connection ciphertext, master data, duplicates, and booking attempts survive hydration.
- PDF, JPG, PNG, XML, and UBL original bytes survive upload, restart, preview, and download.
- Unsupported files are rejected before any file or invoice record is created.
- Failed and unbooked invoices retain their files.
- Files are deleted only after attachment and booking success.
- Local setup status does not require PostgreSQL, S3, Vercel, Outlook, or Microsoft.
- Exact state validation, token exchange, encrypted persistence, refresh, and master-data sync still pass.
- Real booking builds the expected Exact document, attachment, and purchase-entry requests and never sends unsupported VAT codes.
- Exact attachment or posting failures remain retryable and do not delete the local file.

Final verification runs `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build`. A local smoke test uploads and previews a PDF and image, restarts INTO, confirms the records/files remain, and downloads the originals.

The live Exact smoke test cannot be automated without the company account. The system owner completes OAuth login, runs Sync Exact master data, reviews one controlled invoice, enables real booking, books that invoice, confirms its attachment and Exact reference, then disables the flag again until the result is reviewed.

