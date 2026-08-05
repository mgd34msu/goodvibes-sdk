import type { ToolDefinition } from '../../types/tools.js';

export const PROFILE_TOOL_SCHEMA: ToolDefinition = {
  name: 'profile',
  description:
    'Record what the owner tells you about himself: trips and other dated plans, birthdays and '
    + 'anniversaries, declared profile fields, and free-text facts. Also reads back what is stored, '
    + 'and records that he has an upcoming occasion in hand so he stops being reminded about it. '
    + 'Use it in the same turn he says the thing — recording is part of answering, not an offer to make.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['record_trip', 'record_date', 'set_field', 'note', 'list', 'acknowledge_occasion'],
        description:
          'record_trip: a trip or any dated plan, with a start and end date. '
          + 'record_date: a birthday, anniversary or other date that recurs or matters on one day. '
          + 'set_field: one of the declared profile fields, by id. '
          + 'note: a free-text fact under a profile section. '
          + 'list: read back the dates and plans already stored. '
          + 'acknowledge_occasion: he has this one in hand, so stop reminding him about it. Use it '
          + 'whenever he responds to a reminder by saying he knows, he has it covered, he is already '
          + 'sorting it, or that he does not want to hear about it again. It stops the reminders for '
          + 'that occurrence only; the date stays on his profile, every other date is untouched, and '
          + 'next year asks fresh.',
      },
      said: {
        type: 'string',
        description:
          'The owner\'s own words that this came from, quoted verbatim. Required for every write. '
          + 'This is what makes "where did you get that?" answerable later, so quote him rather than '
          + 'paraphrasing.',
      },
      title: {
        type: 'string',
        description: '(record_trip, record_date) What to call it, e.g. "Trip to Picayune" or "Mum\'s birthday".',
      },
      from: {
        type: 'string',
        description: '(record_trip) Start date as YYYY-MM-DD.',
      },
      to: {
        type: 'string',
        description: '(record_trip) End date as YYYY-MM-DD.',
      },
      destination: {
        type: 'string',
        description: '(record_trip) Where he is going, e.g. "Picayune MS".',
      },
      away: {
        type: 'boolean',
        description:
          '(record_trip) True when this takes him away from home. Travel is away; a week of building '
          + 'work at the house is a real dated plan that is not. Default false.',
      },
      details: {
        type: 'array',
        items: { type: 'string' },
        description:
          '(record_trip) Everything else he gave, one detail per entry: confirmation number, each '
          + 'flight with its number and times, who is travelling, and why he is going. Keep his '
          + 'figures exactly; these are the reason he pasted the itinerary.',
      },
      date: {
        type: 'string',
        description:
          '(record_date) MM-DD for something that comes round every year, or YYYY-MM-DD for a single day.',
      },
      kind: {
        type: 'string',
        enum: ['gift-giving', 'remember-only', 'neither'],
        description:
          '(record_date) Whether this is something to sort a gift for, something to simply remember, '
          + 'or neither. Never guess it — no rule tells a birthday from a death anniversary. Ask him '
          + 'if he did not say.',
      },
      person: {
        type: 'string',
        description: '(record_date) Whose date it is, when it belongs to someone else.',
      },
      self: {
        type: 'boolean',
        description:
          '(record_date) True when the date is about the OWNER himself — his own birthday, his own '
          + 'anniversary of something. He knows his own dates, so one he only has to remember is kept '
          + 'and answerable but never pushed at him. Set it when he says "my birthday" rather than '
          + 'putting his name in `person`.',
      },
      occasionId: {
        type: 'string',
        description:
          '(acknowledge_occasion) Which occasion, by the id `list` gives back. Its title normalised — '
          + 'lower case, single spaces.',
      },
      occurrence: {
        type: 'string',
        description:
          '(acknowledge_occasion) The specific date as YYYY-MM-DD, when he means one that is not the '
          + 'next one. Omit for the upcoming occurrence, which is almost always what he means.',
      },
      recurrence: {
        type: 'string',
        enum: ['annual', 'once'],
        description: '(record_date) Whether it repeats every year. Inferred from the date format when omitted.',
      },
      leadDays: {
        type: 'number',
        description: '(record_date) How many days ahead to raise it, when he asked for something other than the default.',
      },
      fieldId: {
        type: 'string',
        description:
          '(set_field) The declared field id, e.g. "location.city", "location.timezone", '
          + '"commerce.shippingAddress", "style.verbosity". A list of valid ids comes back if this one is unknown.',
      },
      value: {
        type: 'string',
        description: '(set_field) The value to store.',
      },
      section: {
        type: 'string',
        description:
          '(note) The profile section to file it under, e.g. "People", "Places", "Work", "Preferences", "Notes".',
      },
      text: {
        type: 'string',
        description: '(note) The fact, as one sentence.',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
  sideEffects: ['state'],
  concurrency: 'serial',
};

export interface ProfileToolInput {
  readonly action: 'record_trip' | 'record_date' | 'set_field' | 'note' | 'list' | 'acknowledge_occasion';
  readonly said?: string | undefined;
  readonly title?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly destination?: string | undefined;
  readonly away?: boolean | undefined;
  readonly details?: readonly string[] | undefined;
  readonly date?: string | undefined;
  readonly kind?: string | undefined;
  readonly person?: string | undefined;
  readonly self?: boolean | undefined;
  readonly occasionId?: string | undefined;
  readonly occurrence?: string | undefined;
  readonly recurrence?: string | undefined;
  readonly leadDays?: number | undefined;
  readonly fieldId?: string | undefined;
  readonly value?: string | undefined;
  readonly section?: string | undefined;
  readonly text?: string | undefined;
}
