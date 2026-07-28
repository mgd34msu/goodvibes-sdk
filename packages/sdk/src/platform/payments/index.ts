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
  renderPurchaseNotice,
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
  WEBUI_CARD_ENTRY_CONDITIONS,
} from './entry-surface.js';
export type { CardEntrySurface, CardDetailScan, CardEntryDecision } from './entry-surface.js';

export {
  DEFAULT_RECOGNISED_RETAILERS,
  classifyMerchant,
  parseRetailerList,
  resolveRecognisedRetailers,
  windowForPurchase,
} from './major-retailers.js';
export type {
  RetailerQualifier,
  RetailerEntry,
  SaleType,
  MerchantIdentity,
  MarketplacePolicy,
  MajorRetailerPolicy,
  MajorRetailerVerdict,
} from './major-retailers.js';

export {
  DEFAULT_MARKETPLACE_LISTING_THRESHOLDS,
  evaluateMarketplaceListing,
} from './marketplace-listing.js';
export type {
  FigureRegion,
  ListingSaleFormat,
  SellerReputation,
  MarketplaceListing,
  MarketplaceListingThresholds,
  MarketplaceListingVerdict,
} from './marketplace-listing.js';

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

// ── Purchase EXECUTION ──────────────────────────────────────────────────────
//
// Everything above decides whether to buy. Everything below actually buys,
// and the seam between them is deliberate: the decision layer is pure and
// exhaustively tested, and the execution layer reaches it through ports so it
// can be driven end to end without a browser or a real card.

export { parseMinorUnits, parseQuantity, minorUnitExponent, MAX_PARSEABLE_MINOR_UNITS } from './money-parsing.js';

export { extractCheckout } from './checkout-extraction.js';
export type { RawCheckoutReading, ExtractedCheckout, ExtractionResult } from './checkout-extraction.js';

export { readCheckoutReadingInput } from './checkout-reading-input.js';
export type { ReadingInputResult } from './checkout-reading-input.js';

export { CardMaterialRedactor, isCardFieldDescriptor, REDACTED_MARKER } from './card-redaction.js';
export type { CardFieldKind, FormControlDescriptor } from './card-redaction.js';

export { cardFieldValue, isCardFieldName, CARD_FIELD_NAMES } from './card-material.js';
export type { CardMaterial, CardMaterialStore, CardFieldName } from './card-material.js';

export {
  CheckoutRegistry,
  CheckoutRegistryError,
  MemoryCheckoutJournal,
  verdictFor,
  describeInterruption,
} from './checkout-registry.js';
export type {
  CheckoutJournal,
  CheckoutPhase,
  InFlightCheckout,
  InterruptedVerdict,
} from './checkout-registry.js';

export type { CheckoutPageDriver, PageIdentity, CheckoutChallenge } from './checkout-page.js';

export { fillCard, FillCardRefusal } from './fill-card.js';
export type { CardFieldTarget, FillCardRequest, FillCardResult, FillCardDeps } from './fill-card.js';

export { runCheckout, merchantIdentity } from './checkout-flow.js';
export type {
  PurchaseRequest,
  PurchaseRecord,
  PurchaseLedger,
  PaymentNotifier,
  CheckoutFlowDeps,
  CheckoutControls,
  CheckoutOutcome,
} from './checkout-flow.js';

export { createChannelPaymentNotifier, parsePaymentReply } from './notice-delivery.js';
export type {
  PaymentNoticeTarget,
  PaymentNoticeRouter,
  PaymentReplySource,
  ChannelPaymentNotifierDeps,
} from './notice-delivery.js';

export { checkAddress, fillAddresses, renderDestination, addressFieldValue } from './address.js';
export type {
  AddressKind,
  AddressFieldName,
  AddressFieldTarget,
  AddressStore,
  AddressCheck,
  AddressFillResult,
} from './address.js';
