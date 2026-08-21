/**
 * inbound-notice.ts, the ONE thing the owner is allowed to read about an
 * arriving email. This is a security boundary, not a formatting helper.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 *
 * The delivery entry point, `DaemonSurfaceDeliveryHelper.deliverSurfaceNotice`
 * (platform/daemon/surface-delivery.ts), takes a PLAIN STRING and hands it to
 * whichever channel the owner's notice route binding points at, Telegram,
 * Slack, Discord, ntfy, a webhook, whatever he has configured. Whatever
 * reaches that string is what he reads on his phone. Inbound mail is written
 * entirely by strangers, so the SDK, not the adapter, not the daemon, not a
 * convention documented somewhere, owns turning one arriving message into
 * that string.
 *
 * ── Escaping belongs to the channel, not the producer (docs/inbound-email.md §7.2) ──
 *
 * An earlier version of this module returned one STRING for every channel,
 * sanitized by one shared trigger-character set. That is an architectural
 * defect, not a tuning problem: Telegram MarkdownV2 reserves
 * `` _*[]()~`>#+-=|{}.! ``, Discord additionally turns a bare `@everyone` /
 * `@here` into a real mention, Slack uses `<url|text>` and has no backslash
 * escape at all, an HTML notice needs entity escaping instead of stripping,
 * and ntfy carries fields in HTTP headers where a bare newline is the
 * injection and markup is irrelevant. A set tuned for one channel is silently
 * wrong on another, and it goes wrong on the day someone adds a channel, in a
 * module they never opened. Stripping is also lossy in the wrong direction:
 * the owner sees a mangled subject and cannot tell whether the mail said that
 * or we did.
 *
 * So `renderInboundMailNotice` returns `StructuredNotice`, literal spans
 * (our own words, safe by construction) and untrusted spans (attacker text,
 * unmodified beyond removing control characters and line breaks, which are
 * unsafe on every channel including plain text, because a raw newline lets
 * attacker text forge what reads as an extra labeled line). Only when a
 * specific channel is about to turn the notice into a wire string does an
 * ESCAPER run, `\[` in Telegram MarkdownV2 renders as a literal `[`, so the
 * owner sees `[Approved](https://evil.example)` exactly as the mail wrote
 * it, doing nothing, rather than either a live link or a row of blanks. The
 * producer never holds a channel-formatted string, so "forgot to escape" is
 * not a mistake available in the wrong place, only the escaper for a given
 * channel's own syntax can make that mistake, in a file whose only job is to
 * know that syntax.
 *
 * `renderNoticeAsPlainText` is the conservative fallback, full markup
 * neutralization plus mention-breaking, the same shape the old single-string
 * renderer used, and is what any unregistered channel gets. It is never
 * the raw concatenation of span text.
 *
 * ── The field audit (§7.1), every field is attacker-chosen until a written
 *    reason says otherwise ──────────────────────────────────────────────────
 *
 * `deliveredTo`'s local part looked safe because the mailbox source is
 * verified; it is not, because this design runs on per-signup aliases
 * (catch-all domain or plus-addressing), so the local part is whatever the
 * SENDER addressed the mail to. `outcome.purpose` looked safe because it
 * comes from an authorized workstream; authority over the CALL is not
 * authority over the STRING, a signup flow that lifted a service name off a
 * web page is still passing untrusted text through a trusted caller. Both are
 * `untrusted` spans below. `receivedAt` is the one field that must NEVER be
 * attacker-reachable, see `ReceiptTimestamp`.
 */

import { toASCII } from 'node:punycode';
import { redactCardShapes } from '../security/card-shapes.js';
import { registrableDomain } from '../security/public-suffix.js';
import type { LinkRefusalReason } from '../security/link-validation.js';
import type { DeliveredRecipient } from '../google/delivery-evidence.js';
import type { InboundCapabilityReason } from './inbound/ports.js';

