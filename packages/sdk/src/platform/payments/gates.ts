/**
 * gates.ts — step 0 of the decision order: the checks that are terminal.
 *
 * Everything here refuses outright. There is no approval path around a gate and
 * no downgrade path through one — that is what separates step 0 from steps 1
 * and 2, where a purchase can still be rescued by an approval or by stepping
 * delivery down.
 *
 * The gates take a single record with every input REQUIRED rather than a partly
 * optional bag, so a caller cannot quietly omit one and get a pass. In
 * particular `isPaymentsLeader` has no default: on a clustered install the wrong
 * answer here is a double-spend, and a defaulted `true` would be the kind of
 * convenience that reads fine in review and costs money in production.
 */
import type { RefusalCode } from './types.js';

export interface GateInput {
  /** `payments.enabled`. */
  readonly enabled: boolean;
  /** A card is configured and its material is present in the secret store. */
  readonly hasUsableCard: boolean;
  /** A shipping address is configured. */
  readonly hasShippingAddress: boolean;
  /**
   * This request came from the owner speaking directly, in this turn.
   *
   * Not "a request arrived" — a schedule, a trigger or a channel message is not
   * an instruction to spend money. See security/untrusted-content.ts: those
   * surfaces carry no command authority at all.
   */
  readonly isOwnerDirectRequest: boolean;
  /**
   * This node is the one elected to serve payments.
   *
   * Required, never defaulted. Config replication carries the LIMITS to every
   * opted-in node but not today's SPEND (cluster/config-replication-policy.ts),
   * so a second node acting would start from a clean daily budget and could
   * spend it a second time. Until the spend ledger itself replicates, exactly
   * one node may act.
   */
  readonly isPaymentsLeader: boolean;
}

export interface GateRefusal {
  readonly code: RefusalCode;
  readonly reason: string;
}

/**
 * Run the terminal gates in order, returning the first refusal or null.
 *
 * Order matters only for the message the owner reads: the most fundamental
 * reason is reported rather than the first incidental one, so "payments are
 * off" beats "no card configured" when both are true.
 */
export function checkPaymentGates(input: GateInput): GateRefusal | null {
  if (!input.enabled) {
    return {
      code: 'disabled',
      reason:
        'Refused: the payment capability is off. Turn on payments.enabled and set a daily budget '
        + 'before I can buy anything.',
    };
  }
  if (!input.isOwnerDirectRequest) {
    return {
      code: 'not-owner-request',
      reason:
        'Refused: this purchase was not asked for by you directly. A schedule, a trigger, or a '
        + 'message from a channel cannot authorize spending — only you can, in your own words.',
    };
  }
  if (!input.isPaymentsLeader) {
    return {
      code: 'disabled',
      reason:
        'Refused: this machine is not the one currently serving payments. Only the elected node '
        + 'may spend, because today\'s totals live on it and a second machine would start from a '
        + 'clean daily budget.',
    };
  }
  if (!input.hasUsableCard) {
    return {
      code: 'no-card',
      reason: 'Refused: no usable card is configured. Add one before asking me to buy something.',
    };
  }
  if (!input.hasShippingAddress) {
    return {
      code: 'no-shipping-address',
      reason:
        'Refused: no shipping address is configured, so I have nowhere to have this delivered.',
    };
  }
  return null;
}
