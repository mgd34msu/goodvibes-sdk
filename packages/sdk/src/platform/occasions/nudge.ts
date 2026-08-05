/**
 * nudge.ts — what a nudge says, and what it must never say.
 *
 * ## The date is not in the message. Not in any form.
 *
 * The owner's rule: *"it only needs to tell me a birthday date if i ask it what
 * it is, same for other dates."* The date value is a closed-tier read, disclosed
 * on an explicit ask and never volunteered.
 *
 * That is stronger than "do not print the date string", and the difference is
 * the whole reason this module exists rather than a template inline in the
 * sweep. "In 10 days" is the date, arithmetic applied. So proximity is a WORD —
 * approaching, soon, imminent — chosen from a day count that never leaves this
 * file. There is no code path from an occurrence date to a rendered nudge, so a
 * later edit cannot reintroduce one by being helpful.
 *
 * The property worth preserving beyond his stated preference: a reminder
 * delivered to Telegram never puts a family member's birth date into a message
 * channel.
 *
 * ## The message does not recommend anything
 *
 * *"it doesn't need to make a recommendation, just needs to know that it would
 * be something that needs to happen."* A gift-giving occasion asks whether he
 * wants to sort something. It does not suggest what.
 */
import type { NudgeSubject, Occasion, OccasionNudge } from './types.js';

/**
 * How close, as a word.
 *
 * The thresholds are the only place a day count is read, and the value does not
 * escape: the returned word is all the renderer ever sees.
 */
export function proximityOf(daysUntil: number): NudgeSubject['proximity'] {
  if (daysUntil <= 2) return 'imminent';
  if (daysUntil <= 5) return 'soon';
  return 'approaching';
}

/** The structured subject for one occasion inside a nudge. */
export function subjectFor(
  occasion: Occasion,
  daysUntil: number,
  acknowledged = false,
): NudgeSubject {
  return {
    occasionId: occasion.id,
    title: occasion.title,
    person: occasion.person,
    kind: occasion.kind,
    proximity: proximityOf(daysUntil),
    subject: occasion.subject,
    acknowledged,
  };
}

/**
 * How one subject is named.
 *
 * The person is appended only when the title does not already carry them —
 * "Sarah's birthday (Sarah)" reads like a machine, and "Dad" with `for Dad`
 * would too. The plan keeps the person as a plain label rather than
 * restructuring the People section, which is prose by design, so this is the
 * one place the two are reconciled.
 */
export function nameOf(subject: NudgeSubject): string {
  const person = subject.person.trim();
  if (person.length === 0) return subject.title;
  if (subject.title.toLowerCase().includes(person.toLowerCase())) return subject.title;
  return `${subject.title} (${person})`;
}

/** Join a list the way a person would: "a", "a and b", "a, b and c". */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  const head = names.slice(0, -1).join(', ');
  return `${head} and ${names[names.length - 1]}`;
}

function urgencyPhrase(subjects: readonly NudgeSubject[]): string {
  if (subjects.some((subject) => subject.proximity === 'imminent')) return 'very close now';
  if (subjects.some((subject) => subject.proximity === 'soon')) return 'coming up soon';
  return 'coming up';
}

/**
 * Compose one message for a whole batch.
 *
 * Several occasions inside one window batch into a single message rather than
 * one ping each — my decision, stated so it can be overridden. The alternative
 * is that a week holding three birthdays produces three separate interruptions
 * on the same day, which is how a useful feature becomes one he mutes.
 */
export function composeNudgeMessage(subjects: readonly NudgeSubject[]): string {
  if (subjects.length === 0) return '';
  const names = joinNames(subjects.map(nameOf));
  const urgency = urgencyPhrase(subjects);
  const gifting = subjects.some((subject) => subject.kind === 'gift-giving');
  const opening = subjects.length === 1
    ? `${names} is ${urgency}.`
    : `${names} are ${urgency}.`;
  if (!gifting) return opening;
  const ask = subjects.length === 1
    ? 'Do you want to sort something for it?'
    : 'Do you want to sort something for any of them?';
  return `${opening} ${ask}`;
}