// ---------------------------------------------------------------------------
// The notice clock. Branded so a caller cannot pass the sender's own `Date:`
// header through by accident.
// ---------------------------------------------------------------------------

declare const RECEIPT_TIME_BRAND: unique symbol;

/**
 * The moment the DAEMON received this message, never a sender-supplied
 * timestamp. `ImapEnvelope.date` is `extractHeader(raw, 'Date')`, a string
 * the sender wrote inside the message; it must never reach this field, and a
 * timestamp is the last field anyone thinks to suspect. The brand is not
 * exported, so no value can satisfy `ReceiptTimestamp` from outside this
 * module, and the only constructor takes a real `Date`, not a string of any
 * kind, so passing a header value through requires an explicit unsafe cast,
 * never an accidental one. Same shape as `DeliveredRecipient`
 * (platform/google/delivery-evidence.ts) for the same reason.
 */
export interface ReceiptTimestamp {
  readonly iso: string;
  readonly [RECEIPT_TIME_BRAND]: true;
}

/** The only constructor for `ReceiptTimestamp`. Takes a `Date`, never a string. */
export function receiptTimestamp(receivedAt: Date): ReceiptTimestamp {
  // The brand is a compile-time construct only; the runtime object carries
  // just the one real field. Same pattern as DeliveredRecipient's `brand()`
  // (platform/google/delivery-evidence.ts), `unique symbol` from a
  // `declare const` has no runtime value, so it is never actually set.
  return { iso: receivedAt.toISOString() } as ReceiptTimestamp;
}

// ---------------------------------------------------------------------------
// Structured output. See the module header, this replaces a plain string.
// ---------------------------------------------------------------------------

/**
 * One piece of notice text. `literal` is ours, assembled by this module,
 * safe by construction, never escaped. `untrusted` is anyone else's,
 * escaped by whichever channel is about to render it, never stripped.
 */
export type NoticeSpan =
  | { readonly kind: 'literal'; readonly text: string }
  | { readonly kind: 'untrusted'; readonly text: string };

/** One labeled row. The label is always ours; the value is spans, in order. */
export interface NoticeField {
  readonly label: string;
  readonly value: readonly NoticeSpan[];
}

/** The whole notice, before any channel has rendered it to a wire string. */
export interface StructuredNotice {
  readonly title: readonly NoticeSpan[];
  readonly fields: readonly NoticeField[];
}

function literal(text: string): NoticeSpan {
  return { kind: 'literal', text };
}

function untrusted(text: string): NoticeSpan {
  return { kind: 'untrusted', text };
}

// ---------------------------------------------------------------------------
// Types the caller supplies.
// ---------------------------------------------------------------------------

/**
 * What happened to an arriving message, for display purposes only. This is
 * NOT the authority decision itself, that lives in the expectation book
 * (platform/google/verification-expectations.ts), it is a report of what
 * that decision already was, reduced to what the owner needs to read.
 */
