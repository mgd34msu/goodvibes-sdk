/**
 * Conversation-first spawn gate — the decision half.
 *
 * Owner ruling: an inbound message, from ANY channel, gets a conversational
 * response. If it looks like it warrants a workstream, the agent PROPOSES one
 * and waits for agreement — it does not start one. Work that was already
 * agreed to (a schedule, a trigger, an on-exit chain, or a proposal the owner
 * just said yes to) was authorized when it was created and runs without
 * re-asking.
 *
 * goodvibes-tui is exempt: the operator is sitting in front of it and typed
 * the thing, so work starting is the expected outcome. TUI spawns never reach
 * this module — the gate is installed on the channel-surface adapter context
 * (see daemon/surface-actions.ts), which the TUI does not go through.
 *
 * This file is pure: no I/O, no clock beyond what callers inject. The pending
 * proposal state lives in work-proposal-store.ts; the per-surface confirmation
 * routing lives in daemon/work-proposal-reply.ts.
 */

/**
 * How the gate treats inbound channel messages.
 *
 * - 'propose'    (default) Conversation is free; work is proposed and waits
 *                for agreement over the channel it arrived on.
 * - 'confirm-all' Every inbound message that would start ANY agent run is
 *                confirmed first, including ones that read as pure chat.
 *                Maximum caution for a noisy or shared channel.
 * - 'off'        Legacy behavior: an inbound message starts work immediately.
 */
export type ConversationGateMode = 'propose' | 'confirm-all' | 'off';

const CONVERSATION_GATE_MODES: readonly ConversationGateMode[] = ['propose', 'confirm-all', 'off'];

export function isConversationGateMode(value: unknown): value is ConversationGateMode {
  return typeof value === 'string' && (CONVERSATION_GATE_MODES as readonly string[]).includes(value);
}

/**
 * Channel surfaces the gate applies to by default — every conversational
 * ingress surface the platform ships. 'webhook' is intentionally absent: a
 * generic webhook is machine-to-machine automation that was authorized when
 * the webhook was registered, so it is pre-authorized work by construction.
 */
export const CONVERSATION_GATE_DEFAULT_SURFACES: readonly string[] = [
  'ntfy',
  'telegram',
  'slack',
  'discord',
  'homeassistant',
  'google-chat',
  'signal',
  'whatsapp',
  'telephony',
  'imessage',
  'msteams',
  'bluebubbles',
  'mattermost',
  'matrix',
];

export interface ConversationGateConfig {
  readonly mode: ConversationGateMode;
  /** How long an unanswered proposal stays answerable. */
  readonly proposalTtlMs: number;
  /** Hard cap on simultaneously pending proposals across all surfaces. */
  readonly maxPendingProposals: number;
  /** Surfaces the gate applies to. Anything not listed spawns as before. */
  readonly gatedSurfaces: readonly string[];
}

export const CONVERSATION_GATE_DEFAULTS: ConversationGateConfig = {
  mode: 'propose',
  proposalTtlMs: 30 * 60_000,
  maxPendingProposals: 20,
  gatedSurfaces: CONVERSATION_GATE_DEFAULT_SURFACES,
};

/** Lower bound so a misconfigured TTL cannot make proposals unanswerable. */
const MIN_PROPOSAL_TTL_MS = 60_000;
/** Upper bound so a stale proposal cannot be answered days later. */
const MAX_PROPOSAL_TTL_MS = 24 * 60 * 60_000;
const MIN_PENDING_PROPOSALS = 1;
const MAX_PENDING_PROPOSALS = 200;

