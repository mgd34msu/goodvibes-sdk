/**
 * personal-capture/spawn-contract.ts
 *
 * What an agent answering a conversational turn is given, and what it is told.
 *
 * ## The defect this closes
 *
 * A message arriving on a channel is answered by an agent the shared-session
 * continuation runner spawns with `restrictTools: true` and no tool list.
 * `AgentManager.deriveEffectiveTools` reads that as "use ONLY the tools named",
 * and none were, so the effective list was empty and
 * `AgentOrchestrator.buildScopedRegistry` handed the run a registry with
 * nothing in it. The agent could emit text and do nothing else — which is why
 * an itinerary pasted into Telegram was answered warmly and stored nowhere.
 *
 * So this file names the tools such a turn actually needs, and the instruction
 * that makes recording part of answering rather than something to offer.
 *
 * ## Why this list and not the default one
 *
 * A conversational turn is not a work chain. `conversation-continuation.ts`
 * already decides that a channel follow-up gets an answer rather than a
 * write-review-fix-confirm chain, and this list keeps that promise: no `write`,
 * no `edit`, no `exec`. Nothing here can start a workstream or touch the
 * project tree. What it can do is read, look things up, and record what the
 * owner just said about himself.
 *
 * Hoisted here rather than written at each spawn site because the daemon and
 * the SDK's own runtime both spawn these turns, and a capability that exists
 * on one of those and not the other is the same defect with a smaller
 * blast radius.
 */

import { resolveCaptureAuthority, type CaptureAuthorityDecision } from './authority.js';

/**
 * The tools a conversational turn is spawned with.
 *
 * `profile` is the capture tool — occasions, plans and profile facts.
 * `read`, `find` and `fetch` are what answering a question ordinarily takes.
 */
export const CONVERSATIONAL_TURN_TOOLS: readonly string[] = [
  'read',
  'find',
  'fetch',
  'profile',
];

/**
 * What to do when he answers a reminder.
 *
 * The gap this closes: occasion nudges are pushed to Telegram and to the agent's
 * own conversation, so the reply to one is a SENTENCE. Nothing ever turned a
 * sentence into a record — the only thing that could write an acknowledgement
 * was a CLI/webui verb — so the owner could answer a nudge, and answer it again,
 * and from the sweep's side he had said nothing at all. It kept asking.
 *
 * Exported so a test can pin the wording. This is behaviour, not decoration.
 */
export const OCCASION_ACKNOWLEDGEMENT_INSTRUCTION: readonly string[] = [
  'When he responds to a reminder about an upcoming date — or mentions one you reminded him',
  'about — and what he says means he has it in hand, record that in the same turn with the',
  '`profile` tool, action `acknowledge_occasion`. "I know", "I\'m on it", "already sorted",',
  '"yeah, next week", "you\'ve told me" and "stop telling me about it" all mean the same thing:',
  'he has heard you. Record it and he stops being pushed about that occurrence; say nothing',
  'and he gets reminded again. Do not ask him whether to record it — asking permission to stop',
  'interrupting him is another interruption.',
  '',
  'Acknowledging is not deleting. The date stays on his profile, it still comes back next year,',
  'and it still answers when he asks what is coming up. Say that back to him in one clause so',
  'he knows what he just did.',
];

/**
 * The remedy ladder for "your reminders are bothering me".
 *
 * The defect this closes, in the owner's words: *"it turned off the entire
 * fucking feature rather than stop telling me about my own fucking birthday
 * every fucking hour."* He complained about ONE occasion and the turn set
 * `occasions.enabled = false`, which also silenced his wife's birthday — a
 * gift-giving occasion with a shopping runway — and he would not have found out
 * until it was too late to matter.
 *
 * The general rule underneath it is worth more than the specific fix: the size
 * of a remedy is matched to the size of a complaint, and turning a whole
 * capability off is never how one noisy item gets quieter.
 */
export const OCCASION_COMPLAINT_LADDER: readonly string[] = [
  'If he objects to being reminded about something, fix the SMALLEST thing that fixes it.',
  'In order, and stop at the first rung that answers what he said:',
  '',
  '  1. Acknowledge that one occurrence, so it stops being raised. This is almost always the',
  '     right rung, and it is one tool call.',
  '  2. Change that one occasion — its kind, how far ahead it is raised, or removing it',
  '     outright if that is what he asked for.',
  '  3. Turn the whole occasions feature off. ONLY when he has said so explicitly and named',
  '     the whole feature. "Stop reminding me about my birthday" is rung 1. It is never rung 3,',
  '     and neither is a complaint with swearing in it — anger tells you how badly he wants the',
  '     noise to stop, not how much of his life to switch off.',
  '',
  'Whatever you do, say which occasion you silenced AND that his other dates still run. He',
  'cannot see the setting you changed, so an unnamed fix is indistinguishable from having',
  'broken something he will notice in November.',
];

export interface ConversationalSpawnContextInput {
  /** The shared session this turn belongs to. */
  readonly sessionId: string;
  /** The surface the message arrived on, when it arrived on one. */
  readonly surfaceKind?: string | undefined;
  /** Whether this turn is allowed to write to the profile, and why/why not. */
  readonly capture?: {
    readonly canCapture: boolean;
    readonly reason: string;
  } | undefined;
}

