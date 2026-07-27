/**
 * entry-surface.ts — where card details may be TYPED, which is a different
 * question from where a purchase may be APPROVED.
 *
 * ══ Attribution, stated precisely ═════════════════════════════════════════
 *
 * These are two different weights and collapsing them is how a chain of agents
 * talks itself into anything. An earlier version of this file got it wrong and
 * relayed a coordinator decision as an owner ruling.
 *
 * OWNER, verbatim — what he actually said about entry surfaces:
 *
 *   "i need to be able to enter payment details (card info and shipping/billing
 *    address etc) in the tui too"
 *   "and in the agent - basically ui should expose it in both."
 *
 * He named the TUI and the agent. He did NOT name the webui, and whether a card
 * number may be typed into a browser page is an open question in front of him —
 * a materially different exposure from typing it at a terminal. Until he
 * answers, the webui is not an entry surface.
 *
 * COORDINATOR ruling — that card details are refused on remote messaging
 * surfaces, with the reasoning below. Not attributed to the owner because no
 * verbatim wording of his has been produced for it.
 *
 * ══ The two axes look alike and must never be merged ══════════════════════
 *
 * A later reader will notice two channel classifications here and try to unify
 * them. They answer different questions:
 *
 *   ANSWERING  — may this surface say yes or no to a purchase?
 *                YES for Telegram and every other live channel. That IS the
 *                owner's explicit ruling and it stays. See types.ts,
 *                `CommandAuthorityChannel`.
 *
 *   ENTERING   — may card details be typed into this surface?
 *                Only a local terminal: the TUI and the agent's own terminal.
 *
 * Remote channels have authority to decide about a purchase. They have no path
 * for entering the instrument.
 *
 * ══ Why entering is stricter than answering ═══════════════════════════════
 *
 * A card number typed into Telegram is stored on Telegram's servers, in message
 * history nobody here controls or can erase, and it travelled through their
 * infrastructure before it ever reached us. The same is true of every hosted
 * chat channel.
 *
 * Encryption at rest is irrelevant to a value that was already copied somewhere
 * else on its way in. That is the whole argument: the damage is done before any
 * storage decision of ours applies.
 *
 * An "approve" typed into Telegram carries no such residue — it is one word
 * about one purchase, it expires, and it authorizes nothing on its own.
 *
 * ══ The prompt is itself the harm ═════════════════════════════════════════
 *
 * There is deliberately no card-entry flow that can be STARTED from a
 * non-entry surface. Prompting for a card number where the answer cannot be
 * accepted is an invitation to type it there, and the invitation is what puts
 * the number on someone else's server. Refusing the answer afterwards is too
 * late.
 */

/** Surfaces where card details may be typed. */
/**
 * Surfaces where card details may be typed.
 *
 * The webui is deliberately ABSENT pending an owner ruling — see the header.
 * Adding it is a one-line change and must not be made without his answer.
 */
export type CardEntrySurface = 'tui' | 'agent-terminal';

const CARD_ENTRY_SURFACES: readonly string[] = ['tui', 'agent-terminal'];

/**
 * Remote messaging surfaces, named so a refusal can say which one it refused.
 *
 * The list is a courtesy for the message, not the defence: `mayEnterCardDetails`
 * allows only the three entry surfaces, so anything not on that allowlist is
 * refused whether or not it appears here.
 */
const REMOTE_MESSAGE_SURFACES: readonly string[] = [
  'telegram', 'ntfy', 'discord', 'slack', 'whatsapp', 'signal', 'webhook', 'email', 'sms', 'matrix',
];

/**
 * May card details be typed on this surface?
 *
 * An ALLOWLIST, deliberately. A denylist ships every channel added after it was
 * written, and the direction to fail for card material is closed.
 */
export function mayEnterCardDetails(surface: string): boolean {
  return CARD_ENTRY_SURFACES.includes(surface.trim().toLowerCase());
}

export function isRemoteMessageSurface(surface: string): boolean {
  return REMOTE_MESSAGE_SURFACES.includes(surface.trim().toLowerCase());
}

/** Digit runs long enough to be a card number, ignoring spaces and dashes. */
const PAN_SHAPED = /(?:\d[ -]?){13,19}/;
/** MM/YY or MM/YYYY, the shape an expiry prompt gets answered with. */
const EXPIRY_SHAPED = /\b(0[1-9]|1[0-2])\s*[/-]\s*(\d{2}|\d{4})\b/;
/** A bare 3-4 digit group, which is what a CVV answer looks like. */
const CVV_SHAPED = /^\s*\d{3,4}\s*$/;

