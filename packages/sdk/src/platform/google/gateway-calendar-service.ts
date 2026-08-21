/**
 * The Google-backed implementation of the daemon's `calendar.*` verbs.
 *
 * This is the piece that was missing. `calendar.events.list`,
 * `calendar.events.get`, `calendar.events.create`, `calendar.ics.export` and
 * `calendar.ics.import` were cataloged with `invokable: false` because no
 * daemon-reachable implementation existed, the connector lived inside one
 * product. This adapts the hoisted connector onto the service slice the verb
 * handlers are written against, so the daemon serves them for real, with no
 * product process attached.
 *
 * Credentials come from the daemon's own tier by the platform-wide derivation
 * (`daemonSecretKeyFor`), which is exactly why `setup-plan.ts` derives its
 * secret names the same way: a hand-written name would sit outside daemon
 * ownership and fail to follow a node handover, and the symptom would be
 * calendar going quiet on the node that took over with nothing in the logs to
 * explain it.
 *
 * Every failure the connector reports carries a `problem` and a `fix`, and both
 * survive into the `GatewayVerbError` a caller sees. A missing scope answers
 * "the credential lacks the required permission, re-authorize with the needed
 * scope", not a bare 500.
 */

import { GatewayVerbError } from '../control-plane/routes/gateway-verb-error.js';
import type {
  CalendarGatewayCreateInput,
  CalendarGatewayCreated,
  CalendarGatewayEventDetail,
  CalendarGatewayEventSummary,
  CalendarGatewayIcsExport,
  CalendarGatewayIcsImport,
  CalendarGatewayListInput,
  CalendarGatewayService,
} from '../control-plane/routes/calendar.js';
import { parseIcs } from '../calendar/ics-parser.js';
import {
  recordCalendarEventIngest,
  type CalendarUntrustedIngestRecorder,
} from '../calendar/untrusted-events.js';
import type { CalendarEvent, EventDateTime } from '../calendar/types.js';
import type { GoogleApiFailure, GoogleApiResult, CalendarEventRecord } from './api-client.js';
import { openGoogleConnection, type GoogleConnection, type GoogleConnectionSources } from './connection.js';
import type { GoogleFetchPort } from './oauth-loopback.js';
import type { GoogleApiFetchPort } from './api-client.js';

/** Everything the service needs, all of it injected. */
export interface GoogleCalendarGatewayServiceOptions {
  readonly sources: GoogleConnectionSources;
  readonly fetch: GoogleFetchPort & GoogleApiFetchPort;
  /** Wall clock, injected so `createdAt` is deterministic under test. */
  readonly now?: () => number;
  /**
   * Records that a turn read untrusted event content.
   *
   * An event whose organizer is somebody other than the owner was written by
   * that somebody, and reading it is the same exposure as reading their mail.
   * Recorded from the READ paths, `listEvents`, `getEvent`, `exportIcs` and
   * `importIcs`, each of which runs because a caller asked. An event Google
   * says the owner organized (`organizer.self`) records nothing: he wrote it.
   * See calendar/untrusted-events.ts.
   */
  readonly recordUntrustedIngest?: CalendarUntrustedIngestRecorder | undefined;
}

const NOT_CONNECTED = [
  'No Google account is connected on this machine, so there is no calendar to read or write.',
  'Connect one, then retry.',
].join(' ');

/**
 * Turn a connector failure into an honest HTTP status.
 *
 * The connector already distinguishes "the credential is not permitted to do
 * this" from "the account is being rate limited" from "that id does not
 * exist"; collapsing all three into 500 would throw that away.
 */
function statusFor(failure: GoogleApiFailure): number {
  if (failure.status === 401) return 401;
  if (failure.status === 403) return 403;
  if (failure.status === 404) return 404;
  if (failure.status === 429) return 429;
  if (failure.status === null) return 400;
  return failure.status >= 500 ? 502 : 400;
}