export type InboundOutcome =
  | {
      /** The message satisfied an expectation an authorized workstream registered in advance. */
      readonly kind: 'matched-expectation';
      /**
       * Why the expectation was opened, e.g. "Create a GitHub account for
       * the owner". Rendered as `untrusted`: authority over the call that
       * registered the expectation is not authority over this string, a
       * signup flow that lifted a service name off a web page is passing
       * untrusted text through an authorized caller.
       */
      readonly purpose: string;
      /** The domain the expectation was scoped to. Punycode-normalized before use, same as a link host, and rendered `untrusted` anyway. */
      readonly serviceDomain: string;
    }
  | {
      /** A candidate expectation existed but had already expired; nothing was renewed or matched. */
      readonly kind: 'expired-expectation';
    }
  | {
      /** No expectation matched anything in the message. Recorded, notice sent, nothing else happened. */
      readonly kind: 'inert';
    }
  | {
      /**
       * A link in the message was refused by link validation
       * (platform/security/link-validation.ts). `reason` is the fixed
       * `LinkRefusalReason` enum our OWN validation code assigns, never
       * text quoting a server's wording, so it is rendered `literal`.
       */
      readonly kind: 'refused-link';
      readonly reason: LinkRefusalReason;
    }
  | {
      /**
       * The mailbox reported it cannot do what inbound mail requires, for
       * example a Gmail grant that authorizes listing but not reading
       * message bodies, or a mailbox that no longer exists
       * (`surfaces.email.inbound.onInsufficientCapability: 'notice-only'`).
       * This message was read from envelope fields ALONE; nothing here
       * matched or could have matched an expectation, because matching
       * requires the body. The renderer marks this outcome visibly, see
       * `renderInboundMailNotice`, so a degraded notice never reads as a
       * normal one.
       */
      readonly kind: 'capability-degraded';
      /**
       * What the account currently cannot do, e.g. "read message bodies
       * under the granted scope". Produced entirely by the daemon's own
       * capability probe (checked OAuth scopes, IMAP CAPABILITY response),
       * it never echoes attacker-supplied text, so it is rendered `literal`.
       */
      readonly missingCapability: string;
    };

/** How a single link in the message was treated. Never carries a URL, see the module header. */
export type LinkVerdict = 'authorized' | 'refused' | 'unrecognized';

/**
 * One link's rendering summary. `host` is the raw hostname the link pointed
 * at (punycode or Unicode, either is fine, this module normalizes it before
 * display), never a full URL: there is no field here a caller could put a
 * path or query string into, so an assembled clickable URL cannot reach the
 * output no matter what the caller passes. `refusalReason`, when set, is the
 * fixed `LinkRefusalReason` enum from link validation, our own vocabulary,
 * never attacker text, so it renders `literal`.
 */
export interface ValidatedLinkSummary {
  readonly host: string;
  readonly verdict: LinkVerdict;
  readonly refusalReason?: LinkRefusalReason | undefined;
}

export interface InboundMailNoticeInput {
  /** Sender's registrable domain and local part. Attacker-written, rendered `untrusted`. */
  readonly senderDisplay: string;
  /** The message subject. Attacker-written, rendered `untrusted`. */
  readonly subject: string;
  /** Evidence-backed delivery address, or null when none was available. Never a `To:` header claim. */
  readonly deliveredTo: DeliveredRecipient | null;
  readonly outcome: InboundOutcome;
  /** Every link found in the message, already run through link validation. */
  readonly links: readonly ValidatedLinkSummary[];
  /** The daemon's own receipt clock, see `ReceiptTimestamp`. Never the sender's `Date:` header. */
  readonly receivedAt: ReceiptTimestamp;
}

// ---------------------------------------------------------------------------
// The producer's ONLY text transform: control characters and line breaks are
// unsafe on every channel, including plain text, because a raw newline lets
// attacker text forge what reads as a separate labeled line, this is a
// structural concern, not a markup-syntax one, so it happens here rather
// than being left to each channel. Nothing else about the text changes:
// every other character survives into the `untrusted` span exactly as the
// message contained it, so a channel that escapes rather than strips can
// show the owner what the mail actually said.
// ---------------------------------------------------------------------------

/**
 * Every ASCII control character, DEL, and the Unicode line/paragraph
 * separators, not just `\n` and `\r`. A subject containing ` ` renders
 * as a real line break in several renderers even though it is not `\n`, so
 * treating only `\n`/`\r` as "a newline" would leave an equivalent forgery
 * path open.
 */
// eslint-disable-next-line no-control-regex
export const CONTROL_OR_LINE_BREAK = new RegExp(
  // U+0085 (NEL) is a line break to a renderer and was not in this class. It
  // sits outside the C0 range, so "control characters and the two Unicode
  // separators" missed it by exactly one code point.
  '[\\u0000-\\u001F\\u007F\\u0085\\u2028\\u2029]',
  'g',
);

export const REPEATED_SPACE = / {2,}/g;

