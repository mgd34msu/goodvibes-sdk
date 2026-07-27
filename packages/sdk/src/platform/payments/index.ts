/**
 * payments/index.ts — the payment capability's public surface.
 *
 * The SDK owns this capability, the daemon serves it, and surfaces are wiring
 * and UI only. Everything a surface needs to render a settings form, an approval
 * prompt, a veto prompt or a purchase list is exported here; no surface
 * re-implements a budget, a ladder step, or a window outcome.
 *
 * See docs/payments.md for the design and
 * docs/decisions/2026-07-27-payment-windows-are-deliberately-opposite.md and
 * docs/decisions/2026-07-27-the-cvv-is-stored.md for the two rulings a later
 * round is most likely to try to undo.
 */

export {
  parseCurrencyCode,
  parseCommandAuthorityChannel,
  ownerSuppliedText,
  SHIPPING_TIERS,
} from './types.js';
export type {
  MinorUnits,
  CurrencyCode,
  OwnerSuppliedText,
  CommandAuthorityChannel,
  ShippingTier,
  ShippingOption,
  ShippingStepDown,
  CardMetadata,
  PostalAddress,
  BudgetPool,
  RefusalCode,
} from './types.js';

export { dayKey, sameDay, isValidTimezone, resolveTimezone } from './day.js';
export type { DayKey } from './day.js';

export { BudgetLedger, RESERVATION_TTL_MS, MAX_RESERVATIONS } from './budget.js';
export type {
  BudgetLimits,
  BudgetReservation,
  BudgetStateSnapshot,
  PoolSnapshot,
  SpendRecord,
} from './budget.js';

export { rankShippingOptions, walkShippingLadder, cheapestOption } from './shipping.js';
export type { RankedShipping, ShippingLadderResult } from './shipping.js';

export {
  APPROVAL_GATE,
  VETO_WINDOW,
  advanceApproval,
  advanceVeto,
  approvalSettlement,
  vetoSettlement,
  isTerminalApproval,
  isTerminalVeto,
  windowDeadlineMs,
  recoverInterruptedWindow,
} from './windows.js';
export type {
  SilenceMeaning,
  ApprovalState,
  VetoState,
  ApprovalEvent,
  VetoEvent,
  ChannelDelivery,
  Settlement,
  WindowRecovery,
} from './windows.js';

export { evaluatePaymentTaint, describePaymentTaint } from './taint-gate.js';
export type { PaymentIntentFields, PaymentTaintDecision } from './taint-gate.js';

export {
  renderApprovalMessage,
  renderVetoMessage,
  renderCancellationReport,
  formatMinorUnits,
} from './message.js';
export type { PurchaseFacts } from './message.js';

export {
  mayEnterCardDetails,
  mayOfferCardEntryFlow,
  isRemoteMessageSurface,
  scanForCardDetails,
  evaluateCardEntry,
  describeCardEntryRefusal,
} from './entry-surface.js';
export type { CardEntrySurface, CardDetailScan, CardEntryDecision } from './entry-surface.js';

export { checkPaymentGates } from './gates.js';
export type { GateInput, GateRefusal } from './gates.js';

export { decidePurchase } from './decide.js';
export type { DecisionInput, DecisionOutcome, BudgetDraw, QuotedTotals } from './decide.js';

export { assertCartMatchesRequest, detectRecurringCharge } from './cart.js';
export type { CartLine, RequestedLine, CartCheck, RecurringCheck } from './cart.js';

/**
 * What every surface must show at the moment someone selects
 * `payments.cvvHandling: 'prompt'`.
 *
 * The wording lives here rather than in each surface so it cannot drift, and it
 * is shown at the point of SELECTION rather than in a document, because a
 * trade-off this large belongs in front of whoever is flipping the switch.
 *
 * Note what this is not: it is not a warning against storing the CVV. Storing it
 * is the owner's settled ruling and the default. This is the honest consequence
 * of choosing the other value.
 */
export const CVV_PROMPT_TRADEOFF_WARNING =
  'Choosing "prompt" disables unattended purchasing. The card verification value will not be '
  + 'stored, so every purchase stops and waits for you to type it — including purchases that are '
  + 'within budget and would otherwise have gone ahead on their own. The veto window still runs, '
  + 'but nothing completes while you are away.';
