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
EXACT_ONLINE_CLIENT_ID=
EXACT_ONLINE_CLIENT_SECRET=
EXACT_ONLINE_REDIRECT_URI=https://your-vercel-domain.vercel.app/api/exact/callback

OAUTH_TOKEN_ENCRYPTION_KEY=
OAUTH_STATE_SECRET=

STORAGE_MODE=local_temp
TEMP_INVOICE_STORAGE_PATH=storage/tmp-invoices
TEMP_INVOICE_RETENTION_DAYS=30
```

`EXACT_ONLINE_REDIRECT_URI` can be omitted when Vercel provides
`VERCEL_PROJECT_PRODUCTION_URL` or `VERCEL_URL`; INTO will derive the callback
URL automatically. Setting it explicitly is still recommended when using a
custom domain.

`DATABASE_URL` is recommended for durable INTO metadata and audit history.
Invoice files are stored only temporarily while they are processed, reviewed,
and attached to Exact Online.

## 3. Callback URLs

Production:

```text
https://into.yourcompany.com/api/exact/callback
```

Vercel preview or generated domain:

```text
https://your-project.vercel.app/api/exact/callback
```

Local development:

```text
http://localhost:3000/api/exact/callback
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

INTO defaults to temporary local invoice file storage. Uploaded files are kept
only while an invoice is being processed, previewed, reviewed, or retried. After
a successful Exact Online booking with an Exact reference, INTO deletes the
local file and keeps the invoice metadata and audit history.

Temporary local storage on Vercel may not survive redeploys, so invoices should
be processed and booked promptly. Failed or unbooked invoices keep their local
files as long as the Vercel instance keeps them available.
