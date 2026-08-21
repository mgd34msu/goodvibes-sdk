/**
 * checkout-registry.ts, which purchase, if any, is in flight on a browser page.
 *
 * ══ What this is for ══════════════════════════════════════════════════════
 *
 * Two of the fill's refusals need an answer to "what was decided, and for
 * whom", and neither can be answered from the fill's own arguments:
 *
 *   - **Refuse a fill with no decision in flight.** The card is typed as part of
 *     an approved checkout or it is not typed. Without this, `fillCard` is a
 *     verb that types the owner's card into whatever page happens to be open,
 *     which is a strictly worse capability than the one it replaced.
 *   - **Refuse a fill into the wrong merchant.** The decision was made against
 *     one registrable domain. A page that has since navigated, or a second tab
 *     the model targeted by mistake, or a merchant page that framed someone
 *     else's form, is not that domain, and the card does not go there.
 *
 * ══ The phases exist for crash recovery ═══════════════════════════════════
 *
 * A checkout that dies partway must not leave an ambiguous state, and the only
 * genuinely ambiguous moment is the submit itself: once the request leaves, we
 * cannot tell from our side whether the merchant received it. Everything before
 * that is unambiguously "not submitted".
 *
 * So the phase is written durably as it changes, and `submit-pending` is written
 * and flushed BEFORE the submit is issued:
 *
 *   deciding        nothing has been typed. Crash ⇒ not submitted.
 *   awaiting-window the window is open, budget is reserved, no card typed.
 *                   Crash ⇒ not submitted.
 *   arming-payment  card material is on the page. Crash ⇒ not submitted, and
 *                   the material dies with the browser.
 *   submit-pending  written and flushed BEFORE the click. Crash ⇒ POSSIBLY
 *                   SUBMITTED. Reported as such and never retried.
 *   submitted       the merchant's response was seen. Crash ⇒ submitted.
 *
 * A record found in `submit-pending` at startup is the one case that needs a
 * human: the owner is told to check that merchant's order history, and nothing
 * automatic touches it. Retrying is how one order becomes two, and "it probably
 * did not go through" is not a thing this code is entitled to believe.
 */
import type { BudgetDraw } from './decide.js';
import type { CurrencyCode, MinorUnits, OwnerSuppliedText, ShippingStepDown, ShippingTier } from './types.js';

export type CheckoutPhase =
  | 'deciding'
  | 'awaiting-window'
  | 'arming-payment'
  | 'submit-pending'
  | 'submitted'
  | 'abandoned';

/** What a restart can conclude about a checkout it found mid-flight. */
export type InterruptedVerdict = 'not-submitted' | 'possibly-submitted' | 'submitted';

/**
 * A purchase in flight, bound to the browser page it is running on.
 *
 * `merchantDomain` is the registrable domain computed by us from the VALIDATED
 * checkout url, never a name the page supplied. It is the value the fill's
 * origin check compares against, so its provenance is the whole point.
 */
export interface InFlightCheckout {
  readonly purchaseId: string;
  readonly sessionId: string;
  readonly pageId: string;
  readonly merchantDomain: string;
  readonly cardId: string;
  readonly item: OwnerSuppliedText;
  readonly currency: CurrencyCode;
  readonly phase: CheckoutPhase;
  readonly startedAtMs: number;
  readonly updatedAtMs: number;
  /** Set once the decision layer has run. Null while still extracting. */
  readonly draw: BudgetDraw | null;
  readonly reservationId: string | null;
  readonly shippingTierRequested: ShippingTier;
  readonly shippingTierUsed: ShippingTier | null;
  readonly stepDown: ShippingStepDown | null;
  readonly totalMinorUnits: MinorUnits | null;
}

/**
 * Durable storage for in-flight checkouts.
 *
 * A port rather than a file path so the flow can be exercised without a daemon
 * home, and so the flush point is explicit: `put` must not return until the
 * record would survive a power cut. An implementation that buffers turns the
 * `submit-pending` guarantee into a comment.
 */
export interface CheckoutJournal {
  put(record: InFlightCheckout): Promise<void>;
  remove(purchaseId: string): Promise<void>;
  list(): Promise<readonly InFlightCheckout[]>;
}

/** An in-memory journal. Durable across nothing; for tests and for a dry run. */
export class MemoryCheckoutJournal implements CheckoutJournal {
  private readonly records = new Map<string, InFlightCheckout>();

  async put(record: InFlightCheckout): Promise<void> {
    this.records.set(record.purchaseId, record);
  }

  async remove(purchaseId: string): Promise<void> {
    this.records.delete(purchaseId);
  }

  async list(): Promise<readonly InFlightCheckout[]> {
    return [...this.records.values()];
  }
}