function codeFor(failure: GoogleApiFailure): string {
  if (failure.status === 403) return 'PERMISSION_DENIED';
  if (failure.status === 404) return 'NOT_FOUND';
  if (failure.status === 429) return 'RATE_LIMITED';
  if (failure.status === 401) return 'UNAUTHENTICATED';
  return 'CALENDAR_REQUEST_FAILED';
}

function unwrap<T>(result: GoogleApiResult<T>): T {
  if (result.ok) return result.value;
  throw new GatewayVerbError(`${result.problem} ${result.fix}`, codeFor(result), statusFor(result));
}

function toSummary(record: CalendarEventRecord): CalendarGatewayEventSummary {
  return {
    id: record.id,
    title: record.summary,
    start: record.start,
    end: record.end,
    ...(record.location.length > 0 ? { location: record.location } : {}),
    ...(record.description.length > 0 ? { description: record.description } : {}),
  };
}

function toDetail(record: CalendarEventRecord): CalendarGatewayEventDetail {
  // Google's event id IS the stable identifier a caller round-trips, so `uid`
  // reports the same value rather than inventing a second one that would then
  // disagree with what `events.list` handed back.
  return { ...toSummary(record), uid: record.id };
}

/**
 * Escape a value for an iCalendar TEXT property (RFC 5545 §3.3.11). Backslash
 * first, or the escapes this adds would themselves be escaped.
 */
