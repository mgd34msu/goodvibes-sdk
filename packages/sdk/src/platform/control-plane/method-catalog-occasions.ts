/**
 * method-catalog-occasions.ts
 *
 * Contract descriptors for the proactive occasions verbs (`occasions.*`), the
 * owner's important dates and plans, and the loop that raises them before they
 * matter. See `docs/occasions.md` for the decision record.
 *
 * Descriptors live here (static) so the generated contract artifacts, the
 * OpenAPI document and the typed-IO maps see them whether or not a handler has
 * been attached yet; `routes/occasions.ts` attaches the handlers when the
 * runtime composition root builds the service. Same descriptor/handler split as
 * `method-catalog-owner-profile.ts`.
 *
 * ## This surface is deliberately complete
 *
 * Every operation a surface needs is here: read the dates, capture one with its
 * confirmation, choose its kind, answer yes/no/later, run the gift interview,
 * remove one with a confirmation, read and set plans, pull what is outstanding,
 * and read what the machine-owned store is holding. A consumer that had to
 * compute anything beyond calling these and rendering the answers would be a
 * second implementation of a rule that lives in the daemon, most dangerously
 * the rule that a nudge never carries the date.
 *
 * ## Two verbs answer with dates and one never does
 *
 * `occasions.list` returns the date and the day count. That is the owner asking
 * their own system what it holds over an authenticated verb, the explicit ask
 * that unlocks a closed-tier read. `occasions.pending` returns the nudge as it
 * would be delivered, and its `subjects` carry a proximity WORD rather than any
 * number, because that payload is what reaches a message channel.
 */
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import {
  BOOLEAN_SCHEMA,
  EMPTY_OBJECT_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  arraySchema,
  methodDescriptor,
  objectSchema,
} from './method-catalog-shared.js';

const NULLABLE_STRING_SCHEMA: Record<string, unknown> = { anyOf: [STRING_SCHEMA, { type: 'null' }] };
const NULLABLE_NUMBER_SCHEMA: Record<string, unknown> = { anyOf: [NUMBER_SCHEMA, { type: 'null' }] };

const OCCASION_KIND_SCHEMA = { type: 'string', enum: ['gift-giving', 'remember-only', 'neither'] } as const;
const OCCASION_ANSWER_SCHEMA = { type: 'string', enum: ['yes', 'no', 'later', 'acknowledged'] } as const;
const OCCASION_SUBJECT_SCHEMA = { type: 'string', enum: ['owner', 'other', 'unattributed'] } as const;
const OCCASION_ACK_SOURCE_SCHEMA = { type: 'string', enum: ['conversation', 'explicit', 'gift-flow'] } as const;
const RECURRENCE_SCHEMA = { type: 'string', enum: ['annual', 'once'] } as const;
const PROXIMITY_SCHEMA = { type: 'string', enum: ['approaching', 'soon', 'imminent'] } as const;

/** A parsed date: `recurring` carries no year, `dated` does. */
export const OCCASION_DATE_SCHEMA = objectSchema({
  kind: { type: 'string', enum: ['recurring', 'dated'] },
  year: NUMBER_SCHEMA,
  month: NUMBER_SCHEMA,
  day: NUMBER_SCHEMA,
}, ['kind', 'month', 'day']);

export const OCCASION_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  title: STRING_SCHEMA,
  date: OCCASION_DATE_SCHEMA,
  recurrence: RECURRENCE_SCHEMA,
  kind: OCCASION_KIND_SCHEMA,
  person: STRING_SCHEMA,
  selfDeclared: BOOLEAN_SCHEMA,
  subject: OCCASION_SUBJECT_SCHEMA,
  leadDays: NULLABLE_NUMBER_SCHEMA,
  mirrored: BOOLEAN_SCHEMA,
  extras: arraySchema(STRING_SCHEMA),
  lineIndex: NUMBER_SCHEMA,
  text: STRING_SCHEMA,
}, ['id', 'title', 'date', 'recurrence', 'kind', 'person', 'selfDeclared', 'subject', 'leadDays', 'mirrored', 'extras', 'lineIndex', 'text']);

