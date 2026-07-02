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

MICROSOFT_CLIENT_ID=
MICROSOFT_CLIENT_SECRET=
MICROSOFT_REDIRECT_URI=https://your-vercel-domain.vercel.app/api/outlook/callback

OAUTH_TOKEN_ENCRYPTION_KEY=
OAUTH_STATE_SECRET=
STORAGE_PROVIDER=s3
S3_ENDPOINT=
S3_BUCKET=
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
```

`EXACT_ONLINE_REDIRECT_URI` and `MICROSOFT_REDIRECT_URI` can be omitted when
Vercel provides `VERCEL_PROJECT_PRODUCTION_URL` or `VERCEL_URL`; INTO will derive
the callback URLs automatically. Setting them explicitly is still recommended
when using a custom domain.

`DATABASE_URL` is optional. In database-free mode, INTO uses Exact Online as the
long-term booking record and checks Exact for duplicate invoice references and
amounts before booking. Without a database, INTO does not keep a durable
application-side invoice archive or audit history across server restarts.

## 3. Callback URLs

Production:

```text
https://into.yourcompany.com/api/exact/callback
https://into.yourcompany.com/api/outlook/callback
```

Vercel preview or generated domain:

```text
https://your-project.vercel.app/api/exact/callback
https://your-project.vercel.app/api/outlook/callback
```

Local development:

```text
http://localhost:3000/api/exact/callback
http://localhost:3000/api/outlook/callback
```

Optional ngrok:

```text
https://your-ngrok-host.ngrok-free.app/api/exact/callback
https://your-ngrok-host.ngrok-free.app/api/outlook/callback
```

For optional ngrok or any other external development host, set `APP_URL` or the
provider-specific redirect URI environment variable to that external host.

## 4. Startup Validation

INTO exposes `/api/setup/status` and shows a first-time setup wizard in the UI
when configuration is incomplete. The wizard shows:

- Connect Company Exact Setup
- Connect Company Outlook Setup
- Environment Configuration Status
- Database-Free Mode or Database Status
- Storage Status

It returns only status information and missing environment variable names. It
never returns client secrets, tokens, encryption keys, or passwords.

## 5. Production Storage Notes

Use an S3-compatible storage provider for original invoice files. Local
filesystem storage is only for development because Vercel serverless files are
not durable. A PostgreSQL database is optional if you later want a durable INTO
invoice archive and audit history in addition to Exact Online.