function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** `2026-07-27T10:00:00Z` / `2026-07-27` -> the iCalendar wire forms. */
function toIcsStamp(value: string): { readonly property: string; readonly value: string } {
  if (!value.includes('T')) {
    return { property: ';VALUE=DATE', value: value.replace(/-/g, '') };
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return { property: '', value };
  return { property: '', value: new Date(parsed).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z') };
}

function renderIcs(events: readonly CalendarEventRecord[], stampMs: number): string {
  const stamp = new Date(stampMs).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const lines: string[] = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//GoodVibes//Calendar Export//EN', 'CALSCALE:GREGORIAN'];
  for (const event of events) {
    const start = toIcsStamp(event.start);
    const end = toIcsStamp(event.end);
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${event.id}`);
    lines.push(`DTSTAMP:${stamp}`);
    lines.push(`DTSTART${start.property}:${start.value}`);
    if (end.value.length > 0) lines.push(`DTEND${end.property}:${end.value}`);
    lines.push(`SUMMARY:${escapeIcsText(event.summary)}`);
    if (event.location.length > 0) lines.push(`LOCATION:${escapeIcsText(event.location)}`);
    if (event.description.length > 0) lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}

/** A parsed .ics datetime back to what the Calendar API accepts. */
function toApiDateTime(value: EventDateTime): string {
  return value.kind === 'date' ? value.value : value.value;
}

export function createGoogleCalendarGatewayService(
  options: GoogleCalendarGatewayServiceOptions,
): CalendarGatewayService {
  const now = options.now ?? ((): number => Date.now());

  /**
   * Opened per call rather than cached: credentials can be connected, adopted
   * or revoked while the daemon is running, and a cached client would keep
   * answering from a credential the owner has already withdrawn.
   */
  async function connect(): Promise<GoogleConnection> {
    const connection = await openGoogleConnection(options.sources, { fetch: options.fetch }, now());
    if (connection === null) {
      throw new GatewayVerbError(NOT_CONNECTED, 'CALENDAR_NOT_CONFIGURED', 400);
    }
    return connection;
  }

  /**
   * Record that a caller just read these events.
   *
   * `organizerIsSelf` is Google's own read-only statement that the owner
   * organized the event; that and only that keeps an event out of the ledger.
   */
  function recordEventsRead(calendarId: string | undefined, events: readonly CalendarEventRecord[]): void {
    recordCalendarEventIngest({
      record: options.recordUntrustedIngest,
      provenance: {
        kind: 'provider',
        provider: 'google',
        ...(calendarId === undefined ? {} : { calendarLabel: calendarId }),
      },
      events: events.map((event) => ({
        summary: event.summary,
        location: event.location,
        description: event.description,
        organizer: event.organizer,
        organizerIsOwner: event.organizerIsSelf,
      })),
      at: new Date(now()).toISOString(),
    });
  }

  async function readEvents(input: CalendarGatewayListInput): Promise<readonly CalendarEventRecord[]> {
    const { client } = await connect();
    const events = unwrap(
      await client.listEvents({
        ...(input.calendarId === undefined ? {} : { calendarId: input.calendarId }),
        ...(input.from === undefined ? {} : { timeMin: input.from }),
        ...(input.to === undefined ? {} : { timeMax: input.to }),
        ...(input.limit === undefined ? {} : { maxResults: input.limit }),
      }),
    );
    recordEventsRead(input.calendarId, events);
    return events;
  }

  return {
    async listEvents(input) {
      return (await readEvents(input)).map(toSummary);
    },

    async getEvent(eventId, calendarId) {
      const { client } = await connect();
      const record = unwrap(await client.getEvent(eventId, calendarId ?? 'primary'));
      recordEventsRead(calendarId, [record]);
      return toDetail(record);
    },

    async createEvent(input: CalendarGatewayCreateInput): Promise<CalendarGatewayCreated> {
      const { client, summary } = await connect();
      if (!summary.canWriteCalendar) {
        throw new GatewayVerbError(
          'The connected Google account was not granted a scope that permits writing to the calendar. Re-authorize with the calendar.events scope.',
          'PERMISSION_DENIED',
          403,
        );
      }
      const created = unwrap(
        await client.createEvent({
          summary: input.title,
          start: input.start,
          end: input.end,
          ...(input.location === undefined ? {} : { location: input.location }),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.calendarId === undefined ? {} : { calendarId: input.calendarId }),
        }),
      );
      return { eventId: created.id, uid: created.id, createdAt: new Date(now()).toISOString() };
    },

    async exportIcs(input): Promise<CalendarGatewayIcsExport> {
      const events = await readEvents(input);
      return { icsContent: renderIcs(events, now()), eventCount: events.length };
    },

    /**
     * Import is per-event and reports partial success honestly: an .ics with
     * one bad VEVENT imports the rest and names the one it could not, rather
     * than failing the whole file or silently dropping it.
     */
    async importIcs(icsContent, calendarId): Promise<CalendarGatewayIcsImport> {
      const { client, summary } = await connect();
      if (!summary.canWriteCalendar) {
        throw new GatewayVerbError(
          'The connected Google account was not granted a scope that permits writing to the calendar. Re-authorize with the calendar.events scope.',
          'PERMISSION_DENIED',
          403,
        );
      }
      const parsed = parseIcs(icsContent);
      // Somebody else's text, read because the caller asked for it to be
      // imported, recorded before anything is written to a real calendar.
      recordCalendarEventIngest({
        record: options.recordUntrustedIngest,
        provenance: { kind: 'ics-import' },
        events: parsed.events,
        at: new Date(now()).toISOString(),
      });
      const eventIds: string[] = [];
      const errors: string[] = [];
      for (const diagnostic of parsed.skipped) {
        errors.push(`Skipped an event in the .ics: ${diagnostic.message}`);
      }
      for (const event of parsed.events as readonly CalendarEvent[]) {
        if (event.end === undefined) {
          errors.push(`"${event.summary || event.uid}" has no end time, so it was not imported.`);
          continue;
        }
        const created = await client.createEvent({
          summary: event.summary,
          start: toApiDateTime(event.start),
          end: toApiDateTime(event.end),
          ...(event.location === undefined ? {} : { location: event.location }),
          ...(event.description === undefined ? {} : { description: event.description }),
          ...(calendarId === undefined ? {} : { calendarId }),
        });
        if (created.ok) eventIds.push(created.value.id);
        else errors.push(`"${event.summary || event.uid}" was not imported: ${created.problem} ${created.fix}`);
      }
      return { imported: eventIds.length, eventIds, errors };
    },
  };
}
