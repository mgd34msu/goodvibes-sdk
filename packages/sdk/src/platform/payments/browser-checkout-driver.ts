/**
 * browser-checkout-driver.ts, the page driver a real browser can answer.
 *
 * ══ The gap this closes ═══════════════════════════════════════════════════
 *
 * `CheckoutPageDriver` (checkout-page.ts) is the port the whole purchase runs
 * against, and until now the only implementation of it was a test fixture. A
 * daemon that had a browser open could not begin a checkout on it, because
 * nothing turned an open page into one of these. `payments.checkout.begin` and
 * `payments.checkout.fillCard` were cataloged verbs with no implementation
 * behind them for exactly that reason.
 *
 * ══ Why the adapter lives here and not in platform/browser ════════════════
 *
 * card-material.ts states that one module produces card material and
 * browser-secret-fill.ts states that one module types it. This file is neither:
 * it receives values fill-card.ts already read and hands them to the engine's
 * `fillSecretBatch`, which is the single typing path. Putting it on the
 * payments side keeps `platform/browser/` free of payment wiring, which is the
 * property browser-secret-fill.ts was split out to preserve.
 *
 * It also does not IMPORT the browser engine. `CheckoutBrowserEngine` below is
 * a structural description of the engine operations a purchase needs, and
 * `BrowserEngine` satisfies it without knowing this file exists. That keeps
 * `platform/payments/` importing nothing from `platform/browser/`, and it is
 * what lets the tests drive every path against a scripted fake with no driver,
 * no display and no process. It is also why a pre-click vs post-click submit
 * failure is told apart by the THROWN ERROR'S NAME rather than by importing
 * `StaleElementError`/`UntrustedEffectError`/`BrowserSessionError`: those
 * names are the engine's own public contract (the containment tests already
 * assert on them), and matching on a string keeps this file free of an import
 * those three classes would otherwise force.
 *
 * ══ The guard is checked, not assumed ═════════════════════════════════════
 *
 * `PaymentsGatewayServiceImpl` arms a `CardMaterialRedactor` before the first
 * keystroke, and the engine scrubs page output against the guard it was BUILT
 * with. Those have to be one object. Two instances means the flow arming one
 * while the engine scrubs against the other, which looks correct at every call
 * site and leaves the card readable in the next snapshot.
 *
 * So this adapter refuses rather than degrades, on two independent checks:
 *
 *  1. **Identity.** Every operation resolves the engine and compares
 *     `engine.cardFieldGuard()` against the guard this driver was constructed
 *     with. Null refuses (no redaction installed at all); a different object
 *     refuses (the engine is scrubbing against something else).
 *  2. **Armed.** Before typing card material, the guard must already hold live
 *     material for this exact page. fill-card.ts arms before it fills, so a
 *     guard that is not armed here is not the object the flow armed, whatever
 *     check 1 said about the engine. This one catches the mismatch that matters
 *     most, a payments service holding a redactor nobody handed to the engine.
 *
 * Neither check is advisory and neither can be skipped by a call site: they run
 * inside the accessor every method goes through.
 *
 * ══ What this driver deliberately cannot tell you ═════════════════════════
 *
 * `submitOrder` reports the url it landed on and, without help, nothing else.
 * Reading a merchant order number off a confirmation page, or recognising a
 * 3-D Secure interstitial, is site-specific knowledge, and checkout-page.ts
 * exists to keep site-specific knowledge out of this port. A composition that
 * can read its own merchants supplies `describeSubmission`; one that cannot
 * gets a null order id AND `verified: false`, which checkout-flow.ts records
 * and reports honestly as submitted-but-unconfirmed rather than as a purchase
 * nothing here actually watched complete.
 *
 * ══ What actually clears the outward-effect guard today ═══════════════════
 *
 * The engine refuses to activate a submitting control once the turn has read
 * page content THIS turn (security/untrusted-content.ts,
 * `evaluateOutwardEffect`). A purchase always reads a snapshot to find the refs
 * it passes in, but that read normally happened on an EARLIER turn: the model
 * snapshots a checkout, decides to buy, and the daemon then runs
 * `payments.checkout.begin` as a fresh owner-direct call, which resets the
 * untrusted-content ledger's turn watermark (`startTurnForOwnerRequest`,
 * security/turn-boundary.ts) before this flow does anything. Nothing this
 * flow itself does calls `snapshot`/`readText`/`extract`, so the watermark
 * reset is usually what leaves `originsThisTurn()` empty at the moment of the
 * click, and an empty set clears the guard with no `OwnerApproval` involved at
 * all. This is a fact about how the verb is normally invoked, not a property
 * this driver enforces, and it stops holding the moment something reads page
 * content inside the SAME turn as the submit.
 *
 * For that case, and as the honest, deliberate fallback, `BrowserCheckoutSeam`
 * (routes/browser-composition.ts) exposes `armSubmitApproval`, a
 * composition-only path onto the engine's `setOwnerApproval`. It is minted
 * and called by the daemon composition, never by anything in
 * `platform/payments/`: only the product's trust contract can construct an
 * `OwnerApproval`, and a payments module that could mint one would be a
 * payments module that could authorise its own spending. What this adapter
 * guarantees on its own side is that a refused submit is a refused submit: it
 * never retries, and it tells a pre-click refusal (`CheckoutSubmitRefused`)
 * apart from genuine post-click ambiguity so the flow's journal and its held
 * budget reservation reflect which one actually happened.
 */