export const OCCASION_VIEW_SCHEMA = objectSchema({
  occasion: OCCASION_SCHEMA,
  nextOccurrence: NULLABLE_STRING_SCHEMA,
  daysUntil: NULLABLE_NUMBER_SCHEMA,
  leadDays: NUMBER_SCHEMA,
  inLeadWindow: BOOLEAN_SCHEMA,
  answer: { anyOf: [OCCASION_ANSWER_SCHEMA, { type: 'null' }] },
  mirrored: BOOLEAN_SCHEMA,
}, ['occasion', 'nextOccurrence', 'daysUntil', 'leadDays', 'inLeadWindow', 'answer', 'mirrored']);

/** A line the reader could not type, reported rather than rewritten. */
export const UNPARSED_LINE_SCHEMA = objectSchema({
  lineIndex: NUMBER_SCHEMA,
  text: STRING_SCHEMA,
  reason: STRING_SCHEMA,
}, ['lineIndex', 'text', 'reason']);

export const OCCASION_CONFLICT_SCHEMA = objectSchema({
  occasionId: STRING_SCHEMA,
  title: STRING_SCHEMA,
  dates: arraySchema(STRING_SCHEMA),
  lineIndexes: arraySchema(NUMBER_SCHEMA),
}, ['occasionId', 'title', 'dates', 'lineIndexes']);

export const PLAN_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  title: STRING_SCHEMA,
  from: STRING_SCHEMA,
  to: STRING_SCHEMA,
  away: BOOLEAN_SCHEMA,
  destination: STRING_SCHEMA,
  extras: arraySchema(STRING_SCHEMA),
  lineIndex: NUMBER_SCHEMA,
  text: STRING_SCHEMA,
}, ['id', 'title', 'from', 'to', 'away', 'destination', 'extras', 'lineIndex', 'text']);

/** One occasion inside a nudge. Carries the person; never carries the date. */
export const NUDGE_SUBJECT_SCHEMA = objectSchema({
  occasionId: STRING_SCHEMA,
  title: STRING_SCHEMA,
  person: STRING_SCHEMA,
  kind: OCCASION_KIND_SCHEMA,
  proximity: PROXIMITY_SCHEMA,
  subject: OCCASION_SUBJECT_SCHEMA,
  acknowledged: BOOLEAN_SCHEMA,
}, ['occasionId', 'title', 'person', 'kind', 'proximity', 'subject', 'acknowledged']);

export const OCCASION_NUDGE_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  raisedAt: NUMBER_SCHEMA,
  subjects: arraySchema(NUDGE_SUBJECT_SCHEMA),
  message: STRING_SCHEMA,
  answerable: BOOLEAN_SCHEMA,
}, ['id', 'raisedAt', 'subjects', 'message', 'answerable']);

export const INTERVIEW_STEP_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  prompt: STRING_SCHEMA,
  opensFrom: STRING_SCHEMA,
}, ['id', 'prompt', 'opensFrom']);

export const INTERVIEW_PROGRESS_SCHEMA = objectSchema({
  interviewId: STRING_SCHEMA,
  occasionId: STRING_SCHEMA,
  occurrence: STRING_SCHEMA,
  steps: arraySchema(INTERVIEW_STEP_SCHEMA),
  nextStep: { anyOf: [INTERVIEW_STEP_SCHEMA, { type: 'null' }] },
  complete: BOOLEAN_SCHEMA,
  landedOn: NULLABLE_STRING_SCHEMA,
}, ['interviewId', 'occasionId', 'occurrence', 'steps', 'nextStep', 'complete', 'landedOn']);

export const GIFT_RECORD_SCHEMA = objectSchema({
  occasionId: STRING_SCHEMA,
  occurrence: STRING_SCHEMA,
  recordedAt: NUMBER_SCHEMA,
  landedOn: STRING_SCHEMA,
  notes: STRING_SCHEMA,
}, ['occasionId', 'occurrence', 'recordedAt', 'landedOn']);

