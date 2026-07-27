/**
 * turn-boundary.ts — when the untrusted-content window resets.
 *
 * ── The bug this exists to fix ────────────────────────────────────────────
 *
 * `UntrustedContentLedger.startTurn()` had no production caller anywhere —
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
 * A turn begins when the owner makes a fresh request — `explicitUserRequest`,
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

/**
 * Reset the untrusted-content window if — and only if — this invocation is a
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
