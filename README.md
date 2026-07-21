# INTO

INTO is a local-first invoice booking automation tool for bulk invoice intake,
validation, review, and Exact Online booking. The current implementation uses
mock OCR while keeping extraction, Exact Online, database, and file storage
concerns isolated behind service modules. Exact Online can run in mock mode or
real OAuth mode for the shared company account.

## Structure

- `app/api/invoices` handles bulk upload, extraction, validation, review saves,
  single booking, and bulk booking.
- `app/api/exact` contains the Exact Online OAuth and connection surface.
- `components/into-workbench.tsx` is the product workbench UI.
- `lib/services` separates extraction, validation, storage, Exact Online, and
  booking logic.
- `lib/repository/invoice-store.ts` is the runtime repository. Local requests
  hydrate and flush it through the SQLite snapshot adapter in
  `lib/repository/sqlite-store.ts`; optional Vercel deployments can use the
  PostgreSQL adapter in `lib/repository/postgres-store.ts`.
- `db/schema.ts` defines the Sites/D1 schema, and `db/postgres-schema.sql`
  mirrors a production PostgreSQL schema.

## Environment

Copy `.env.example` to `.env.local` for local development and fill in real
values. Exact Online credentials are read on the server and are not hard-coded.

INTO includes a readiness panel backed by `/api/setup/status`. The UI shows
simple user-facing readiness items for the shared Exact connection, invoice
upload, review queue, Exact master data sync, and booking. It does not show
normal users database, storage, migration, internal API, or raw environment
variable checklist items.

Local mode uses SQLite for durable metadata and the local filesystem for the
original invoice while it is being processed, previewed, reviewed, and attached
to Exact Online. After a successful Exact booking and attachment upload, INTO
deletes the local invoice file and keeps its metadata, booking status, Exact
reference, and audit history.

```bash
DATABASE_MODE=sqlite
LOCAL_DATABASE_PATH=data/into.sqlite
STORAGE_MODE=local
TEMP_INVOICE_STORAGE_PATH=storage/invoices
TEMP_INVOICE_RETENTION_DAYS=30
```

SQLite, PostgreSQL, and S3 are not all required: a dedicated local INTO server
needs only SQLite and local storage. Keep that machine running and backed up.
If booking fails or an invoice still needs review, INTO keeps the local file so
users can preview and retry it.

### Real Exact Online connection

INTO uses Exact Online OAuth. It must never ask for or store an Exact username
or password. The system owner configures one shared Exact OAuth app, then users
authenticate on Exact Online's official OAuth page.

1. Create or open the Exact Online OAuth app for INTO.
2. Register the callback URL that matches where INTO is running:

```text
Local:  https://your-public-local-url/api/exact/callback
Vercel: https://your-vercel-domain/api/exact/callback
```

Exact requires a secure callback. For local operation, expose only the INTO
server through a trusted HTTPS tunnel/reverse proxy and forward it to
`http://localhost:3000`. Set `APP_URL` and `EXACT_ONLINE_REDIRECT_URI` to that
same public HTTPS origin while connecting Exact.

3. Put the required values in the right place:

- Local development: `.env` or `.env.local`
- Vercel: Project Settings > Environment Variables, then redeploy

```bash
EXACT_ONLINE_MODE=real
EXACT_ONLINE_CLIENT_ID=your_exact_oauth_app_client_id
EXACT_ONLINE_CLIENT_SECRET=your_exact_oauth_app_client_secret
EXACT_ONLINE_REDIRECT_URI=http://localhost:3000/api/exact/callback
EXACT_ONLINE_BASE_URL=https://start.exactonline.nl
OAUTH_TOKEN_ENCRYPTION_KEY=use-a-long-random-secret
OAUTH_STATE_SECRET=use-another-long-random-secret
EXACT_ONLINE_ENABLE_REAL_BOOKING=false
```

`EXACT_ONLINE_CLIENT_ID` must be the Exact OAuth app Client ID, not a user email
address. `EXACT_ONLINE_CLIENT_SECRET` must be the app secret from Exact.

4. Restart the local server (or redeploy Vercel), unlock INTO, and click
   `Connect Company Exact`.
5. After the connection succeeds, click `Sync Exact Data Now` to load suppliers,
   payment conditions, journals, G/L accounts, cost centers, cost units, VAT
   codes, and available historical purchase data from Exact.

In real mode, INTO exchanges the OAuth code, encrypts the access and refresh
tokens for the company Exact account, refreshes tokens when needed, discovers
the current division, and syncs Exact master data. Exact remains the source of
truth.

INTO is read-only for Exact master data. It may fetch and cache suppliers,
payment conditions, journals, G/L accounts, cost centers, cost units, and VAT
codes, but it must never create, update, patch, merge, or delete those records
in Exact. The Exact API client includes a hard guard that blocks non-read
requests to those master-data resources before a network request can be sent.

Real purchase-entry posting is intentionally guarded. INTO verifies the Exact
document type, creates a purchase-invoice document, uploads the original file,
and only then creates the purchase entry linked to that document. Keep
`EXACT_ONLINE_ENABLE_REAL_BOOKING=false` until one controlled invoice has been
reviewed against your Exact company. Then set it to `true` and restart INTO.
If the attachment upload fails, no purchase entry is sent and the local file is
kept for retry.

## Development

```bash
npm install
npm run dev
```

Run validation tests:

```bash
npm test
```

Generate D1 migrations after schema changes:

```bash
npm run db:generate
```

## Optional Vercel Deployment

Vercel is optional. It provides a stable HTTPS domain, but it is not required
for a dedicated local INTO installation. The repository includes:

- `vercel.json`
- `.vercelignore`
- `npm run build:vercel`

Deploy the project in Vercel and set environment variables in Vercel Project
Settings. Register these callback paths with the OAuth providers:

```text
https://your-vercel-domain/api/exact/callback
```

See `docs/VERCEL_DEPLOYMENT.md` and `docs/OAUTH_SETUP.md` for the full setup.

## Supplier learning rollout

Supplier learning, its UI, document intelligence, and supplier resolution V2
have independent server-side feature flags. Production defaults keep new
behavior off and shadow comparison on. Learning artifacts use a dedicated
`LEARNING_ARTIFACT_ENCRYPTION_KEY`; do not reuse the OAuth encryption key.

Managed document analysis is optional and disabled by default. Configure its
endpoint and API key only after privacy, residency, and cost approval. Local
embedded-PDF, XML, and text extraction remains the fallback.

A Vercel deployment must use shared durable metadata and file storage because
its local filesystem is ephemeral; the local-first setup above does not have
that limitation.
