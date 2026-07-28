/**
 * fixture-checkout-driver.ts — playing the part the model plays.
 *
 * ══ What this stands in for ═══════════════════════════════════════════════
 *
 * In production the model reads a checkout with the browser tool and reports
 * what it found as structured values; the daemon parses, decides and types.
 * Here the reading is produced by actually parsing the fixture merchant's real
 * HTML with a real HTML parser, so the strings that reach `extractCheckout` are
 * the strings the merchant really served — including its number formatting,
 * which is the part most likely to break a parser.
 *
 * Nothing in this file is importable by the SDK, and nothing in the SDK knows
 * either fixture's markup. The per-shape selectors below are the TEST playing
 * the model's role; that knowledge living here rather than in the flow is the
 * whole point of the exercise.
 *
 * ══ Why the page url is not the fixture's url ═════════════════════════════
 *
 * `validateLinkTarget` — the platform's one link check, and the one the fill's
 * merchant binding uses — requires https, refuses a bare IP host, and refuses a
 * non-standard port. A loopback fixture on `http://127.0.0.1:41293` fails all
 * three, so a driver that reported its own address could only be tested by
 * weakening the check, which would leave the real check untested.
 *
 * So the driver separates the two things a browser separates: WHERE THE PAGE IS
 * (an https merchant url, which is what a routed or proxied session reports)
 * from WHERE THE BYTES CAME FROM (loopback). The merchant binding is exercised
 * for real against real domains, and no test needs an exemption.
 */
import type { CardFieldKind } from '../../packages/sdk/src/platform/payments/card-redaction.js';
import type { RawCheckoutReading } from '../../packages/sdk/src/platform/payments/checkout-extraction.js';
import type { CheckoutChallenge, CheckoutPageDriver, PageIdentity } from '../../packages/sdk/src/platform/payments/checkout-page.js';
import type { FixtureMerchant } from './fixture-merchant.js';

/**
 * Decode the handful of HTML entities a checkout actually uses.
 *
 * A browser hands the model DECODED text, so the reading a real run produces
 * never contains `&euro;`. HTMLRewriter yields the raw source text, so without
 * this the fixture would feed the money parser something no production path can
 * produce — and the parser would rightly refuse it, failing the test for a
 * reason that does not exist outside the harness.
 */
function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    '&euro;': '\u20ac', '&pound;': '\u00a3', '&yen;': '\u00a5', '&cent;': '\u00a2',
    '&nbsp;': '\u00a0', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
    '&uuml;': '\u00fc', '&auml;': '\u00e4', '&ouml;': '\u00f6', '&szlig;': '\u00df',
  };
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&[a-z]+;/gi, (entity) => named[entity.toLowerCase()] ?? entity);
}

/** Text of every element matching a selector, in document order. */
async function textsOf(html: string, selector: string): Promise<string[]> {
  const found: string[] = [];
  let current: string | null = null;
  const rewriter = new HTMLRewriter().on(selector, {
    element() {
      if (current !== null) found.push(current);
      current = '';
    },
    text(chunk) {
      if (current !== null) current += chunk.text;
    },
  });
  await rewriter.transform(new Response(html)).text();
  if (current !== null) found.push(current);
  return found.map((value) => decodeEntities(value).replace(/\s+/g, ' ').trim());
}

/** One attribute from every element matching a selector. */
async function attributesOf(html: string, selector: string, name: string): Promise<string[]> {
  const found: string[] = [];
  const rewriter = new HTMLRewriter().on(selector, {
    element(element) {
      found.push(element.getAttribute(name) ?? '');
    },
  });
  await rewriter.transform(new Response(html)).text();
  return found;
}

/**
 * Read a fixture checkout into the structured reading the daemon accepts.
 *
 * This is the model's job, and the two branches below are why it is the model's
 * job: the shapes share nothing. Alpha's prices are `<td class="price">` inside
 * two different tables; beta's are `<span data-amount>` distinguished by the
 * attribute's value. A flow that had to know either would need to know both,
 * and then the next one.
 */
