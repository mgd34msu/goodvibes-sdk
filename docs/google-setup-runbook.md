# Connecting Gmail and Google Calendar

> This file is generated from the SDK's Google setup plan (`packages/sdk/src/platform/google/setup-plan.ts`). Do not edit it by hand — edit the plan and regenerate, or the test that compares the two will fail. It exists so that when the automation cannot finish a step, there is a written route through the same work that cannot have drifted out of date.

## Just run this

```
/google setup
```

It reports what it is doing at every step, stops and names exactly what to click when it needs you, and picks up where it left off if you re-run it. Nothing is done twice.

For the full-API path:

```
/google setup --path oauth
```

To see what is already connected without changing anything:

```
/google status
```

## Which path do I want?

| | App password | OAuth |
| --- | --- | --- |
| Read Gmail | yes | yes |
| Send Gmail | yes | yes |
| Read calendar | yes (read-only) | yes |
| Write calendar | no | yes |
| Gmail push notifications | no | yes |
| Google Cloud project needed | no | yes |
| Credential expires | no | only if you skip the publishing step |
| Setup time | ~3 min | ~15 min |

Start with the app password path. Add OAuth later if you hit its limits — they coexist, and setting up one does not undo the other.

## What needs you, and what does not

Everything is automated except 7 points where Google requires a real human action. They are unavoidable: Google blocks automated browsers at sign-in, and consent cannot be granted programmatically by design.

