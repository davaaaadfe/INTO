# INTO OAuth Setup

INTO never asks for Exact Online passwords. The system owner authenticates on
Exact Online's official login page, approves access, and INTO stores only
encrypted OAuth access and refresh tokens.

## Exact Online

1. Open the Exact Online app registration page.
2. Create or update an OAuth client for INTO.
3. Add the redirect URI:

```text
https://your-domain/api/exact/callback
```

For local development:

```text
http://localhost:3000/api/exact/callback
```

4. Copy the OAuth client ID and client secret into environment variables.

Important: `EXACT_ONLINE_CLIENT_ID` is the OAuth app Client ID from Exact, not
the user's Exact login email address.

```text
EXACT_ONLINE_CLIENT_ID=
EXACT_ONLINE_CLIENT_SECRET=
EXACT_ONLINE_REDIRECT_URI=https://your-domain/api/exact/callback
EXACT_ONLINE_BASE_URL=https://start.exactonline.nl
```

5. Restart or redeploy INTO.
6. Sign in to INTO as the system owner.
7. Click `Connect Company Exact`.

INTO uses one company Exact OAuth connection. Individual INTO users do not
connect their own Exact accounts. They book through the company connection,
subject to their verified INTO user access.

Flow:

1. The system owner clicks `Connect Company Exact`.
2. INTO redirects the system owner to Exact Online.
3. The system owner logs in directly with the approved company Exact account.
4. Exact asks the system owner to approve INTO permissions.
5. Exact returns an authorization code to `/api/exact/callback`.
6. INTO validates OAuth state, exchanges the code server-side, encrypts tokens,
   and stores them as the company Exact connection.

## Required Security Variables

Use long random values and store them only as server-side environment variables.

```text
OAUTH_TOKEN_ENCRYPTION_KEY=
OAUTH_STATE_SECRET=
```

Older Exact-specific names are still supported as fallback:

```text
EXACT_TOKEN_ENCRYPTION_KEY=
EXACT_OAUTH_STATE_SECRET=
```

## What INTO Never Stores

INTO never stores:

- Exact Online passwords
- Plaintext access tokens
- Plaintext refresh tokens
- OAuth client secrets in source code

INTO never sends token values to the frontend and never displays tokens in the
UI.
