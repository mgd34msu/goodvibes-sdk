import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import {
  STRING_SCHEMA,
  NUMBER_SCHEMA,
  arraySchema,
  objectSchema,
  listOutputSchema,
  bodyEnvelopeSchema,
  methodDescriptor,
} from './method-catalog-shared.js';

const CALENDAR_EVENT_SUMMARY_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  title: STRING_SCHEMA,
  start: STRING_SCHEMA,
  end: STRING_SCHEMA,
  location: STRING_SCHEMA,
  description: STRING_SCHEMA,
  attendees: arraySchema(STRING_SCHEMA),
}, ['id', 'title', 'start', 'end']);

const CALENDAR_EVENT_DETAIL_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  uid: STRING_SCHEMA,
  title: STRING_SCHEMA,
  start: STRING_SCHEMA,
  end: STRING_SCHEMA,
  location: STRING_SCHEMA,
  description: STRING_SCHEMA,
  attendees: arraySchema(STRING_SCHEMA),
  recurrence: STRING_SCHEMA,
}, ['id', 'title', 'start', 'end']);

/**
 * Calendar operator methods — CalDAV-backed event read/write and iCalendar
 * import/export through the standard operator method protocol. Daemon-backed;
 * the SDK publishes the typed contract surface (no internal handler). Local .ics
 * parsing is handled agent-side and does not depend on these contracts.
 *
 * Route-reconcile debt (surfaced by a route-advertisement audit, retired here): none of these five
 * http paths are served by the daemon router — there is no /api/calendar
 * surface at any prefix (confirmed by reading router.ts, every dispatch
 * chain it delegates to, and grepping the full path across packages/sdk/src
 * and packages/daemon-sdk/src; there is no calendar-routes.ts and no
 * calendar handler anywhere). These were originally grandfathered into
 * KNOWN_PRE_EXISTING_ROUTE_DEBT in test/w4-a3-capability-route-reconcile.test.ts
 * as an out-of-ownership finding that audit incidentally surfaced; marked
 * `invokable: false` here so the published contract and the live
 * method-dispatch path both say "cataloged, not callable" instead of
 * letting a caller discover the 404 the hard way. Un-mark a method once its
 * real CalDAV-backed route or handler exists — the route-reconcile
 * regression gate (method-catalog-route-reconcile.ts, exercised in
 * test/w4-a3-capability-route-reconcile.test.ts) will catch it if this
 * comment goes stale and a route reappears without the flag being cleared.
 */
export const builtinGatewayCalendarMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'calendar.events.list',
    title: 'List Calendar Events',
    description: 'Return calendar event summaries from the configured CalDAV calendar within an optional time window.',
    category: 'calendar',
    scopes: ['read:calendar'],
    http: { method: 'GET', path: '/api/calendar/events' },
    inputSchema: objectSchema({
      calendarId: STRING_SCHEMA,
      from: STRING_SCHEMA,
      to: STRING_SCHEMA,
      limit: NUMBER_SCHEMA,
    }),
    outputSchema: listOutputSchema('events', CALENDAR_EVENT_SUMMARY_SCHEMA),
    invokable: false,
  }),
  methodDescriptor({
    id: 'calendar.events.get',
    title: 'Get Calendar Event',
    description: 'Return the full event object including attendees, recurrence, and raw iCalendar UID.',
    category: 'calendar',
    scopes: ['read:calendar'],
    http: { method: 'GET', path: '/api/calendar/events/{eventId}' },
    inputSchema: objectSchema({
      eventId: STRING_SCHEMA,
      calendarId: STRING_SCHEMA,
    }, ['eventId']),
    outputSchema: CALENDAR_EVENT_DETAIL_SCHEMA,
    invokable: false,
  }),
  methodDescriptor({
    id: 'calendar.events.create',
    title: 'Create Calendar Event',
    description: 'Create an event on the configured CalDAV calendar. Requires explicit confirmation.',
    category: 'calendar',
    scopes: ['write:calendar'],
    access: 'admin',
    http: { method: 'POST', path: '/api/calendar/events' },
    inputSchema: bodyEnvelopeSchema({
      title: STRING_SCHEMA,
      start: STRING_SCHEMA,
      end: STRING_SCHEMA,
      description: STRING_SCHEMA,
      attendees: arraySchema(STRING_SCHEMA),
      location: STRING_SCHEMA,
      calendarId: STRING_SCHEMA,
      confirm: { type: 'boolean' },
    }, ['title', 'start', 'end', 'confirm']),
    outputSchema: objectSchema({
      eventId: STRING_SCHEMA,
      uid: STRING_SCHEMA,
      createdAt: STRING_SCHEMA,
    }, ['eventId', 'uid', 'createdAt']),
    invokable: false,
  }),
  methodDescriptor({
    id: 'calendar.ics.import',
    title: 'Import iCalendar',
    description: 'Import raw .ics content into the configured CalDAV calendar. Requires explicit confirmation.',
    category: 'calendar',
    scopes: ['write:calendar'],
    access: 'admin',
    http: { method: 'POST', path: '/api/calendar/ics/import' },
    inputSchema: bodyEnvelopeSchema({
      icsContent: STRING_SCHEMA,
      calendarId: STRING_SCHEMA,
      confirm: { type: 'boolean' },
    }, ['icsContent', 'confirm']),
    outputSchema: objectSchema({
      imported: NUMBER_SCHEMA,
      eventIds: arraySchema(STRING_SCHEMA),
      errors: arraySchema(STRING_SCHEMA),
    }, ['imported', 'eventIds', 'errors']),
    invokable: false,
  }),
  methodDescriptor({
    id: 'calendar.ics.export',
    title: 'Export iCalendar',
    description: 'Export events from the configured CalDAV calendar as raw .ics content within an optional time window.',
    category: 'calendar',
    scopes: ['read:calendar'],
    http: { method: 'GET', path: '/api/calendar/ics/export' },
    inputSchema: objectSchema({
      calendarId: STRING_SCHEMA,
      from: STRING_SCHEMA,
      to: STRING_SCHEMA,
    }),
    outputSchema: objectSchema({
      icsContent: STRING_SCHEMA,
      eventCount: NUMBER_SCHEMA,
    }, ['icsContent', 'eventCount']),
    invokable: false,
  }),
];
