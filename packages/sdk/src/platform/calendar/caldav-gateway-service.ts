/**
 * caldav-gateway-service.ts — the CalDAV-backed implementation of the daemon's
 * `calendar.*` verbs.
 *
 * A sibling of `google/gateway-calendar-service.ts`, not a replacement for it:
 * both satisfy the same `CalendarGatewayService` slice that
 * `control-plane/routes/calendar.ts` is written against, so the five verbs are
 * served identically whether the operator's calendar is a Google account or any
 * CalDAV server (Fastmail, iCloud, Nextcloud, Radicale, a corporate DAV host).
 * The route layer knows about neither.
 *
 * This is a port, verb for verb, of the CalDAV surface that lived inside one
 * product — the same discovery, the same collection mapping, the same
 * .ics import/export, and the same operator-facing wording, including the
 * config keys the errors name. Two implementations of one advertised capability
 * is how a contract drifts, so there is now one.
 *
 * Three properties are kept exactly as they were:
 *
 *  - **`calendarId` is logical.** It maps inward to a collection URL and never
 *    comes back out; ids handed to a caller are host-relative hrefs, so no
 *    response carries the scheme+host a credential is scoped to.
 *  - **Attendees are display names.** A gateway response carries the CN (or the
 *    address local-part) and never the address itself. The raw value survives
 *    only inside a PUT, where the server needs it to address an invitation.
 *  - **Import is per-event and honest.** One bad VEVENT in a file does not
 *    fail the whole import or vanish from the result — the rest land and the
 *    failure is named, per event, in `errors`.
 *
 * Everything is injected: the HTTP port, the config port, the secret port, the
 * clock and the uid source. Nothing here reads a socket, a file, or `Date.now`.
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
import { CalDavClient, type CalDavHttpPort } from '../google/caldav-client.js';
import { isCalendarResourceType, parseMultistatus } from '../google/caldav-parse.js';
import { parseICS, type ParsedICalEvent } from './caldav-ics.js';
import { generateCalendar, generateICS, type GenerateICalInput } from './caldav-ics-generate.js';
import {
  collectionPathOrRoot,
  collectionUrlFor,
  isHrefLike,
  joinUrl,
  resolveCalDavGatewayConfig,
  resolveResourceUrl,
  stripTrailingSlash,
  toRelativeHref,
  type CalDavConfigPort,
  type CalDavGatewayConfig,
  type CalDavSecretPort,
} from './caldav-gateway-config.js';
import {
  calendarQueryBody,
  calendarQueryByUidBody,
  createCalDavRequest,
  propfindCalendarsBody,
  readHeader,
  type CalDavRequest,
} from './caldav-gateway-wire.js';

/** Everything the service needs, all of it injected. */
export interface CalDavCalendarGatewayServiceOptions {
  /** Reads `surfaces.calendar.*`. */
  readonly config: CalDavConfigPort;
  /** Resolves the CalDAV password from the secret store. */
  readonly secrets: CalDavSecretPort;
  /** The HTTP transport. The fetch-backed adapter is `createFetchCalDavHttpPort`. */
  readonly http: CalDavHttpPort;
  /** Wall clock, injected so DTSTAMP and `createdAt` are deterministic under test. */
  readonly now?: (() => number) | undefined;
  /** UID source for created events, injected for the same reason. */
  readonly randomUuid?: (() => string) | undefined;
}

/** One calendar collection the account can reach. */
export interface CalDavCalendarSummary {
  readonly calendarId: string;
  readonly displayName: string;
}

/**
 * The gateway slice plus discovery. `listCalendars` is not one of the five
 * cataloged verbs — it is what a setup flow calls to fill in
 * `surfaces.calendar.defaultCalendarId` with something real instead of asking
 * an operator to hand-copy a collection path out of a web UI.
 */
export interface CalDavCalendarGatewayService extends CalendarGatewayService {
  listCalendars(): Promise<readonly CalDavCalendarSummary[]>;
}

/** One event as it came off the wire, with where it lives. */
interface CalDavEvent extends ParsedICalEvent {
  /** Opaque, host-relative href (never absolute, never authenticated). */
  readonly href: string;
  /** The logical calendar id this event was read from. */
  readonly calendarId: string;
}

// ---------------------------------------------------------------------------
// Input validation (the wording an operator sees, unchanged)
// ---------------------------------------------------------------------------

