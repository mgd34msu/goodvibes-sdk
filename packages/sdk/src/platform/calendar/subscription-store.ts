/**
 * subscription-store.ts — named external-calendar feed subscriptions with honest,
 * per-subscription status. The engine that agent-side `/calendar subscribe` and the
 * connect wizard drive.
 *
 * Reaches the network ONLY through an injected `FeedFetcher`, and reads time ONLY
 * through an injected `Clock`. That is the whole IO boundary: tests supply fake
 * feeds and a fake clock, so no test ever touches a real URL, and refresh/staleness
 * timing is deterministic. Persistence is the CALLER's job (the agent stores the
 * feed URL via its secret manager and the rest of the metadata in its config);
 * `snapshot()` / `restore()` move that metadata across restarts, events re-fetched.
 *
 * UX shape (per Mike's least-friction rule): `add({ url })` is paste-URL-and-done —
 * it validates by fetching, auto-derives the subscription name from the feed's
 * X-WR-CALNAME (falling back to the URL host) when the caller gives no name, and
 * applies a sensible default refresh interval with no mandatory knobs. Every status
 * it reports is honest: stale carries its age, unreachable/parse-error carry the
 * stage and detail.
 *
 * PURE of ambient IO — no direct fs/network/process; all IO is injected.
 */

import { parseIcs } from './ics-parser.js';
import type {
  CalendarEvent,
  CalendarSubscription,
  Clock,
  FeedFetcher,
  FeedFetchResult,
  RefreshReport,
  SubscriptionHealth,
  SubscriptionSnapshot,
} from './types.js';

/** Sensible refresh cadence for a read-only feed that rarely changes minute-to-minute. */
export const DEFAULT_REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
/** Never hammer a feed faster than this, even if a caller asks. */
export const MIN_REFRESH_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
/** A feed refreshed less often than this is capped up to here. */
export const MAX_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Data is considered stale once it is older than this multiple of the interval. */
const STALE_MULTIPLE = 2;

export interface SubscriptionStoreOptions {
  readonly fetcher: FeedFetcher;
  readonly clock?: Clock;
  readonly defaultRefreshIntervalMs?: number;
}

export interface AddSubscriptionInput {
  readonly url: string;
  /** Optional; when omitted, derived from the feed's X-WR-CALNAME or the URL host. */
  readonly name?: string;
  readonly refreshIntervalMs?: number;
}

/** The outcome of validate-by-fetch — what the wizard shows before saving. */
export type ValidationResult =
  | {
      readonly ok: true;
      readonly calendarName?: string;
      readonly eventCount: number;
      readonly derivedName: string;
    }
  | {
      readonly ok: false;
      /** Which stage failed, so failure wording can name it honestly. */
      readonly stage: 'fetch' | 'parse';
      readonly detail: string;
    };

export type AddResult =
  | { readonly ok: true; readonly subscription: CalendarSubscription; readonly report: RefreshReport }
  | { readonly ok: false; readonly stage: 'fetch' | 'parse' | 'duplicate'; readonly detail: string };

/** The last completed refresh result, used to derive live health. */
type LastResult = 'ok' | 'not-modified' | 'unreachable' | 'parse-error' | undefined;

interface SubscriptionRecord {
  name: string;
  url: string;
  refreshIntervalMs: number;
  lastFetchedAt?: number | undefined;
  lastSucceededAt?: number | undefined;
  etag?: string | undefined;
  lastModified?: string | undefined;
  lastResult: LastResult;
  lastDetail?: string | undefined;
  events: CalendarEvent[];
  eventCount?: number | undefined;
}

/** Clamp a requested refresh interval into the safe [MIN, MAX] band. */
function clampInterval(requested: number | undefined, fallback: number): number {
  const v = requested ?? fallback;
  if (!Number.isFinite(v) || v <= 0) return fallback;
  return Math.max(MIN_REFRESH_INTERVAL_MS, Math.min(MAX_REFRESH_INTERVAL_MS, v));
}