/**
 * Collapse control characters and line breaks to spaces.
 *
 * Exported because the escaper layer needs the SAME rule: a newline surviving
 * into a rendered notice forges a labelled line, and the producer stripping it
 * only protects the fields the producer writes. See `flattenSpans`.
 */
export function stripControlAndLineBreaks(raw: string): string {
  return raw.replace(CONTROL_OR_LINE_BREAK, ' ').replace(REPEATED_SPACE, ' ').trim();
}

/**
 * A hostname and nothing else: letters, digits, and hyphens per label,
 * joined by single dots, at least two labels. `ValidatedLinkSummary.host` is
 * typed as a plain `string` with no guarantee the caller extracted it with
 * `new URL(...).hostname` rather than handing this function a raw, unparsed
 * link, this pattern is what makes a path, query string, scheme, or
 * userinfo accidentally smuggled into `host` fail closed instead of being
 * treated as part of a "domain".
 */
const VALID_ASCII_HOSTNAME = new RegExp(
  '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$',
);

declare const VALIDATED_DOMAIN_BRAND: unique symbol;

/**
 * The output of `safeRegistrableDomain`, a punycode-normalized,
 * hostname-shaped registrable domain, never the raw claimed host it was
 * built from. Branded so that a raw value (`ValidatedLinkSummary.host`, an
 * expectation's `serviceDomain`) cannot be substituted for one that has
 * actually been through validation, the same §7.3 pattern as
 * `DeliveredRecipient` and `ReceiptTimestamp`, applied here because the two
 * values are easy to confuse: both are "a domain string" at the type level,
 * and only one of them has been punycode-normalized and hostname-validated.
 * A future field builder that reaches for `outcome.serviceDomain` directly
 * instead of calling `safeRegistrableDomain` first gets a compile error, not
 * a homograph rendered as its lookalike.
 */
interface ValidatedRegistrableDomain {
  readonly value: string;
  readonly [VALIDATED_DOMAIN_BRAND]: true;
}

function validatedDomain(value: string): ValidatedRegistrableDomain {
  // Brand is compile-time only; see receiptTimestamp() for the same pattern.
  return { value } as ValidatedRegistrableDomain;
}

/**
 * The registrable domain of `rawHost`, rendered so a homograph cannot read as
 * its lookalike. `toASCII` punycode-encodes any non-ASCII label BEFORE the
 * registrable-domain lookup and before the result is ever placed in a
 * string, a Cyrillic `аpple.com` becomes the opaque `xn--pple-43d.com`,
 * never the Latin string it was built to be mistaken for. An already-ASCII
 * host (including one already in `xn--` form) passes through unchanged.
 * Returns a fixed, safe placeholder for anything unparseable, including
 * anything that is not actually hostname-shaped, rather than falling back
 * to raw attacker text. This is a substance transform (which characters the
 * string is even allowed to contain), separate from and prior to the
 * escaping model above, it runs the same regardless of which channel ends
 * up rendering the result, which is then STILL wrapped as `untrusted` (see
 * the field audit): a validated hostname costs nothing extra to escape.
 */
function safeRegistrableDomain(rawHost: string): ValidatedRegistrableDomain {
  const trimmed = rawHost.trim().toLowerCase().replace(/\.+$/, '');
  if (trimmed.length === 0) return validatedDomain('(unrecognized link)');
  let ascii: string;
  try {
    ascii = toASCII(trimmed);
  } catch {
    return validatedDomain('(unrecognized link)');
  }
  if (!VALID_ASCII_HOSTNAME.test(ascii)) return validatedDomain('(unrecognized link)');
  const domain = registrableDomain(ascii);
  return validatedDomain(domain ?? '(unrecognized link)');
}

// ---------------------------------------------------------------------------
// Field builders. Each returns a NoticeField; span kind follows the §7.1
// audit exactly, not intuition.
// ---------------------------------------------------------------------------