export async function readFixtureCheckout(merchant: FixtureMerchant): Promise<RawCheckoutReading> {
  const html = await merchant.checkoutHtml();
  const summary = (await textsOf(html, 'body')).join(' ');

  if (merchant.shape === 'alpha') {
    const names = await textsOf(html, 'tr.line td.name');
    const quantities = await textsOf(html, 'tr.line td.qty');
    const linePrices = await textsOf(html, 'tr.line td.price');
    const totalRows = await textsOf(html, '#totals tr td');
    const shipLabels = await textsOf(html, '#delivery label');
    const shipPrices = await textsOf(html, '#delivery label span.price');

    // #totals is label/value pairs: [Subtotal, $129.00, Sales tax, $10.97, ...]
    const totals = new Map<string, string>();
    for (let index = 0; index + 1 < totalRows.length; index += 2) {
      totals.set(totalRows[index] ?? '', totalRows[index + 1] ?? '');
    }

    return {
      lines: names.map((label, index) => ({
        label,
        quantity: quantities[index] ?? '1',
        unitPrice: linePrices[index] ?? '',
      })),
      tax: totals.get('Sales tax') ?? null,
      fees: totals.has('Handling fee')
        ? [{ label: 'Handling fee', amount: totals.get('Handling fee') ?? '' }]
        : [],
      shippingOptions: shipPrices.map((cost, index) => ({
        label: (shipLabels[index] ?? '').replace(cost, '').trim(),
        cost,
      })),
      statedTotal: null,
      currency: 'USD',
      orderSummaryText: summary,
    };
  }

  const names = await textsOf(html, '.posten .bezeichnung');
  const quantities = await textsOf(html, '.posten .menge');
  const amounts = await textsOf(html, '[data-amount]');
  const kinds = await attributesOf(html, '[data-amount]', 'data-amount');
  const shipLabels = await textsOf(html, '#versand .option span:not([data-amount])');

  const byKind = (kind: string): string[] =>
    amounts.filter((_, index) => kinds[index] === kind);

  return {
    lines: names.map((label, index) => ({
      label,
      quantity: quantities[index] ?? '1',
      unitPrice: byKind('unit')[index] ?? '',
    })),
    tax: byKind('tax')[0] ?? null,
    fees: [],
    shippingOptions: byKind('ship').map((cost, index) => ({
      label: shipLabels[index] ?? `option ${String(index)}`,
      cost,
    })),
    statedTotal: null,
    currency: 'EUR',
    orderSummaryText: summary,
  };
}

export interface FixtureDriverOptions {
  readonly merchant: FixtureMerchant;
  /** The https url the page reports itself to be at. */
  readonly pageUrl: string;
  readonly sessionId?: string;
  readonly pageId?: string;
  /** Make the submit throw, to exercise the "possibly submitted" path. */
  readonly failSubmit?: boolean;
  /** Return a challenge instead of an order, to exercise the pause. */
  readonly challenge?: CheckoutChallenge;
  /** Make one named field reject input, to exercise the fill failure path. */
  readonly rejectField?: string;
}

/**
 * A driver over a real fixture merchant.
 *
 * `fill` and `fillSecret` accumulate form state exactly as a browser would, and
 * `submitOrder` posts that state to the merchant's real endpoint, which really
 * records it. The containment assertions then read the merchant's record to
 * prove the card reached the merchant — and read everything else to prove it
 * reached nothing else.
 */
export class FixtureCheckoutDriver implements CheckoutPageDriver {
  /** What has been typed into the page, by target. Card material included. */
  readonly formState = new Map<string, string>();

  /** Every fill this driver was asked to perform, for ordering assertions. */
  readonly fillLog: { target: string; kind: CardFieldKind | 'plain' }[] = [];

  constructor(private readonly options: FixtureDriverOptions) {}

  identity(): PageIdentity {
    return {
      sessionId: this.options.sessionId ?? 'session-1',
      pageId: this.options.pageId ?? 'page-1',
    };
  }

  async url(): Promise<string> {
    return this.options.pageUrl;
  }

  async fill(target: string, value: string): Promise<void> {
    if (this.options.rejectField === target) throw new Error(`field ${target} rejected input`);
    this.formState.set(target, value);
    this.fillLog.push({ target, kind: 'plain' });
  }

  async fillSecret(target: string, value: string, kind: CardFieldKind): Promise<void> {
    if (this.options.rejectField === target) {
      // Deliberately quotes the value in the message. A real browser's fill
      // error does exactly this, and the point of the test is that fill-card.ts
      // discards the driver's message rather than wrapping it.
      throw new Error(`could not type "${value}" into ${target}`);
    }
    this.formState.set(target, value);
    this.fillLog.push({ target, kind });
  }

  async choose(target: string, value: string): Promise<void> {
    this.formState.set(target, value);
  }

  async submitOrder(target: string): Promise<{
    readonly url: string;
    readonly orderId: string | null;
    readonly challenge?: CheckoutChallenge | null | undefined;
  }> {
    if (this.options.failSubmit === true) {
      throw new Error('the connection dropped while submitting');
    }
    if (this.options.challenge !== undefined) {
      return { url: this.options.pageUrl, orderId: null, challenge: this.options.challenge };
    }
    const fields: Record<string, string> = { submitTarget: target };
    for (const [key, value] of this.formState.entries()) fields[key] = value;
    const result = await this.options.merchant.submit(fields);
    return { url: result.url, orderId: result.orderId };
  }
}
