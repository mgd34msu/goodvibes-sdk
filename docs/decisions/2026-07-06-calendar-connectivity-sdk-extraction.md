# Decision: External-calendar READ connectivity machinery in the SDK (One-Platform Wave 4, A9)

Status: accepted — 2026-07-06
Scope: goodvibes-sdk (`packages/sdk`) — new public subpath `@pellux/goodvibes-sdk/platform/calendar`
Wave: One-Platform Wave 4 — external calendar support (A9)

## Decision

One pure SDK module — `platform/calendar` — provides the machinery the agent needs to
READ external calendars two ways: parse `.ics` text (a file body or a fetched feed) into
typed events, and manage named feed subscriptions with honest per-feed status. It is
data, pure functions, and one small stateful store whose entire IO surface (network,
clock) is INJECTED. No fs, no direct network, no process globals. Consumers own IO;
tests fake it.

Files under `packages/sdk/src/platform/calendar/` (all ≤800 lines):

1. **`ics-parser.ts`** — `parseIcs(text): ParsedCalendar`. A vendored, dependency-free
   RFC 5545 reader for the read subset we actually use: VCALENDAR framing, X-WR-CALNAME,
   and VEVENT UID/SUMMARY/LOCATION/DESCRIPTION/DTSTART/DTEND/RRULE, with RFC 5545 line
   unfolding and TEXT unescaping.
2. **`rrule.ts`** — `describeRecurrence(rule)` classifies an RRULE at parse time;
   `expandEvent(event, window)` expands the supported subset into concrete occurrences.
3. **`subscription-store.ts`** — `SubscriptionStore`: named subscriptions, conditional
   (etag/last-modified) refresh, bounded intervals, honest health, snapshot/restore, and
   `maskFeedUrl`.
4. **`types.ts`** / **`index.ts`** — shared shapes and public re-exports.

New export subpath added to `packages/sdk/package.json` alphabetically between
`platform/bookmarks` and `platform/channels`. Not added to `platform/node/capabilities.ts`
(that file lists only a curated subset — session-spine and presentation aren't in it
either; `check:metadata` only requires that entries which EXIST there resolve). The module
is reachable only via its own subpath — it is NOT re-exported from the main index or any
browser/react-native bundle, so its (currently zero) `node:` usage cannot leak into a
runtime-neutral entry that `check:browser` guards.

## Parser decision: vendored, not a dependency