function validateIsoDate(value: string, field: string): string {
  if (Number.isNaN(new Date(value).getTime())) {
    throw new GatewayVerbError(
      `Field '${field}' must be a valid ISO-8601 date.`,
      'CALENDAR_BAD_INPUT',
      400,
    );
  }
  return value;
}

/**
 * The page size. Absent means 20; anything else is clamped to 1..200 rather
 * than refused, because a caller asking for 10000 events wants "as many as you
 * will give me", and a caller asking for 0 has a bug that an empty page would
 * hide.
 */
function resolveLimit(limit: number | undefined): number {
  if (limit === undefined) return 20;
  return Math.max(1, Math.min(200, Math.floor(limit)));
}

// ---------------------------------------------------------------------------
// Response mapping (credential-free, address-free, schema-exact)
// ---------------------------------------------------------------------------

function displayAttendees(event: CalDavEvent): string[] {
  return event.attendees.map((attendee) => attendee.displayName).filter((name) => name.length > 0);
}

function toSummary(event: CalDavEvent): CalendarGatewayEventSummary {
  const attendees = displayAttendees(event);
  return {
    id: event.href || event.uid,
    title: event.summary,
    start: event.start,
    end: event.end,
    ...(event.location === undefined ? {} : { location: event.location }),
    ...(event.description === undefined ? {} : { description: event.description }),
    ...(attendees.length > 0 ? { attendees } : {}),
  };
}

function toDetail(event: CalDavEvent): CalendarGatewayEventDetail {
  return {
    ...toSummary(event),
    uid: event.uid,
    ...(event.recurrence === undefined ? {} : { recurrence: event.recurrence }),
  };
}

/** A parsed event back into generator input, preserving what a PUT must re-emit. */
function toGenerateInput(
  event: ParsedICalEvent,
  uid: string,
  dtStamp: string,
): GenerateICalInput {
  return {
    uid,
    summary: event.summary,
    start: event.start,
    end: event.end,
    dtStamp,
    ...(event.description === undefined ? {} : { description: event.description }),
    ...(event.location === undefined ? {} : { location: event.location }),
    // Re-emit attendees by their RAW value so an import preserves the original
    // addressing. Display-name-only reduction applies to gateway responses, not
    // to what the calendar server is told.
    attendees: event.attendees.map((attendee) => attendee.rawValue),
    ...(event.organizerRaw === undefined ? {} : { organizer: event.organizerRaw }),
    ...(event.status === undefined ? {} : { status: event.status }),
    ...(event.recurrence === undefined ? {} : { recurrence: event.recurrence }),
    allDay: event.allDay,
  };
}

