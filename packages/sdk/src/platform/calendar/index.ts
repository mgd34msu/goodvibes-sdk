/**
 * @pellux/goodvibes-sdk/platform/calendar
 *
 * External-calendar READ connectivity — the SDK machinery behind the agent's
 * `/calendar import`, `/calendar subscribe`, and the connect wizard (One-Platform
 * Wave 4, A9). Two pieces, both honest by construction:
 *
 *  - A vendored iCalendar (RFC 5545) reader: `parseIcs` turns .ics text (a file body
 *    or a fetched feed) into typed events, and `expandEvent` expands the honest RRULE
 *    subset into concrete occurrences. A recurrence outside the subset is NEVER
 *    fabricated — the event keeps its seed and carries an explicit
 *    `recurrence.expansion: 'unsupported'` marker naming the part we declined.
 *  - `SubscriptionStore`: named external-calendar feed subscriptions with per-feed
 *    honest status (ok / stale-with-age / unreachable / parse-error), etag/
 *    last-modified conditional refresh, and a paste-URL-and-done `add()` that
 *    validates by fetching and auto-derives the name from X-WR-CALNAME.
 *
 * Network and clock are INJECTED (FeedFetcher / Clock) — this module never reaches
 * the network or reads wall-clock on its own, so consumers (and tests, with fake
 * feeds) own the IO boundary entirely. Persistence is the caller's job.
 *
 * The daemon `calendar.*` operator methods stay `invokable: false` — they are
 * CalDAV-backed contracts with no live route, a separate concern from this
 * read-focused file/feed machinery. See
 * docs/decisions/2026-07-05-calendar-connectivity-sdk-extraction.md.
 */

export { parseIcs } from './ics-parser.js';
export { describeRecurrence, expandEvent } from './rrule.js';
export {
  SubscriptionStore,
  maskFeedUrl,
  DEFAULT_REFRESH_INTERVAL_MS,
  MIN_REFRESH_INTERVAL_MS,
  MAX_REFRESH_INTERVAL_MS,
  type SubscriptionStoreOptions,
  type AddSubscriptionInput,
  type AddResult,
  type ValidationResult,
} from './subscription-store.js';

export type {
  CalendarEvent,
  EventDateTime,
  EventZone,
  RecurrenceInfo,
  RecurrenceExpansion,
  ParsedCalendar,
  ParseDiagnostic,
  EventOccurrence,
  DateWindow,
  CalendarSubscription,
  SubscriptionHealth,
  SubscriptionSnapshot,
  RefreshReport,
  FeedFetcher,
  FeedFetchRequest,
  FeedFetchResult,
  Clock,
} from './types.js';