`packages/sdk`'s runtime dependency set is workspace-only — ZERO third-party runtime deps
(see `packages/sdk/package.json`), guarded by `bundle:check` / `check:browser` /
`any:check` / `publint:check`. Pulling a general iCalendar library in for the read subset
we need would break that convention for little gain and drag a large surface (and its own
tz-database and RRULE assumptions) into the bundle budget. A focused, well-tested internal
reader matches repo style, keeps the module pure and injectable, and lets us hold the
honesty contract precisely (we control exactly what is and isn't expanded). Rejected: a
third-party ICS/RRULE dependency — no strong reason clears the zero-runtime-deps bar.

## RRULE supported subset (honest, deliberately bounded)

The rule: recurrence is FULLY and correctly expanded, or NOT expanded at all with an
explicit reason. We never emit occurrences from a rule we do not completely honor — a
half-applied `BYMONTHDAY` would place events on wrong dates, which is worse than not
expanding.

Fully supported → expanded to real occurrences:
- `FREQ` = DAILY | WEEKLY | MONTHLY | YEARLY
- `INTERVAL` (default 1)
- `COUNT` (occurrence cap)
- `UNTIL` (inclusive end bound; DATE or date-time, `Z` or floating)
- `BYDAY` — ONLY for `FREQ=WEEKLY` with `INTERVAL=1` and weekday-only tokens
  (MO,TU,WE,TH,FR,SA,SU, no leading ordinal). Under those conditions `WKST` cannot change
  the matched set, so it is ignored safely.

Everything else present in the RRULE marks it `expansion: 'unsupported'` and names the
offending part: `BYMONTHDAY`, `BYMONTH`, `BYSETPOS`, `BYHOUR`/…, `BYWEEKNO`, `BYYEARDAY`,
an ordinal `BYDAY` (e.g. `3TU`), `BYDAY` on a non-weekly FREQ, `BYDAY` with `INTERVAL>1`
(week-boundary/WKST handling required), or an unknown/missing `FREQ`. An unsupported event
keeps its seed occurrence (if in-window), flagged `isSeed`, and carries the marker — the
agent surfaces it as "recurrence not fully expanded". Never silently dropped, never
fabricated. A hard occurrence cap (1000) plus a 10-year weekly-walk ceiling bound
runaway rules.

## Time-zone handling (documented, not faked)

This build ships no tz database, so it does not fabricate offset conversions:
- trailing `Z` → `zone: 'utc'` (real UTC).
- `TZID=...` → `zone: 'tzid'`, the wall-clock value kept verbatim with the TZID recorded,
  NOT converted to UTC. "9am in America/New_York" stays "9am" with the zone named.
- neither → `zone: 'floating'`.
- `VALUE=DATE` / bare `YYYYMMDD` → `kind: 'date'`.
A caller can therefore display honestly and never mistakes an un-converted local time for
UTC. Full TZID→offset conversion is out of scope for v1 and explicitly marked so.

## Subscription semantics

- **Consent = adding.** The store never fetches a URL that a caller didn't explicitly add.
  `add({ url })` is the consent act; the agent tells the user what will be fetched and how
  often at add time.
- **Paste-URL-and-done** (per Mike's least-friction rule): `add({ url })` fetches ONCE
  (no separate validate round trip), auto-derives the subscription name from the feed's
  X-WR-CALNAME (falling back to the URL host), applies the default 1-hour cadence with no
  mandatory knobs, and stores the events — or refuses without saving and names the failed
  stage (`fetch` / `parse` / `duplicate`). `validateByFetch(url)` is the lighter "test this
  URL" pre-check the wizard can run without saving.
- **Bounded refresh**: default 1h, clamped to [15m, 24h]. `refresh(name)` skips the network
  when not due unless `force`; it sends stored etag/last-modified so an unchanged feed
  returns 304 and keeps its events. `refreshDue()` drives boot + on-demand refresh.
- **Honest health**, recomputed live from the injected clock: `never-fetched` / `ok` /
  `stale` (older than 2× the interval, detail carries the age) / `unreachable` (network
  stage, detail carries the HTTP status) / `parse-error` (fetched but unusable).
- **Feed URLs are secrets-adjacent.** A Google "secret address" grants read access, so the
  store never encourages surfacing the raw URL: `maskFeedUrl` keeps scheme+host and masks
  the middle. The agent persists the URL via its secret manager; `snapshot()`/`restore()`
  move metadata (URL + validators + timestamps) across restarts and deliberately EXCLUDE
  events, which are re-fetched on boot.

## The daemon `calendar.*` routes stay `invokable: false` (the routes verdict)

Serving `calendar.events.list/get` + `calendar.ics.import` "for real" is NOT cheap, so per
the brief's guardrail they are left `invokable: false` and the route-reconcile gate keeps
guarding them. Reasoning:
- Those five descriptors are documented as **CalDAV-backed** (`calendar.ics.import` writes
  "into the configured CalDAV calendar"). There is no CalDAV backend anywhere, and there is
  no `/api/calendar` route surface at any prefix — confirmed by 011c6fc3, which retired the
  route-reconcile debt precisely because no route exists.
- The daemon HTTP router (`platform/daemon/http/router.ts`, ~846 lines) wires every route
  surface through a large dependency-injection context. A real calendar surface would need
  a daemon-side store wired into that context, an `operator.ts` dispatch case, and route
  handlers in the separate `@pellux/goodvibes-daemon-sdk` package — a substantial, separate
  effort, and pointing a CalDAV-labeled contract at a feed-subscription store would
  misrepresent the contract.
- The new machinery is **read-focused file/feed** parsing consumed AGENT-side (the agent's
  `/calendar` is a local store). It does not need a daemon route to be real, and wiring one
  would be half-work against a mismatched contract. So: no route added, no descriptor
  flipped, `test/w4-a3-capability-route-reconcile.test.ts` stays green unchanged.

## Consumability proof

`test/platform-calendar.test.ts` (26 tests) proves: field extraction + unfolding +
unescaping + honest zone anchoring (utc/floating/tzid/date) + synthetic UID + honest skip
of a DTSTART-less VEVENT; the full RRULE subset expanding correctly (DAILY/WEEKLY/MONTHLY/
YEARLY, INTERVAL/COUNT/UNTIL, weekly BYDAY, window clipping) and every unsupported case
yielding ONLY the seed with a named marker; and the `SubscriptionStore` against FAKE feeds
+ a FAKE clock (no real network): X-WR-CALNAME-derived add, conditional 304 refresh,
not-due skip, honest unreachable/parse-error/stale-with-age, validate-by-fetch staging,
interval clamping, snapshot/restore, remove, and `maskFeedUrl`. Plus a purity assertion
that no file under `platform/calendar/` imports fs/net/tty/process or calls `fetch`.

## Rejected alternatives

- **A third-party ICS/RRULE library.** Breaks the zero-runtime-deps convention for the SDK
  package; the read subset is small enough to vendor cleanly and hold honest.
- **A store that fetches on its own (ambient `fetch`).** Would make tests touch the network
  and hide the consent boundary. Network is injected; the store is pure of ambient IO.
- **Persisting events in the SDK store.** Persistence (and secret storage of the URL) is the
  agent's job; the SDK store is the in-memory engine with snapshot/restore of metadata only.
- **Serving the daemon `calendar.*` routes now.** Not cheap and contract-mismatched (CalDAV
  vs feed) — see the routes verdict above.
- **Expanding unsupported RRULE parts "best effort".** Explicitly rejected: fabricated dates
  are worse than an honest "not fully expanded" marker.
