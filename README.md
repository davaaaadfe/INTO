# INTO

INTO is an invoice booking automation tool for bulk invoice intake, validation,
review, and Exact Online booking. The current implementation uses mock OCR while
keeping extraction, Exact Online, database, and temporary file storage concerns
isolated behind service modules. Exact Online can run in mock mode or real OAuth
mode for the shared company account.

## Structure

- `app/api/invoices` handles bulk upload, extraction, validation, review saves,
  single booking, and bulk booking.
- `app/api/exact` contains the Exact Online OAuth and connection surface.
- `components/into-workbench.tsx` is the product workbench UI.
- `lib/services` separates extraction, validation, storage, Exact Online, and
  booking logic.
- `lib/repository/invoice-store.ts` is the local/mock repository used during
  development and tests. In Vercel production, API routes hydrate and flush this
  state through a PostgreSQL JSONB snapshot bridge in
  `lib/repository/postgres-store.ts` while the normalized repository is completed.
- `db/schema.ts` defines the Sites/D1 schema, and `db/postgres-schema.sql`
  mirrors a production PostgreSQL schema.

## Environment

Copy `.env.example` to `.env` for local development and fill in real values
when replacing the mock adapters. Exact Online credentials are read from
environment variables and are not hard-coded.

INTO includes a readiness panel backed by `/api/setup/status`. The UI shows
simple user-facing readiness items for the shared Exact connection, invoice
upload, review queue, Exact master data sync, and booking. It does not show
normal users database, storage, migration, internal API, or raw environment
variable checklist items.

For Vercel production, configure durable records. Invoice files use temporary
local storage by default while they are being processed, previewed, reviewed,
and attached to Exact Online. After a successful Exact booking, INTO deletes the
local invoice file and keeps invoice metadata, booking status, Exact reference,
and audit history.

```bash
DATABASE_URL=your_postgres_connection_string
STORAGE_MODE=local_temp
TEMP_INVOICE_STORAGE_PATH=storage/tmp-invoices
TEMP_INVOICE_RETENTION_DAYS=30
```

Temporary local storage on Vercel is suitable only for short-lived processing;
files may not survive redeploys. This is acceptable only when invoices are
processed and booked quickly. If booking fails or an invoice still needs review,
INTO keeps the local file so users can preview and retry it.

### Real Exact Online connection

INTO uses Exact Online OAuth. It must never ask for or store an Exact username
or password. The system owner configures one shared Exact OAuth app, then users
authenticate on Exact Online's official OAuth page.

1. Create or open the Exact Online OAuth app for INTO.
2. Register the callback URL that matches where INTO is running:

```text
Local:  http://localhost:3000/api/exact/callback
Vercel: https://your-vercel-domain/api/exact/callback
```

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

4. Restart the dev server or redeploy Vercel, sign in as the system owner, and
   click `Connect Company Exact`.
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

Real purchase-entry posting is intentionally guarded. Keep
`EXACT_ONLINE_ENABLE_REAL_BOOKING=false` until the Exact purchase-entry payload
has been validated against your Exact division.

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

## Vercel Deployment

Vercel is the default deployment target for OAuth integrations because it gives
the app a stable HTTPS domain without ngrok. The repository includes:

- `vercel.json`
- `.vercelignore`
- `npm run build:vercel`

Deploy the project in Vercel and set environment variables in Vercel Project
Settings. Register these callback paths with the OAuth providers:

```text
https://your-vercel-domain/api/exact/callback
```

See `docs/VERCEL_DEPLOYMENT.md` and `docs/OAUTH_SETUP.md` for the full setup.

## Sites Deployment

This project keeps `.openai/hosting.json` configured for the older Sites
packaging flow, but the Vercel app now defaults to local temporary invoice file
storage. Vercel production still needs durable metadata storage through
PostgreSQL.
