/**
 * interview.ts, a few questions that guide HIM to a good idea.
 *
 * *"if yes, ask me a few questions to guide me into a good gift idea. i feel
 * like a short interview section would be very useful here."*
 *
 * Three properties, each of which is a decision rather than a detail:
 *
 *  1. **It does not recommend.** The original framing was *"it doesn't need to
 *     make a recommendation"*, and nothing here proposes a gift. It asks
 *     questions. Judgement stays with him, which is also why the outcome is
 *     recorded as what HE landed on rather than what was suggested.
 *  2. **It opens from what the profile already knows.** People and Notes are
 *     prose preserved verbatim; if he has mentioned she is into something, the
 *     first question starts there. That is the difference between useful and
 *     generic, and it is why {@link openInterview} takes profile lines rather
 *     than a name.
 *  3. **It is genuinely short.** The question count is a setting with a default
 *     of three. A long one is a form, and he will stop answering it.
 *
 * A thread he walks away from is a DROPPED thread, not a completion. The steps
 * and the answers so far persist, so resuming picks up at the next unanswered
 * question rather than starting again, that is what makes the open-item loop's
 * third case work.
 */
import type { ProfileLine } from '../owner-profile/types.js';
import type { IsoDate } from './dates.js';
import type { GiftRecord, Interview, InterviewStep, Occasion } from './types.js';

/**
 * Words that turn a line about a person into a line about what she LIKES.
 *
 * A People section holds both, "Sarah, sister, lives in Leeds" and "Sarah has
 * been doing pottery all year", and only the second one opens a useful
 * question. Preferring it is a small heuristic with an honest fallback rather
 * than a classifier: when nothing matches, the question is asked plainly instead
 * of being asked about the wrong line.
 */
const INTEREST_WORDS = [
  'likes', 'liked', 'loves', 'loved', 'into', 'enjoys', 'enjoyed', 'collects',
  'wants', 'wanted', 'obsessed', 'keeps talking about', 'been doing', 'hobby',
  'favourite', 'favorite', 'fan of', 'reading', 'plays',
];

/** The profile line most likely to be about what she is interested in. */
export function interestLine(lines: readonly ProfileLine[]): string {
  const texts = lines.map((line) => line.text.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim())
    .filter((text) => text.length > 0);
  const match = texts.find((text) => {
    const lower = text.toLowerCase();
    return INTEREST_WORDS.some((word) => lower.includes(word));
  });
  return match ?? '';
}

export interface OpenInterviewInput {
  readonly occasion: Occasion;
  readonly occurrence: IsoDate;
  readonly now: number;
  /** Profile lines mentioning the person, from `profile.person`. */
  readonly personLines: readonly ProfileLine[];
  /** What he landed on in previous years, newest first. */
  readonly history: readonly GiftRecord[];
  /** How many questions to ask. Clamped to at least one. */
  readonly maxQuestions: number;
}

/** Who the questions are about: the person label, or the occasion's title. */
function subjectOf(occasion: Occasion): string {
  const person = occasion.person.trim();
  return person.length > 0 ? person : occasion.title;
}

/**
 * Build the questions.
 *
 * Order matters: the one grounded in something he already told the system comes
 * first, because it is the question that proves the thing was listening. A blank
 * opening question is what makes an interview feel like a form.
 */
export function interviewSteps(input: OpenInterviewInput): readonly InterviewStep[] {
  const subject = subjectOf(input.occasion);
  const opener = interestLine(input.personLines);
  const previous = input.history[0];
  const steps: InterviewStep[] = [];

  steps.push(opener.length > 0
    ? {
      id: 'direction',
      prompt: `You've mentioned: "${opener}". Is that still a good direction, or has that moved on?`,
      opensFrom: opener,
    }
    : {
      id: 'direction',
      prompt: `What has ${subject} been into lately?`,
      opensFrom: '',
    });

  steps.push(previous !== undefined
    ? {
      id: 'contrast',
      prompt: `Last time you went with ${previous.landedOn}. Something in the same vein, or somewhere different this year?`,
      opensFrom: previous.landedOn,
    }
    : {
      id: 'contrast',
      prompt: 'Something to keep, or something to do together?',
      opensFrom: '',
    });

  steps.push({
    id: 'budget',
    prompt: 'Roughly what are you looking to spend?',
    opensFrom: '',
  });

  return steps.slice(0, Math.max(1, Math.round(input.maxQuestions)));
}

export function interviewIdFor(occasionId: string, occurrence: IsoDate): string {
  return `interview:${occasionId}@${occurrence}`;
}

/** Start an interview. Nothing is asked until a surface renders the first step. */
export function openInterview(input: OpenInterviewInput): Interview {
  return {
    id: interviewIdFor(input.occasion.id, input.occurrence),
    occasionId: input.occasion.id,
    occurrence: input.occurrence,
    startedAt: input.now,
    steps: interviewSteps(input),
    answers: [],
  };
}

/**
 * The next unanswered question, or `undefined` when they are all answered.
 *
 * Resumption is exactly this call: an interview reloaded from disk after he
 * went quiet mid-thread returns the question he did not get to, not the first
 * one. Re-asking answered questions is how a resumed thread turns into a
 * restarted one.
 */
export function nextStep(interview: Interview): InterviewStep | undefined {
  const answered = new Set(interview.answers.map((answer) => answer.stepId));
  return interview.steps.find((step) => !answered.has(step.id));
}

/** Record one answer. Re-answering a step replaces the earlier answer. */
export function answerStep(
  interview: Interview,
  stepId: string,
  text: string,
  now: number,
): Interview {
  if (!interview.steps.some((step) => step.id === stepId)) return interview;
  const answers = interview.answers.filter((answer) => answer.stepId !== stepId);
  answers.push({ stepId, text, answeredAt: now });
  return { ...interview, answers };
}

/**
 * Close the interview with what he landed on.
 *
 * Recording the OUTCOME rather than merely that he said yes is the whole point
 * of the history: year three should not steer where year one did, and "he said
 * yes in 2026" cannot tell it anything.
 */
export function completeInterview(interview: Interview, landedOn: string, now: number): Interview {
  return { ...interview, landedOn, completedAt: now };
}

/** True when the interview has an outcome. */
export function isComplete(interview: Interview): boolean {
  return interview.completedAt !== undefined;
}

/** The gift record a completed interview produces. */
export function giftRecordFor(interview: Interview): GiftRecord | null {
  if (interview.landedOn === undefined || interview.completedAt === undefined) return null;
  const notes = interview.answers.map((answer) => answer.text).filter((text) => text.length > 0).join(' · ');
  return {
    occasionId: interview.occasionId,
    occurrence: interview.occurrence,
    recordedAt: interview.completedAt,
    landedOn: interview.landedOn,
    ...(notes.length === 0 ? {} : { notes }),
  };
}
