/**
 * payment-ports.ts, the two composition-supplied ports the checkout flow
 * spends and speaks through.
 *
 * Split from checkout-flow.ts purely for size; the flow re-exports both, so
 * every existing import path still works. The semantics documented on each
 * member are the contract; see checkout-flow.ts for how the flow uses them.
 */
import type { PurchaseRecord } from './purchase-record.js';
import type { ChannelDelivery } from './windows.js';
import type { CommandAuthorityChannel } from './types.js';

export interface PurchaseLedger {
  record(entry: PurchaseRecord): Promise<void>;
  /**
   * Optional lookup. Boot recovery uses it to verify that a `submitted`
   * journal record really has its purchase on the ledger before closing the
   * record and telling the owner it was recorded. A composition without it
   * gets the conservative treatment: the record is kept and the owner is
   * told exactly what could and could not be verified.
   */
  has?(purchaseId: string): Promise<boolean>;
}

/** Delivering a prompt and hearing back, over channels that carry authority. */
export interface PaymentNotifier {
  /** Sends the message; reports per-channel landing. `notice` expects no reply (boot-recovery settlements). */
  deliver(input: {
    readonly kind: 'approval' | 'veto' | 'notice';
    readonly message: string;
  }): Promise<readonly ChannelDelivery[]>;
  /**
   * Wait for an answer, or until the deadline.
   *
   * Resolves null on silence. The caller decides what silence MEANS, because
   * the two windows mean opposite things by it and a notifier that decided
   * would be one place where they could be accidentally unified.
   */
  awaitAnswer(input: {
    readonly kind: 'approval' | 'veto';
    readonly deadlineMs: number;
  }): Promise<{
    readonly answer: 'approve' | 'deny' | 'acknowledge' | 'object';
    readonly channel: CommandAuthorityChannel;
  } | null>;
}

