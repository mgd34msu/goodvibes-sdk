/**
 * turn-boundary.ts, when the untrusted-content window resets.
 *
 * ── The bug this exists to fix ────────────────────────────────────────────
 *
 * `UntrustedContentLedger.startTurn()` had no production caller anywhere,
 * not in the SDK, not in any product, only tests. So "this turn" silently
 * meant "everything since the process started", bounded only by the ledger's
 * retention cap, and the corpus grew with uptime.
 *
 * That was harmless while the ledger drove a DISCLOSURE: a longer list of
 * origins on a receipt is noise, not a fault. It has teeth now that the ledger
 * drives a REFUSAL. A daemon up for a week would carry a week of strangers'
 * text as evidence against every outward action, and the first legitimate send
 * that happened to echo any of it would be refused for no reason a person
 * could reconstruct.
 *
 * ── What a turn is bound to, and why ──────────────────────────────────────
 *
 * A turn begins when the owner makes a fresh request, `explicitUserRequest`,
 * the one signal that honestly means "a person asked for this, now". Anything
 * the runtime then reads and does belongs to that turn.
 *
 * Automated work deliberately does NOT start a turn. A schedule, a trigger or
 * a channel-driven call leaves the window open, so its exposure accumulates
 * rather than clearing. That asymmetry is the safe direction and it is the
 * point: if automated work reset the window, content that had just been read
 * could arrange for the record of itself to be erased before the send it was
 * trying to cause.
 */

import { getProcessUntrustedContentLedger, type UntrustedContentLedger } from './untrusted-content.js';
import type { TurnInputOrigin } from '../../events/turn.js';

/**
 * Reset the untrusted-content window if, and only if, this invocation is a
 * fresh owner request.
 *
 * Returns whether a turn was started, so a caller can log or test it without
 * reaching into the ledger.
 */
export function startTurnForOwnerRequest(
  explicitUserRequest: boolean | undefined,
  ledger: UntrustedContentLedger = getProcessUntrustedContentLedger(),
): boolean {
  if (explicitUserRequest !== true) return false;
  ledger.startTurn();
  return true;
}

/**
 * Message sources that mean "the human typed this, here, now".
 *
 * `operator` is the only source in `MessageSource` whose own definition says
 * so, "human typed in the TUI prompt". Everything else in that union is a
 * companion, a channel, or the runtime talking to itself.
 *
 * Deliberately NOT in this list: `companion-followup`. It reads like the owner
 * and sometimes is, but the same emit path serves anything that can inject into
 * the operator's live conversation, and a source that is sometimes the owner is
 * not evidence that this one was. A surface that CAN establish it is the human
 * says so with `ownerDirect: true` rather than by being on a list of names.
 */
export const OWNER_DIRECT_INPUT_SOURCES: readonly string[] = ['operator'];

/**
 * Did this input come from the owner, directly?
 *
 * Three ways to be true, and the default for everything else is false:
 *
 *  1. **No origin at all.** The surface process took this text off its own
 *     input widget; nothing routed it in. That is the keyboard.
 *  2. **`ownerDirect: true`.** An explicit attestation from a transport that
 *     can honestly make it, it authenticated the owner, or it read a local
 *     terminal. It is a claim about the CALLER, made by code, and no message
 *     body can set it, because message bodies do not construct these records.
 *  3. **A source on the list above.**
 *
 * Unknown sources are false. This is the asymmetry the module header describes
 * and it only works in one direction: failing to reset the window costs some
 * friction on a legitimate action, while resetting it wrongly lets content that
 * was just read arrange for the record of itself to be erased before the send
 * it was trying to cause.
 */
export function inputOriginIsOwnerDirect(origin: TurnInputOrigin | undefined): boolean {
  if (origin === undefined) return true;
  if (origin.ownerDirect === true) return true;
  if (origin.ownerDirect === false) return false;
  return typeof origin.source === 'string' && OWNER_DIRECT_INPUT_SOURCES.includes(origin.source);
}

/**
 * Start a turn for a message entering the conversation, if the owner sent it.
 *
 * This is the boundary the module header describes and the one that had no
 * caller: `startTurnForOwnerRequest` existed, the daemon's gateway dispatch
 * used it, and the CONVERSATION, where a person actually speaks to the agent,
 * did not. So in the agent and the TUI the window opened once at process start
 * and never again: one mailbox read on Monday refused every send until the
 * process was restarted, which is why the refusal the owner met said "earlier
 * in this session" rather than "in this turn". It was telling the truth about
 * a scope that should never have been that wide.
 *
 * Returns whether a turn was started.
 */
export function startTurnForOwnerInput(
  origin: TurnInputOrigin | undefined,
  ledger: UntrustedContentLedger = getProcessUntrustedContentLedger(),
): boolean {
  if (!inputOriginIsOwnerDirect(origin)) return false;
  ledger.startTurn();
  return true;
}