export interface ConversationGateConfigReader {
  get(key: string): unknown;
  /**
   * `gatedSurfaces` is an array, so it is not a scalar ConfigKey — it is read
   * through the category, mirroring how wrfc.gates is read.
   */
  getCategory?(name: 'conversationGate'): unknown;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Read the gate's configuration. Every value is bounded here rather than at
 * the use site, so a hand-edited config cannot produce a gate that never
 * expires a proposal or accepts an unbounded number of them.
 */
export function readConversationGateConfig(reader: ConversationGateConfigReader): ConversationGateConfig {
  const read = (key: string): unknown => {
    try {
      return reader.get(key);
    } catch {
      // An embedder with an older schema has no such key; fall back to defaults.
      return undefined;
    }
  };
  const category = (() => {
    try {
      return reader.getCategory?.('conversationGate') as Partial<ConversationGateConfig> | undefined;
    } catch {
      return undefined;
    }
  })();

  const rawMode = read('conversationGate.mode') ?? category?.mode;
  const rawTtl = read('conversationGate.proposalTtlMs') ?? category?.proposalTtlMs;
  const rawMax = read('conversationGate.maxPendingProposals') ?? category?.maxPendingProposals;
  const rawSurfaces = category?.gatedSurfaces;

  const surfaces: string[] | null = Array.isArray(rawSurfaces)
    ? (rawSurfaces as readonly unknown[]).filter(
        (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0,
      )
    : null;

  return {
    mode: isConversationGateMode(rawMode) ? rawMode : CONVERSATION_GATE_DEFAULTS.mode,
    proposalTtlMs: Number.isFinite(rawTtl)
      ? clamp(rawTtl as number, MIN_PROPOSAL_TTL_MS, MAX_PROPOSAL_TTL_MS)
      : CONVERSATION_GATE_DEFAULTS.proposalTtlMs,
    maxPendingProposals: Number.isFinite(rawMax)
      ? Math.floor(clamp(rawMax as number, MIN_PENDING_PROPOSALS, MAX_PENDING_PROPOSALS))
      : CONVERSATION_GATE_DEFAULTS.maxPendingProposals,
    gatedSurfaces: surfaces && surfaces.length > 0 ? surfaces : CONVERSATION_GATE_DEFAULTS.gatedSurfaces,
  };
}

export function isGatedSurface(config: ConversationGateConfig, surfaceKind: string | undefined): boolean {
  if (config.mode === 'off') return false;
  if (!surfaceKind) {
    // An un-annotated channel spawn. Conversation is the default, so an
    // unknown channel surface is gated rather than waved through — a new
    // adapter cannot silently opt out by forgetting to declare itself.
    return true;
  }
  if (surfaceKind === 'tui' || surfaceKind === 'local') return false;
  return config.gatedSurfaces.includes(surfaceKind);
}

// ---------------------------------------------------------------------------
// Intent classification
// ---------------------------------------------------------------------------

/**
 * Base-form verbs that, in an imperative or request position, mean "do work on
 * the codebase". Only base forms are listed: "test" is here, "testing" is not,
 * which is exactly why the bare word "Testing" reads as conversation.
 */
const WORK_VERBS: ReadonlySet<string> = new Set([
  'add', 'audit', 'build', 'bump', 'change', 'clean', 'commit', 'configure',
  'convert', 'create', 'debug', 'delete', 'deploy', 'document', 'draft',
  'extract', 'finish', 'fix', 'generate', 'implement', 'improve', 'init',
  'inline', 'install', 'integrate', 'investigate', 'migrate', 'move',
  'optimize', 'patch', 'port', 'publish', 'refactor', 'release', 'remove',
  'rename', 'repair', 'replace', 'resolve', 'restructure', 'review', 'rewrite',
  'scaffold', 'ship', 'split', 'test', 'tidy', 'triage', 'update', 'upgrade',
  'wire', 'write',
]);

/**
 * Preambles that turn a following base-form verb into a work request:
 * "can you fix ...", "please add ...", "go ahead and rename ...".
 */
const REQUEST_PREAMBLES: readonly RegExp[] = [
  /^(?:hey|hi|hello|ok|okay|so|alright|right)\b[\s,:.!-]*/i,
  /^(?:please|pls|plz)\b[\s,:-]*/i,
  /^(?:can|could|would|will)\s+(?:you|u)\s+(?:please\s+)?/i,
  /^(?:i(?:'d| would)?\s+(?:like|want|need)\s+(?:you\s+)?to)\s+/i,
  /^(?:we\s+(?:need|have)\s+to)\s+/i,
  /^(?:you\s+(?:should|need\s+to))\s+/i,
  /^(?:let(?:'s| us))\s+/i,
  /^(?:go\s+ahead\s+and)\s+/i,
  /^(?:make\s+sure\s+(?:you\s+|to\s+)?)/i,
  /^(?:time\s+to)\s+/i,
];

/** Shapes that mean "this is a question about something", not "do this". */
const QUESTION_OPENERS = /^(?:what|why|when|where|who|which|how|is|are|was|were|do|does|did|can|could|should|would|will|has|have|had)\b/i;

/** Markers that a message is talking about real code, not chatting. */
const CODE_REFERENCE = /(?:`[^`]+`|\b[\w./-]+\.(?:ts|tsx|js|jsx|json|md|py|go|rs|java|rb|sh|yml|yaml|toml)\b|\bsrc\/|\bpackages\/|\b#\d+\b|\bhttps?:\/\/\S*\/(?:issues|pull)\/\d+)/;

export type InboundIntent =
  | { readonly kind: 'conversation'; readonly reason: string }
  | { readonly kind: 'work'; readonly reason: string; readonly summary: string };

function stripPreambles(text: string): string {
  let current = text.trim();
  // Peel repeatedly: "hey, can you please fix ..." is three layers.
  for (let pass = 0; pass < REQUEST_PREAMBLES.length; pass += 1) {
    let matched = false;
    for (const preamble of REQUEST_PREAMBLES) {
      const next = current.replace(preamble, '');
      if (next !== current) {
        current = next.trimStart();
        matched = true;
      }
    }
    if (!matched) break;
  }
  return current;
}

function firstWord(text: string): string {
  const match = text.match(/^[a-z][a-z'-]*/i);
  return match ? match[0].toLowerCase() : '';
}

/** One short line naming what the proposed work is, for the lock screen. */
export function summarizeWorkRequest(text: string, maxLength = 90): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, maxLength - 1).trimEnd()}…`;
}

/**
 * Decide whether an inbound message is conversation or a work request.
 *
 * Conversation is the default and the burden of proof is on "work": a message
 * only classifies as work when a base-form work verb sits in an imperative or
 * request position, or when it both references real code and uses a work verb
 * somewhere. Everything else — greetings, single words, questions, status
 * checks, opinions — is conversation and gets a conversational reply.
 */
export function classifyInboundIntent(rawText: string | undefined): InboundIntent {
  const text = (rawText ?? '').trim();
  if (!text) return { kind: 'conversation', reason: 'empty-message' };

  // Evaluate clause by clause: "thanks! now fix the login bug" is a request.
  const clauses = text
    .split(/(?:[.!?\n]+|\b(?:then|and then|after that|now)\b)/i)
    .map((clause) => clause.trim())
    .filter(Boolean);

  for (const clause of clauses) {
    const stripped = stripPreambles(clause);
    if (!stripped) continue;
    const head = firstWord(stripped);
    if (!head || !WORK_VERBS.has(head)) continue;
    // "can you review this?" is a request; "how do I review this?" is a
    // question about reviewing. A question opener before the verb survives
    // preamble stripping only in the second shape.
    if (QUESTION_OPENERS.test(clause.trim()) && stripPreambles(clause) === clause.trim()) continue;
    return {
      kind: 'work',
      reason: `imperative-work-verb:${head}`,
      summary: summarizeWorkRequest(text),
    };
  }

  if (CODE_REFERENCE.test(text)) {
    const words = text.toLowerCase().match(/[a-z][a-z'-]*/g) ?? [];
    const verb = words.find((word) => WORK_VERBS.has(word));
    if (verb) {
      return {
        kind: 'work',
        reason: `code-reference-with-work-verb:${verb}`,
        summary: summarizeWorkRequest(text),
      };
    }
  }

  return { kind: 'conversation', reason: 'no-imperative-work-request' };
}

// ---------------------------------------------------------------------------
// Confirmation parsing
// ---------------------------------------------------------------------------

export type WorkProposalReply =
  | { readonly decision: 'affirmative'; readonly note?: string | undefined }
  | { readonly decision: 'negative'; readonly note?: string | undefined };

/**
 * Openers that answer a yes/no question and mean nothing else in English.
 * "yeah", "do it", "ship it" are not the start of a new instruction, so a
 * short qualifier is allowed to follow one ("yes, but only the ntfy adapter").
 *
 * Longest alternatives come first: `go\s+ahead` must be tried before the bare
 * `go` in {@link STANDALONE_AFFIRMATIVE}, and `no\s+thank\s+you` before `no`.
 */
const UNAMBIGUOUS_AFFIRMATIVE = /^(?:yes\s+please|go\s+ahead|goahead|go\s+for\s+it|do\s+it|doit|run\s+it|runit|sounds?\s+good|works?\s+for\s+me|let'?s\s+go|lets\s+go|let'?s\s+do\s+it|make\s+it\s+so|ship\s+it|affirmative|approved?|confirm(?:ed)?|yeah|yep|yup|yes|yea|yah|ya|okay|ok|kk|sure|y|k)\b/i;

/**
 * Openers that answer a yes/no question ONLY when they are the whole answer.
 *
 * Every word here is also an ordinary English word that opens a brand-new
 * request — "Please refactor the parser in src/parse.ts", "start the daemon",
 * "go look at the logs". Treating one of these as agreement to whatever was
 * proposed earlier is how a fresh request got accepted as "yes" to an
 * unrelated proposal and launched a chain on the OLD task, with the new
 * sentence demoted to "Additional direction from the owner".
 *
 * So these are answers only with nothing after them (or nothing after them but
 * a closing particle or a second affirmative: "go ahead", "start it", "ok go").
 */
const STANDALONE_AFFIRMATIVE = /^(?:proceed|please|begin|start|plz|pls|go)\b/i;

/** Refusals that mean nothing but "no". */
const UNAMBIGUOUS_NEGATIVE = /^(?:no\s+thank\s+you|no\s+thanks?|never\s?mind|nevermind|not\s+now|hold\s+off|holdoff|drop\s+it|forget\s+it|negative|nope|nah|naw|no|nm|n)\b/i;

/**
 * Refusals that are also verbs taking an object — "stop the daemon", "cancel
 * the release", "skip the slow tests", "don't forget the changelog". Same rule
 * as {@link STANDALONE_AFFIRMATIVE}: only an answer when it is the whole answer.
 */
const STANDALONE_NEGATIVE = /^(?:do\s+not|don'?t|dont|cancel|abort|later|stop|skip)\b/i;

/**
 * Closing words that add nothing to a bare answer, so they do not turn one
 * into a sentence: "go for it", "start it", "ok then", "sure thing".
 */
const ANSWER_PARTICLES: ReadonlySet<string> = new Set([
  'it', 'that', 'this', 'them', 'then', 'now', 'ahead', 'on', 'for it', 'with it',
  'thing', 'please', 'pls', 'plz', 'thanks', 'thank you', 'thx', 'ty', 'sir',
]);

/**
 * The whole reply must be an ANSWER. A longer message is conversation that
 * happens to open with an answer-shaped word.
 */
const MAX_REPLY_LENGTH = 200;
/** A qualifier riding along with an unambiguous yes/no ("but skip the tests"). */
const MAX_QUALIFIER_LENGTH = 80;
const MAX_QUALIFIER_WORDS = 12;
/** "ok go ahead" is two layers; nothing legitimate is deeper. */
const MAX_ANSWER_DEPTH = 2;

/** The text after the matched opener, with joining punctuation removed. */
function remainderAfter(text: string, pattern: RegExp): string {
  const match = pattern.exec(text);
  if (!match) return text;
  return text.slice(match[0].length).replace(/^[\s:,.!?–—-]+/, '').trim();
}

/**
 * Conjunctions that join a second instruction onto an answer — "go ahead AND
 * rename the config key". They are not preambles (classifyInboundIntent does
 * not peel them), so they are stripped here before the note is classified;
 * otherwise the work verb behind them hides and the instruction gets filed as
 * a note on somebody else's task.
 */
const NOTE_CONJUNCTIONS = /^(?:and\s+also|but\s+also|and\s+then|and|also|plus|then)\b[\s,]*/i;

/**
 * May this trail an unambiguous answer as steering, or is it a request of its
 * own? A qualifier is short, names no code, and does not classify as work —
 * "but only touch the ntfy adapter" steers; "refactor the parser in
 * src/parse.ts" is a new job and must not be swallowed as a note.
 */
function isSteeringQualifier(note: string): boolean {
  if (!note) return true;
  if (note.length > MAX_QUALIFIER_LENGTH) return false;
  if ((note.match(/\S+/g) ?? []).length > MAX_QUALIFIER_WORDS) return false;
  if (CODE_REFERENCE.test(note)) return false;
  return classifyInboundIntent(note.replace(NOTE_CONJUNCTIONS, '')).kind !== 'work';
}

function isAnswerParticle(note: string): boolean {
  if (!note) return true;
  const cleaned = note.toLowerCase().replace(/[\s.!,?–—-]+$/, '').replace(/\s+/g, ' ').trim();
  return ANSWER_PARTICLES.has(cleaned);
}

function parseAnswer(text: string, depth: number): WorkProposalReply | null {
  for (const [pattern, decision] of [
    [UNAMBIGUOUS_AFFIRMATIVE, 'affirmative'],
    [UNAMBIGUOUS_NEGATIVE, 'negative'],
  ] as const) {
    if (!pattern.test(text)) continue;
    const note = remainderAfter(text, pattern);
    if (!isSteeringQualifier(note)) return null;
    return { decision, ...(note ? { note } : {}) };
  }

  for (const [pattern, decision] of [
    [STANDALONE_AFFIRMATIVE, 'affirmative'],
    [STANDALONE_NEGATIVE, 'negative'],
  ] as const) {
    if (!pattern.test(text)) continue;
    const note = remainderAfter(text, pattern);
    if (isAnswerParticle(note)) return { decision };
    if (depth >= MAX_ANSWER_DEPTH) return null;
    // "ok go", "please go ahead" — a second answer word, not a new request.
    const inner = parseAnswer(note, depth + 1);
    if (!inner || inner.decision !== decision) return null;
    return inner;
  }

  return null;
}

/**
 * Parse a channel reply as agreement or refusal for a pending proposal.
 *
 * Forgiving of natural phrasing — the owner should be able to type "yeah go
 * for it" from a phone, not a magic token — but the reply must be ONLY an
 * answer. A message that carries its own request is that request, never a
 * "yes" to something proposed earlier, no matter how politely it opens.
 * Anything unrecognized returns null and flows through as a normal message,
 * so a pending proposal cannot swallow unrelated conversation.
 */
export function parseWorkProposalReply(rawText: string | undefined): WorkProposalReply | null {
  const text = (rawText ?? '').trim();
  if (!text) return null;
  // Bound the input: a long paragraph that happens to start with "no" is
  // conversation, not an answer to a yes/no proposal.
  if (text.length > MAX_REPLY_LENGTH) return null;
  return parseAnswer(text.replace(/^[\s"'`*_>-]+/, ''), 0);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * The proposal message. One short line per real thing, readable on a phone
 * lock screen without expanding the notification.
 */
export function renderWorkProposalMessage(input: {
  readonly summary: string;
  readonly expiresInMs: number;
}): string {
  const minutes = Math.max(1, Math.round(input.expiresInMs / 60_000));
  return [
    `Start work on: ${input.summary}`,
    `Reply "yes" to start, "no" to skip (expires in ${minutes}m).`,
  ].join('\n');
}

export function renderProposalDeclinedMessage(summary: string): string {
  return `Skipped: ${summary}`;
}

export function renderProposalExpiredMessage(summary: string): string {
  return `That proposal expired: ${summary}. Ask again to restart it.`;
}
