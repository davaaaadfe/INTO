# INTO Vercel Deployment

INTO can be deployed to Vercel without ngrok. Localhost remains supported for
development, and ngrok is only optional when a provider requires testing against
a public temporary URL.

## 1. Deploy to Vercel

1. Push the repository to GitHub, GitLab, or Bitbucket.
2. In Vercel, create a new project from that repository.
3. Vercel will read `vercel.json`.
4. Build command: `npm run build:vercel`.
5. Framework preset: Next.js.

## 2. Required Environment Variables

Set these in Vercel Project Settings -> Environment Variables.

```text
AUTH_MODE=dual
INTO_ACCESS_PASSWORD=
INTO_INVITATION_SECRET=
INTO_TRUSTED_ORIGINS=https://your-vercel-domain.vercel.app

EXACT_ONLINE_MODE=real
EXACT_ONLINE_CLIENT_ID=
EXACT_ONLINE_CLIENT_SECRET=
EXACT_ONLINE_REDIRECT_URI=https://your-vercel-domain.vercel.app/api/exact/callback
EXACT_ONLINE_ENABLE_REAL_BOOKING=false

OAUTH_TOKEN_ENCRYPTION_KEY=
OAUTH_STATE_SECRET=
LEARNING_ARTIFACT_ENCRYPTION_KEY=

LEARNING_V2_ENABLED=false
LEARN_WORKFLOW_ENABLED=false
LEARNING_UI_ENABLED=false
SUPPLIER_RELIABILITY_ENABLED=false
SUPPLIER_DRIFT_ENABLED=false
SUPPLIER_RESOLUTION_V2_ENABLED=false
LEARNING_SHADOW_MODE=true
SUPPLIER_LEARNED_AUTO_SELECTION_ENABLED=false
SUPPLIER_LEARNED_AUTO_SELECTION_EVALUATION_APPROVED=false
SUPPLIER_LEARNED_AUTO_SELECTION_ALLOWLIST=
SUPPLIER_LEARNED_AUTO_SELECTION_PERCENTAGE=0
SUPPLIER_LEARNING_MODE=off
DOCUMENT_INTELLIGENCE_ENABLED=false

DATABASE_MODE=postgres
DATABASE_URL=your_managed_postgresql_connection_string
STORAGE_MODE=postgres
TEMP_INVOICE_RETENTION_DAYS=30
INTO_STORAGE_CLEANUP_TOKEN=
CRON_SECRET=
```

Keep `AUTH_MODE=dual` only for the verified-user bootstrap window. After two
active verified users can sign in and recovery has been rehearsed, change it to
`verified_user`, redeploy, and retire the shared password. Missing or invalid
production `AUTH_MODE` fails closed to verified-user authentication.

Before deploying an application version with newer database schemas, back up
the production database and run this one-shot command with the production
`DATABASE_URL` available locally:

```text
npm run db:migrate:postgres
```

The command migrates and verifies the auth, supplier-learning, runtime-store,
and temporary-invoice-file schemas. Production requests verify auth and
learning schema versions but do not run those migrations.

If managed document analysis is approved, also configure
`AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT`,
`AZURE_DOCUMENT_INTELLIGENCE_API_KEY`, and an optional
`AZURE_DOCUMENT_INTELLIGENCE_MODEL_ID`. Keep the API key server-side. Roll out
the learning, UI, resolver, and document-analysis flags independently after the
database migration and held-out evaluation pass.

`EXACT_ONLINE_REDIRECT_URI` can be omitted when Vercel provides
`VERCEL_PROJECT_PRODUCTION_URL` or `VERCEL_URL`; INTO will derive the callback
URL automatically. Setting it explicitly is still recommended when using a
custom domain.

`DATABASE_URL` is required on Vercel because serverless process memory and its
local filesystem are not durable. The PostgreSQL adapter stores metadata and
temporary invoice bytes until they are attached to Exact Online.

Set `INTO_STORAGE_CLEANUP_TOKEN` to a random secret of at least 32 characters,
then set `CRON_SECRET` to the exact same value. Vercel sends `CRON_SECRET` as a
Bearer token to the daily cleanup job defined in `vercel.json`.

## 3. Callback URLs

Production:

```text
https://into.yourcompany.com/api/exact/callback
```

Vercel preview or generated domain:

```text
https://your-project.vercel.app/api/exact/callback
```

Local server through a public HTTPS endpoint:

```text
https://your-public-local-url/api/exact/callback
```

Optional ngrok:

```text
https://your-ngrok-host.ngrok-free.app/api/exact/callback
```

For optional ngrok or any other external development host, set `APP_URL` or the
provider-specific redirect URI environment variable to that external host.

## 4. Startup Validation

INTO exposes `/api/setup/status` and shows a simple readiness panel in the UI
when something needed for invoice processing is not ready. The panel uses
runtime checks where possible and shows user-facing items only:

- Shared Exact Online connection
- Invoice upload
- Invoice review queue
- Exact master data sync
- Invoice booking

It does not show database, storage, migration, internal API, or raw environment
variable checklist items to normal users. It never returns client secrets,
tokens, encryption keys, or passwords.

## 5. Production Storage Notes

INTO defaults to SQLite plus local invoice storage when it runs on a dedicated
local server. Vercel must use the PostgreSQL modes shown above because its local
filesystem may disappear between requests or deployments. In either mode, an
invoice file is deleted only after the Exact booking and attachment succeed;
metadata and audit history remain.