/** Build the nudge a batch of due occasions produces. */
export function composeNudge(input: {
  readonly id: string;
  readonly now: number;
  readonly subjects: readonly NudgeSubject[];
}): OccasionNudge {
  return {
    id: input.id,
    raisedAt: input.now,
    subjects: input.subjects,
    message: composeNudgeMessage(input.subjects),
    // Only a gift-giving occasion asks a question, so only a batch containing
    // one can be answered yes/no/later. A remember-only batch is a statement,
    // and offering an answer to a statement invites an answer that means nothing.
    answerable: input.subjects.some((subject) => subject.kind === 'gift-giving'),
  };
}

/** The label that opens every occasion notice landed in the agent's own conversation. */
export const AGENT_NOTICE_HEADING = 'Occasion reminder';

/**
 * The same nudge, framed for delivery INTO the agent's own conversation.
 *
 * ## The defect this closes
 *
 * A push to the agent surface used to land `nudge.message` as a bare body, so
 * the sentence *"Mike's birthday is very close now."* arrived unlabelled in the
 * middle of a session about wake-word debugging — and the model, given a bare
 * sentence with no frame, did the only thing a bare sentence permits: it said
 * it out loud, twice, woven into troubleshooting that had nothing to do with
 * it. Every other destination is a message channel where an arriving message is
 * self-evidently a new message. The agent's conversation is not: text put into
 * it is indistinguishable from the conversation itself unless it says what it
 * is.
 *
 * So the notice is SELF-CONTAINED and says four things, in this order:
 *
 *  1. What it is — a scheduled reminder, named as one, not a remark.
 *  2. What it is about — the occasion, by name, and never the date. The
 *     closed-tier rule is unchanged and is the reason this composes from
 *     {@link composeNudgeMessage} rather than writing its own sentence.
 *  3. That it is unrelated to whatever is happening in the conversation.
 *  4. How he makes it stop — one sentence from him, recorded as an
 *     acknowledgement. An affordance he can use, not a fact he must act on.
 *
 * It does NOT tell the model to relay it verbatim. He may be mid-something; the
 * turn decides when a reminder is worth raising, which is what the last line
 * is for.
 */
export function composeAgentNotice(nudge: OccasionNudge): string {
  const message = nudge.message.trim();
  if (message.length === 0) return '';
  return [
    `[${AGENT_NOTICE_HEADING}]`,
    message,
    '',
    'This is a scheduled reminder about a date recorded in the owner\'s profile. It is not',
    'part of the conversation it arrived in and has nothing to do with it — do not weave it',
    'into whatever is being discussed, and do not restate it as an observation of your own.',
    'Raise it as its own point when there is a natural moment, or hold it until the current',
    'thread finishes.',
    '',
    'If he says he already has this one in hand — in any words — record that with the',
    '`profile` tool, action `acknowledge_occasion`, in the same turn. He will not be sent',
    'this reminder again for this occurrence once you do. He will be sent it at most once',
    'more regardless, on the day itself.',
  ].join('\n');
}

/**
 * The message raised when two declared dates for one thing disagree.
 *
 * The dates are NOT printed, and that is deliberate rather than an oversight of
 * a message whose subject is dates. This goes to the same channels a nudge does,
 * and the closed-tier rule is about the channel, not about the message's
 * purpose. He can answer it by saying which date is right — that is one
 * sentence, and it is also the explicit ask that unlocks reading them back to
 * him if he would rather see both first.
 *
 * `dates` is carried in the structured payload beside this string, so a surface
 * that IS a direct owner interface can lay both out. What never happens is a
 * message channel receiving them unasked.
 */
export function composeConflictMessage(title: string, dates: readonly string[]): string {
  return `Your profile has ${dates.length} different dates recorded for ${title}. `
    + 'Nothing has been changed — which one is right?';
}
