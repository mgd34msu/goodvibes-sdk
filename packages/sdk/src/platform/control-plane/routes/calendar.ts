/**
 * routes/calendar.ts — the daemon actually serving `calendar.events.*` and
 * `calendar.ics.*`.
 *
 * These five methods shipped cataloged with `invokable: false` for one
 * reason: the connector that could satisfy them lived inside a single product,
 * so the daemon had nothing to call. A caller who trusted the advertisement
 * and hit `GET /api/calendar/events` got a 404, and scheduled work, triggers
 * and channel-driven work could not read or write a calendar at all with no
 * product process attached.
 *
 * The connector is now platform capability (`platform/google`), so this module
 * is the thin part: it maps the descriptors' declared input and output shapes
 * onto a narrow service slice and nothing else. It performs no I/O, holds no
 * credential, and knows nothing about Google — a CalDAV-backed or Microsoft
 * Graph-backed implementation of `CalendarGatewayService` would serve the same
 * verbs unchanged.
 *
 * Two things are deliberate:
 *
 *  - **`confirm: true` is enforced here, not only advertised.** `events.create`
 *    and `ics.import` write to a real calendar. The descriptors mark them
 *    `dangerous`/`admin` and require `confirm` in their input schema; this
 *    module refuses without it as well, so the guarantee does not depend on
 *    schema validation being reached by every transport.
 *  - **A failure carries its own fix.** The connector answers with
 *    `{ problem, fix }` rather than an exception, and both survive into the
 *    error a caller sees, because "Google refused the request because the
 *    credential lacks the required permission" plus "re-authorize with the
 *    needed scope" is actionable where a bare 500 is not.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { refuseNonUserRequest } from './explicit-user-request.js';
import { readInvocationParams } from './invocation-params.js';

/** One event, in the shape `calendar.events.list` advertises. */
export interface CalendarGatewayEventSummary {
  readonly id: string;
  readonly title: string;
  readonly start: string;
  readonly end: string;
  readonly location?: string;
  readonly description?: string;
  readonly attendees?: readonly string[];
}

/** One event, in the shape `calendar.events.get` advertises. */
export interface CalendarGatewayEventDetail extends CalendarGatewayEventSummary {
  readonly uid?: string;
  readonly recurrence?: string;
}

export interface CalendarGatewayListInput {
  readonly calendarId?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly limit?: number | undefined;
}

export interface CalendarGatewayCreateInput {
  readonly title: string;
  readonly start: string;
  readonly end: string;
  readonly description?: string | undefined;
  readonly location?: string | undefined;
  readonly attendees?: readonly string[] | undefined;
  readonly calendarId?: string | undefined;
}

export interface CalendarGatewayCreated {
  readonly eventId: string;
  readonly uid: string;
  readonly createdAt: string;
}

export interface CalendarGatewayIcsExport {
  readonly icsContent: string;
  readonly eventCount: number;
}

export interface CalendarGatewayIcsImport {
  readonly imported: number;
  readonly eventIds: readonly string[];
  readonly errors: readonly string[];
}

/**
 * What a calendar backend must be able to do to serve these verbs.
 *
 * Every method reports failure by throwing `GatewayVerbError` with an honest
 * status — a missing scope is a 403, an unknown event id a 404, an
 * unconfigured account a 400 naming what to configure. Nothing here returns a
 * plausible empty result in place of an error.
 */
export interface CalendarGatewayService {
  listEvents(input: CalendarGatewayListInput): Promise<readonly CalendarGatewayEventSummary[]>;
  getEvent(eventId: string, calendarId?: string | undefined): Promise<CalendarGatewayEventDetail>;
  createEvent(input: CalendarGatewayCreateInput): Promise<CalendarGatewayCreated>;
  exportIcs(input: CalendarGatewayListInput): Promise<CalendarGatewayIcsExport>;
  importIcs(icsContent: string, calendarId?: string | undefined): Promise<CalendarGatewayIcsImport>;
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readRequiredString(value: unknown, field: string): string {
  const read = readOptionalString(value);
  if (read === undefined) {
    throw new GatewayVerbError(`${field} (non-empty string) is required`, 'INVALID_ARGUMENT', 400, field);
  }
  return read;
}

function readOptionalNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return undefined;
  return Math.trunc(parsed);
}

function readOptionalStringList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
  return entries.length > 0 ? entries : undefined;
}

/**
 * A write verb without `confirm: true` is refused before the backend is
 * touched. See the module header for why this is not left to schema
 * validation alone.
 */
function requireConfirmation(params: Record<string, unknown>, action: string): void {
  if (params.confirm !== true) {
    throw new GatewayVerbError(
      `${action} writes to a real calendar. Re-issue with confirm: true once the change has been reviewed.`,
      'CONFIRMATION_REQUIRED',
      400,
    );
  }
}

function listInputFrom(params: Record<string, unknown>): CalendarGatewayListInput {
  return {
    calendarId: readOptionalString(params.calendarId),
    from: readOptionalString(params.from),
    to: readOptionalString(params.to),
    limit: readOptionalNumber(params.limit),
  };
}

export function createCalendarEventsListHandler(service: CalendarGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const events = await service.listEvents(listInputFrom(readInvocationParams(invocation)));
    return { events };
  };
}

export function createCalendarEventsGetHandler(service: CalendarGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const eventId = readRequiredString(params.eventId, 'eventId');
    return service.getEvent(eventId, readOptionalString(params.calendarId));
  };
}

export function createCalendarEventsCreateHandler(service: CalendarGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    requireConfirmation(params, 'calendar.events.create');
    refuseNonUserRequest(invocation, 'calendar.events.create');
    return service.createEvent({
      title: readRequiredString(params.title, 'title'),
      start: readRequiredString(params.start, 'start'),
      end: readRequiredString(params.end, 'end'),
      description: readOptionalString(params.description),
      location: readOptionalString(params.location),
      attendees: readOptionalStringList(params.attendees),
      calendarId: readOptionalString(params.calendarId),
    });
  };
}

export function createCalendarIcsExportHandler(service: CalendarGatewayService): GatewayMethodHandler {
  return async (invocation) => service.exportIcs(listInputFrom(readInvocationParams(invocation)));
}

export function createCalendarIcsImportHandler(service: CalendarGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    requireConfirmation(params, 'calendar.ics.import');
    refuseNonUserRequest(invocation, 'calendar.ics.import');
    return service.importIcs(
      readRequiredString(params.icsContent, 'icsContent'),
      readOptionalString(params.calendarId),
    );
  };
}

/** Attach the calendar handlers to their registered descriptors (missing = no-op). */
export function registerCalendarGatewayMethods(
  catalog: GatewayMethodCatalog,
  service: CalendarGatewayService,
): void {
  const attach = (id: string, handler: GatewayMethodHandler): void => {
    const descriptor = catalog.get(id);
    if (descriptor) catalog.register(descriptor, handler, { replace: true });
  };
  attach('calendar.events.list', createCalendarEventsListHandler(service));
  attach('calendar.events.get', createCalendarEventsGetHandler(service));
  attach('calendar.events.create', createCalendarEventsCreateHandler(service));
  attach('calendar.ics.export', createCalendarIcsExportHandler(service));
  attach('calendar.ics.import', createCalendarIcsImportHandler(service));
}