export const OCCASION_PROPOSAL_SCHEMA = objectSchema({
  ok: BOOLEAN_SCHEMA,
  reason: NULLABLE_STRING_SCHEMA,
  line: STRING_SCHEMA,
  confirmation: STRING_SCHEMA,
  needsKind: BOOLEAN_SCHEMA,
  conflictsWith: arraySchema(STRING_SCHEMA),
}, ['ok', 'reason', 'line', 'confirmation', 'needsKind', 'conflictsWith']);

export const OCCASION_WRITE_OUTCOME_SCHEMA = objectSchema({
  ok: BOOLEAN_SCHEMA,
  reason: NULLABLE_STRING_SCHEMA,
  occasionId: STRING_SCHEMA,
  disclosure: STRING_SCHEMA,
  droppedRecords: NUMBER_SCHEMA,
}, ['ok', 'reason', 'occasionId', 'disclosure', 'droppedRecords']);

export const OCCASION_SWEEP_REPORT_SCHEMA = objectSchema({
  sweptAt: NUMBER_SCHEMA,
  expiredAcknowledgements: NUMBER_SCHEMA,
  orphanedRecords: NUMBER_SCHEMA,
  expiredOpenItems: NUMBER_SCHEMA,
  agedGiftRecords: NUMBER_SCHEMA,
  droppedInterviews: NUMBER_SCHEMA,
  staleMirrors: NUMBER_SCHEMA,
}, ['sweptAt', 'expiredAcknowledgements', 'orphanedRecords', 'expiredOpenItems', 'agedGiftRecords', 'droppedInterviews', 'staleMirrors']);

// ---------------------------------------------------------------------------
// Verb IO
// ---------------------------------------------------------------------------

export const OCCASIONS_LIST_INPUT_SCHEMA = EMPTY_OBJECT_SCHEMA;
export const OCCASIONS_LIST_OUTPUT_SCHEMA = objectSchema({
  today: STRING_SCHEMA,
  timezone: STRING_SCHEMA,
  occasions: arraySchema(OCCASION_VIEW_SCHEMA),
  unparsed: arraySchema(UNPARSED_LINE_SCHEMA),
  conflicts: arraySchema(OCCASION_CONFLICT_SCHEMA),
}, ['today', 'timezone', 'occasions', 'unparsed', 'conflicts']);

export const OCCASIONS_PROPOSE_INPUT_SCHEMA = objectSchema({
  title: STRING_SCHEMA,
  date: STRING_SCHEMA,
  kind: OCCASION_KIND_SCHEMA,
  person: STRING_SCHEMA,
  recurrence: RECURRENCE_SCHEMA,
  leadDays: NUMBER_SCHEMA,
}, ['title', 'date']);

/**
 * `kind`, `surface`, `said` and `authority` are all REQUIRED on the confirm.
 *
 * `kind` because it is the owner's choice and is never inferred; the other three
 * because this writes a line into the owner's profile and the owner-profile
 * write gate takes all three. Marking them optional in the schema while the handler answers 400
 * without them is how a published contract breaks a client by construction.
 */
export const OCCASIONS_CONFIRM_INPUT_SCHEMA = objectSchema({
  title: STRING_SCHEMA,
  date: STRING_SCHEMA,
  kind: OCCASION_KIND_SCHEMA,
  person: STRING_SCHEMA,
  recurrence: RECURRENCE_SCHEMA,
  leadDays: NUMBER_SCHEMA,
  surface: STRING_SCHEMA,
  said: STRING_SCHEMA,
  authority: STRING_SCHEMA,
}, ['title', 'date', 'kind', 'surface', 'said', 'authority']);

export const OCCASIONS_REMOVE_INPUT_SCHEMA = objectSchema({
  occasionId: STRING_SCHEMA,
  confirmed: BOOLEAN_SCHEMA,
  authority: STRING_SCHEMA,
}, ['occasionId', 'confirmed', 'authority']);