- **Checking you are signed in to Google** ([details](#google-signed-in)) — app password path
- **Checking 2-Step Verification is on** ([details](#two-step-verification)) — app password path
- **Signing gcloud in to your Google account** ([details](#gcloud-authenticated)) — OAuth path
- **Filling in the OAuth consent screen** ([details](#oauth-branding)) — OAuth path
- **Setting publishing status to In production** ([details](#oauth-audience-production)) — OAuth path
- **Creating the Desktop app OAuth client** ([details](#oauth-client)) — OAuth path
- **Authorizing the agent** ([details](#oauth-authorize)) — OAuth path

A note on sign-in: Google rejects automated browsers with "this browser or app may not be secure". The flow uses a persistent browser profile, so you sign in **once, by hand**, and every later run reuses that session. When a sign-in is needed the flow says so and stops — it never loops or pretends.

## Path A — app password (start here)

This is the fast lane and the default. There is no Google Cloud project, no API to enable, no OAuth client, no consent screen, and no token that expires. One app password, and Gmail works.

**What you get:** Gmail read and send over IMAP/SMTP, and read-only calendar.

**What you don't get:** writing calendar events, and Gmail push notifications. Those need the OAuth path below.

A note on calendar, because it is the one place this path is narrower than it looks: Google refuses HTTP Basic authentication on its CalDAV endpoint — its own documentation says "Attempting to connect over HTTP or using Basic Authentication results in an HTTP `401 Unauthorized` status code" ([CalDAV guide](https://developers.google.com/workspace/calendar/caldav/v2/guide)). So an app password cannot reach Google Calendar over CalDAV, no matter how it is configured. The private iCal address is used instead. It works without any credential setup, and it is read-only.

**Time:** about three minutes, most of it waiting for a 2-Step Verification prompt.

### 1. Making sure a browser is available

<a id="browser-ready"></a>

**Who does it:** Automated — the flow does this for you.

**Why:** The app password and the calendar address both live behind pages Google exposes through no API, so they have to be read out of a real browser.

**By hand:**

1. No action needed — this only matters to the automated flow. If you are following this runbook by hand, use whatever browser you normally use.

### 2. Checking you are signed in to Google

<a id="google-signed-in"></a>

**Who does it:** Needs one action from you — the flow opens the page and tells you what to click.

**Why:** Google blocks automated browsers at its sign-in screen ("this browser or app may not be secure"), so the sign-in is done by hand exactly once. The browser profile is persistent, so it stays signed in for every later run.

**Page:** https://myaccount.google.com/apppasswords

**By hand:**

1. A browser window will open. If it shows a Google sign-in page, sign in with the Google account you want the agent to use.
2. Complete any 2-Step Verification prompt on your phone.
3. Leave the window open and re-run the command. The sign-in is remembered from now on.

### 3. Checking 2-Step Verification is on

<a id="two-step-verification"></a>

**Who does it:** Needs one action from you — the flow opens the page and tells you what to click.

**Why:** Google only offers app passwords on accounts with 2-Step Verification enabled. Without it the app password page is unavailable and this whole path is blocked.

**Page:** https://myaccount.google.com/signinoptions/twosv

**By hand:**

1. Open https://myaccount.google.com/signinoptions/twosv
2. If it says 2-Step Verification is off, click "Turn on 2-Step Verification" and follow the prompts (a phone number or an authenticator app is enough).
3. Once it reports 2-Step Verification is on, continue.

### 4. Creating the app password

<a id="app-password"></a>

**Who does it:** Automated — the flow does this for you.

**Why:** A 16-character app password lets Gmail be reached over IMAP and SMTP with no Google Cloud project, no OAuth client and no token that expires.

**Page:** https://myaccount.google.com/apppasswords

**By hand:**

1. Open https://myaccount.google.com/apppasswords
2. In the "App name" box type: goodvibes-agent
3. Click "Create".
4. Google shows a 16-character password in a yellow box. Copy it. You cannot see it again after closing the dialog.
5. Store it with: goodvibes-agent secret set GOODVIBES_EMAIL_PASSWORD_REF

### 5. Pointing the mail surface at Gmail

<a id="gmail-config"></a>

**Who does it:** Automated — the flow does this for you.

**Why:** Writes the Gmail IMAP and SMTP endpoints into config so the mail surface knows where to connect.

**By hand:**

1. goodvibes-agent config set email.imapHost imap.gmail.com
2. goodvibes-agent config set email.imapPort 993
3. goodvibes-agent config set email.smtpHost smtp.gmail.com
4. goodvibes-agent config set email.smtpPort 587
5. goodvibes-agent config set email.smtpSecurity starttls
6. goodvibes-agent config set email.username <your-address@gmail.com>
7. goodvibes-agent config set email.fromAddress <your-address@gmail.com>
8. goodvibes-agent config set email.enabled true

### 6. Connecting to Gmail over IMAP and SMTP

<a id="gmail-verify"></a>

**Who does it:** Automated — the flow does this for you.

**Why:** Proves the credential actually works by opening a real IMAP session and a real authenticated SMTP session. Nothing is sent and nothing is marked read.

**By hand:**

1. goodvibes-agent email test
2. A successful run reports both the IMAP and the SMTP stage as connected.
3. If IMAP fails with AUTHENTICATIONFAILED, the app password was mistyped — create a new one and store it again.

### 7. Capturing the private calendar address

<a id="calendar-ics-address"></a>

**Who does it:** Automated — the flow does this for you.

**Why:** Google refuses Basic authentication on its CalDAV endpoint, so an app password cannot reach Calendar that way. The private iCal address is the credential-free route that does work. It is read-only; calendar writes need the OAuth path.

**Page:** https://calendar.google.com/calendar/u/0/r/settings

**By hand:**

1. Open https://calendar.google.com/calendar/u/0/r/settings
2. In the left panel under "Settings for my calendars", click the calendar you want.
3. Click "Integrate calendar".
4. Under "Secret address in iCal format", click the copy button.
5. Store it with: goodvibes-agent secret set GOODVIBES_CALENDAR_GOOGLE_ICS_URL
6. Treat this URL as a password — anyone holding it can read your calendar.

### 8. Reading calendar events

<a id="calendar-verify"></a>

**Who does it:** Automated — the flow does this for you.

**Why:** Fetches and parses the calendar feed so the run ends having actually read real events, not just stored a URL.

**By hand:**

1. goodvibes-agent calendar refresh
2. goodvibes-agent calendar list
3. A successful run prints upcoming events from the subscribed feed.

## Path B — OAuth (full Gmail and Calendar APIs)

Take this path when you need to write calendar events, use Gmail push/watch channels, or run richer queries than IMAP allows.

It is longer because Google exposes no API for two of the steps — the consent screen and creating an OAuth client — so those are done in the browser. Everything else is scripted through `gcloud`.

**Read this before you start.** An OAuth app left in **Testing** publishing status is issued refresh tokens that expire after **seven days**. Google documents this plainly: "A Google Cloud Platform project with an OAuth consent screen configured for an external user type and a publishing status of 'Testing' is issued a refresh token expiring in 7 days" ([OAuth 2.0 guide](https://developers.google.com/identity/protocols/oauth2)). The exemption for apps requesting only `openid`/`email`/`profile` does not apply here — Gmail and Calendar scopes are sensitive or restricted.

The practical consequence: if you skip the publishing-status step, this integration will silently stop working one week later, and the failure looks like an unrelated auth error. Step 6 is the one that matters most.

**Scopes requested:** `https://www.googleapis.com/auth/calendar.events`

**APIs enabled:** `calendar-json.googleapis.com`

**Time:** about fifteen minutes.

### 1. Making sure gcloud is installed

<a id="gcloud-installed"></a>

**Who does it:** Automated — the flow does this for you.

**Why:** The project and API-enablement steps are scriptable through gcloud, which keeps the console clicking down to the two things Google exposes no API for.

**By hand:**

1. Check whether it is already there: gcloud --version
2. If it is missing, install it into your home directory without root:
3.   curl -sSLO https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-linux-x86_64.tar.gz
4.   tar -xzf google-cloud-cli-linux-x86_64.tar.gz -C "$HOME"
5.   "$HOME/google-cloud-sdk/install.sh" --quiet
6.   export PATH="$HOME/google-cloud-sdk/bin:$PATH"

### 2. Signing gcloud in to your Google account

<a id="gcloud-authenticated"></a>

**Who does it:** Needs one action from you — the flow opens the page and tells you what to click.

**Why:** gcloud needs its own sign-in before it can create a project or enable APIs.

**By hand:**

1. gcloud auth login
2. A browser opens. Choose the Google account you want the agent to use, then click "Allow".
3. Confirm it worked: gcloud auth list

### 3. Selecting or creating the Cloud project

<a id="gcloud-project"></a>

**Who does it:** Automated — the flow does this for you.

**Why:** Every OAuth client belongs to a Cloud project. An existing project is reused rather than piling up new ones on re-runs.

**By hand:**

1. List what you already have: gcloud projects list
2. To reuse one: gcloud config set project <PROJECT_ID>
3. To make a new one: gcloud projects create goodvibes-agent-<random> --name="goodvibes agent"
4. Then: gcloud config set project <PROJECT_ID>

### 4. Enabling the Gmail and Calendar APIs

<a id="apis-enabled"></a>

**Who does it:** Automated — the flow does this for you.

**Why:** Without these two services enabled on the project, every API call fails with a service-disabled error rather than an auth error, which is confusing to debug.

**By hand:**

1. gcloud services enable calendar-json.googleapis.com
2. Confirm: gcloud services list --enabled --filter="calendar-json.googleapis.com"

### 5. Filling in the OAuth consent screen

<a id="oauth-branding"></a>

**Who does it:** Needs one action from you — the flow opens the page and tells you what to click.

**Why:** Google exposes no API for the consent screen, so this is one of the two places the browser has to be driven. Without it the client cannot be created.

**Page:** https://console.cloud.google.com/auth/branding

**By hand:**

1. Open https://console.cloud.google.com/auth/branding
2. If prompted, click "Get started".
3. App name: goodvibes agent
4. User support email: your own address
5. Audience: choose "External".
6. Contact email: your own address
7. Agree to the user data policy and click "Create".

### 6. Setting publishing status to In production

<a id="oauth-audience-production"></a>

**Who does it:** Needs one action from you — the flow opens the page and tells you what to click.

**Why:** This is the step that decides whether the integration keeps working. An app left in "Testing" is issued refresh tokens that expire after seven days, so the integration dies once a week and does so silently. Moving to "In production" removes that expiry. It is self-certified: no Google review is needed, you just click through an "unverified app" warning once when you authorize.

**Page:** https://console.cloud.google.com/auth/audience

**By hand:**

1. Open https://console.cloud.google.com/auth/audience
2. Find the "Publishing status" box. If it reads "Testing", click "PUBLISH APP".
3. A dialog asks you to confirm pushing the app to production. Click "Confirm".
4. The status box must now read "In production". If it still reads "Testing", the credential you create next will stop working in seven days.
5. You do not need to submit for verification. Sensitive and restricted scopes on an unverified app still work for personal use, capped by Google at 100 users.

### 7. Creating the Desktop app OAuth client

<a id="oauth-client"></a>

**Who does it:** Needs one action from you — the flow opens the page and tells you what to click.

**Why:** The second thing Google exposes no API for. A Desktop app client is the right type: it permits the loopback redirect the agent uses and needs no hosted redirect URL.

**Page:** https://console.cloud.google.com/auth/clients

**By hand:**

1. Open https://console.cloud.google.com/auth/clients
2. Click "CREATE CLIENT".
3. Application type: choose "Desktop app".
4. Name: goodvibes agent
5. Click "Create".
6. A dialog shows the Client ID and Client secret. Copy both.
7. Store them with:
8.   goodvibes-agent config set calendar.google.clientId <CLIENT_ID>
9.   goodvibes-agent secret set GOODVIBES_CALENDAR_GOOGLE_CLIENT_SECRET_REF

### 8. Authorizing the agent

<a id="oauth-authorize"></a>

**Who does it:** Needs one action from you — the flow opens the page and tells you what to click.

**Why:** Exchanges a one-time consent for a long-lived refresh token, which is what the agent actually uses from then on. Before it opens: Google will show a red "Google hasn't verified this app" warning. That is expected here and is not a sign anything is wrong — the app is one you just created in your own Google Cloud account, and you are its only user, so there is nobody for Google to have verified it for. You will click "Advanced", then "Go to goodvibes agent (unsafe)". This happens once.

**By hand:**

1. /google setup --path oauth
2. A browser opens on a Google consent screen.
3. Expect a red warning screen saying "Google hasn't verified this app". This is normal for an app you created yourself and are the only user of — there is no third party for Google to have verified it on behalf of.
4. Because the app is self-certified rather than Google-verified, you will see "Google hasn't verified this app". Click "Advanced", then "Go to goodvibes agent (unsafe)". This is expected for a personal install and only happens once.
5. Tick the Gmail and Calendar permissions, then click "Continue".
6. The browser lands on a local page confirming the agent is connected.

### 9. Checking the credential and its lifetime

<a id="oauth-verify"></a>

**Who does it:** Automated — the flow does this for you.

**Why:** Confirms the refresh token works by making a real API call, and re-reads the publishing status so a seven-day-expiry credential is reported loudly instead of discovered a week later.

**By hand:**

1. /google status
2. A successful run reports the account it connected as and the publishing status.
3. If publishing status reads "Testing", go back to the audience page and publish the app, then authorize again — the existing token still expires.

## If something goes wrong

**Re-run the command.** It detects what already exists and skips it, so re-running after fixing something never duplicates work or creates a second project, client, or app password.

**"This browser or app may not be secure"** — Google is refusing the automated browser at sign-in. Sign in by hand in the window that opened, then re-run. The session persists after that.

**IMAP fails with `AUTHENTICATIONFAILED`** — the app password is wrong or was revoked. Google never re-displays an existing app password, so delete the `goodvibes-agent` entry at https://myaccount.google.com/apppasswords and re-run to create a fresh one.

**Everything worked, then broke about a week later** — this is the Testing-publishing-status trap. Check https://console.cloud.google.com/auth/audience: if publishing status reads "Testing", click PUBLISH APP, then re-authorize. The old token cannot be salvaged.

**"Google hasn't verified this app"** — expected. The app is self-certified, not Google-reviewed. Click "Advanced", then "Go to goodvibes agent (unsafe)". Google allows up to 100 users on an unverified app, which is ample for a personal install.

## Where credentials live

Every secret — the app password, the OAuth client secret, the refresh token, and the private calendar address — is written to the encrypted secret store and referenced from config by name only. No secret is written to config files, logs, transcripts, or `/status` output. The private calendar address is treated as a credential because anyone holding it can read the calendar.
