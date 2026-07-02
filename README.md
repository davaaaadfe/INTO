# INTO

INTO is an invoice booking automation tool for bulk invoice intake, validation,
review, and Exact Online booking. The current implementation uses mock OCR and
mock Outlook ingestion while keeping those integration points isolated behind
service modules. Exact Online can run in mock mode or real OAuth/master-data sync
mode.

## Structure

- `app/api/invoices` handles bulk upload, extraction, validation, review saves,
  single booking, and bulk booking.
- `app/api/exact` contains the Exact Online OAuth and connection surface.
- `app/api/outlook` contains Outlook connection and invoice email ingestion.
- `components/into-workbench.tsx` is the product workbench UI.
- `lib/services` separates extraction, validation, storage, Exact Online, and
  Outlook logic.
- `lib/repository/invoice-store.ts` is an in-memory mock repository for local
  development.
- `db/schema.ts` defines the Sites/D1 schema, and `db/postgres-schema.sql`
  mirrors a production PostgreSQL schema.

## Environment

Copy `.env.example` to `.env` for local development and fill in real values
when replacing the mock adapters. Exact Online and Microsoft credentials are
read from environment variables and are not hard-coded.

INTO includes a readiness panel backed by `/api/setup/status`. The UI shows
simple user-facing readiness items for the shared Exact connection, shared
Outlook mailbox, invoice upload, review queue, Exact master data sync, and
booking. It does not show normal users database, storage, migration, internal
API, or raw environment variable checklist items. `DATABASE_URL` is optional; in
database-free mode, INTO treats Exact Online as the durable booking record and
checks Exact for duplicate invoice reference plus amount before booking.

### Real Exact Online connection

1. Create or open your Exact Online app registration.
2. Add this redirect URI:

```text
http://localhost:3000/api/exact/callback
```

3. Put the credentials in `.env`:

```bash
EXACT_ONLINE_MODE=real
EXACT_ONLINE_CLIENT_ID=your_exact_client_id
EXACT_ONLINE_CLIENT_SECRET=your_exact_client_secret
EXACT_ONLINE_REDIRECT_URI=http://localhost:3000/api/exact/callback
EXACT_ONLINE_BASE_URL=https://start.exactonline.nl
EXACT_TOKEN_ENCRYPTION_KEY=use-a-long-random-secret
EXACT_OAUTH_STATE_SECRET=use-another-long-random-secret
EXACT_ONLINE_ENABLE_REAL_BOOKING=false
```

4. Restart the dev server, sign in as the system owner, and click `Connect Company Exact`.

In real mode, INTO exchanges the OAuth code, encrypts the access and refresh
tokens for the company Exact account, discovers the current division, and syncs suppliers, payment
conditions, journals, G/L accounts, cost centers, cost units, VAT codes, and
available historical purchase data from Exact. Exact remains the source of
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
https://your-vercel-domain/api/outlook/callback
```

See `docs/VERCEL_DEPLOYMENT.md` and `docs/OAUTH_SETUP.md` for the full setup.

## Sites Deployment

This project keeps `.openai/hosting.json` configured with logical `DB` and
`INVOICE_FILES` bindings so Sites can attach database and file storage resources
when the source is saved and deployed. The database binding is optional for the
Vercel database-free setup.
