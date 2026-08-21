# Connecting a calendar: register your own OAuth app

GoodVibes ships **no OAuth client id of its own**. To connect a Google or Microsoft
calendar, whoever sets up the environment registers an OAuth app with the provider
and puts its client id in config. Until that is done, a connect attempt refuses and
names the key to set. It never falls back to a built-in default and never reports a
connection it does not have.

This is the whole setup. There is no "advanced" path and no basic one; there is one
path, and it is this.

## Why there is no bundled client id

An earlier design carried a project-level client id in the provider profiles, on the
plan that real ids would be filled in later. They will not be. A client id baked into
the product is one the operator cannot audit, cannot rotate, and did not agree to.
Their calendar access would run through somebody else's provider app, under somebody
else's consent screen and quota. Registering your own takes a few minutes and the
credential stays yours.

Native-app client ids are not secrets (RFC 8252), so nothing here needs guarding the
way a password does, but it is still your registration, in your provider account.

## The config keys

| Key | Holds | Required |
| --- | --- | --- |
| `calendar.google.clientId` | The Google OAuth client id | Yes, to connect Google |
| `calendar.google.clientSecretRef` | Reference to the Google client secret | Only for a confidential (Web-app) registration |
| `calendar.microsoft.clientId` | The Microsoft (Entra) application id | Yes, to connect Microsoft |
| `calendar.microsoft.clientSecretRef` | Reference to the Microsoft client secret | Only for a confidential registration |

The `...ClientSecretRef` keys hold a **reference**, not a secret. The secret itself
lives in the secret store under the platform-derived name
(`GOODVIBES_CALENDAR_GOOGLE_CLIENT_SECRET_REF` and its Microsoft counterpart), the
same derivation the daemon uses to decide which credentials it owns, which is what
lets a connection set up on any surface keep working after a handover.

A **desktop / public-client** registration needs no secret at all. That is the
recommended shape for both providers: paired with PKCE it is the standard native-app
pattern, and it means there is no secret to store, rotate, or leak. Use a
confidential registration only if you specifically want one.

## Google

1. Open the Google Cloud Console (`console.cloud.google.com`) and select or create a
   project.
2. **APIs & Services → Library** → enable **Google Calendar API**.
3. **APIs & Services → OAuth consent screen** → configure it. *External* is fine for
   personal use; while the app is unverified, add your own Google account under
   **Test users** or consent will be refused.
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID** →
   application type **Desktop app**.
5. Copy the generated **Client ID**. A Desktop-app client needs no client secret with
   PKCE. Leave the secret field alone unless you deliberately created a Web-app
   client.
6. Set it:

   ```bash
   goodvibes config set calendar.google.clientId <CLIENT_ID>
   ```

   If you registered a Web-app (confidential) client instead, also store its secret
   and point `calendar.google.clientSecretRef` at it.

The scopes requested are `calendar.readonly` and `calendar.events`: read plus event
creation. Narrow them by supplying your own scope list if you want read-only access.

## Microsoft

1. Open the Azure portal (`portal.azure.com`) → **Microsoft Entra ID → App
   registrations → New registration**.
2. Name the app. Under **Supported account types**, "Accounts in any organizational
   directory and personal Microsoft accounts" gives the broadest reach.
3. Under **Redirect URI**, add a **Mobile and desktop applications** platform with the
   entry `http://localhost`. The loopback flow supplies its own `127.0.0.1` port at
   connect time.
4. **Authentication** → set **Allow public client flows** to **Yes**. This is the
   public-client / device-code property; with it set, no client secret is needed.
5. **API permissions → Add a permission → Microsoft Graph → Delegated** → add
   `Calendars.ReadWrite` and `offline_access`. Without `offline_access` you get no
   refresh token and the connection dies at the first token expiry.
6. Copy the **Application (client) ID** and set it:

   ```bash
   goodvibes config set calendar.microsoft.clientId <CLIENT_ID>
   ```

   A confidential registration additionally needs its secret stored and referenced in
   `calendar.microsoft.clientSecretRef`.

## What you see before it is configured

A connect attempt with no client id set fails immediately, before any network call,
with reason `client-not-configured` and a message naming the exact key:

```
No google OAuth client id is configured, so this connection cannot be attempted.
GoodVibes ships no client id of its own: register your own OAuth app with the
provider, then set calendar.google.clientId to its client id. ...
```

That is a normal state with a next step, not a failure to debug. Both connect paths
(the loopback authorization-code flow and the headless device-code flow) refuse the
same way, so a headless install cannot slip past the check.

## Verifying it took

```bash
goodvibes config get calendar.google.clientId
```

Then run the connect flow. The authorization URL it opens carries your client id in
its `client_id` parameter. If you see the id you registered, the flow is running on
your app.

## Related

- `docs/google-setup-runbook.md`: the wider Google connector setup, including mail.
- `docs/secrets.md`: how secret references and the secret store work.
