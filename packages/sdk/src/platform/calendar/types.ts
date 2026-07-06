/**
 * types.ts — the shared type surface for the calendar-connectivity module.
 *
 * Pure data shapes only. The module reads external calendars two ways — parsing
 * .ics text (a file or a fetched feed body) into typed events, and managing named
 * feed subscriptions with honest per-subscription status — and every value a
 * caller sees is described here.
 *
 * Honesty contract (see docs/decisions/2026-07-05-calendar-connectivity-sdk-extraction.md):
 *  - date-time zone handling is stated, never faked. A DTSTART with a TZID is kept
 *    as its wall-clock value with the TZID recorded; NO offset conversion is applied
 *    (this build ships no tz database), so `zone: 'tzid'` means "local wall time in
 *    the named zone, not converted to UTC". A trailing-Z value is real UTC
 *    (`zone: 'utc'`); a bare date-time with neither is floating (`zone: 'floating'`).
 *  - recurrence is either fully expanded or explicitly not. A VEVENT whose RRULE
 *    uses only the supported subset expands to real occurrences; anything else keeps
 *    the seed event and carries an explicit `expansion: 'unsupported'` marker naming
 *    the part we declined to expand. Occurrences are never fabricated from a rule we
 *    do not fully honor.
 */

/** How a date/date-time value is anchored in time. */
export type EventZone = 'utc' | 'floating' | 'tzid';

/** A parsed DTSTART/DTEND value with its honest time anchoring. */
export interface EventDateTime {
  /**
   * The as-parsed value:
   *  - `kind: 'date'`      => 'YYYY-MM-DD'
   *  - `kind: 'date-time'` => 'YYYY-MM-DDTHH:mm:ss' (floating/tzid) or the same
   *                           with a trailing 'Z' (utc).
   */
  readonly value: string;
  readonly kind: 'date' | 'date-time';
  readonly zone: EventZone;
  /** Present only when `zone === 'tzid'`; the raw TZID as written in the feed. */
  readonly tzid?: string;
}

/** Whether a VEVENT's RRULE was fully expanded, and why not when it was not. */
export type RecurrenceExpansion = 'full' | 'unsupported';

/** The honest recurrence descriptor attached to a recurring VEVENT. */
export interface RecurrenceInfo {
  /** The raw RRULE line value, e.g. 'FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10'. */
  readonly rule: string;
  readonly expansion: RecurrenceExpansion;
  /**
   * When `expansion === 'unsupported'`, a plain-language reason naming the part
   * this build does not expand (e.g. 'RRULE part BYMONTHDAY is not expanded by
   * this build'). Absent when `expansion === 'full'`.
   */
  readonly unsupportedReason?: string;
}

/** A single calendar event parsed from a VEVENT. */
export interface CalendarEvent {
  /** The VEVENT UID; a stable synthetic id is assigned when the feed omits one. */
  readonly uid: string;
  readonly summary: string;
  readonly location?: string;
  readonly description?: string;
  readonly start: EventDateTime;
  /** DTEND when present; a VEVENT may legitimately omit it (e.g. a reminder). */
  readonly end?: EventDateTime;
  /** Present when the VEVENT carried an RRULE. */
  readonly recurrence?: RecurrenceInfo;
}

/** A non-fatal problem encountered while parsing, tied to the source when known. */
export interface ParseDiagnostic {
  /** 1-based line number in the (unfolded) source, when attributable. */
  readonly line?: number;
  /** The offending component/property name, when attributable (e.g. 'DTSTART'). */
  readonly component?: string;
  readonly message: string;
}

/** The full result of parsing .ics text. */
export interface ParsedCalendar {
  /** Calendar name from X-WR-CALNAME, when the feed supplied one. */
  readonly calendarName?: string;
  readonly events: readonly CalendarEvent[];
  /**
   * Events that were recognised as VEVENTs but could not be turned into a usable
   * event (e.g. no DTSTART). Never silently dropped — surfaced here with a reason.
   */
  readonly skipped: readonly ParseDiagnostic[];
  /** Non-fatal notes (unsupported recurrence, unknown TZID kept as-is, etc.). */
  readonly diagnostics: readonly ParseDiagnostic[];
}

