/**
 * windows.ts — the approval gate and the veto window.
 *
 * ══ READ THIS BEFORE UNIFYING THEM ════════════════════════════════════════
 *
 * These two look like near-duplicates. Merging them into one timed-prompt
 * primitive with a configurable default would be a natural cleanup and it would
 * be a serious defect. See docs/decisions/2026-07-27-payment-windows-are-deliberately-opposite.md.
 *
 *   ABOVE budget → an APPROVAL. Silence means DENIED.
 *   WITHIN budget → a VETO.     Silence means PROCEEDS.
 *
 * Owner's reasoning for the approval side:
 *
 *   "if i didn't want the approval to expire, I should have just increased the
 *    limit... puts it directly in the human's hands, never lets automated
 *    spending happen"
 *
 * They answer different questions. The approval asks *may this happen at all*,
 * and an unanswered question about money above the limit must resolve to no. The
 * veto announces *this is about to happen*, and an unanswered announcement about
 * money inside a limit he already set must resolve to yes — otherwise the limit
 * does nothing and every purchase is an approval.
 *
 * Collapsing them means picking one silence rule for both. Either every
 * above-budget purchase starts going through unattended, or every in-budget one
 * stalls waiting for a human — and the second gets "fixed" by flipping the
 * default, which produces the first.
 *
 * The duplication below is load-bearing. There is deliberately no shared
 * `openTimedPrompt()`.
 *
 * ══ Presence is not attention ═════════════════════════════════════════════
 *
 * The window runs its full configured duration regardless of where he is. No
 * presence, focus, idle or activity signal shortens, skips or extends it — the
 * deadline is a function of the start instant and the configured duration and
 * nothing else. Owner's reasoning:
 *
 *   "this is for situations where the user is multitasking and doesn't look at
 *    the specific terminal session for an extended period of time"
 *
 * Only an explicit acknowledgement short-circuits it.
 */
import type { CommandAuthorityChannel } from './types.js';

/**
 * What happens when a window closes with no answer.
 *
 * The two windows must never share a value. A test asserts both values
 * individually and asserts they differ, so a change to either fails with a
 * message naming the ruling rather than silently converting denials into
 * purchases.
 */
export type SilenceMeaning = 'denied' | 'proceeds';

export const APPROVAL_GATE = {
  kind: 'approval',
  silenceMeans: 'denied',
} as const satisfies { kind: string; silenceMeans: SilenceMeaning };

export const VETO_WINDOW = {
  kind: 'veto',
  silenceMeans: 'proceeds',
} as const satisfies { kind: string; silenceMeans: SilenceMeaning };

/** What the delivery layer reported, per channel. */
export interface ChannelDelivery {
  readonly channel: CommandAuthorityChannel;
  readonly delivered: boolean;
  /** Whether this channel's history can be re-read for a span we were down. */
  readonly backfillable: boolean;
}

export type ApprovalState =
  | 'pending-dispatch'
  | 'awaiting-approval'
  | 'approved'
  | 'denied-explicit'
  | 'denied-timeout'
  | 'denied-undeliverable'
  | 'void';

export type VetoState =
  | 'pending-dispatch'
  | 'open'
  | 'proceeding-acknowledged'
  | 'proceeding-silent'
  | 'proceeding-undelivered'
  | 'cancelled'
  | 'void';

/** Every terminal state settles its reservation exactly one way. */
export type Settlement = 'commit' | 'release' | 'hold';

const APPROVAL_SETTLEMENT: Readonly<Record<ApprovalState, Settlement>> = {
  'pending-dispatch': 'hold',
  'awaiting-approval': 'hold',
  approved: 'hold', // proceeds to payment; commit happens after the charge
  'denied-explicit': 'release',
  'denied-timeout': 'release',
  'denied-undeliverable': 'release',
  void: 'release',
};

const VETO_SETTLEMENT: Readonly<Record<VetoState, Settlement>> = {
  'pending-dispatch': 'hold',
  open: 'hold',
  'proceeding-acknowledged': 'hold',
  'proceeding-silent': 'hold',
  'proceeding-undelivered': 'hold',
  cancelled: 'release',
  void: 'release',
};

export function approvalSettlement(state: ApprovalState): Settlement {
  return APPROVAL_SETTLEMENT[state];
}

export function vetoSettlement(state: VetoState): Settlement {
  return VETO_SETTLEMENT[state];
}

export function isTerminalApproval(state: ApprovalState): boolean {
  return state !== 'pending-dispatch' && state !== 'awaiting-approval';
}

export function isTerminalVeto(state: VetoState): boolean {
  return state !== 'pending-dispatch' && state !== 'open';
}

/** The deadline. A pure function of the start and the duration — nothing else. */
export function windowDeadlineMs(startedAtMs: number, minutes: number): number {
  return startedAtMs + Math.max(0, minutes) * 60_000;
}

export type ApprovalEvent =
  | { readonly kind: 'dispatched'; readonly deliveries: readonly ChannelDelivery[] }
  | { readonly kind: 'undeliverable' }
  | { readonly kind: 'approve'; readonly channel: CommandAuthorityChannel }
  | { readonly kind: 'deny'; readonly channel: CommandAuthorityChannel }
  | { readonly kind: 'deadline' }
  | { readonly kind: 'total-changed' };

