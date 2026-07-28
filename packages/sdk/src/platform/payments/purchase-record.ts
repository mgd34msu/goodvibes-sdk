/**
 * purchase-record.ts — one row of the audit ledger.
 *
 * Split out because it is read by more than the flow that writes it: the
 * control-plane view, the correlation lookup that recognises a store's
 * confirmation, and any surface rendering `payments.purchases.list` all need
 * the shape without needing the orchestration.
 *
 * Every amount is integer minor units this daemon parsed. Nothing on this
 * record came from merchant text unparsed, and nothing on it can carry card
 * material — `cardLast4` is the only part of the instrument that appears, which
 * is what makes the row reconcilable against a statement without being a leak.
 */
import type { MinorUnits } from './types.js';

/** One completed purchase, as the audit ledger stores it. */
export interface PurchaseRecord {
  readonly purchaseId: string;
  readonly atUtc: string;
  readonly dayKey: string;
  readonly timezone: string;
  readonly merchantDomain: string;
  readonly item: string;
  readonly currency: string;
  readonly itemMinorUnits: MinorUnits;
  readonly taxMinorUnits: MinorUnits;
  readonly feesMinorUnits: MinorUnits;
  readonly shippingMinorUnits: MinorUnits;
  readonly totalMinorUnits: MinorUnits;
  readonly shippingTierRequested: string;
  readonly shippingTierUsed: string;
  readonly steppedDown: boolean;
  readonly itemPoolDraw: MinorUnits;
  readonly overagePoolDraw: MinorUnits;
  readonly tolerancePoolDraw: MinorUnits;
  readonly cardLast4: string;
  readonly windowKind: string;
  readonly windowOutcome: string;
  readonly answeredBy: string | null;
  readonly outcome: string;
  readonly refusalReason: string | null;
  readonly merchantOrderId: string | null;
  readonly refundedAt: string | null;
  /**
   * Whether the merchant carried established recourse, and on what grounds.
   *
   * Recorded because it is the fact that decided what SILENCE meant on this
   * purchase, and a ledger that showed the outcome without it would leave him
   * unable to reconstruct why one purchase asked and another did not.
   */
  readonly merchantRecognised: boolean;
  readonly merchantQualifier: string | null;
}