/**
 * The instruction block for a conversational turn.
 *
 * Written as standing behaviour rather than a suggestion, because "would you
 * like me to save that?" is the failure mode being corrected: the owner had
 * already told it the thing, and being asked again is not service.
 *
 * The last paragraph is the occasions doctrine applied here — nothing
 * unresolved drops silently. A capture that could not complete has to be said
 * out loud in the reply, in the same breath as the answer.
 */
export function buildConversationalTurnContext(
  input: ConversationalSpawnContextInput,
): string {
  const lines: string[] = [
    `shared-session:${input.sessionId}`,
    '',
    'You are answering the owner in conversation. Answer him; do not open a work chain.',
    '',
    'When he tells you something about himself, recording it is part of answering — not',
    'something to offer to do. A trip or any dated plan, a birthday or anniversary, a',
    'preference, a person who matters to him, an address: capture it with the `profile`',
    'tool in the same turn, then answer.',
    '',
    'A trip is a plan with two dates. Record it with `profile` action `record_trip`,',
    'carrying the dates, the destination, and every detail he gave — confirmation number,',
    'flight numbers and times, who is travelling, and why he is going. Do not summarise',
    'those away; they are the reason he pasted them.',
    '',
    'Recording is the floor, not the job. Read what the thing MEANS and fold that into',
    'the same turn. An itinerary is not just a plan with two dates: it says he is away',
    'for that span (say the span back to him in plain words); the people traveling with',
    'him are people in his life; the destination plus the reason tell you durable facts',
    'worth keeping too, in the same capture (visiting his parents in a town means his',
    'parents live there). Capture what the message implies, not only what it states.',
    '',
    'Then use it. What you just stored should shape the rest of the answer: name',
    'anything on his calendar or plans that collides with the span, and offer the',
    'obviously useful next things once — a reminder before departure, weather where he',
    'is going. Offer is the word: capturing and inferring are part of answering, but',
    'anything beyond the conversation — booking, monitoring, a standing job — is',
    'proposed and waits for his yes.',
    '',
    'Then say concretely what you stored: what it was, the dates, and where it went. Not',
    '"noted" — he cannot tell "noted" apart from nothing happening, and that is exactly',
    'what went wrong before.',
    '',
    'If a capture does not complete, say so plainly in the reply and say what stopped it.',
    'Never let a failed capture pass as a friendly acknowledgement. Nothing unresolved',
    'drops silently.',
    '',
    ...OCCASION_ACKNOWLEDGEMENT_INSTRUCTION,
    '',
    ...OCCASION_COMPLAINT_LADDER,
  ];

  if (input.surfaceKind) {
    lines.push('', `This turn arrived over ${input.surfaceKind}.`);
  }
  if (input.capture && !input.capture.canCapture) {
    lines.push(
      '',
      `Recording to the profile is not available on this turn: ${input.capture.reason}`,
      'If he tells you something worth keeping, say plainly that you cannot store it and why.',
    );
  }

  return lines.join('\n');
}

/** The part of a shared-session input this contract reads. */
export interface ConversationalTurnInputLike {
  readonly sessionId: string;
  readonly surfaceKind?: string | undefined;
  readonly surfaceId?: string | undefined;
  /** Present when the turn came in over a configured route. See CaptureChannelIdentity.routed. */
  readonly routeId?: string | undefined;
}

/** The settings the authority decision reads, supplied live by the caller. */
export interface ConversationalTurnConfigReader {
  get(key: 'profile.ownerChannels' | 'occasions.nudgeChannel'): string;
}

/**
 * The spawn-input fragment for a conversational turn: the tools, the
 * instruction, and the bound write authority.
 *
 * Spread into the `agentManager.spawn` call in a continuation runner. It
 * REPLACES the bare `context: 'shared-session:<id>'` and the empty tool list
 * that `restrictTools: true` with no `tools` produced — those two together are
 * why a channel turn could neither record anything nor knew it was supposed to.
 *
 * `tools` is set explicitly alongside `restrictTools: true`, so the restriction
 * still means "only these" — it just now names some.
 */
export function conversationalTurnSpawnOptions(
  input: ConversationalTurnInputLike,
  options: { readonly configReader?: ConversationalTurnConfigReader | undefined } = {},
): {
  readonly tools: string[];
  readonly restrictTools: true;
  readonly context: string;
  readonly captureAuthority: CaptureAuthorityDecision;
} {
  const captureAuthority = resolveCaptureAuthority({
    channel: {
      ...(input.surfaceKind === undefined ? {} : { surfaceKind: input.surfaceKind }),
      ...(input.surfaceId === undefined ? {} : { address: input.surfaceId }),
      routed: input.routeId !== undefined || input.surfaceKind !== undefined,
    },
    ownerChannels: options.configReader?.get('profile.ownerChannels') ?? '',
    nudgeChannels: options.configReader?.get('occasions.nudgeChannel') ?? '',
  });
  return {
    tools: [...CONVERSATIONAL_TURN_TOOLS],
    restrictTools: true,
    context: buildConversationalTurnContext({
      sessionId: input.sessionId,
      ...(input.surfaceKind === undefined ? {} : { surfaceKind: input.surfaceKind }),
      capture: { canCapture: captureAuthority.canCapture, reason: captureAuthority.reason },
    }),
    captureAuthority,
  };
}
