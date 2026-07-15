# INTO Local-First Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make INTO persist its complete state in local SQLite, keep original invoices in durable local filesystem storage, preserve preview/download across restarts, and support guarded Exact Online OAuth, master-data sync, document attachment, and purchase-entry posting.

**Architecture:** Preserve the existing `IntoStore` repository API and replace its provider-specific PostgreSQL hydration with a small persistence selector. Local mode serializes the full store into one SQLite row using Node's built-in `node:sqlite`; local invoice files remain original bytes under `storage/invoices`. Existing hosted PostgreSQL behavior remains available explicitly. Exact posting creates a document and attachment before posting a purchase entry that references the document.

**Tech Stack:** Next.js 16, TypeScript 5.9, Node `node:sqlite`, local filesystem, Exact Online REST/OAuth APIs, Node test runner.

## Global Constraints

- Default local database: `DATABASE_MODE=sqlite`, `LOCAL_DATABASE_PATH=data/into.sqlite`.
- Default local storage: `STORAGE_MODE=local`, `LOCAL_INVOICE_STORAGE_PATH=storage/invoices`.
- No Vercel, PostgreSQL, S3, Outlook, or Microsoft requirement for local operation.
- Do not edit `.env` or `.env.local`.
- Never expose or log Exact client secrets, access tokens, refresh tokens, passwords, or attachment bytes.
- Keep Exact master data read-only.
- Keep `EXACT_ONLINE_ENABLE_REAL_BOOKING=false` until the controlled live-company test.
- Do not delete a local invoice until Exact attachment upload and purchase-entry creation both succeed.
- Existing Vercel environment variables remain unchanged.

---

### Task 1: SQLite Snapshot Repository

**Files:**
- Create: `lib/repository/sqlite-store.ts`
- Modify: `lib/repository/invoice-store.ts`
- Modify: `lib/repository/persistent-request.ts`
- Test: `tests/sqlite-store.test.ts`

**Interfaces:**
- Produces: `databaseMode(): "sqlite" | "postgres" | "memory"`
- Produces: `sqliteDatabasePath(): string`
- Produces: `loadSqliteStoreSnapshot(): IntoStore | null`
- Produces: `saveSqliteStoreSnapshot(store: IntoStore): void`
- Produces: `closeSqliteStore(): void`
- Produces: `hydrateStoreFromPersistence()` and `flushStoreToPersistence()`

- [ ] **Step 1: Write failing SQLite persistence tests**

Create tests that set a unique temporary `LOCAL_DATABASE_PATH`, save a store containing one invoice, audit event, encrypted-looking Exact connection, master-data cache, duplicate log, and booking attempt, close SQLite, reopen it, and assert deep equality. Also assert the database file exists and `DATABASE_URL` is unnecessary.

```ts
test("persists the complete INTO store across SQLite close and reopen", () => {
  process.env.DATABASE_MODE = "sqlite";
  process.env.LOCAL_DATABASE_PATH = databasePath;
  saveSqliteStoreSnapshot(expected);
  closeSqliteStore();
  assert.deepEqual(loadSqliteStoreSnapshot(), expected);
});
```

- [ ] **Step 2: Run the targeted test and verify RED**

Run: `npm test -- tests/sqlite-store.test.ts`

Expected: FAIL because `sqlite-store.ts` does not exist.

- [ ] **Step 3: Implement the minimal SQLite store**

Use `DatabaseSync` from `node:sqlite`, resolve relative paths from `process.cwd()`, recursively create the parent directory, and initialize:

```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS into_runtime_store (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Store the `company` snapshot with one parameterized UPSERT. Parse and return `payload` on load. Cache one `DatabaseSync` per resolved path and close it through `closeSqliteStore()`.

- [ ] **Step 4: Select persistence at the existing request boundary**

Replace PostgreSQL-specific hydration names with generic persistence names. Selection rules:

```ts
DATABASE_MODE=memory   -> no persistence
DATABASE_MODE=postgres -> existing PostgreSQL snapshot
DATABASE_MODE=sqlite   -> SQLite snapshot
unset + Vercel         -> PostgreSQL when DATABASE_URL exists, otherwise memory
unset + non-Vercel     -> SQLite
```

`withPersistentStore()` must hydrate before the handler and flush after it. Preserve the existing public repository API used by all routes.

- [ ] **Step 5: Run tests and verify GREEN**

Run: `npm test -- tests/sqlite-store.test.ts`

Expected: PASS and the temporary SQLite database survives close/reopen.

---

### Task 2: Local Invoice Files and Upload Ordering

**Files:**
- Modify: `lib/services/storage-service.ts`
- Modify: `app/api/invoices/route.ts`
- Modify: `tests/storage-service.test.ts`
- Modify: `tests/invoice-file-route.test.ts`
- Modify: `tests/temp-invoice-file-lifecycle.test.ts`

**Interfaces:**
- Produces: `invoiceStorageProvider(): "local" | "postgres_temp"`
- Produces: `localInvoiceStoragePath(): string`
- Preserves: `storeInvoiceFile`, `getStoredInvoiceFile`, `deleteStoredInvoiceFile`

- [ ] **Step 1: Write failing local-storage tests**

Add tests for `STORAGE_MODE=local` and `LOCAL_INVOICE_STORAGE_PATH`. Assert files are written under the configured directory, their bytes/checksum/MIME type are unchanged, and reopening SQLite plus calling the file route still returns the original PDF/JPG/PNG/XML/UBL bytes and download disposition.

Add a test proving an unsupported extension creates neither a file nor an invoice record.

- [ ] **Step 2: Run targeted tests and verify RED**

Run: `npm test -- tests/storage-service.test.ts tests/invoice-file-route.test.ts tests/temp-invoice-file-lifecycle.test.ts`

Expected: FAIL because `STORAGE_MODE=local` and `LOCAL_INVOICE_STORAGE_PATH` are not active and unsupported files are currently stored before rejection.

- [ ] **Step 3: Implement local provider selection and stable paths**

Use `LOCAL_INVOICE_STORAGE_PATH`, default `storage/invoices`. Retain `TEMP_INVOICE_STORAGE_PATH` only as a backwards-compatible fallback for existing tests/configuration. Generate storage filenames with `createId("file")` plus a sanitized original filename. Never route local mode through `tmpdir()`.

When Vercel is detected with local storage, reject uploads with the system-owner-safe durability message. Keep explicit `postgres_temp` support for hosted mode.

- [ ] **Step 4: Validate before writing**

Move `isSupportedInvoiceFile(file.name)` before `storeInvoiceFile(file)` in the upload route. Return the existing clear rejection without creating an invoice or orphan file.

- [ ] **Step 5: Verify preview, download, and lifecycle GREEN**

Run the targeted tests again. Expected: PASS for original PDF/JPG/PNG/XML/UBL bytes, download, failed-booking retention, and post-success deletion.

---

### Task 3: Local Setup Status and Documentation

**Files:**
- Modify: `lib/services/setup-status-service.ts`
- Modify: `tests/setup-status.test.ts`
- Modify: `.env.example`
- Verify/modify: `.gitignore`
- Create: `docs/LOCAL_SETUP.md`

**Interfaces:**
- Consumes: `databaseMode`, `sqliteDatabasePath`, `invoiceStorageProvider`, `localInvoiceStoragePath`
- Produces user-safe setup messages without secret values

- [ ] **Step 1: Write failing setup-status tests**

Assert that local SQLite/local storage reports:

```text
Local SQLite database is ready.
Local invoice storage is ready.
```

Assert no local status contains `DATABASE_URL`, `S3_`, `Outlook`, or `Microsoft`. Assert Vercel plus local storage reports the system-owner durability warning.

- [ ] **Step 2: Run setup tests and verify RED**

Run: `npm test -- tests/setup-status.test.ts`

Expected: FAIL on current production-database and temporary-storage wording.

- [ ] **Step 3: Implement local readiness checks**

Check SQLite by opening the configured database and performing a harmless snapshot-table query. Check local storage using the existing write/read/delete readiness probe. Do not expose absolute paths or raw errors to normal users.

- [ ] **Step 4: Update safe configuration examples**

Make `.env.example` local-first and include the exact variables from the approved design with blank secret values. Keep `.gitignore` entries for `data/`, `storage/`, SQLite sidecars, and all `.env*` except `.env.example`.

- [ ] **Step 5: Write local setup instructions**

Document install, `.env.local`, `npm run dev`, HTTPS tunnel callback registration, upload/preview, Exact connection, master-data sync, one controlled booking, and disabling real booking afterward. Explicitly state that Vercel variables are not automatically available locally.

- [ ] **Step 6: Run setup tests and verify GREEN**

Run: `npm test -- tests/setup-status.test.ts`

Expected: PASS.

---

### Task 4: Persist Local Exact OAuth and Master Data

**Files:**
- Modify: `tests/exact-oauth-flow.test.ts`
- Modify only if tests expose a defect: `lib/services/exact-api-client.ts`
- Modify only if tests expose a defect: `lib/repository/invoice-store.ts`

**Interfaces:**
- Preserves: state signing, code exchange, encrypted token storage, token refresh, division lookup, master-data sync
- Adds no browser-visible secrets

- [ ] **Step 1: Write a failing SQLite OAuth persistence test**

Perform the existing mocked authorization-code flow with `DATABASE_MODE=sqlite`, flush the store, close/reopen SQLite, clear the runtime copy, hydrate, and assert:

- access/refresh values remain ciphertext in the store
- decryption returns the mocked token only on the server
- division and all master-data collections remain available
- refreshed token ciphertext persists after another close/reopen

- [ ] **Step 2: Run the Exact OAuth test and verify RED**

Run: `npm test -- tests/exact-oauth-flow.test.ts`

Expected: FAIL until generic SQLite hydration is connected to Exact mutations.

- [ ] **Step 3: Make only persistence fixes required by the test**

Ensure `setExactConnection`, token refresh, and `syncExactDataNow` schedule persistence and `withPersistentStore()` flushes it. Do not alter OAuth credentials, state validation, or read-only master-data guards.

- [ ] **Step 4: Run the test and verify GREEN**

Run: `npm test -- tests/exact-oauth-flow.test.ts`

Expected: PASS with no token/client-secret text in route responses.

---

### Task 5: Guarded Exact Document Attachment and Purchase Entry

**Files:**
- Modify: `lib/domain/invoice.ts`
- Modify: `lib/services/exact-api-client.ts`
- Modify: `app/api/invoices/[invoiceId]/book/route.ts`
- Create: `tests/exact-booking.test.ts`

**Interfaces:**
- Produces: `buildExactPurchaseEntryPayload(invoice, masterData, documentId)`
- Produces: `createRealExactPurchaseBooking(connection, invoice, masterData)`
- Produces: safe booking-stage metadata for failed attempts

- [ ] **Step 1: Write failing payload contract tests**

Using mocked Exact HTTP responses, assert this sequence:

1. `GET /documents/DocumentTypes?$filter=ID eq 55`
2. `POST /documents/Documents`
3. `POST /documents/DocumentAttachments`
4. `POST /purchaseentry/PurchaseEntries`

The document payload must contain `Subject`, `Type`, `Account`, `DocumentDate`, `AmountFC`, and `Currency`. Attachment payload must contain base64 `Attachment`, `Document`, and the original `FileName`.

Purchase-entry payload must contain:

```ts
{
  Journal,
  Supplier,
  EntryDate,
  DueDate,
  Description,
  PaymentCondition,
  YourRef,
  Currency,
  Document,
  PurchaseEntryLines: [{
    GLAccount,
    Description,
    AmountFC,
    VATCode,
    VATAmountFC,
    CostCenter,
    CostUnit,
    From,
    To
  }]
}
```

Look up `GLAccount` GUIDs from synced Exact master data while preserving account codes in the UI. Assert VAT codes outside 4-8 are rejected before any POST.

- [ ] **Step 2: Write failing booking-stage tests**

Assert:

- disabled flag performs no POST
- missing local file performs no POST
- attachment failure performs no purchase-entry POST and keeps the file
- purchase-entry failure stores safe Exact document metadata and keeps the file
- retry reuses the prior attached document
- full success returns Exact entry/document/attachment IDs
- no request or thrown error exposes OAuth tokens

- [ ] **Step 3: Run Exact booking tests and verify RED**

Run: `npm test -- tests/exact-booking.test.ts`

Expected: FAIL because the real posting adapter currently throws “not implemented.”

- [ ] **Step 4: Preserve Exact identifiers needed for posting**

Add an optional `id` to `ExactGlAccount` and map Exact's `ID` during master-data sync. In real mode, reject a selected G/L account whose GUID is unavailable rather than sending its code as a GUID.

- [ ] **Step 5: Implement a minimal authenticated POST helper**

Reuse decrypted access tokens server-side. Send JSON with `Accept` and `Content-Type`, parse Exact OData entity responses, cap provider error details, and call the existing master-data write guard so only document, attachment, and purchase-entry resources are writable.

- [ ] **Step 6: Implement document and attachment creation**

Use `EXACT_ONLINE_PURCHASE_DOCUMENT_TYPE`, default `55`. Verify the type exists and `DocumentIsCreatable` is true. Create the document, upload original bytes as base64, and capture returned IDs. Do not log or persist attachment bytes.

- [ ] **Step 7: Implement purchase-entry creation**

Build dates as Exact-compatible midnight ISO values. Include only optional line fields that have values. POST the nested lines with header. Parse `EntryID` as the Exact booking reference.

- [ ] **Step 8: Preserve safe retry metadata**

When purchase-entry creation fails after attachment success, attach this safe payload to the failed booking attempt:

```ts
{ stage: "purchase_entry", exactDocumentId, exactAttachmentId, attachmentUploaded: true }
```

On retry, reuse that document. The route must never mark Booked or delete the file until a purchase entry succeeds.

- [ ] **Step 9: Run Exact booking tests and verify GREEN**

Run: `npm test -- tests/exact-booking.test.ts tests/exact-master-data-readonly.test.ts`

Expected: PASS.

---

### Task 6: End-to-End Local Restart Verification

**Files:**
- Create: `tests/local-first-restart.test.ts`
- Modify only if defects are found: active upload/file routes and persistence boundary

**Interfaces:**
- Consumes the real upload, SQLite, preview, download, and audit paths

- [ ] **Step 1: Write a failing restart integration test**

Use unique temporary database/storage paths. Upload a PDF and PNG through the active route, flush and close SQLite, clear the runtime store, hydrate from SQLite, list invoices, preview both files, and download the PDF. Assert metadata, audit events, checksums, and bytes survive.

- [ ] **Step 2: Run the integration test and verify RED or GREEN**

Run: `npm test -- tests/local-first-restart.test.ts`

If RED, fix only the demonstrated persistence boundary defect. If already GREEN, no production change is needed.

- [ ] **Step 3: Verify failed booking retention**

Add a failed Exact response, restart, and assert the invoice remains retryable and its original file remains available.

- [ ] **Step 4: Run the integration test and verify GREEN**

Expected: PASS.

---

### Task 7: Full Verification and Local Smoke Test

**Files:**
- No planned production edits; fix only failures caused by this work.

- [ ] **Step 1: Run all automated tests**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 2: Run static checks**

Run: `npm run typecheck`

Run: `npm run lint`

Expected: zero errors. Existing unrelated warnings must be reported rather than silently changed.

- [ ] **Step 3: Run production build**

Run: `npm run build`

Expected: successful Next.js production build.

- [ ] **Step 4: Run local browser smoke test**

Start `npm run dev` without modifying `.env.local`. Upload a PDF and image fixture, confirm files appear under the configured local storage path, preview/download them, restart the process, and verify the same records and files remain.

- [ ] **Step 5: Report the manual live-company steps**

Do not enable or perform the live booking without the system owner's local Exact credentials and explicit controlled invoice. Report the callback setup, connection, sync, flag enablement, one-invoice booking, Exact verification, and flag disablement steps.

## Commit Note

The current Windows ACL denies creation of `.git/index.lock` from the Codex process. Keep implementation changes in the working tree and report this limitation; do not modify Git ACLs and do not push.