export class CheckoutRegistryError extends Error {
  constructor(message: string, readonly fix: string) {
    super(message);
    this.name = 'CheckoutRegistryError';
  }
}

/**
 * The live map of page → purchase, backed by a journal.
 *
 * One checkout per page, enforced: a second `open` for a page already running
 * one throws rather than replacing it. Two purchases driving one page would
 * interleave their fills and their submits, and the cheapest way to guarantee
 * that cannot happen is to make it unrepresentable.
 */
export class CheckoutRegistry {
  private readonly byPage = new Map<string, InFlightCheckout>();

  constructor(private readonly journal: CheckoutJournal) {}

  private static key(sessionId: string, pageId: string): string {
    return `${sessionId}:${pageId}`;
  }

  async open(record: InFlightCheckout): Promise<InFlightCheckout> {
    const key = CheckoutRegistry.key(record.sessionId, record.pageId);
    const existing = this.byPage.get(key);
    if (existing !== undefined) {
      throw new CheckoutRegistryError(
        `A purchase is already in flight on this page (${existing.purchaseId}).`,
        'Finish or abandon that purchase before starting another on the same page.',
      );
    }
    this.byPage.set(key, record);
    await this.journal.put(record);
    return record;
  }

  /** The checkout in flight on this page, or null. */
  current(sessionId: string, pageId: string): InFlightCheckout | null {
    return this.byPage.get(CheckoutRegistry.key(sessionId, pageId)) ?? null;
  }

  /**
   * Move a checkout to a new phase, flushing before returning.
   *
   * The flush is what makes `submit-pending` mean anything, so it is not
   * conditional on the phase: making it conditional would put the guarantee one
   * edit away from a caller that passed the wrong flag.
   */
  async advance(
    purchaseId: string,
    phase: CheckoutPhase,
    patch: Partial<Omit<InFlightCheckout, 'purchaseId' | 'sessionId' | 'pageId' | 'phase'>> = {},
    nowMs: number = Date.now(),
  ): Promise<InFlightCheckout> {
    const found = [...this.byPage.entries()].find(([, record]) => record.purchaseId === purchaseId);
    if (found === undefined) {
      throw new CheckoutRegistryError(
        `No purchase with id ${purchaseId} is in flight.`,
        'Start a checkout before advancing it.',
      );
    }
    const [key, record] = found;
    const next: InFlightCheckout = { ...record, ...patch, phase, updatedAtMs: nowMs };
    this.byPage.set(key, next);
    await this.journal.put(next);
    return next;
  }

  /** Remove a finished or abandoned checkout from the live map and the journal. */
  async close(purchaseId: string): Promise<void> {
    const found = [...this.byPage.entries()].find(([, record]) => record.purchaseId === purchaseId);
    if (found !== undefined) this.byPage.delete(found[0]);
    await this.journal.remove(purchaseId);
  }

  /** Every checkout still in flight, for a restart to reason about. */
  async interrupted(): Promise<readonly { record: InFlightCheckout; verdict: InterruptedVerdict }[]> {
    const records = await this.journal.list();
    return records.map((record) => ({ record, verdict: verdictFor(record.phase) }));
  }
}

/**
 * What a restart may conclude from a phase.
 *
 * `submit-pending` is the honest answer to a question we cannot answer, and it
 * is deliberately not called "failed". A checkout that reached this phase had
 * everything ready and a submit issued or about to be; treating it as failed is
 * what makes a restart buy the same thing twice.
 */
export function verdictFor(phase: CheckoutPhase): InterruptedVerdict {
  switch (phase) {
    case 'submitted':
      return 'submitted';
    case 'submit-pending':
      return 'possibly-submitted';
    default:
      return 'not-submitted';
  }
}

/**
 * What the owner is told about a checkout that a crash interrupted.
 *
 * Rendered from the record's own typed fields, never from anything the merchant
 * page said, for the same reason every other payment notice is
 * (message.ts), a page that can write this text writes what the owner reads.
 */
export function describeInterruption(
  record: InFlightCheckout,
  verdict: InterruptedVerdict,
): string {
  if (verdict === 'submitted') {
    return `The order at ${record.merchantDomain} was submitted before the restart and is recorded.`;
  }
  if (verdict === 'not-submitted') {
    return (
      `A checkout at ${record.merchantDomain} was interrupted before anything was submitted. `
      + 'Nothing was charged and the budget it was holding has been released.'
    );
  }
  return (
    `A checkout at ${record.merchantDomain} was interrupted AT THE MOMENT OF SUBMITTING, so I `
    + 'cannot tell whether the order went through. Check your order history at that merchant. '
    + 'I will not retry it and I have not released the budget it was holding, tell me which it '
    + 'was and I will settle the record.'
  );
}