import type { CardFieldKind } from './card-redaction.js';
import { CheckoutSubmitRefused, type CheckoutChallenge, type CheckoutPageDriver, type PageIdentity } from './checkout-page.js';

/**
 * The part of a card-material guard this adapter can see.
 *
 * Both `CardMaterialRedactor` (payments) and `CardFieldGuard` (browser) satisfy
 * it, which is the point: the identity check compares two references the two
 * layers each describe in their own terms.
 */
export interface CheckoutGuardHandle {
  hasLiveMaterial(sessionId: string, pageId: string): boolean;
}

/** Which session and page an engine operation acts on. */
export interface CheckoutEngineTarget {
  readonly sessionId?: string | undefined;
  readonly pageId?: string | undefined;
}

/**
 * The engine operations a purchase needs, described structurally so that
 * `BrowserEngine` satisfies this without either module importing the other.
 *
 * Every one of them answers with the engine's open record. This adapter reads
 * only `url`/`filled`/`failedRef` out of those records and never forwards a
 * whole one, so nothing a page wrote reaches the checkout flow through here.
 *
 * Every member is written in PROPERTY position (`foo: (args) => Ret`), not
 * method-shorthand (`foo(args): Ret`). TypeScript checks method-shorthand
 * parameters bivariantly even under `strictFunctionTypes`, so a real engine
 * method whose parameter type quietly narrowed or widened would still satisfy
 * this interface with no compile error. Property position is checked
 * contravariantly, which is what makes a real signature drift here a build
 * failure instead of a silent one.
 */
export interface CheckoutBrowserEngine {
  cardFieldGuard: () => CheckoutGuardHandle | null;
  tabs: (target: CheckoutEngineTarget) => Promise<Record<string, unknown>>;
  type: (target: CheckoutEngineTarget, args: { readonly ref: string; readonly text: string }) => Promise<Record<string, unknown>>;
  fillSecretBatch: (
    target: CheckoutEngineTarget,
    args: { readonly fills: readonly { readonly ref: string; readonly value: string }[] },
  ) => Promise<Record<string, unknown>>;
  select: (target: CheckoutEngineTarget, args: { readonly ref: string; readonly values: readonly string[] }) => Promise<Record<string, unknown>>;
  click: (target: CheckoutEngineTarget, args: { readonly ref: string }) => Promise<Record<string, unknown>>;
}

/** What the driver landed on after the one outward act, before it is described. */
export interface CheckoutSubmission {
  readonly url: string;
  readonly navigated: boolean;
}

/**
 * A merchant-order reading, when the composition has one.
 *
 * `verified` on the submission this produces is evidence-based: it is true
 * only when this description carries something the composition actually
 * looked at and found, an order id, a challenge, or `confirmed: true`. A
 * composition that ran and saw nothing, a declined card, a spinner, a page it
 * did not recognise, returns all three empty/false/null, and the submission is
 * `verified: false` exactly as if `describeSubmission` had never been wired.
 * Being CALLED is not evidence; what it returns is.
 */
export interface CheckoutSubmissionDescription {
  readonly orderId: string | null;
  readonly challenge: CheckoutChallenge | null;
  /**
   * Set when the composition positively confirmed the order without a
   * merchant order number to point to, a "thank you" / order-confirmed marker
   * it recognised on the landing page. Absent or false is not evidence of
   * anything, it is simply the common case where nothing more specific was
   * found.
   */
  readonly confirmed?: boolean | undefined;
}