export interface CardDetailScan {
  readonly looksLikeCardDetails: boolean;
  /** Which shape matched, for the refusal — never the value that matched. */
  readonly matched: readonly ('card-number' | 'expiry' | 'cvv')[];
}

/**
 * Does this inbound message look like it carries card details?
 *
 * Returns only WHICH SHAPE matched, never the matching text. A scanner that
 * echoed its evidence would put the card in the refusal, the log line and the
 * notification body — the exact places this exists to keep it out of.
 *
 * `expectingCvv` is set when the last thing we asked for was a verification
 * code, because a bare "123" is meaningless out of context and refusing every
 * three-digit message would be unusable.
 *
 * Luhn is deliberately NOT used to narrow this. A number that fails Luhn is
 * still a number he typed into a chat surface, and the point is to stop that
 * happening at all rather than to grade the quality of what leaked.
 */
export function scanForCardDetails(text: string, options: { readonly expectingCvv?: boolean } = {}): CardDetailScan {
  const matched: ('card-number' | 'expiry' | 'cvv')[] = [];
  const digitsOnly = text.replace(/[^\d]/g, '');
  if (PAN_SHAPED.test(text) && digitsOnly.length >= 13 && digitsOnly.length <= 19) {
    matched.push('card-number');
  }
  if (EXPIRY_SHAPED.test(text)) matched.push('expiry');
  if (options.expectingCvv === true && CVV_SHAPED.test(text)) matched.push('cvv');
  return { looksLikeCardDetails: matched.length > 0, matched };
}

/**
 * The reply he gets when card details arrive somewhere they cannot be accepted.
 *
 * Built from the surface name and the matched SHAPES only. It never quotes,
 * echoes, partially masks or summarizes the value it just refused — a masked
 * echo is still an echo, and the message it appears in is stored on the same
 * server the refusal is about.
 */
export function describeCardEntryRefusal(surface: string): string {
  const where = isRemoteMessageSurface(surface) ? surface : 'this channel';
  return [
    `I can't take card details over ${where}, so I have not stored anything from that message.`,
    `Anything typed here is kept on ${where}'s servers, in history I can't reach or delete,`,
    'and it passed through their systems before it ever got to me — encrypting it on my end afterwards',
    'would not undo that.',
    '',
    'Enter the card at a terminal instead: the TUI or the agent terminal.',
    '',
    'Please also delete the message you just sent, and if that was a real card number, treat it as exposed.',
  ].join(' ').replace(/ {2,}/g, ' ');
}

export interface CardEntryDecision {
  readonly allowed: boolean;
  readonly reason: string | null;
  /** Shapes detected, for the audit record. Never the values. */
  readonly matched: readonly ('card-number' | 'expiry' | 'cvv')[];
}

/**
 * The gate an inbound message passes before anything stores card material.
 *
 * Two refusals, in order:
 *  1. the surface may not carry card details at all; or
 *  2. the surface may, but this specific message is not a card-entry step.
 *
 * Note the asymmetry with approvals: this function has no bearing on whether
 * the same surface may approve a purchase. See the module header.
 */
export function evaluateCardEntry(input: {
  readonly surface: string;
  readonly text: string;
  readonly expectingCvv?: boolean;
}): CardEntryDecision {
  const scan = scanForCardDetails(input.text, { expectingCvv: input.expectingCvv === true });
  if (mayEnterCardDetails(input.surface)) {
    return { allowed: true, reason: null, matched: scan.matched };
  }
  if (!scan.looksLikeCardDetails) {
    // Nothing card-shaped arrived; this is an ordinary message on a channel
    // that simply is not a card-entry surface. Not a refusal, just not entry.
    return { allowed: false, reason: null, matched: [] };
  }
  return {
    allowed: false,
    reason: describeCardEntryRefusal(input.surface),
    matched: scan.matched,
  };
}

/**
 * May a card-entry FLOW be offered here?
 *
 * Separate from `evaluateCardEntry` because the prompt is the harm: a surface
 * that cannot accept the answer must never ask the question.
 */
export function mayOfferCardEntryFlow(surface: string): boolean {
  return mayEnterCardDetails(surface);
}