export const OCCASIONS_ANSWER_INPUT_SCHEMA = objectSchema({
  occasionId: STRING_SCHEMA,
  answer: OCCASION_ANSWER_SCHEMA,
  occurrence: STRING_SCHEMA,
}, ['occasionId', 'answer']);
export const OCCASIONS_ANSWER_OUTPUT_SCHEMA = objectSchema({
  ok: BOOLEAN_SCHEMA,
  reason: NULLABLE_STRING_SCHEMA,
  interview: { anyOf: [INTERVIEW_PROGRESS_SCHEMA, { type: 'null' }] },
}, ['ok', 'reason', 'interview']);

export const OCCASIONS_INTERVIEW_GET_INPUT_SCHEMA = objectSchema({ interviewId: STRING_SCHEMA }, ['interviewId']);
export const OCCASIONS_INTERVIEW_ANSWER_INPUT_SCHEMA = objectSchema({
  interviewId: STRING_SCHEMA,
  stepId: STRING_SCHEMA,
  text: STRING_SCHEMA,
}, ['interviewId', 'stepId', 'text']);
export const OCCASIONS_INTERVIEW_RECORD_INPUT_SCHEMA = objectSchema({
  interviewId: STRING_SCHEMA,
  landedOn: STRING_SCHEMA,
}, ['interviewId', 'landedOn']);
export const OCCASIONS_INTERVIEW_OUTPUT_SCHEMA = objectSchema({
  present: BOOLEAN_SCHEMA,
  interview: { anyOf: [INTERVIEW_PROGRESS_SCHEMA, { type: 'null' }] },
}, ['present', 'interview']);

export const OCCASIONS_PENDING_INPUT_SCHEMA = EMPTY_OBJECT_SCHEMA;
export const OCCASIONS_PENDING_OUTPUT_SCHEMA = objectSchema({
  today: STRING_SCHEMA,
  nudge: { anyOf: [OCCASION_NUDGE_SCHEMA, { type: 'null' }] },
  conflicts: arraySchema(objectSchema({
    occasionId: STRING_SCHEMA,
    message: STRING_SCHEMA,
  }, ['occasionId', 'message'])),
  acknowledged: arraySchema(NUDGE_SUBJECT_SCHEMA),
  interviews: arraySchema(INTERVIEW_PROGRESS_SCHEMA),
}, ['today', 'nudge', 'acknowledged', 'conflicts', 'interviews']);

/**
 * One destination a nudge was pushed to, and what came of it.
 *
 * Reported per destination because `occasions.nudgeChannel` is a list, Telegram
 * AND the agent is the owner's ruling, and one boolean for the batch would not
 * say WHICH channel went quiet. A channel the owner believes is reaching them
 * and is not is the failure this whole feature exists to avoid.
 */
export const NUDGE_DELIVERY_SCHEMA = objectSchema({
  channel: STRING_SCHEMA,
  delivered: BOOLEAN_SCHEMA,
  deliveryId: NULLABLE_STRING_SCHEMA,
  failure: NULLABLE_STRING_SCHEMA,
}, ['channel', 'delivered', 'deliveryId', 'failure']);

export const OCCASIONS_SWEEP_INPUT_SCHEMA = EMPTY_OBJECT_SCHEMA;
export const OCCASIONS_SWEEP_OUTPUT_SCHEMA = objectSchema({
  ranAt: NUMBER_SCHEMA,
  today: STRING_SCHEMA,
  hold: NULLABLE_STRING_SCHEMA,
  nudge: { anyOf: [OCCASION_NUDGE_SCHEMA, { type: 'null' }] },
  conflictMessages: arraySchema(STRING_SCHEMA),
  resumedInterviews: arraySchema(STRING_SCHEMA),
  delivered: BOOLEAN_SCHEMA,
  deliveryChannel: STRING_SCHEMA,
  deliveryId: NULLABLE_STRING_SCHEMA,
  deliveries: arraySchema(NUDGE_DELIVERY_SCHEMA),
  mirrored: NUMBER_SCHEMA,
  housekeeping: { anyOf: [OCCASION_SWEEP_REPORT_SCHEMA, { type: 'null' }] },
}, ['ranAt', 'today', 'hold', 'nudge', 'conflictMessages', 'resumedInterviews', 'delivered', 'deliveryChannel', 'deliveryId', 'deliveries', 'mirrored', 'housekeeping']);

