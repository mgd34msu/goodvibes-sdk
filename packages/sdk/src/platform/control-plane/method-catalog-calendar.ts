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
 * Calendar operator methods — event read/write and iCalendar import/export
 * through the standard operator method protocol.
 *
 * These are SERVED. `registerCalendarGatewayMethods`
 * (control-plane/routes/calendar.ts) attaches an in-process handler to each id
 * over a `CalendarGatewayService`, the daemon composition supplies the
 * Google-backed implementation
 * (platform/google/gateway-calendar-service.ts), and
 * `GATEWAY_REST_ROUTES` maps each advertised http path to the same handler, so
 * the REST path and the methodId-invoke endpoint resolve identically.
 *
 * They did not used to be. For a long time none of these five http paths was
 * served by anything: there was no /api/calendar surface at any prefix, no
 * calendar-routes.ts, and no handler. They carried `invokable: false` so the
 * published contract and the live method-dispatch path both said "cataloged,
 * not callable" rather than letting a caller discover the 404 the hard way.
 * The reason was never the routing — it was that the only implementation
 * lived inside one product, so the daemon had nothing to call, and scheduled
 * work, triggers and channel-driven work could not touch a calendar at all.
 * Hoisting the connector into the SDK is what made serving them possible.
 *
 * The route-reconcile regression gate (method-catalog-route-reconcile.ts,
 * exercised in test/capability-route-reconcile.test.ts) keeps the two halves
 * honest in both directions: a descriptor that advertises an http path no
 * route serves reddens it, and so does one that quietly reappears unmarked.
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
  }),
];
