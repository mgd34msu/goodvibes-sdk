/**
 * google-calendar-api.ts — the Google Calendar API v3 client over an access token
 * and the injected HttpFetch. Lists calendars (calendarList.list), lists events
 * (events.list with timeMin/timeMax paging and singleEvents=true so instances are
 * already expanded), and creates events (events.insert). Every event is normalized
 * into the merged model; every failure is a named degraded state via CalendarApiError.
 */

import { authedRequest } from './calendar-api-shared.js';
import { normalizeGoogleEvent } from './merged-calendar-model.js';
import type { EventDateTime } from './types.js';
import type { HttpFetch, MergedCalendarEvent, NewCalendarEvent, ProviderCalendar } from './oauth-types.js';

const BASE = 'https://www.googleapis.com/calendar/v3';

/** List the user's calendars. Write access is inferred from accessRole. */
export async function listGoogleCalendars(fetchImpl: HttpFetch, token: string): Promise<ProviderCalendar[]> {
  const out: ProviderCalendar[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${BASE}/users/me/calendarList`);
    url.searchParams.set('maxResults', '250');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const body = (await authedRequest(fetchImpl, 'google', { url: url.toString(), method: 'GET', token })) as {
      items?: unknown[];
      nextPageToken?: unknown;
    };
    for (const raw of body.items ?? []) {
      const item = (raw ?? {}) as { id?: unknown; summary?: unknown; primary?: unknown; accessRole?: unknown };
      if (typeof item.id !== 'string') continue;
      const accessRole = typeof item.accessRole === 'string' ? item.accessRole : 'reader';
      out.push({
        id: item.id,
        name: typeof item.summary === 'string' ? item.summary : item.id,
        provider: 'google',
        ...(item.primary === true ? { primary: true } : {}),
        canWrite: accessRole === 'owner' || accessRole === 'writer',
      });
    }
    pageToken = typeof body.nextPageToken === 'string' ? body.nextPageToken : undefined;
  } while (pageToken);
  return out;
}

export interface GoogleEventsQuery {
  readonly calendarId: string;
  readonly calendarLabel: string;
  /** RFC3339 lower bound (inclusive), e.g. '2026-07-01T00:00:00Z'. */
  readonly timeMin: string;
  /** RFC3339 upper bound (exclusive). */
  readonly timeMax: string;
  /** Page size cap per request; the client pages until exhausted. */
  readonly pageSize?: number;
}

/** List events in a window, paging through every page. Instances are pre-expanded. */
export async function listGoogleEvents(
  fetchImpl: HttpFetch,
  token: string,
  query: GoogleEventsQuery,
): Promise<MergedCalendarEvent[]> {
  const out: MergedCalendarEvent[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${BASE}/calendars/${encodeURIComponent(query.calendarId)}/events`);
    url.searchParams.set('timeMin', query.timeMin);
    url.searchParams.set('timeMax', query.timeMax);
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('orderBy', 'startTime');
    url.searchParams.set('maxResults', String(query.pageSize ?? 250));
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const body = (await authedRequest(fetchImpl, 'google', { url: url.toString(), method: 'GET', token })) as {
      items?: unknown[];
      nextPageToken?: unknown;
    };
    for (const raw of body.items ?? []) {
      const status = (raw as { status?: unknown }).status;
      if (status === 'cancelled') continue;
      const event = normalizeGoogleEvent(raw, query.calendarId, query.calendarLabel);
      if (event) out.push(event);
    }
    pageToken = typeof body.nextPageToken === 'string' ? body.nextPageToken : undefined;
  } while (pageToken);
  return out;
}

/** Insert a new event; returns it normalized into the merged model. */
export async function createGoogleEvent(
  fetchImpl: HttpFetch,
  token: string,
  calendarId: string,
  calendarLabel: string,
  event: NewCalendarEvent,
): Promise<MergedCalendarEvent> {
  const payload: Record<string, unknown> = {
    summary: event.summary,
    start: googleEventDate(event.start),
    ...(event.end ? { end: googleEventDate(event.end) } : {}),
    ...(event.location ? { location: event.location } : {}),
    ...(event.description ? { description: event.description } : {}),
  };
  const url = `${BASE}/calendars/${encodeURIComponent(calendarId)}/events`;
  const created = await authedRequest(fetchImpl, 'google', { url, method: 'POST', token, body: payload });
  const normalized = normalizeGoogleEvent(created, calendarId, calendarLabel);
  if (!normalized) throw new Error('Google accepted the event but returned an unreadable body.');
  return normalized;
}

/** Map an EventDateTime to a Google event start/end object. */
function googleEventDate(dt: EventDateTime): Record<string, string> {
  if (dt.kind === 'date') return { date: dt.value };
  if (dt.zone === 'tzid' && dt.tzid) return { dateTime: dt.value, timeZone: dt.tzid };
  // utc or floating: send an explicit UTC anchor so Google does not guess.
  const iso = dt.value.endsWith('Z') ? dt.value : `${dt.value}Z`;
  return { dateTime: iso, timeZone: 'UTC' };
}