export interface BrowserCheckoutDriverDeps {
  /**
   * The engine, resolved on first use.
   *
   * A function rather than an instance because the daemon builds its browser
   * lazily: registering the verbs must not download a driver or start a
   * process, so the driver factory has to exist before the engine does.
   */
  readonly engineFor: () => Promise<CheckoutBrowserEngine>;
  /**
   * The guard the payments service arms. Must be the same object the engine was
   * constructed with; see the two checks in this module's header.
   */
  readonly cardFieldGuard: CheckoutGuardHandle;
  /** Reads a merchant order id or a verification step off the landing page. */
  readonly describeSubmission?:
    | ((submission: CheckoutSubmission) => Promise<CheckoutSubmissionDescription>)
    | undefined;
}

/**
 * A refusal from the driver itself, as opposed to a page that would not accept
 * input.
 *
 * Carries no card material: every message below names a field, a page or a
 * missing guard, and never a value. The `fix` is what the operator has to
 * change in the composition, because every one of these is a wiring fault
 * rather than something a retry would clear.
 */
export class CheckoutDriverRefusal extends Error {
  constructor(message: string, readonly fix: string) {
    super(message);
    this.name = 'CheckoutDriverRefusal';
  }
}

function readUrl(result: Record<string, unknown>): string | null {
  const url = result['url'];
  return typeof url === 'string' && url.length > 0 ? url : null;
}

/**
 * A `CheckoutPageDriver` over one open page of a browser engine.
 *
 * Bound to a session and a page at construction and never resolving a default:
 * a purchase decided against one page must not be typed into whichever page
 * happens to be active when the second verb arrives.
 */
class BrowserCheckoutPageDriver implements CheckoutPageDriver {
  private readonly target: CheckoutEngineTarget;

  constructor(
    private readonly sessionId: string,
    private readonly pageId: string,
    private readonly deps: BrowserCheckoutDriverDeps,
  ) {
    this.target = { sessionId, pageId };
  }

  identity(): PageIdentity {
    return { sessionId: this.sessionId, pageId: this.pageId };
  }

  /**
   * The engine, with both guard checks applied.
   *
   * Every method goes through here, so there is no operation on this driver
   * that can run against an engine whose redaction is absent or is scrubbing
   * against a different object.
   */
  private async engine(): Promise<CheckoutBrowserEngine> {
    const engine = await this.deps.engineFor();
    const installed = engine.cardFieldGuard();
    if (installed === null) {
      throw new CheckoutDriverRefusal(
        'Refused: this browser was built with no card-material redaction, so anything typed into a '
        + 'checkout on it could be read straight back out of a page snapshot.',
        'Compose the browser through the checkout seam, which builds the engine with the guard the '
        + 'payments service arms.',
      );
    }
    if (installed !== this.deps.cardFieldGuard) {
      throw new CheckoutDriverRefusal(
        'Refused: this browser is scrubbing page output against a different card-material guard than '
        + 'the one this checkout arms, so material typed here would survive into reported content.',
        'Hand the seam\'s cardFieldGuard to the payments service instead of constructing a second one.',
      );
    }
    return engine;
  }

  async url(): Promise<string> {
    const engine = await this.engine();
    const listing = await engine.tabs({ sessionId: this.sessionId });
    const pages = listing['pages'];
    if (Array.isArray(pages)) {
      for (const entry of pages) {
        if (typeof entry !== 'object' || entry === null) continue;
        const record = entry as Record<string, unknown>;
        if (record['pageId'] !== this.pageId) continue;
        const url = record['url'];
        if (typeof url === 'string' && url.length > 0) return url;
      }
    }
    throw new CheckoutDriverRefusal(
      `Refused: page ${this.pageId} is not open in browser session ${this.sessionId}, so there is no `
      + 'checkout on it to read.',
      'Snapshot the checkout page again and start the purchase against the page id that reports back.',
    );
  }

  async fill(target: string, value: string): Promise<void> {
    const engine = await this.engine();
    await engine.type(this.target, { ref: target, text: value });
  }

  async fillSecrets(
    fields: readonly { readonly target: string; readonly value: string; readonly kind: CardFieldKind }[],
  ): Promise<{ readonly filledTargets: readonly string[]; readonly failedTarget: string | null }> {
    if (fields.length === 0) return { filledTargets: [], failedTarget: null };
    const engine = await this.engine();
    // The flow arms before it fills, once, for every field in the batch. A
    // guard with nothing live for this page is therefore not the object the
    // flow armed, whichever object the engine holds, and typing now would put
    // material on a page the redactor is not watching.
    if (!this.deps.cardFieldGuard.hasLiveMaterial(this.sessionId, this.pageId)) {
      throw new CheckoutDriverRefusal(
        'Refused: nothing has armed card-material redaction for this page, so the card fields will '
        + 'not be typed into.',
        'Run the fill through the checkout flow, which arms the redactor before the first keystroke.',
      );
    }
    const result = await engine.fillSecretBatch(this.target, {
      fills: fields.map((field) => ({ ref: field.target, value: field.value })),
    });
    const filled = result['filled'];
    const failedRef = result['failedRef'];
    return {
      filledTargets: Array.isArray(filled) ? filled.filter((entry): entry is string => typeof entry === 'string') : [],
      failedTarget: typeof failedRef === 'string' ? failedRef : null,
    };
  }

