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
    'Then say concretely what you stored: what it was, the dates, and where it went. Not',
    '"noted" — he cannot tell "noted" apart from nothing happening, and that is exactly',
    'what went wrong before.',
    '',
    'If a capture does not complete, say so plainly in the reply and say what stopped it.',
    'Never let a failed capture pass as a friendly acknowledgement. Nothing unresolved',
    'drops silently.',
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
