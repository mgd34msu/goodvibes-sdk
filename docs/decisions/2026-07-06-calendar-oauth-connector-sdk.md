# Decision: OAuth 2.0 calendar provider connectivity in the SDK (One-Platform Wave 4, A10)

Status: accepted — 2026-07-06
Scope: goodvibes-sdk (`packages/sdk`) — new machinery under the existing public subpath `@pellux/goodvibes-sdk/platform/calendar`
Wave: One-Platform Wave 4 — Calendar (A10), sibling of A9 (ICS files + feeds)

## Decision

The `platform/calendar` module gains an authenticated-provider connectivity layer
alongside A9's file/feed reader. It connects real accounts over OAuth 2.0 and reads
and writes calendars through the Google Calendar API v3 and Microsoft Graph, then
normalizes everything into the SAME merged event model A9's `.ics` path produces so a
single `/calendar` view renders every source labeled.

New source files (all ≤800 lines, all within the module's existing purity contract —
no `node:*`, no `process.*`, no bare `fetch(`):

1. `oauth-types.ts` — the OAuth/connector/merged-model type surface. Re-exports A9's
   `Clock` rather than redefining it (one clock type, no barrel clash).
2. `oauth-providers.ts` — the fixed Google + Microsoft profiles, client-config
   resolution (bundled default vs user override), and the verbatim provider-console
   setup steps (`PROVIDER_SETUP_STEPS`) shared by the wizard help and these docs.
3. `oauth-flow.ts` — authorization-code + PKCE (S256), device-code (RFC 8628) with
   `authorization_pending`/`slow_down`/expiry handling, token exchange, refresh, and
   revocation. Every network call goes through the injected `HttpFetch`; PKCE reuses
   the SDK's runtime-neutral `crypto-adapter`.
4. `oauth-token-store.ts` — `CalendarTokenStore`: tokens persisted ONLY through the
   injected secret-store slice, an honest `ConnectionState` computed from the stored
   set + clock, auto-refresh on expiry, and a durable `reconnect-needed` marker when a
   refresh fails (never hands back a stale token as if valid).
5. `merged-calendar-model.ts` — `normalizeGoogleEvent` / `normalizeGraphEvent` into
   `MergedCalendarEvent` (A9's `CalendarEvent` + a `source` label + provider ids),
   following A9's time-anchoring honesty (fixed-offset → real UTC is arithmetic and
   allowed; a named zone with no offset is kept as `tzid`, never converted).
6. `calendar-api-shared.ts` — bearer-auth request helper + honest degraded-state
   mapping: 401 → `reconnect-needed`, 403 → `insufficient-scope` naming the scope,
   429 → `rate-limited` with the honored Retry-After, else `provider-error`.
7. `google-calendar-api.ts` — `calendarList.list`, `events.list` (paginated,
   `singleEvents=true`, `timeMin`/`timeMax`), `events.insert`.
8. `microsoft-graph-api.ts` — `me/calendars`, `me/calendars/{id}/calendarView`
   (paged `@odata.nextLink`, `Prefer: outlook.timezone="UTC"`), event create.
9. `calendar-connector.ts` — `CalendarConnector`, the high-level surface the agent
   drives (connect via auth-code or device-code, disconnect, list accounts/state,
   list calendars, list events over a window, create event routed to a chosen
   provider).
10. `http-fetch-adapter.ts` — a pure adapter from a WHATWG `fetch` to `HttpFetch`
    (references only global fetch, so the module stays pure; the real `fetch` is
    supplied by the caller/tests).

## What shipped (SDK side; the agent wizard + the real loopback listener are A10's agent half)

- New exports appended to `packages/sdk/src/platform/calendar/index.ts` under A9's
  existing exports. No new subpath — A9 already added `./platform/calendar` to
  `package.json` exports; this rides the same barrel.
- The node-touching pieces are deliberately NOT in this module: the real loopback
  redirect listener (`platform/config/oauth-local-listener.ts`, `node:http`) and the
  runtime `fetch` are injected by the agent, so the calendar module keeps A9's purity
  contract and the whole flow tests against fakes.
- Default-experience design (per Mike's least-friction rule): the profiles ship a
  bundled project-level client id (rclone/gh pattern). A native-app / public-client id
  is not a secret (RFC 8252); paired with mandatory PKCE no client secret is needed.
  The bundled id ships as an honest PLACEHOLDER; `resolveClientConfig` reports
  `isPlaceholder:true` until it is replaced, and a flow refuses with
  `client-not-configured` rather than faking success. A user MAY override with their
  own id (+ secret for a confidential registration) — never a required step.

## Divergence ruling: bundled default vs user-registered app

Mike's directive mid-build changed the default from "every user registers their own
app" (high friction) to a bundled project client id (low friction), user registration
demoted to an advanced override. The code models BOTH paths through one
`resolveClientConfig`; the only content decision left to Mike is dropping the two real
project client ids into config defaults once he registers the apps (see verification-
pending below). Until then the placeholders keep the flow honest, not broken.

## Rejected alternatives

- Reusing `platform/runtime/auth/oauth-core.ts` for the network calls — rejected: it
  calls `instrumentedFetch` directly (not injectable), so it cannot be exercised
  against a fake server without stubbing global fetch. A10 needs zero-network tests,
  so it uses an injected `HttpFetch` throughout.
- Expanding provider recurrence locally — rejected: the API clients request expanded
  single instances (Google `singleEvents=true`, Graph `calendarView`), so each event
  is a concrete occurrence and no rule is fabricated. This mirrors A9's "never
  fabricate an occurrence" contract.
- Storing tokens in config with a secret reference (the email path's pattern) —
  rejected for the SDK layer: tokens are written straight into the injected secret
  store, so the SDK module has no config dependency; the agent maps its own config
  keys as needed.

## Flag

"Both providers connect" is proven only against fake OAuth + fake Google/Graph
servers. The real provider consent screens and live token issuance are
verification-pending until Mike registers the two project apps (or a user supplies
their own client id). No real network is touched anywhere in the tests.

## Consumability proof

`test/platform-calendar-oauth.test.ts` drives the full stack against in-memory fakes
(no network, no port, no keychain): auth-code + PKCE end to end with the fake token
endpoint verifying the S256 verifier against the challenge from the authorize URL (and
rejecting a wrong verifier); device-code through pending → slow_down → success and an
honest expiry; bundled-default vs override resolution and the placeholder refusal;
refresh-on-expiry and the refresh-failure → reconnect-needed flip; Google + Microsoft
revoke/disconnect; paginated calendar + event listing normalized and source-labeled;
event creation; and the 401/403/429 degraded states each named. A9's existing
`test/platform-calendar.test.ts` purity test now also covers these files.
