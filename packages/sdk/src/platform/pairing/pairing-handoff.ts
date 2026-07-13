/**
 * pairing/pairing-handoff.ts
 *
 * One pairing exchange, carrying an OFFER SET so a freshly-paired surface can
 * complete several set-up steps in a single pass, each independently declinable:
 *   - notifications — register this device for browser push (VAPID + subscribe).
 *   - relay         — connect through the rendezvous relay for off-LAN reach.
 *   - passkey       — register a WebAuthn credential for step-up.
 *
 * The QR / deep-link content is EXACTLY the `#pair=<token>` fragment shape the
 * web app already consumes (goodvibes-webui `src/lib/pairing.ts` reads the
 * `pair` key out of the URL fragment via URLSearchParams and ignores any other
 * fragment keys). So the token rides in `pair=` and the offer set rides
 * alongside in an `offers=` key the web app harmlessly ignores today; a
 * bundle-aware surface reads it to know which offers to present. The fragment is
 * deliberate: a `#`-fragment is never sent to a server, so the one-time token
 * never lands in an access log or Referer header.
 *
 * This module is pure over strings — QR *rendering* and the daemon verbs live
 * elsewhere; it only builds and parses the link content.
 */

/** The set-up steps a pairing hand-off can offer. Each is independently declinable. */
export type PairingHandoffOfferKind = 'notifications' | 'relay' | 'passkey';

export const PAIRING_HANDOFF_OFFER_KINDS: readonly PairingHandoffOfferKind[] = [
  'notifications',
  'relay',
  'passkey',
];

/** The fragment keys the pairing deep-link uses. `pair` is the one the web app reads. */
export const PAIRING_FRAGMENT_KEY = 'pair';
export const PAIRING_OFFERS_FRAGMENT_KEY = 'offers';

function isOfferKind(value: string): value is PairingHandoffOfferKind {
  return (PAIRING_HANDOFF_OFFER_KINDS as readonly string[]).includes(value);
}

/** Normalize/dedupe an offer list into canonical order. */
export function normalizeOffers(offers: readonly string[]): PairingHandoffOfferKind[] {
  const present = new Set(offers.filter(isOfferKind));
  return PAIRING_HANDOFF_OFFER_KINDS.filter((kind) => present.has(kind));
}

export interface BuildPairingHandoffLinkInput {
  /** The web app origin the QR points at, e.g. `https://app.example` (no trailing slash needed). */
  readonly webOrigin: string;
  /** The per-device pairing token (the one-time secret). */
  readonly token: string;
  /** The offers this hand-off carries; empty ⇒ a plain pairing link with no offer set. */
  readonly offers?: readonly PairingHandoffOfferKind[] | undefined;
}

/**
 * Build the `#pair=<token>` deep link (optionally carrying the offer set). The
 * token lands in the URL fragment, never the query, so it is not sent to a
 * server. Extra `offers=` key is ignored by the current web app.
 */
export function buildPairingHandoffLink(input: BuildPairingHandoffLinkInput): string {
  const base = input.webOrigin.replace(/\/+$/, '');
  const params = new URLSearchParams();
  params.set(PAIRING_FRAGMENT_KEY, input.token);
  const offers = normalizeOffers(input.offers ?? []);
  if (offers.length > 0) params.set(PAIRING_OFFERS_FRAGMENT_KEY, offers.join(','));
  return `${base}/#${params.toString()}`;
}

/**
 * Build just the `#pair=<token>` fragment (no origin) — for a producer (e.g. the
 * TUI QR renderer) that prepends its own known web origin.
 */
export function buildPairingHandoffFragment(input: {
  readonly token: string;
  readonly offers?: readonly PairingHandoffOfferKind[] | undefined;
}): string {
  const params = new URLSearchParams();
  params.set(PAIRING_FRAGMENT_KEY, input.token);
  const offers = normalizeOffers(input.offers ?? []);
  if (offers.length > 0) params.set(PAIRING_OFFERS_FRAGMENT_KEY, offers.join(','));
  return `#${params.toString()}`;
}

export interface ParsedPairingHandoff {
  readonly token: string;
  readonly offers: PairingHandoffOfferKind[];
}

/**
 * Parse a pairing deep-link's fragment back into its token + offer set. Accepts
 * a full URL, a bare `#pair=…` fragment, or the fragment body — the same
 * tolerance the web app applies. Returns null when no `pair` token is present.
 */
export function parsePairingHandoffLink(input: string): ParsedPairingHandoff | null {
  const hashIndex = input.indexOf('#');
  const rawFragment = hashIndex >= 0 ? input.slice(hashIndex + 1) : input;
  if (!rawFragment) return null;
  const params = new URLSearchParams(rawFragment);
  const token = params.get(PAIRING_FRAGMENT_KEY)?.trim() ?? '';
  if (token.length === 0) return null;
  const offers = normalizeOffers((params.get(PAIRING_OFFERS_FRAGMENT_KEY) ?? '').split(','));
  return { token, offers };
}
