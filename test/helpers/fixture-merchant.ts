/**
 * fixture-merchant.ts, two local merchants, deliberately unlike each other.
 *
 * ══ Why a fixture at all ══════════════════════════════════════════════════
 *
 * Purchase execution is the one capability whose tests must never touch the
 * thing they are testing. A test that ordered from a real merchant would be a
 * test that spends money, and "it only runs in CI with a fake card" is a
 * property nobody can guarantee about a suite that thousands of runs will
 * execute. So there is a merchant here, it runs on localhost, and its "submit
 * order" endpoint records what it received instead of shipping anything.
 *
 * ══ Why TWO, and why they disagree about everything ═══════════════════════
 *
 * A single realistic fixture proves the flow works on that fixture. Two that
 * share no markup, no label wording, no element structure and no number
 * formatting prove something much more useful: that no code in the flow knows
 * what a checkout looks like.
 *
 *   ALPHA  a table-driven US store. `$1,299.00`. Fields carry the standard
 *          `autocomplete="cc-number"` tokens. Labels say "Sales tax",
 *          "Delivery". Prices in `<td class="price">`.
 *   BETA   a div-and-span European store. `1.299,00 €`, dot thousands, comma
 *          decimal, symbol trailing. NO autocomplete attributes at all, so the
 *          card fields are recognisable only by their names. Labels say
 *          "Umsatzsteuer", "Versand". Prices in `<span data-amount>`.
 *
 * If both work against identical flow code, the generic approach holds. If one
 * needed a special case, that special case would be the beginning of the
 * selector table this design exists to avoid.
 *
 * BETA also exists to exercise `parseMinorUnits` on the layout that breaks
 * naive parsers: `1.299,00` is 1299.00 and a strip-every-non-digit reader turns
 * it into 129900 major units.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type FixtureShape = 'alpha' | 'beta';

/** One order the fixture actually received, exactly as it arrived. */
export interface RecordedSubmission {
  readonly at: number;
  readonly fields: Record<string, string>;
  readonly orderId: string;
}

export interface FixtureMerchant {
  readonly shape: FixtureShape;
  readonly origin: string;
  readonly currency: string;
  /** Every submission the merchant received, in order. */
  readonly submissions: RecordedSubmission[];
  /** The checkout page's markup, as a browser would receive it. */
  checkoutHtml(): Promise<string>;
  /** Submit an order, exactly as a form post would. */
  submit(fields: Record<string, string>): Promise<{ orderId: string; url: string }>;
  close(): Promise<void>;
}

const ALPHA_CHECKOUT = `<!doctype html>
<html><body>
<h1>Checkout</h1>
<table id="cart">
  <tr class="line"><td class="name">Mechanical keyboard, tenkeyless</td><td class="qty">1</td><td class="price">$129.00</td></tr>
</table>
<table id="totals">
  <tr><td>Subtotal</td><td class="price">$129.00</td></tr>
  <tr><td>Sales tax</td><td class="price">$10.97</td></tr>
  <tr><td>Handling fee</td><td class="price">$1.50</td></tr>
</table>
<fieldset id="delivery">
  <label><input type="radio" name="ship" value="standard"> Standard <span class="price">$4.99</span></label>
  <label><input type="radio" name="ship" value="two-day"> Two-day <span class="price">$12.99</span></label>
  <label><input type="radio" name="ship" value="overnight"> Overnight <span class="price">$29.99</span></label>
</fieldset>
<form id="pay" method="post" action="/submit">
  <input id="ccnum" name="cardNumber" autocomplete="cc-number" placeholder="Card number">
  <input id="ccexp" name="cardExpiry" autocomplete="cc-exp" placeholder="MM/YYYY">
  <input id="cccvv" name="cardCvv" autocomplete="cc-csc" placeholder="CVV">
  <input id="ccname" name="cardName" autocomplete="cc-name" placeholder="Name on card">
  <input id="coupon" name="coupon" placeholder="Coupon code">
  <button type="submit" id="place">Place your order</button>
</form>
</body></html>`;

const BETA_CHECKOUT = `<!doctype html>
<html><body>
<div class="kopf">Bestellung abschliessen</div>
<div id="warenkorb">
  <div class="posten">
    <span class="bezeichnung">Espressomaschine, zweikreisig</span>
    <span class="menge">1</span>
    <span data-amount="unit">1.299,00 &euro;</span>
  </div>
</div>
<div id="summen">
  <div><span>Zwischensumme</span><span data-amount="subtotal">1.299,00 &euro;</span></div>
  <div><span>Umsatzsteuer</span><span data-amount="tax">246,81 &euro;</span></div>
</div>
<div id="versand">
  <div class="option" data-ship="post"><span>Post</span><span data-amount="ship">6,90 &euro;</span></div>
  <div class="option" data-ship="express"><span>Express</span><span data-amount="ship">19,90 &euro;</span></div>
</div>
<form id="zahlung" method="post" action="/submit">
  <input id="k1" name="kreditkartennummer" placeholder="Kartennummer">
  <input id="k2" name="gueltig_bis" placeholder="MM/JJ">
  <input id="k3" name="pruefziffer" placeholder="Pr&uuml;fziffer">
  <input id="k4" name="karteninhaber" placeholder="Karteninhaber">
  <input id="k5" name="gutschein" placeholder="Gutscheincode">
  <button type="submit" id="kaufen">Kostenpflichtig bestellen</button>
</form>
</body></html>`;

/**
 * Start a merchant.
 *
 * Binds to port 0 on loopback, so many tests can run at once and none of them
 * can reach anything outside this machine.
 */
export async function startFixtureMerchant(shape: FixtureShape): Promise<FixtureMerchant> {
  const submissions: RecordedSubmission[] = [];
  let counter = 0;

  const server: Server = createServer((request, response) => {
    const url = request.url ?? '/';
    if (request.method === 'POST' && url.startsWith('/submit')) {
      let body = '';
      request.on('data', (chunk) => {
        body += String(chunk);
      });
      request.on('end', () => {
        const fields: Record<string, string> = {};
        for (const [key, value] of new URLSearchParams(body).entries()) fields[key] = value;
        counter += 1;
        const orderId = `${shape.toUpperCase()}-${String(counter).padStart(5, '0')}`;
        // What the merchant RECEIVED, kept verbatim. The containment tests read
        // this to prove the card arrived here and nowhere else.
        submissions.push({ at: Date.now(), fields, orderId });
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(`<html><body><h1>Order placed</h1><p id="order">${orderId}</p></body></html>`);
      });
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(shape === 'alpha' ? ALPHA_CHECKOUT : BETA_CHECKOUT);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${String(address.port)}`;

  return {
    shape,
    origin,
    currency: shape === 'alpha' ? 'USD' : 'EUR',
    submissions,
    async checkoutHtml(): Promise<string> {
      const response = await fetch(`${origin}/checkout`);
      return response.text();
    },
    async submit(fields: Record<string, string>): Promise<{ orderId: string; url: string }> {
      const response = await fetch(`${origin}/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString(),
      });
      const text = await response.text();
      const match = /<p id="order">([^<]+)<\/p>/.exec(text);
      return { orderId: match?.[1] ?? '', url: `${origin}/confirmation` };
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