/**
 * Strip control characters and line breaks, THEN redact card shapes (§11.0).
 *
 * Redaction is not only the record store's job. That store keeps the digits
 * off disk; this keeps them out of what the owner actually reads, and the two
 * are separate exposures, a notice goes to whichever surface his route
 * binding names, and on most of them it lands in a message history the daemon
 * does not control and cannot later redact.
 *
 * The ORDER matters, in this direction only. `stripControlAndLineBreaks`
 * rewrites a line break as a SPACE, and a space is a separator `PAN_RUN` joins
 * across, so a card number written across two lines becomes one detectable run
 * by stripping first. Redacting first would leave that same number as two
 * halves too short for the detector, and pass both through.
 */
function displaySafe(raw: string): string {
  return redactCardShapes(stripControlAndLineBreaks(raw));
}

function senderField(senderDisplay: string): NoticeField {
  const stripped = displaySafe(senderDisplay);
  return {
    label: 'From',
    value: [stripped.length > 0 ? untrusted(stripped) : literal('(unknown sender)')],
  };
}

function subjectField(subject: string): NoticeField {
  const stripped = displaySafe(subject);
  return {
    label: 'Subject',
    value: [stripped.length > 0 ? untrusted(stripped) : literal('(no subject)')],
  };
}

function deliveredToField(deliveredTo: DeliveredRecipient | null): NoticeField {
  if (deliveredTo === null) {
    return { label: 'Delivered to', value: [literal('(no verified delivery evidence)')] };
  }
  // Attacker-chosen, see the module header's field audit. Control characters
  // and line breaks are removed and card shapes redacted; everything else
  // (including markup metacharacters) survives into the untrusted span
  // unmodified, to be escaped rather than stripped by whichever channel
  // renders this notice.
  return { label: 'Delivered to', value: [untrusted(displaySafe(deliveredTo.address))] };
}

