/**
 * card-fields.ts, recognising a payment field on any page.
 *
 * Lives in security/ rather than in payments/ or browser/ because both need it
 * and neither owns it. The browser's snapshot must suppress a payment field's
 * value whether or not the payment capability is even configured, and the
 * payment capability must classify the same way the snapshot does or the two
 * disagree about what was protected. A shared rule in the layer they both
 * already depend on is the only arrangement where that cannot drift.
 *
 * It is also why `platform/browser/` still imports no product surface: this is
 * foundation, like link validation and the public-suffix list beside it.
 *
 * ── Why this is a classification and not a lookup ─────────────────────────
 *
 * There is no registry of merchants here and there must never be one. A rule
 * written against the standard `autocomplete` tokens works on every checkout
 * that wants browser autofill to function, which is every checkout that works
 * at all; the name and id patterns catch the rest. Neither needs to know which
 * site it is looking at.
 *
 * ── Erring toward yes ─────────────────────────────────────────────────────
 *
 * A false positive costs the model the contents of one form field, which it can
 * ask the owner about. A false negative hands it a card number. Those are not
 * comparable, so the patterns are broad and the tie goes to suppression.
 */

/**
 * Everything about one control the classification may look at.
 *
 * A plain record rather than a DOM element, because the function that walks a
 * page is serialized and evaluated inside the browser and can import nothing.
 * The in-page collector gathers these attributes; the judgement happens in
 * process, where it can be tested against real inputs instead of merely read.
 */
export interface FormControlDescriptor {
  readonly tag: string;
  readonly type: string;
  readonly autocomplete: string;
  readonly name: string;
  readonly id: string;
  readonly placeholder: string;
  readonly ariaLabel: string;
  readonly label: string;
}

/**
 * The autofill tokens the HTML standard defines for payment instruments.
 *
 * A checkout that wants a browser to fill it must use these, so this catches
 * every well-behaved payment form without knowing anything about the site.
 */
const CARD_AUTOCOMPLETE_TOKENS: ReadonlySet<string> = new Set([
  'cc-number',
  'cc-csc',
  'cc-exp',
  'cc-exp-month',
  'cc-exp-year',
  'cc-name',
  'cc-given-name',
  'cc-family-name',
  'cc-additional-name',
  'cc-type',
]);

/**
 * For the pages that do not bother with autocomplete at all.
 *
 * Not English-only, and that is not a nicety. A German checkout names its field
 * `kreditkartennummer` and its verification field `pruefziffer`; against an
 * English-only list both read as ordinary text inputs and their contents get
 * reported like any other field. The word for "card" is the stem that travels,
 * so the patterns key on it in the languages a merchant is likely to use.
 */
const CARD_NAME_PATTERNS: readonly RegExp[] = [
  // card / karte / carte / carta / tarjeta / kaart / kort / kort
  /(card|kart|carte|carta|tarjeta|kaart|kort)\w*.?(number|num|no|nummer|numero|número|nr)\b/i,
  /\b(cc|credit.?card|debit.?card|kreditkarte|kredittkort|carte.?bancaire|tarjeta.?de.?credito)\w*/i,
  /kreditkarte|bankkarte|zahlungskarte/i,
  /\bpan\b/i,
  // The verification value, by its many names.
  /\b(cvv|cvc|csc|cvv2|cid|security.?code|card.?code)\b/i,
  /pruefziffer|prüfziffer|sicherheitscode|kartenpruefnummer|kartenprüfnummer/i,
  /cryptogramme|code.?de.?securite|codigo.?de.?seguridad|código.?de.?seguridad/i,
  // Expiry, in the spellings that actually appear.
  /\bexp(iry|iration)?.?(date|month|year|mm|yy)?\b/i,
  /gueltig.?bis|gültig.?bis|verfallsdatum|ablaufdatum|scadenza|caducidad|validite|validité/i,
  // The cardholder.
  /cardholder|karteninhaber|titulaire|titular|intestatario/i,
  /\bname.?on.?card\b/i,
];

/** Whether this control is a payment field whose value must never be reported. */
export function isCardFieldDescriptor(control: FormControlDescriptor): boolean {
  // Every field is coerced rather than trusted. This runs on data that came
  // back from inside a page, where a missing or oddly-typed property is an
  // ordinary occurrence, and a throw here would fail the whole snapshot, which
  // is a far worse outcome than misclassifying one control.
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  const tag = text(control.tag).toLowerCase();
  if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return false;

  // `autocomplete="shipping cc-number"` and `section-pay cc-csc` are both legal
  // spellings, so each token is checked rather than the whole attribute.
  const tokens = text(control.autocomplete).toLowerCase().split(/\s+/).filter((token) => token.length > 0);
  if (tokens.some((token) => CARD_AUTOCOMPLETE_TOKENS.has(token))) return true;

  const haystack = [
    text(control.name),
    text(control.id),
    text(control.placeholder),
    text(control.ariaLabel),
    text(control.label),
  ].join(' ');
  return CARD_NAME_PATTERNS.some((pattern) => pattern.test(haystack));
}
