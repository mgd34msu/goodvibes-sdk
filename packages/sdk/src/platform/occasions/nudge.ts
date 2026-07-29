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
export function subjectFor(occasion: Occasion, daysUntil: number): NudgeSubject {
  return {
    occasionId: occasion.id,
    title: occasion.title,
    person: occasion.person,
    kind: occasion.kind,
    proximity: proximityOf(daysUntil),
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