/** Every VEVENT carried by a multistatus body, tagged with where it came from. */
function eventsFromMultistatus(xml: string, calendarId: string): CalDavEvent[] {
  const events: CalDavEvent[] = [];
  for (const entry of parseMultistatus(xml)) {
    const calendarData = entry.props['calendar-data'];
    if (!calendarData) continue;
    const href = toRelativeHref(entry.href);
    for (const event of parseICS(calendarData)) {
      events.push({ ...event, href, calendarId });
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function createCalDavCalendarGatewayService(
  options: CalDavCalendarGatewayServiceOptions,
): CalDavCalendarGatewayService {
  const now = options.now ?? ((): number => Date.now());
  const randomUuid = options.randomUuid ?? ((): string => crypto.randomUUID());

  /**
   * Resolved per call rather than cached: the password can be stored, rotated
   * or withdrawn while the daemon is running, and a cached client would keep
   * answering from a credential the owner has already changed.
   */
  async function connect(): Promise<{
    readonly config: CalDavGatewayConfig;
    readonly request: CalDavRequest;
  }> {
    const config = await resolveCalDavGatewayConfig(options.config, options.secrets);
    return { config, request: createCalDavRequest(options.http, config) };
  }

  function stampNow(): string {
    return new Date(now()).toISOString();
  }

  function newUid(): string {
    return `${randomUuid()}@goodvibes`;
  }

  async function readEvents(
    input: CalendarGatewayListInput,
  ): Promise<{ readonly config: CalDavGatewayConfig; readonly events: CalDavEvent[] }> {
    if (input.from !== undefined) validateIsoDate(input.from, 'from');
    if (input.to !== undefined) validateIsoDate(input.to, 'to');
    const { config, request } = await connect();
    const calendarId = input.calendarId && input.calendarId.length > 0
      ? input.calendarId
      : config.defaultCalendarId;
    const response = await request(
      collectionUrlFor(config, calendarId),
      'REPORT',
      calendarQueryBody(input.from, input.to),
      { Depth: '1' },
    );
    return { config, events: eventsFromMultistatus(response.body, calendarId) };
  }

  /**
   * Write one .ics resource into a collection and report the host-relative
   * href it now lives at. `If-None-Match: *` on a create refuses to overwrite
   * an existing resource that happens to share the uid.
   */
  async function putEvent(
    config: CalDavGatewayConfig,
    request: CalDavRequest,
    calendarId: string,
    uid: string,
    ics: string,
    guardAgainstOverwrite: boolean,
  ): Promise<string> {
    const collectionUrl = collectionUrlFor(config, calendarId);
    const resourcePath = `${uid}.ics`;
    const response = await request(
      joinUrl(collectionUrl, resourcePath),
      'PUT',
      ics,
      guardAgainstOverwrite ? { 'If-None-Match': '*' } : undefined,
    );
    // Prefer the server-assigned location; otherwise the relative resource path.
    const location = readHeader(response.headers, 'Location');
    return location !== undefined && location.length > 0
      ? toRelativeHref(location)
      : toRelativeHref(joinUrl(collectionPathOrRoot(collectionUrl, config.baseUrl), resourcePath));
  }

  return {
    async listCalendars(): Promise<readonly CalDavCalendarSummary[]> {
      const { config, request } = await connect();
      const response = await request(
        stripTrailingSlash(config.baseUrl),
        'PROPFIND',
        propfindCalendarsBody(),
        { Depth: '1' },
      );
      const calendars = collectionsFrom(response.body, config.defaultCalendarId);
      if (calendars.length > 0) return calendars;

      // The configured URL is not itself a calendar home (a server root, or a
      // principal URL). Chain the standard discovery — current-user-principal,
      // then calendar-home-set, then the collections under it — through the
      // hoisted client, which speaks exactly those three PROPFINDs.
      const discovered = await new CalDavClient({
        http: options.http,
        auth: { kind: 'basic', username: config.username, password: config.password },
      }).discover(config.baseUrl);
      if (discovered.ok && discovered.calendars.length > 0) {
        return discovered.calendars.map((calendar) => ({
          calendarId: logicalIdFor(toRelativeHref(calendar.href), config.defaultCalendarId),
          displayName: calendar.displayName.length > 0
            ? calendar.displayName
            : logicalIdFor(toRelativeHref(calendar.href), config.defaultCalendarId),
        }));
      }
      // Nothing advertised a calendar collection. The configured default is
      // still a usable answer — it is the collection every other verb writes
      // to — and is a better reply than an empty list that reads as "you have
      // no calendars".
      return [{ calendarId: config.defaultCalendarId, displayName: config.defaultCalendarId }];
    },

    async listEvents(input: CalendarGatewayListInput): Promise<readonly CalendarGatewayEventSummary[]> {
      const { events } = await readEvents(input);
      const sorted = [...events].sort((a, b) => a.start.localeCompare(b.start));
      return sorted.slice(0, resolveLimit(input.limit)).map(toSummary);
    },

    async getEvent(
      eventId: string,
      calendarId?: string | undefined,
    ): Promise<CalendarGatewayEventDetail> {
      const { config, request } = await connect();
      const id = calendarId && calendarId.length > 0 ? calendarId : config.defaultCalendarId;
      const collectionUrl = collectionUrlFor(config, id);

      // Strategy 1 — an href-like identifier (a path, or a *.ics resource
      // name): resolve it to a single resource URL and GET that. A true
      // single-event fetch, not a collection scan.
      if (isHrefLike(eventId)) {
        let body: string;
        try {
          body = (await request(
            resolveResourceUrl(collectionUrl, config.baseUrl, eventId),
            'GET',
            undefined,
            { Depth: '0' },
          )).body;
        } catch (error) {
          // A 404 is "no such event"; anything else is a real failure.
          if (error instanceof GatewayVerbError && error.code === 'CALENDAR_NOT_FOUND') {
            throw notFound(eventId);
          }
          throw error;
        }
        const parsed = parseICS(body);
        const first = parsed[0];
        if (first === undefined) throw notFound(eventId);
        return toDetail({ ...first, href: toRelativeHref(eventId), calendarId: id });
      }

      // Strategy 2 — a bare UID: ask the server for only the matching resource
      // via a UID prop-filter. Some servers ignore an unsupported prop-filter
      // and return the whole collection, so the exact UID is confirmed here as
      // well; a near-miss must never come back as the answer.
      const response = await request(collectionUrl, 'REPORT', calendarQueryByUidBody(eventId), { Depth: '1' });
      const found = eventsFromMultistatus(response.body, id).find((event) => event.uid === eventId);
      if (found === undefined) throw notFound(eventId);
      return toDetail(found);
    },

    async createEvent(input: CalendarGatewayCreateInput): Promise<CalendarGatewayCreated> {
      const start = validateIsoDate(input.start, 'start');
      const end = validateIsoDate(input.end, 'end');
      if (new Date(end).getTime() < new Date(start).getTime()) {
        throw new GatewayVerbError(
          "Field 'end' must not be before 'start'.",
          'CALENDAR_BAD_INPUT',
          400,
        );
      }
      const { config, request } = await connect();
      const calendarId = input.calendarId && input.calendarId.length > 0
        ? input.calendarId
        : config.defaultCalendarId;
      const uid = newUid();
      const createdAt = stampNow();
      const href = await putEvent(
        config,
        request,
        calendarId,
        uid,
        generateICS({
          uid,
          summary: input.title,
          start,
          end,
          dtStamp: createdAt,
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.location === undefined ? {} : { location: input.location }),
          ...(input.attendees === undefined ? {} : { attendees: input.attendees }),
          status: 'confirmed',
        }),
        true,
      );
      return { eventId: href, uid, createdAt };
    },

    async exportIcs(input: CalendarGatewayListInput): Promise<CalendarGatewayIcsExport> {
      const { events } = await readEvents(input);
      const dtStamp = stampNow();
      const inputs = events.map((event) =>
        toGenerateInput(event, event.uid || newUid(), dtStamp),
      );
      return { icsContent: generateCalendar(inputs), eventCount: inputs.length };
    },

    async importIcs(
      icsContent: string,
      calendarId?: string | undefined,
    ): Promise<CalendarGatewayIcsImport> {
      const parsed = parseICS(icsContent);
      if (parsed.length === 0) {
        throw new GatewayVerbError(
          'No VEVENT components found in .ics content.',
          'CALENDAR_EMPTY_ICS',
          400,
        );
      }
      const { config, request } = await connect();
      const id = calendarId && calendarId.length > 0 ? calendarId : config.defaultCalendarId;
      const eventIds: string[] = [];
      const errors: string[] = [];
      for (const event of parsed) {
        const uid = event.uid && event.uid.length > 0 ? event.uid : newUid();
        try {
          const href = await putEvent(
            config,
            request,
            id,
            uid,
            generateICS(toGenerateInput(event, uid, stampNow())),
            false,
          );
          eventIds.push(href);
        } catch (error) {
          errors.push(`${uid}: ${describeImportFailure(error)}`);
        }
      }
      return { imported: eventIds.length, eventIds, errors };
    },
  };
}

function notFound(eventId: string): GatewayVerbError {
  return new GatewayVerbError(`Event not found: ${eventId}`, 'CALENDAR_NOT_FOUND', 404);
}

/**
 * What a per-event import failure says. `GatewayVerbError` messages are already
 * written for an operator and carry no host or credential; anything else is
 * reduced to its message text for the same reason.
 */
function describeImportFailure(error: unknown): string {
  if (error instanceof GatewayVerbError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/**
 * A collection href to a stable logical id: the last path segment, decoded.
 * That is the id an operator sees, and the one `surfaces.calendar.calendars`
 * maps back to a path.
 */
function logicalIdFor(relativeHref: string, fallback: string): string {
  const segments = relativeHref.split('/').filter((segment) => segment.length > 0);
  const last = segments[segments.length - 1];
  return last === undefined ? fallback : decodeURIComponent(last);
}

/** Calendar collections in a PROPFIND multistatus body, de-duplicated by logical id. */
function collectionsFrom(xml: string, fallbackId: string): CalDavCalendarSummary[] {
  const calendars: CalDavCalendarSummary[] = [];
  const seen = new Set<string>();
  for (const entry of parseMultistatus(xml)) {
    if (!isCalendarResourceType(entry.props['resourcetype'])) continue;
    const logical = logicalIdFor(toRelativeHref(entry.href), fallbackId);
    if (seen.has(logical)) continue;
    seen.add(logical);
    const displayName = entry.props['displayname'];
    calendars.push({
      calendarId: logical,
      displayName: displayName !== undefined && displayName.length > 0 ? displayName : logical,
    });
  }
  return calendars;
}