/** Best-effort host for name/derivation fallback; never throws. */
function urlHost(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/**
 * Mask a feed URL for display. Google/Outlook "secret address" URLs grant read
 * access, so a subscription's URL is secrets-adjacent — surfaces should show this,
 * never the raw URL. Keeps the scheme+host and the last few chars, masks the middle.
 */
export function maskFeedUrl(url: string): string {
  try {
    const u = new URL(url);
    const tail = u.pathname.length > 6 ? u.pathname.slice(-6) : u.pathname;
    return `${u.protocol}//${u.host}/…${tail}`;
  } catch {
    if (url.length <= 10) return '…';
    return `${url.slice(0, 4)}…${url.slice(-4)}`;
  }
}

export class SubscriptionStore {
  private readonly fetcher: FeedFetcher;
  private readonly clock: Clock;
  private readonly defaultInterval: number;
  private readonly records = new Map<string, SubscriptionRecord>();

  constructor(options: SubscriptionStoreOptions) {
    this.fetcher = options.fetcher;
    this.clock = options.clock ?? (() => Date.now());
    this.defaultInterval = clampInterval(options.defaultRefreshIntervalMs, DEFAULT_REFRESH_INTERVAL_MS);
  }

  /**
   * Fetch a feed WITHOUT saving it and report whether it is a usable calendar. Drives
   * the wizard's validate-before-save step and the derived-name preview.
   */
  async validateByFetch(url: string, requestedName?: string): Promise<ValidationResult> {
    const res = await this.fetcher({ url });
    if (res.kind === 'error') {
      return { ok: false, stage: 'fetch', detail: res.status ? `HTTP ${res.status}: ${res.message}` : res.message };
    }
    if (res.kind === 'not-modified') {
      // A cold validate should never see 304 (no validators sent); treat as fetch failure.
      return { ok: false, stage: 'fetch', detail: 'Server returned 304 Not Modified to an unconditional request — no calendar body to validate.' };
    }
    const parsed = parseIcs(res.body);
    if (parsed.events.length === 0 && parsed.skipped.length === 0 && !parsed.calendarName) {
      return { ok: false, stage: 'parse', detail: 'Fetched, but no VEVENTs or calendar name were found — this does not look like an iCalendar feed.' };
    }
    const derivedName = this.deriveName(requestedName, parsed.calendarName, url);
    return {
      ok: true,
      ...(parsed.calendarName !== undefined ? { calendarName: parsed.calendarName } : {}),
      eventCount: parsed.events.length,
      derivedName,
    };
  }

  /**
   * Paste-URL-and-done: validate by fetching, and on success register the subscription
   * with an auto-derived name and default cadence, storing its events. Refuses (without
   * saving) on a fetch/parse failure or a duplicate name, always with an honest reason.
   */
  async add(input: AddSubscriptionInput): Promise<AddResult> {
    // Single unconditional fetch — no separate validate round trip. We fetch once,
    // derive the name from the body, then apply that SAME result into the record.
    const now = this.clock();
    const res = await this.fetcher({ url: input.url });
    if (res.kind === 'error') {
      return { ok: false, stage: 'fetch', detail: res.status ? `HTTP ${res.status}: ${res.message}` : res.message };
    }
    if (res.kind === 'not-modified') {
      return { ok: false, stage: 'fetch', detail: 'Server returned 304 Not Modified to an unconditional request — no calendar body to add.' };
    }
    const parsed = parseIcs(res.body);
    if (parsed.events.length === 0 && parsed.skipped.length === 0 && !parsed.calendarName) {
      return { ok: false, stage: 'parse', detail: 'Fetched, but no VEVENTs or calendar name were found — this does not look like an iCalendar feed.' };
    }

    const name = this.deriveName(input.name, parsed.calendarName, input.url);
    const record: SubscriptionRecord = {
      name,
      url: input.url,
      refreshIntervalMs: clampInterval(input.refreshIntervalMs, this.defaultInterval),
      lastResult: undefined,
      events: [],
    };
    this.records.set(name, record);
    record.lastFetchedAt = now;
    const report = this.applyFetch(record, res, now);
    return { ok: true, subscription: this.toPublic(record), report };
  }

  /** Remove a subscription and drop its cached events. Returns whether it existed. */
  remove(name: string): boolean {
    return this.records.delete(name);
  }

  list(): CalendarSubscription[] {
    return [...this.records.values()].map((r) => this.toPublic(r));
  }

  get(name: string): CalendarSubscription | undefined {
    const r = this.records.get(name);
    return r ? this.toPublic(r) : undefined;
  }

  has(name: string): boolean {
    return this.records.has(name);
  }

  /** Events from the most recent successful parse of the named subscription. */
  events(name: string): readonly CalendarEvent[] {
    return this.records.get(name)?.events ?? [];
  }

  /** All subscriptions' events, each tagged with its source subscription name. */
  allEvents(): { readonly name: string; readonly events: readonly CalendarEvent[] }[] {
    return [...this.records.values()].map((r) => ({ name: r.name, events: r.events }));
  }

  /**
   * Refresh one subscription. Skips the network when not due unless `force`. Sends
   * conditional-fetch validators (etag/last-modified) so an unchanged feed comes back
   * 304 and keeps its events. Updates honest status either way.
   */
  async refresh(name: string, opts: { force?: boolean } = {}): Promise<RefreshReport> {
    const r = this.records.get(name);
    if (!r) return { name, outcome: 'skipped', health: 'never-fetched', detail: `No subscription named '${name}'.` };

    const now = this.clock();
    if (!opts.force && r.lastFetchedAt !== undefined && now - r.lastFetchedAt < r.refreshIntervalMs) {
      return { name, outcome: 'skipped', health: this.healthOf(r, now), ...(r.eventCount !== undefined ? { eventCount: r.eventCount } : {}), detail: 'Not due for refresh yet.' };
    }

    r.lastFetchedAt = now;
    const res = await this.fetcher({
      url: r.url,
      ...(r.etag !== undefined ? { etag: r.etag } : {}),
      ...(r.lastModified !== undefined ? { lastModified: r.lastModified } : {}),
    });
    return this.applyFetch(r, res, now);
  }

  /** Apply a fetch result to a record, mutating status/events and returning the honest report. */
  private applyFetch(r: SubscriptionRecord, res: FeedFetchResult, now: number): RefreshReport {
    const name = r.name;
    if (res.kind === 'error') {
      r.lastResult = 'unreachable';
      r.lastDetail = res.status ? `HTTP ${res.status}: ${res.message}` : res.message;
      return { name, outcome: 'unreachable', health: this.healthOf(r, now), ...(r.eventCount !== undefined ? { eventCount: r.eventCount } : {}), detail: r.lastDetail };
    }

    if (res.kind === 'not-modified') {
      r.lastResult = 'not-modified';
      r.lastSucceededAt = now;
      if (res.etag !== undefined) r.etag = res.etag;
      if (res.lastModified !== undefined) r.lastModified = res.lastModified;
      r.lastDetail = undefined;
      return { name, outcome: 'not-modified', health: this.healthOf(r, now), ...(r.eventCount !== undefined ? { eventCount: r.eventCount } : {}) };
    }

    const parsed = parseIcs(res.body);
    if (parsed.events.length === 0 && parsed.skipped.length > 0) {
      r.lastResult = 'parse-error';
      r.lastDetail = `Fetched, but every VEVENT was unusable: ${parsed.skipped[0]?.message ?? 'no usable events'}`;
      return { name, outcome: 'parse-error', health: this.healthOf(r, now), detail: r.lastDetail };
    }

    r.events = [...parsed.events];
    r.eventCount = parsed.events.length;
    r.lastResult = 'ok';
    r.lastSucceededAt = now;
    r.lastDetail = parsed.diagnostics.length > 0 ? `${parsed.diagnostics.length} note(s): ${parsed.diagnostics[0]?.message ?? ''}` : undefined;
    if (res.etag !== undefined) r.etag = res.etag;
    if (res.lastModified !== undefined) r.lastModified = res.lastModified;
    return { name, outcome: 'updated', health: 'ok', eventCount: r.eventCount, ...(r.lastDetail !== undefined ? { detail: r.lastDetail } : {}) };
  }

  /** Refresh every subscription that is due (or never fetched). Used on boot + on demand. */
  async refreshDue(opts: { force?: boolean } = {}): Promise<RefreshReport[]> {
    const reports: RefreshReport[] = [];
    for (const name of this.records.keys()) {
      reports.push(await this.refresh(name, opts));
    }
    return reports;
  }

  /** Metadata snapshot for persistence; events are intentionally excluded (re-fetched on boot). */
  snapshot(): SubscriptionSnapshot[] {
    return [...this.records.values()].map((r) => ({
      name: r.name,
      url: r.url,
      refreshIntervalMs: r.refreshIntervalMs,
      ...(r.lastFetchedAt !== undefined ? { lastFetchedAt: r.lastFetchedAt } : {}),
      ...(r.lastSucceededAt !== undefined ? { lastSucceededAt: r.lastSucceededAt } : {}),
      ...(r.etag !== undefined ? { etag: r.etag } : {}),
      ...(r.lastModified !== undefined ? { lastModified: r.lastModified } : {}),
    }));
  }

  /** Restore subscription metadata (from `snapshot()`); call `refreshDue()` afterward to load events. */
  restore(snapshots: readonly SubscriptionSnapshot[]): void {
    for (const s of snapshots) {
      this.records.set(s.name, {
        name: s.name,
        url: s.url,
        refreshIntervalMs: clampInterval(s.refreshIntervalMs, this.defaultInterval),
        ...(s.lastFetchedAt !== undefined ? { lastFetchedAt: s.lastFetchedAt } : {}),
        ...(s.lastSucceededAt !== undefined ? { lastSucceededAt: s.lastSucceededAt } : {}),
        ...(s.etag !== undefined ? { etag: s.etag } : {}),
        ...(s.lastModified !== undefined ? { lastModified: s.lastModified } : {}),
        lastResult: undefined,
        events: [],
      });
    }
  }

  private deriveName(requested: string | undefined, calendarName: string | undefined, url: string): string {
    const candidate = (requested?.trim() || calendarName?.trim() || urlHost(url)).replace(/\s+/g, ' ').trim();
    let name = candidate || urlHost(url);
    // De-duplicate against existing names so an unnamed second Google feed still lands.
    if (this.records.has(name)) {
      let n = 2;
      while (this.records.has(`${name} (${n})`)) n++;
      name = `${name} (${n})`;
    }
    return name;
  }

  private healthOf(r: SubscriptionRecord, now: number): SubscriptionHealth {
    if (r.lastResult === undefined) return 'never-fetched';
    if (r.lastResult === 'unreachable') return 'unreachable';
    if (r.lastResult === 'parse-error') return 'parse-error';
    if (r.lastSucceededAt === undefined) return 'never-fetched';
    const age = now - r.lastSucceededAt;
    if (age > r.refreshIntervalMs * STALE_MULTIPLE) return 'stale';
    return 'ok';
  }

  private toPublic(r: SubscriptionRecord): CalendarSubscription {
    const now = this.clock();
    const health = this.healthOf(r, now);
    let detail = r.lastDetail;
    if (health === 'stale' && r.lastSucceededAt !== undefined) {
      const ageMin = Math.round((now - r.lastSucceededAt) / 60000);
      detail = `Last updated ${ageMin} min ago (past the ${Math.round(r.refreshIntervalMs / 60000)} min refresh window).`;
    }
    return {
      name: r.name,
      url: r.url,
      refreshIntervalMs: r.refreshIntervalMs,
      ...(r.lastFetchedAt !== undefined ? { lastFetchedAt: r.lastFetchedAt } : {}),
      ...(r.lastSucceededAt !== undefined ? { lastSucceededAt: r.lastSucceededAt } : {}),
      ...(r.etag !== undefined ? { etag: r.etag } : {}),
      ...(r.lastModified !== undefined ? { lastModified: r.lastModified } : {}),
      health,
      ...(detail !== undefined ? { detail } : {}),
      ...(r.eventCount !== undefined ? { eventCount: r.eventCount } : {}),
    };
  }
}