  async choose(target: string, value: string): Promise<void> {
    const engine = await this.engine();
    await engine.select(this.target, { ref: target, values: [value] });
  }

  async submitOrder(target: string): Promise<{
    readonly url: string;
    readonly orderId: string | null;
    readonly challenge?: CheckoutChallenge | null | undefined;
    readonly verified: boolean;
  }> {
    let result: Record<string, unknown>;
    try {
      const engine = await this.engine();
      result = await engine.click(this.target, { ref: target });
    } catch (error) {
      throw asSubmitFailure(error);
    }
    const url = readUrl(result) ?? await this.url();
    const describe = this.deps.describeSubmission;
    if (describe === undefined) return { url, orderId: null, challenge: null, verified: false };
    const described = await describe({ url, navigated: result['navigated'] === true });
    // Being wired is not evidence; what it found is. A composition that looked
    // and saw nothing, no order id, no challenge, no explicit confirmation,
    // gets the same honest `verified: false` as a composition with no
    // describeSubmission at all, rather than a "purchased" nothing here
    // actually watched complete.
    const verified = described.orderId !== null || described.challenge !== null || described.confirmed === true;
    return { url, orderId: described.orderId, challenge: described.challenge, verified };
  }
}

/**
 * Classify a `submitOrder` failure as pre-click or genuinely ambiguous.
 *
 * `CheckoutDriverRefusal` is this module's own guard (identity, armed state):
 * always thrown before `engine.click` runs, so it is always pre-click.
 * Everything `engine.click` itself can throw before its one act
 * (`locator.click`), a stale/unresolved ref, the credential-page refusal, the
 * untrusted-effect guard, is named by ERROR NAME rather than by importing the
 * browser-layer classes; see this module's header for why that boundary
 * matters. Anything else, most of all a failure from the click itself, is
 * genuine ambiguity: the merchant may have received it.
 */
const PRE_CLICK_ERROR_NAMES = new Set(['BrowserSessionError', 'StaleElementError', 'UntrustedEffectError']);

/**
 * What checkout-flow.ts is told about a pre-click failure of each kind,
 * written by this module rather than taken from the engine's own message.
 *
 * The engine's own message can name the element it was trying to click,
 * `The button "Complete Purchase for $1,299" would not accept input`, and an
 * untrusted-effect refusal's message is built from that same page-authored
 * name (see `evaluateOutwardEffect`'s `description` in
 * security/untrusted-content.ts). checkout-flow.ts interpolates this string
 * straight into an owner-facing refusal, so forwarding it would be exactly the
 * read path fill-card.ts already refuses to open for a fill failure: an error
 * message is a page-controlled channel to whoever reads the refusal.
 */
function describePreClickFailure(name: string): string {
  switch (name) {
    case 'BrowserSessionError':
      return 'the submit control on this page could not be activated';
    case 'StaleElementError':
      return 'the page changed before the submit control could be found';
    case 'UntrustedEffectError':
      return 'this turn read page content just before the submit, so it was withheld pending your review';
    default:
      return 'the submit could not be attempted';
  }
}

function asSubmitFailure(error: unknown): Error {
  if (error instanceof CheckoutDriverRefusal) {
    // This module's own guard messages (identity, armed state): they name a
    // field, a page or a missing guard, and never page-authored text. See this
    // module's header.
    return new CheckoutSubmitRefused(error.message);
  }
  if (error instanceof Error && PRE_CLICK_ERROR_NAMES.has(error.name)) {
    return new CheckoutSubmitRefused(describePreClickFailure(error.name));
  }
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * The factory `PaymentsServiceDeps.driverFor` wants.
 *
 * Synchronous, because the payments service resolves a driver per verb call and
 * the engine behind it may not exist yet. Nothing is opened until the first page
 * operation runs.
 */
export function createBrowserCheckoutDriverFactory(
  deps: BrowserCheckoutDriverDeps,
): (sessionId: string, pageId: string) => CheckoutPageDriver {
  return (sessionId, pageId) => new BrowserCheckoutPageDriver(sessionId, pageId, deps);
}