function outcomeField(outcome: InboundOutcome): NoticeField {
  switch (outcome.kind) {
    case 'matched-expectation': {
      const purpose = stripControlAndLineBreaks(outcome.purpose);
      const domain = safeRegistrableDomain(outcome.serviceDomain);
      return {
        label: 'Outcome',
        value: [
          literal('Matched an open expectation: '),
          untrusted(purpose),
          literal(' ('),
          untrusted(domain.value),
          literal(').'),
        ],
      };
    }
    case 'expired-expectation':
      return {
        label: 'Outcome',
        value: [literal('The closest expectation had already expired, not renewed, not matched.')],
      };
    case 'refused-link':
      return {
        label: 'Outcome',
        value: [literal(`A link in this message was refused: ${outcome.reason}.`)],
      };
    case 'inert':
      return { label: 'Outcome', value: [literal('No expectation matched. Recorded, not actioned.')] };
    case 'capability-degraded':
      return {
        label: 'Outcome',
        // The capability is UNTRUSTED, not literal. Its only real source is
        // the server's own wording (`capability.ts` builds it from a refusal),
        // and §7.1 is explicit that any reason quoting a server is
        // attacker-chosen. As a literal span it skipped every channel escaper,
        // so `*text*` in a refusal rendered as markup on Discord and Slack.
        // Control characters were already stripped here; that made it
        // line-safe and left it markup-live.
        value: [
          literal('LIMITED VIEW, this account cannot currently '),
          untrusted(outcome.missingCapability),
          literal(
            '. Read from envelope fields only; nothing here could match or '
            + 'satisfy a verification.',
          ),
        ],
      };
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}

/** True when the header line must mark the whole notice as showing less than the full picture. */
function isCapabilityDegraded(outcome: InboundOutcome): boolean {
  return outcome.kind === 'capability-degraded';
}

function linkField(link: ValidatedLinkSummary): NoticeField {
  const domain = untrusted(safeRegistrableDomain(link.host).value);
  switch (link.verdict) {
    case 'authorized':
      return { label: 'Link', value: [domain, literal(', matched the authorized service')] };
    case 'refused':
      return {
        label: 'Link',
        value: [domain, literal(`, refused (${link.refusalReason ?? 'refused'}), not opened`)],
      };
    case 'unrecognized':
    default:
      return { label: 'Link', value: [domain, literal(', no expectation matched, not opened')] };
  }
}

function receivedAtField(receivedAt: ReceiptTimestamp): NoticeField {
  return { label: 'Received', value: [literal(receivedAt.iso)] };
}

// ---------------------------------------------------------------------------
// The one exported producer entry point.
// ---------------------------------------------------------------------------

/**
 * Render an inbound-mail owner notice as STRUCTURE, never a channel-formatted
 * string. A channel's delivery path runs this through `renderNoticeForChannel`
 * (or its own equivalent escaper) immediately before calling
 * `DaemonSurfaceDeliveryHelper.deliverSurfaceNotice`, that is the only
 * allowed path from an arriving message to what the owner reads.
 *
 * When `outcome.kind === 'capability-degraded'`, the title itself changes
 * (`New mail, LIMITED VIEW` rather than plain `New mail`) so a degraded
 * notice is never visually indistinguishable from a normal one.
 */
export function renderInboundMailNotice(input: InboundMailNoticeInput): StructuredNotice {
  const degraded = isCapabilityDegraded(input.outcome);
  const fields: NoticeField[] = [
    senderField(input.senderDisplay),
    subjectField(input.subject),
    deliveredToField(input.deliveredTo),
    outcomeField(input.outcome),
    ...input.links.map(linkField),
    receivedAtField(input.receivedAt),
  ];
  return {
    title: [literal(degraded ? 'New mail, LIMITED VIEW' : 'New mail')],
    fields,
  };
}

// ---------------------------------------------------------------------------
// The other thing the owner is told about: that there will BE no mail.
// ---------------------------------------------------------------------------

/**
 * What the owner is told when inbound mail has stopped for good.
 *
 * Fields, not a sentence, for the same reason arriving mail is fields: `detail`
 * carries the MAIL SERVER'S OWN wording, which is attacker-influenceable text
 * (§7.1) and must reach a channel as an `untrusted` span so the channel escapes
 * it. `reason` and `fix` are ours, a fixed enum and a fixed sentence from
 * `capability.ts`, so they are `literal`.
 */
export interface InboundMailStoppedNoticeInput {
  /** Config account id, never an address. */
  readonly account: string;
  readonly mailbox: string;
  /** Our own machine-readable reason. Never server text. */
  readonly reason: InboundCapabilityReason;
  /** What the server (or the platform) said. Attacker-influenceable, untrusted. */
  readonly detail: string;
  /** The one remedial step, in our words. '' when there is none. */
  readonly fix: string;
  /** When this was reached, ISO, from the daemon's own clock. */
  readonly at: string;
}

/**
 * Render "inbound mail has stopped" as structure.
 *
 * §3.4b: *a terminal state is announced, not merely recorded.* The tracker that
 * fires once per transition already existed; its only consumer was a log line,
 * which is the same "rendered and never sent" shape this round exists to
 * remove, in the one place where it means no mail will ever arrive again.
 */
export function renderInboundMailStoppedNotice(
  input: InboundMailStoppedNoticeInput,
): StructuredNotice {
  const detail = stripControlAndLineBreaks(input.detail);
  const fix = stripControlAndLineBreaks(input.fix);
  return {
    title: [literal('Inbound mail has stopped')],
    fields: [
      {
        label: 'Mailbox',
        value: [
          // Owner-written config, not attacker text, but escaped anyway,
          // because an account id that renders as markup on his phone is a
          // display bug either way and escaping costs nothing.
          untrusted(stripControlAndLineBreaks(input.account)),
          literal(' / '),
          untrusted(stripControlAndLineBreaks(input.mailbox)),
        ],
      },
      { label: 'Reason', value: [literal(input.reason)] },
      {
        label: 'What it said',
        value: [detail.length > 0 ? untrusted(detail) : literal('(nothing was reported)')],
      },
      {
        label: 'Fix',
        value: [literal(fix.length > 0
          ? fix
          : 'No single remedial step is known for this condition; the detail above is '
            + 'everything the daemon was told.')],
      },
      { label: 'Stopped at', value: [literal(input.at)] },
      {
        label: 'Until then',
        value: [literal(
          'No mail is being read, so nothing waiting on a verification email will '
          + 'complete. This is reported once; it is not repeated while the condition '
          + 'lasts.',
        )],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// The conservative fallback: full markup neutralization plus mention-
// breaking, applied only to `untrusted` span text. This is what any channel
// with no registered escaper gets, never the raw concatenation.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Compiler-checked guards, independent of the review that added them.
// ---------------------------------------------------------------------------

/**
 * If a future edit ever adds a `body`, `text`, `content`, `preview`, or
 * `snippet` field to `InboundMailNoticeInput`, this line stops compiling. It
 * exists alongside the structural absence above (not instead of it) for the
 * same reason `InboundMailContext` in platform/email/inbound/ gets a runtime
 * own-property assertion on top of its type: a type shape can be widened by
 * someone who does not read this file's header; a failing build is harder to
 * miss than a comment.
 */
type _ForbiddenBodyLikeField = Extract<keyof InboundMailNoticeInput, 'body' | 'text' | 'content' | 'preview' | 'snippet'>;
type _AssertNoBodyLikeField = _ForbiddenBodyLikeField extends never ? true : 'FAIL: a body-like field was added to InboundMailNoticeInput';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _assertNoBodyLikeField: _AssertNoBodyLikeField = true;

/**
 * The producer's return type is structure, never a channel-formatted string.
 * If `renderInboundMailNotice`'s return type is ever widened to include
 * `string`, this line stops compiling.
 */
type _ProducerReturnType = ReturnType<typeof renderInboundMailNotice>;
type _AssertProducerReturnsStructure = _ProducerReturnType extends string
  ? 'FAIL: renderInboundMailNotice must not return a plain string'
  : true;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _assertProducerReturnsStructure: _AssertProducerReturnsStructure = true;

/**
 * The brand IS the protection for `ReceiptTimestamp` and
 * `ValidatedRegistrableDomain`, and unlike the two guards above, nothing
 * else notices if it degrades. Should either type ever be simplified to a
 * plain `string` alias (plausibly by someone chasing an unrelated type error
 * elsewhere, with no idea this line existed), every test still passes,
 * `tsc` is still clean apart from here, and the line cap does not move, the
 * compile-time guarantee is gone with no other signal anywhere. These four
 * assignments exist purely so that degradation has somewhere to fail:
 * `@ts-expect-error` fails the build the moment the error it expects STOPS
 * occurring, which is exactly the event worth hearing about.
 */
// @ts-expect-error, a raw string must never satisfy ReceiptTimestamp; only receiptTimestamp(date) may construct one.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _rawStringIsNotAReceiptTimestamp: ReceiptTimestamp = '2026-07-27T12:00:00.000Z';
// @ts-expect-error, the sender's own Date: header text must never satisfy ReceiptTimestamp either.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _senderDateHeaderIsNotAReceiptTimestamp: ReceiptTimestamp = 'Mon, 27 Jul 2026 12:00:00 +0000';
// @ts-expect-error, a raw string must never satisfy ValidatedRegistrableDomain; only safeRegistrableDomain() may construct one.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _rawStringIsNotAValidatedDomain: ValidatedRegistrableDomain = 'evil.example';
// @ts-expect-error, an attacker-claimed link host must never satisfy ValidatedRegistrableDomain without going through validation first.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _claimedHostIsNotAValidatedDomain: ValidatedRegistrableDomain = 'attacker-controlled.example';
