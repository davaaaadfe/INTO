# INTO OAuth Setup

INTO never asks for Exact Online or Outlook passwords. Users authenticate on the
provider's official login page, approve access, and INTO stores only encrypted
OAuth access and refresh tokens.

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

## Microsoft Outlook / Microsoft Graph

1. In Azure Portal, open Microsoft Entra ID.
2. Go to App registrations.
3. Create or update an app registration for INTO.
4. Add a Web redirect URI:

```text
https://your-domain/api/outlook/callback
```

For local development:

```text
http://localhost:3000/api/outlook/callback
```

5. Add Microsoft Graph delegated permissions:

```text
offline_access
User.Read
Mail.ReadWrite
```

6. Create a client secret.
7. Copy the values into environment variables.

Important: `MICROSOFT_CLIENT_ID` is the Azure Application (client) ID, not the
user's Outlook email address.

```text
MICROSOFT_CLIENT_ID=
MICROSOFT_CLIENT_SECRET=
MICROSOFT_REDIRECT_URI=https://your-domain/api/outlook/callback
MICROSOFT_TENANT_ID=common
```

8. Restart or redeploy INTO.
9. Sign in to INTO as the system owner.
10. Click `Connect Company Outlook`.

INTO uses one company Outlook mailbox for ingestion. Invoice import reads only
from that connected mailbox.

Flow:

1. The system owner clicks `Connect Company Outlook`.
2. INTO redirects the system owner to Microsoft.
3. The system owner logs in directly with the approved company mailbox account.
4. Microsoft asks the system owner to approve Graph permissions.
5. Microsoft returns an authorization code to `/api/outlook/callback`.
6. INTO validates OAuth state, exchanges the code server-side, encrypts tokens,
   and stores them as the company Outlook connection.

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
- Microsoft passwords
- Plaintext access tokens
- Plaintext refresh tokens
- OAuth client secrets in source code

INTO never sends token values to the frontend and never displays tokens in the
UI.