export const OCCASIONS_PLANS_LIST_INPUT_SCHEMA = EMPTY_OBJECT_SCHEMA;
export const OCCASIONS_PLANS_LIST_OUTPUT_SCHEMA = objectSchema({
  today: STRING_SCHEMA,
  plans: arraySchema(PLAN_SCHEMA),
  unparsed: arraySchema(UNPARSED_LINE_SCHEMA),
  awayNow: { anyOf: [PLAN_SCHEMA, { type: 'null' }] },
}, ['today', 'plans', 'unparsed', 'awayNow']);

export const OCCASIONS_PLANS_PROPOSE_INPUT_SCHEMA = objectSchema({
  title: STRING_SCHEMA,
  from: STRING_SCHEMA,
  to: STRING_SCHEMA,
  away: BOOLEAN_SCHEMA,
  destination: STRING_SCHEMA,
}, ['title', 'from', 'to']);

export const OCCASIONS_PLANS_CONFIRM_INPUT_SCHEMA = objectSchema({
  title: STRING_SCHEMA,
  from: STRING_SCHEMA,
  to: STRING_SCHEMA,
  away: BOOLEAN_SCHEMA,
  destination: STRING_SCHEMA,
  surface: STRING_SCHEMA,
  said: STRING_SCHEMA,
  authority: STRING_SCHEMA,
}, ['title', 'from', 'to', 'surface', 'said', 'authority']);

export const OCCASIONS_GIFTS_INPUT_SCHEMA = objectSchema({ occasionId: STRING_SCHEMA }, ['occasionId']);
export const OCCASIONS_GIFTS_OUTPUT_SCHEMA = objectSchema({
  occasionId: STRING_SCHEMA,
  gifts: arraySchema(GIFT_RECORD_SCHEMA),
}, ['occasionId', 'gifts']);

export const OCCASIONS_CONFLICT_RESOLVE_INPUT_SCHEMA = objectSchema({ occasionId: STRING_SCHEMA }, ['occasionId']);
export const OCCASIONS_CONFLICT_RESOLVE_OUTPUT_SCHEMA = objectSchema({
  occasionId: STRING_SCHEMA,
  resolved: BOOLEAN_SCHEMA,
}, ['occasionId', 'resolved']);

export const OCCASIONS_STATE_INPUT_SCHEMA = EMPTY_OBJECT_SCHEMA;
export const OCCASIONS_STATE_OUTPUT_SCHEMA = objectSchema({
  path: STRING_SCHEMA,
  acknowledgements: NUMBER_SCHEMA,
  giftRecords: NUMBER_SCHEMA,
  openItems: NUMBER_SCHEMA,
  interviews: NUMBER_SCHEMA,
  mirrors: NUMBER_SCHEMA,
  lastSweep: { anyOf: [OCCASION_SWEEP_REPORT_SCHEMA, { type: 'null' }] },
  reconciledOpenItems: NUMBER_SCHEMA,
  corruption: NULLABLE_STRING_SCHEMA,
}, ['path', 'acknowledgements', 'giftRecords', 'openItems', 'interviews', 'mirrors', 'lastSweep', 'reconciledOpenItems', 'corruption']);

export const OCCASIONS_ACKNOWLEDGE_INPUT_SCHEMA = objectSchema({
  occasionId: STRING_SCHEMA,
  source: OCCASION_ACK_SOURCE_SCHEMA,
  occurrence: STRING_SCHEMA,
}, ['occasionId']);
export const OCCASIONS_ACKNOWLEDGE_OUTPUT_SCHEMA = objectSchema({
  ok: BOOLEAN_SCHEMA,
  reason: NULLABLE_STRING_SCHEMA,
  reply: STRING_SCHEMA,
}, ['ok', 'reason', 'reply']);

export const builtinGatewayOccasionsMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'occasions.list',
    title: 'List Important Dates',
    description: 'Return every occasion declared in the owner profile, with its next occurrence, how many days away it is, the lead it uses, whether it is inside its lead window, and what was answered for that occurrence. Also returns lines under the heading that could not be typed, each with the reason, and any occasion that has two different dates recorded. This carries the dates: it is the owner asking their own system what it holds, which is the explicit ask that unlocks a closed-tier read. A nudge never does.',
    category: 'occasions',
    scopes: ['read:occasions'],
    http: { method: 'GET', path: '/api/occasions' },
    inputSchema: OCCASIONS_LIST_INPUT_SCHEMA,
    outputSchema: OCCASIONS_LIST_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'occasions.propose',
    title: 'Propose An Important Date',
    description: 'Work out what would be written for a date heard in conversation, and return the one-line confirmation to put to the owner. WRITES NOTHING. When no kind was given, needsKind is true and the confirmation asks for it in the same breath, the kind is the owner\'s choice and is never inferred, because no rule that reads a label tells a birthday from a death anniversary. Any date already recorded for the same name that disagrees comes back in conflictsWith.',
    category: 'occasions',
    scopes: ['write:occasions'],
    http: { method: 'POST', path: '/api/occasions/propose' },
    inputSchema: OCCASIONS_PROPOSE_INPUT_SCHEMA,
    outputSchema: OCCASION_PROPOSAL_SCHEMA,
  }),
  methodDescriptor({
    id: 'occasions.confirm',
    title: 'Record A Confirmed Important Date',
    description: 'Write the confirmed occasion as one line in the owner profile, under Important dates, carrying its provenance. This is the ONE confirmation: nothing re-confirms at nudge time, because for an annual date a silent write means the mistake surfaces up to eleven months later. Refused without a kind rather than defaulting one. Goes through the owner-profile write gate, so authority, surface and a verbatim quote of what the owner said are all required.',
    category: 'occasions',
    scopes: ['write:occasions'],
    http: { method: 'POST', path: '/api/occasions/confirm' },
    inputSchema: OCCASIONS_CONFIRM_INPUT_SCHEMA,
    outputSchema: OCCASION_WRITE_OUTCOME_SCHEMA,
  }),
  methodDescriptor({
    id: 'occasions.remove',
    title: 'Remove An Important Date',
    description: 'Remove one occasion and every record the machine kept against it, answers, gift history, open items, interviews and calendar mirrors. Takes exactly one confirmation: not unquestioned, and not an argument. People divorce and people die. A confirmed:false call returns the sentence to put to the owner and removes nothing.',
    category: 'occasions',
    scopes: ['write:occasions'],
    http: { method: 'POST', path: '/api/occasions/remove' },
    inputSchema: OCCASIONS_REMOVE_INPUT_SCHEMA,
    outputSchema: OCCASION_WRITE_OUTCOME_SCHEMA,
    dangerous: true,
  }),
  methodDescriptor({
    id: 'occasions.answer',
    title: 'Answer An Occasion Nudge',
    description: 'Record yes, no or later for one occurrence. A no goes silent for the rest of this cycle and expires with the date, so next year asks fresh carrying no memory of the refusal. A later is NOT a decline, it comes back roughly halfway to the date. A yes on a gift-giving occasion opens the short interview and returns its first question. All three RESOLVE the open item and remove it; to say only "I have this in hand" without ending the question, use occasions.acknowledge instead.',
    category: 'occasions',
    scopes: ['write:occasions'],
    http: { method: 'POST', path: '/api/occasions/answer' },
    inputSchema: OCCASIONS_ANSWER_INPUT_SCHEMA,
    outputSchema: OCCASIONS_ANSWER_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'occasions.acknowledge',
    title: 'Acknowledge An Occasion',
    description: 'Record that the owner has one occurrence in hand, so nothing is pushed at them about it again. This is not a yes and not a no: the open item STAYS OPEN and stays enumerable, so occasions.pending still lists it, under acknowledged[] rather than in the nudge, and asking what is coming up still answers with it. Only the push stops. The record expires with its occurrence, so next year asks fresh. source names how it was recorded: conversation when the owner said so in a reply, explicit when a surface offered the action, gift-flow when the owner is already answering gift questions about it.',
    category: 'occasions',
    scopes: ['write:occasions'],
    http: { method: 'POST', path: '/api/occasions/acknowledge' },
    inputSchema: OCCASIONS_ACKNOWLEDGE_INPUT_SCHEMA,
    outputSchema: OCCASIONS_ACKNOWLEDGE_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'occasions.interview.get',
    title: 'Get Gift Interview',
    description: 'Return one gift interview and the question that has not been answered yet. A thread the owner walked away from resumes here rather than restarting: the next step is the one the owner did not get to. Over a channel the steps are asked one at a time; in the agent they can be one exchange.',
    category: 'occasions',
    scopes: ['read:occasions'],
    http: { method: 'POST', path: '/api/occasions/interview' },
    inputSchema: OCCASIONS_INTERVIEW_GET_INPUT_SCHEMA,
    outputSchema: OCCASIONS_INTERVIEW_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'occasions.interview.answer',
    title: 'Answer A Gift Interview Question',
    description: 'Record one answer and return the next question, if there is one. The interview guides the owner to their own idea and never recommends a gift, that judgement is the owner\'s, which is also why the outcome recorded is what the owner landed on rather than what was suggested.',
    category: 'occasions',
    scopes: ['write:occasions'],
    http: { method: 'POST', path: '/api/occasions/interview/answer' },
    inputSchema: OCCASIONS_INTERVIEW_ANSWER_INPUT_SCHEMA,
    outputSchema: OCCASIONS_INTERVIEW_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'occasions.interview.record',
    title: 'Record What The Owner Landed On',
    description: 'Close the interview with what the owner settled on and write it to the gift history. Recording the outcome rather than merely that the owner said yes is the point: "said yes in 2026" cannot stop year three steering where year one did.',
    category: 'occasions',
    scopes: ['write:occasions'],
    http: { method: 'POST', path: '/api/occasions/interview/record' },
    inputSchema: OCCASIONS_INTERVIEW_RECORD_INPUT_SCHEMA,
    outputSchema: OCCASIONS_INTERVIEW_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'occasions.gifts',
    title: 'List Gift History',
    description: 'Return what the owner landed on for one occasion in previous years, newest first. Kept beyond the answers deliberately: the answers expire with their date so next year asks fresh, the history does not.',
    category: 'occasions',
    scopes: ['read:occasions'],
    http: { method: 'POST', path: '/api/occasions/gifts' },
    inputSchema: OCCASIONS_GIFTS_INPUT_SCHEMA,
    outputSchema: OCCASIONS_GIFTS_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'occasions.pending',
    title: 'Pull Outstanding Occasions',
    description: 'Return everything unresolved, without delivering anything: the batched nudge, any date conflict still open, and any interview left mid-thread. This is how a surface that is not a push destination receives a nudge, it pulls at the start of a turn rather than being pushed at, and a stored date is the prior scheduling that permits raising something unprompted. A nudge a push has already landed on the agent is left out while the agent is a configured push destination, so the push and the pull cannot raise the same thing twice; an item no push has ever landed there is still returned, so a missing sender or a failed send loses nothing. The nudge names the occasion and the person and NEVER the date: proximity is a word, not a count of days.',
    category: 'occasions',
    scopes: ['read:occasions'],
    http: { method: 'GET', path: '/api/occasions/pending' },
    inputSchema: OCCASIONS_PENDING_INPUT_SCHEMA,
    outputSchema: OCCASIONS_PENDING_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'occasions.sweep',
    title: 'Run The Approach Sweep Now',
    description: 'Run one pass immediately: reap expired and orphaned state, find the occasions entering their lead window, batch them into a single message, mirror to the calendar if that is on, and deliver. Delivery goes to every destination in occasions.nudgeChannel, a comma-separated list, so Telegram and the agent both get it, and each is attempted independently, with deliveries[] naming per destination what landed and what did not. Housekeeping runs first and unconditionally, so a machine with nudging turned off still reaps. Returns hold:"quiet-hours" or hold:"disabled" when it deliberately said nothing, nothing is dropped, it waits.',
    category: 'occasions',
    scopes: ['write:occasions'],
    http: { method: 'POST', path: '/api/occasions/sweep' },
    inputSchema: OCCASIONS_SWEEP_INPUT_SCHEMA,
    outputSchema: OCCASIONS_SWEEP_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'occasions.conflict.resolve',
    title: 'Close A Date Conflict',
    description: 'Stop re-raising a conflict the owner has dealt with. The conflict itself is never resolved automatically, two different dates for one thing means only the owner knows which was right, and silently taking the newer value is the behaviour this exists to prevent.',
    category: 'occasions',
    scopes: ['write:occasions'],
    http: { method: 'POST', path: '/api/occasions/conflict/resolve' },
    inputSchema: OCCASIONS_CONFLICT_RESOLVE_INPUT_SCHEMA,
    outputSchema: OCCASIONS_CONFLICT_RESOLVE_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'occasions.plans.list',
    title: 'List Plans',
    description: 'Return every plan declared in the owner profile, a dated range with attributes, plus whichever one has the owner away today. Plans are ambient: they never prompt. They exist so the system knows not to suggest things into that window, and so a nudge that would land while the owner is abroad moves to the day before they leave.',
    category: 'occasions',
    scopes: ['read:occasions'],
    http: { method: 'GET', path: '/api/occasions/plans' },
    inputSchema: OCCASIONS_PLANS_LIST_INPUT_SCHEMA,
    outputSchema: OCCASIONS_PLANS_LIST_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'occasions.plans.propose',
    title: 'Propose A Plan',
    description: 'Work out what would be written for a plan heard in conversation, and return the one-line confirmation. Writes nothing. Away is opt-in rather than assumed: "the kitchen is being redone, 3rd to the 10th" is a real dated range that is not the owner leaving the house.',
    category: 'occasions',
    scopes: ['write:occasions'],
    http: { method: 'POST', path: '/api/occasions/plans/propose' },
    inputSchema: OCCASIONS_PLANS_PROPOSE_INPUT_SCHEMA,
    outputSchema: OCCASION_PROPOSAL_SCHEMA,
  }),
  methodDescriptor({
    id: 'occasions.plans.confirm',
    title: 'Record A Confirmed Plan',
    description: 'Write the confirmed plan as one line in the owner profile, under Plans, carrying its provenance. Same one-confirmation rule and the same owner-profile write gate as an occasion.',
    category: 'occasions',
    scopes: ['write:occasions'],
    http: { method: 'POST', path: '/api/occasions/plans/confirm' },
    inputSchema: OCCASIONS_PLANS_CONFIRM_INPUT_SCHEMA,
    outputSchema: OCCASION_WRITE_OUTCOME_SCHEMA,
  }),
  methodDescriptor({
    id: 'occasions.state',
    title: 'Occasions State Disclosure',
    description: 'What the machine-owned store is holding, counts of answers, gift records, open items, interviews and calendar mirrors, plus what the last housekeeping pass removed and why, and whether the file was found unreadable. Counts and reasons only: no answer, no gift and no date is returned, which is what makes this safe in a support bundle.',
    category: 'occasions',
    scopes: ['read:occasions'],
    http: { method: 'GET', path: '/api/occasions/state' },
    inputSchema: OCCASIONS_STATE_INPUT_SCHEMA,
    outputSchema: OCCASIONS_STATE_OUTPUT_SCHEMA,
  }),
];
