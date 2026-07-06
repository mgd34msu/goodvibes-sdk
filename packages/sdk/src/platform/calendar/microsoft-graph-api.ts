/**
 * microsoft-graph-api.ts — the Microsoft Graph client over an access token and the
 * injected HttpFetch. Lists calendars (me/calendars), lists events over a window
 * (me/calendars/{id}/calendarView, which returns expanded instances), and creates
 * events (me/calendars/{id}/events). A Prefer: outlook.timezone="UTC" header makes
 * Graph return UTC wall times so normalization is honest. Paging follows
 * @odata.nextLink; failures are named degraded states via CalendarApiError.
 */

import { authedRequest } from './calendar-api-shared.js';
import { normalizeGraphEvent } from './merged-calendar-model.js';
import type { EventDateTime } from './types.js';
import type { HttpFetch, MergedCalendarEvent, NewCalendarEvent, ProviderCalendar } from './oauth-types.js';

const BASE = 'https://graph.microsoft.com/v1.0';
const UTC_PREFER = { Prefer: 'outlook.timezone="UTC"' } as const;

/** List the user's calendars; write access comes from canEdit. */
export async function listGraphCalendars(fetchImpl: HttpFetch, token: string): Promise<ProviderCalendar[]> {
  const out: ProviderCalendar[] = [];
  let next: string | undefined = `${BASE}/me/calendars?$select=id,name,canEdit,isDefaultCalendar&$top=100`;
  while (next) {
    const body = (await authedRequest(fetchImpl, 'microsoft', { url: next, method: 'GET', token })) as {
      value?: unknown[];
      '@odata.nextLink'?: unknown;
    };
    for (const raw of body.value ?? []) {
      const item = (raw ?? {}) as { id?: unknown; name?: unknown; canEdit?: unknown; isDefaultCalendar?: unknown };
      if (typeof item.id !== 'string') continue;
      out.push({
        id: item.id,
        name: typeof item.name === 'string' ? item.name : item.id,
        provider: 'microsoft',
        ...(item.isDefaultCalendar === true ? { primary: true } : {}),
        canWrite: item.canEdit === true,
      });
    }
    next = typeof body['@odata.nextLink'] === 'string' ? body['@odata.nextLink'] : undefined;
  }
  return out;
}

export interface GraphEventsQuery {
  readonly calendarId: string;
  readonly calendarLabel: string;
  /** ISO lower bound, e.g. '2026-07-01T00:00:00Z'. */
  readonly start: string;
  /** ISO upper bound. */
  readonly end: string;
  readonly pageSize?: number;
}

/** List events over a window via calendarView, paging @odata.nextLink to exhaustion. */
export async function listGraphEvents(
  fetchImpl: HttpFetch,
  token: string,
  query: GraphEventsQuery,
): Promise<MergedCalendarEvent[]> {
  const out: MergedCalendarEvent[] = [];
  const first = new URL(`${BASE}/me/calendars/${encodeURIComponent(query.calendarId)}/calendarView`);
  first.searchParams.set('startDateTime', query.start);
  first.searchParams.set('endDateTime', query.end);
  first.searchParams.set('$select', 'id,iCalUId,subject,bodyPreview,location,start,end,isAllDay');
  first.searchParams.set('$orderby', 'start/dateTime');
  first.searchParams.set('$top', String(query.pageSize ?? 100));
  let next: string | undefined = first.toString();
  while (next) {
    const body = (await authedRequest(fetchImpl, 'microsoft', {
      url: next,
      method: 'GET',
      token,
      extraHeaders: UTC_PREFER,
    })) as { value?: unknown[]; '@odata.nextLink'?: unknown };
    for (const raw of body.value ?? []) {
      const event = normalizeGraphEvent(raw, query.calendarId, query.calendarLabel);
      if (event) out.push(event);
    }
    next = typeof body['@odata.nextLink'] === 'string' ? body['@odata.nextLink'] : undefined;
  }
  return out;
}

/** Create an event; returns it normalized into the merged model. */
export async function createGraphEvent(
  fetchImpl: HttpFetch,
  token: string,
  calendarId: string,
  calendarLabel: string,
  event: NewCalendarEvent,
): Promise<MergedCalendarEvent> {
  const isAllDay = event.start.kind === 'date';
  const payload: Record<string, unknown> = {
    subject: event.summary,
    isAllDay,
    start: graphEventDate(event.start),
    end: graphEventDate(event.end ?? event.start),
    ...(event.location ? { location: { displayName: event.location } } : {}),
    ...(event.description ? { body: { contentType: 'text', content: event.description } } : {}),
  };
  const url = `${BASE}/me/calendars/${encodeURIComponent(calendarId)}/events`;
  const created = await authedRequest(fetchImpl, 'microsoft', {
    url,
    method: 'POST',
    token,
    body: payload,
    extraHeaders: UTC_PREFER,
  });
  const normalized = normalizeGraphEvent(created, calendarId, calendarLabel);
  if (!normalized) throw new Error('Microsoft Graph accepted the event but returned an unreadable body.');
  return normalized;
}

/** Map an EventDateTime to a Graph {dateTime,timeZone} object. */
function graphEventDate(dt: EventDateTime): { dateTime: string; timeZone: string } {
  if (dt.kind === 'date') return { dateTime: `${dt.value}T00:00:00`, timeZone: 'UTC' };
  if (dt.zone === 'tzid' && dt.tzid) return { dateTime: stripZ(dt.value), timeZone: dt.tzid };
  return { dateTime: stripZ(dt.value), timeZone: 'UTC' };
}

function stripZ(value: string): string {
  return value.endsWith('Z') ? value.slice(0, -1) : value;
}