export type VetoEvent =
  | { readonly kind: 'dispatched'; readonly deliveries: readonly ChannelDelivery[] }
  | { readonly kind: 'undeliverable' }
  | { readonly kind: 'acknowledge'; readonly channel: CommandAuthorityChannel }
  | { readonly kind: 'object'; readonly channel: CommandAuthorityChannel }
  | { readonly kind: 'deadline' }
  | { readonly kind: 'total-changed' };

/**
 * The approval gate. SILENCE DENIES.
 *
 * Note `undeliverable` → `denied-undeliverable`. An above-budget purchase whose
 * notification could not reach him does not happen: there is nobody to put it in
 * front of, and the whole point of the above-budget branch is that a human
 * decides.
 */
export function advanceApproval(state: ApprovalState, event: ApprovalEvent): ApprovalState {
  if (isTerminalApproval(state)) return state;
  switch (event.kind) {
    case 'dispatched':
      return event.deliveries.some((entry) => entry.delivered)
        ? 'awaiting-approval'
        : 'denied-undeliverable';
    case 'undeliverable':
      return 'denied-undeliverable';
    case 'approve':
      return state === 'awaiting-approval' ? 'approved' : state;
    case 'deny':
      return 'denied-explicit';
    case 'deadline':
      return 'denied-timeout';
    case 'total-changed':
      return 'void';
    default:
      return state;
  }
}

/**
 * The veto window. SILENCE PROCEEDS.
 *
 * Note `undeliverable` → `proceeding-undelivered`. Owner ruling: under or at
 * budget, items get through. This is the exact mirror of the approval's
 * undeliverable edge, and that pair of edges is his undeliverable ruling in its
 * entirety.
 */
export function advanceVeto(state: VetoState, event: VetoEvent): VetoState {
  if (isTerminalVeto(state)) return state;
  switch (event.kind) {
    case 'dispatched':
      return event.deliveries.some((entry) => entry.delivered) ? 'open' : 'proceeding-undelivered';
    case 'undeliverable':
      return 'proceeding-undelivered';
    case 'acknowledge':
      return 'proceeding-acknowledged';
    case 'object':
      return 'cancelled';
    case 'deadline':
      return 'proceeding-silent';
    case 'total-changed':
      return 'void';
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Recovering a window that was interrupted by downtime
// ---------------------------------------------------------------------------

/**
 * What a restart should do with a window whose deadline passed while we were
 * down.
 *
 * ── Keyed on DELIVERY, not on uptime ──────────────────────────────────────
 *
 * Silence means "he had the chance to object and did not." Whether OUR process
 * was alive has nothing to do with whether he had that chance. An earlier draft
 * keyed this on uptime and re-opened every interrupted window; that is wrong,
 * because it re-pings him about something he deliberately ignored, and a system
 * that repeats itself is one he stops reading.
 *
 *  - delivered, then expired  → the expiry STANDS. Backfill each live channel
 *    for the downtime span and honour any objection found there before charging.
 *    Do not re-notify: he already saw it.
 *  - never delivered          → the undeliverable rule governs, unchanged.
 *  - cannot be backfilled     → re-open on THAT CHANNEL ONLY, because only that
 *    channel cannot distinguish silence from an objection we dropped.
 */
export interface WindowRecovery {
  readonly outcome: 'expiry-stands' | 'undeliverable-rule' | 'reopen';
  /** Channels whose history must be read for the downtime span before settling. */
  readonly backfillChannels: readonly CommandAuthorityChannel[];
  /** Channels the window re-opens on, when it re-opens at all. */
  readonly reopenChannels: readonly CommandAuthorityChannel[];
  readonly reason: string;
}

export function recoverInterruptedWindow(input: {
  readonly deliveries: readonly ChannelDelivery[];
  readonly deadlinePassed: boolean;
}): WindowRecovery {
  const delivered = input.deliveries.filter((entry) => entry.delivered);
  if (delivered.length === 0) {
    return {
      outcome: 'undeliverable-rule',
      backfillChannels: [],
      reopenChannels: [],
      reason: 'The notification never reached him, so the undeliverable rule decides this, not the clock.',
    };
  }
  if (!input.deadlinePassed) {
    return {
      outcome: 'expiry-stands',
      backfillChannels: delivered.filter((entry) => entry.backfillable).map((entry) => entry.channel),
      reason: 'The window is still open; it is re-armed and any missed replies are backfilled.',
      reopenChannels: [],
    };
  }

  const unbackfillable = delivered.filter((entry) => !entry.backfillable);
  if (unbackfillable.length > 0) {
    return {
      outcome: 'reopen',
      backfillChannels: delivered.filter((entry) => entry.backfillable).map((entry) => entry.channel),
      reopenChannels: unbackfillable.map((entry) => entry.channel),
      reason:
        'One or more channels cannot be re-read for the span we were down, so on those channels silence '
        + 'is indistinguishable from an objection we dropped.',
    };
  }

  return {
    outcome: 'expiry-stands',
    backfillChannels: delivered.map((entry) => entry.channel),
    reopenChannels: [],
    reason: 'He was notified and the window elapsed. Backfill first, then settle — but do not ask him twice.',
  };
}