/** One concrete occurrence produced by expanding a (possibly recurring) event. */
export interface EventOccurrence {
  readonly event: CalendarEvent;
  /** Occurrence start as 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:mm:ss[Z]', mirroring start.kind/zone. */
  readonly start: string;
  /** True only for the seed occurrence of a recurring event. */
  readonly isSeed: boolean;
}

/** An inclusive [from, to] window for occurrence expansion, as 'YYYY-MM-DD' strings. */
export interface DateWindow {
  readonly from: string;
  readonly to: string;
}

// ---------------------------------------------------------------------------
// Subscription store
// ---------------------------------------------------------------------------

/** Honest health of a named feed subscription. */
export type SubscriptionHealth =
  | 'never-fetched'
  | 'ok'
  | 'stale'
  | 'unreachable'
  | 'parse-error';

/** A named external-calendar feed subscription and its current status. */
export interface CalendarSubscription {
  readonly name: string;
  /** The feed URL. Treat as secrets-adjacent: a Google "secret address" grants read access. */
  readonly url: string;
  /** How often a refresh becomes due, in milliseconds. Bounded by the store. */
  readonly refreshIntervalMs: number;
  /** Epoch ms of the last fetch ATTEMPT (success or failure), if any. */
  readonly lastFetchedAt?: number;
  /** Epoch ms of the last SUCCESSFUL parse, if any. */
  readonly lastSucceededAt?: number;
  /** HTTP validators for conditional refresh, when the server supplied them. */
  readonly etag?: string;
  readonly lastModified?: string;
  readonly health: SubscriptionHealth;
  /** Plain-language elaboration of a non-ok health (http status, parse line, age). */
  readonly detail?: string;
  /** Count of events from the most recent successful parse. */
  readonly eventCount?: number;
}

/** A conditional-fetch request the injected fetcher receives. */
export interface FeedFetchRequest {
  readonly url: string;
  readonly etag?: string;
  readonly lastModified?: string;
}

/** The result the injected fetcher returns. Tests supply this from fake feeds. */
export type FeedFetchResult =
  | { readonly kind: 'ok'; readonly body: string; readonly etag?: string; readonly lastModified?: string }
  | { readonly kind: 'not-modified'; readonly etag?: string; readonly lastModified?: string }
  | { readonly kind: 'error'; readonly status?: number; readonly message: string };

/** Injected network boundary — the ONLY way this module reaches the network. */
export type FeedFetcher = (req: FeedFetchRequest) => Promise<FeedFetchResult>;

/** Injected clock, so refresh/staleness timing is deterministic in tests. */
export type Clock = () => number;

/** The per-refresh report a caller can turn into an honest status line. */
export interface RefreshReport {
  readonly name: string;
  /**
   *  - 'updated'      — fetched fresh body, parsed, events replaced.
   *  - 'not-modified' — server said 304; kept prior events, refreshed timestamp.
   *  - 'skipped'      — not due yet and not forced.
   *  - 'unreachable'  — fetch failed at the network stage.
   *  - 'parse-error'  — fetched, but the body could not be parsed.
   */
  readonly outcome: 'updated' | 'not-modified' | 'skipped' | 'unreachable' | 'parse-error';
  readonly health: SubscriptionHealth;
  readonly eventCount?: number;
  readonly detail?: string;
}

/** Serialisable subscription metadata for a caller that persists across restarts. */
export interface SubscriptionSnapshot {
  readonly name: string;
  readonly url: string;
  readonly refreshIntervalMs: number;
  readonly lastFetchedAt?: number;
  readonly lastSucceededAt?: number;
  readonly etag?: string;
  readonly lastModified?: string;
}
