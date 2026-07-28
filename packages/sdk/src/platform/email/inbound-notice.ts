/**
 * inbound-notice.ts — the ONE thing the owner is allowed to read about an
 * arriving email. This is a security boundary, not a formatting helper.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 *
 * The delivery entry point, `DaemonSurfaceDeliveryHelper.deliverSurfaceNotice`
 * (platform/daemon/surface-delivery.ts), takes a PLAIN STRING and hands it to
 * whichever channel the owner's notice route binding points at — Telegram,
 * Slack, Discord, ntfy, a webhook, whatever he has configured. Whatever
 * reaches that string is what he reads on his phone. Inbound mail is written
 * entirely by strangers, so the SDK — not the adapter, not the daemon, not a
 * convention documented somewhere — owns turning one arriving message into
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
 * So `renderInboundMailNotice` returns `StructuredNotice` — literal spans
 * (our own words, safe by construction) and untrusted spans (attacker text,
 * unmodified beyond removing control characters and line breaks, which are
 * unsafe on every channel including plain text, because a raw newline lets
 * attacker text forge what reads as an extra labeled line). Only when a
 * specific channel is about to turn the notice into a wire string does an
 * ESCAPER run — `\[` in Telegram MarkdownV2 renders as a literal `[`, so the
 * owner sees `[Approved](https://evil.example)` exactly as the mail wrote
 * it, doing nothing, rather than either a live link or a row of blanks. The
 * producer never holds a channel-formatted string, so "forgot to escape" is
 * not a mistake available in the wrong place — only the escaper for a given
 * channel's own syntax can make that mistake, in a file whose only job is to
 * know that syntax.
 *
 * `renderNoticeAsPlainText` is the conservative fallback — full markup
 * neutralization plus mention-breaking, the same shape the old single-string
 * renderer used — and is what any unregistered channel gets. It is never
 * the raw concatenation of span text.
 *
 * ── The field audit (§7.1) — every field is attacker-chosen until a written
 *    reason says otherwise ──────────────────────────────────────────────────
 *
 * `deliveredTo`'s local part looked safe because the mailbox source is
 * verified; it is not, because this design runs on per-signup aliases
 * (catch-all domain or plus-addressing), so the local part is whatever the
 * SENDER addressed the mail to. `outcome.purpose` looked safe because it
 * comes from an authorized workstream; authority over the CALL is not
 * authority over the STRING — a signup flow that lifted a service name off a
 * web page is still passing untrusted text through a trusted caller. Both are
 * `untrusted` spans below. `receivedAt` is the one field that must NEVER be
 * attacker-reachable — see `ReceiptTimestamp`.
 */

import { toASCII } from 'node:punycode';
import { registrableDomain } from '../security/public-suffix.js';
import type { LinkRefusalReason } from '../security/link-validation.js';
import type { DeliveredRecipient } from '../google/delivery-evidence.js';

// ---------------------------------------------------------------------------
// The notice clock. Branded so a caller cannot pass the sender's own `Date:`
// header through by accident.
// ---------------------------------------------------------------------------

declare const RECEIPT_TIME_BRAND: unique symbol;

/**
 * The moment the DAEMON received this message — never a sender-supplied
 * timestamp. `ImapEnvelope.date` is `extractHeader(raw, 'Date')`, a string
 * the sender wrote inside the message; it must never reach this field, and a
 * timestamp is the last field anyone thinks to suspect. The brand is not
 * exported, so no value can satisfy `ReceiptTimestamp` from outside this
 * module, and the only constructor takes a real `Date` — not a string of any
 * kind — so passing a header value through requires an explicit unsafe cast,
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
  // (platform/google/delivery-evidence.ts) — `unique symbol` from a
  // `declare const` has no runtime value, so it is never actually set.
  return { iso: receivedAt.toISOString() } as ReceiptTimestamp;
}

// ---------------------------------------------------------------------------
// Structured output. See the module header — this replaces a plain string.
// ---------------------------------------------------------------------------

/**
 * One piece of notice text. `literal` is ours — assembled by this module,
 * safe by construction, never escaped. `untrusted` is anyone else's —
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
 * NOT the authority decision itself — that lives in the expectation book
 * (platform/google/verification-expectations.ts) — it is a report of what
 * that decision already was, reduced to what the owner needs to read.
 */
export type InboundOutcome =
  | {
      /** The message satisfied an expectation an authorized workstream registered in advance. */
      readonly kind: 'matched-expectation';
      /**
       * Why the expectation was opened, e.g. "Create a GitHub account for
       * the owner". Rendered as `untrusted`: authority over the call that
       * registered the expectation is not authority over this string — a
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
       * `LinkRefusalReason` enum our OWN validation code assigns — never
       * text quoting a server's wording — so it is rendered `literal`.
       */
      readonly kind: 'refused-link';
      readonly reason: LinkRefusalReason;
    }
  | {
      /**
       * The mailbox reported it cannot do what inbound mail requires — for
       * example a Gmail grant that authorizes listing but not reading
       * message bodies, or a mailbox that no longer exists
       * (`surfaces.email.inbound.onInsufficientCapability: 'notice-only'`).
       * This message was read from envelope fields ALONE; nothing here
       * matched or could have matched an expectation, because matching
       * requires the body. The renderer marks this outcome visibly — see
       * `renderInboundMailNotice` — so a degraded notice never reads as a
       * normal one.
       */
      readonly kind: 'capability-degraded';
      /**
       * What the account currently cannot do, e.g. "read message bodies
       * under the granted scope". Produced entirely by the daemon's own
       * capability probe (checked OAuth scopes, IMAP CAPABILITY response) —
       * it never echoes attacker-supplied text, so it is rendered `literal`.
       */
      readonly missingCapability: string;
    };

/** How a single link in the message was treated. Never carries a URL — see the module header. */
export type LinkVerdict = 'authorized' | 'refused' | 'unrecognized';

/**
 * One link's rendering summary. `host` is the raw hostname the link pointed
 * at (punycode or Unicode, either is fine — this module normalizes it before
 * display), never a full URL: there is no field here a caller could put a
 * path or query string into, so an assembled clickable URL cannot reach the
 * output no matter what the caller passes. `refusalReason`, when set, is the
 * fixed `LinkRefusalReason` enum from link validation — our own vocabulary,
 * never attacker text — so it renders `literal`.
 */
export interface ValidatedLinkSummary {
  readonly host: string;
  readonly verdict: LinkVerdict;
  readonly refusalReason?: LinkRefusalReason | undefined;
}

export interface InboundMailNoticeInput {
  /** Sender's registrable domain and local part. Attacker-written — rendered `untrusted`. */
  readonly senderDisplay: string;
  /** The message subject. Attacker-written — rendered `untrusted`. */
  readonly subject: string;
  /** Evidence-backed delivery address, or null when none was available. Never a `To:` header claim. */
  readonly deliveredTo: DeliveredRecipient | null;
  readonly outcome: InboundOutcome;
  /** Every link found in the message, already run through link validation. */
  readonly links: readonly ValidatedLinkSummary[];
  /** The daemon's own receipt clock — see `ReceiptTimestamp`. Never the sender's `Date:` header. */
  readonly receivedAt: ReceiptTimestamp;
}

// ---------------------------------------------------------------------------
// The producer's ONLY text transform: control characters and line breaks are
// unsafe on every channel, including plain text, because a raw newline lets
// attacker text forge what reads as a separate labeled line — this is a
// structural concern, not a markup-syntax one, so it happens here rather
// than being left to each channel. Nothing else about the text changes:
// every other character survives into the `untrusted` span exactly as the
// message contained it, so a channel that escapes rather than strips can
// show the owner what the mail actually said.
// ---------------------------------------------------------------------------

/**
 * Every ASCII control character, DEL, and the Unicode line/paragraph
 * separators — not just `\n` and `\r`. A subject containing ` ` renders
 * as a real line break in several renderers even though it is not `\n`, so
 * treating only `\n`/`\r` as "a newline" would leave an equivalent forgery
 * path open.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_OR_LINE_BREAK = new RegExp('[\\u0000-\\u001F\\u007F\\u2028\\u2029]', 'g');

const REPEATED_SPACE = / {2,}/g;

function stripControlAndLineBreaks(raw: string): string {
  return raw.replace(CONTROL_OR_LINE_BREAK, ' ').replace(REPEATED_SPACE, ' ').trim();
}

/**
 * A hostname and nothing else: letters, digits, and hyphens per label,
 * joined by single dots, at least two labels. `ValidatedLinkSummary.host` is
 * typed as a plain `string` with no guarantee the caller extracted it with
 * `new URL(...).hostname` rather than handing this function a raw, unparsed
 * link — this pattern is what makes a path, query string, scheme, or
 * userinfo accidentally smuggled into `host` fail closed instead of being
 * treated as part of a "domain".
 */
const VALID_ASCII_HOSTNAME = new RegExp(
  '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$',
);

declare const VALIDATED_DOMAIN_BRAND: unique symbol;

/**
 * The output of `safeRegistrableDomain` — a punycode-normalized,
 * hostname-shaped registrable domain, never the raw claimed host it was
 * built from. Branded so that a raw value (`ValidatedLinkSummary.host`, an
 * expectation's `serviceDomain`) cannot be substituted for one that has
 * actually been through validation — the same §7.3 pattern as
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
 * string — a Cyrillic `аpple.com` becomes the opaque `xn--pple-43d.com`,
 * never the Latin string it was built to be mistaken for. An already-ASCII
 * host (including one already in `xn--` form) passes through unchanged.
 * Returns a fixed, safe placeholder for anything unparseable — including
 * anything that is not actually hostname-shaped — rather than falling back
 * to raw attacker text. This is a substance transform (which characters the
 * string is even allowed to contain), separate from and prior to the
 * escaping model above — it runs the same regardless of which channel ends
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

function senderField(senderDisplay: string): NoticeField {
  const stripped = stripControlAndLineBreaks(senderDisplay);
  return {
    label: 'From',
    value: [stripped.length > 0 ? untrusted(stripped) : literal('(unknown sender)')],
  };
}

function subjectField(subject: string): NoticeField {
  const stripped = stripControlAndLineBreaks(subject);
  return {
    label: 'Subject',
    value: [stripped.length > 0 ? untrusted(stripped) : literal('(no subject)')],
  };
}

function deliveredToField(deliveredTo: DeliveredRecipient | null): NoticeField {
  if (deliveredTo === null) {
    return { label: 'Delivered to', value: [literal('(no verified delivery evidence)')] };
  }
  // Attacker-chosen — see the module header's field audit. Only control
  // characters and line breaks are removed here; everything else (including
  // markup metacharacters) survives into the untrusted span unmodified, to be
  // escaped rather than stripped by whichever channel renders this notice.
  return { label: 'Delivered to', value: [untrusted(stripControlAndLineBreaks(deliveredTo.address))] };
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
        value: [literal('The closest expectation had already expired — not renewed, not matched.')],
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
        value: [
          literal(
            `LIMITED VIEW — this account cannot currently ${stripControlAndLineBreaks(outcome.missingCapability)}. `
            + 'Read from envelope fields only; nothing here could match or satisfy a verification.',
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
      return { label: 'Link', value: [domain, literal(' — matched the authorized service')] };
    case 'refused':
      return {
        label: 'Link',
        value: [domain, literal(` — refused (${link.refusalReason ?? 'refused'}), not opened`)],
      };
    case 'unrecognized':
    default:
      return { label: 'Link', value: [domain, literal(' — no expectation matched, not opened')] };
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
 * `DaemonSurfaceDeliveryHelper.deliverSurfaceNotice` — that is the only
 * allowed path from an arriving message to what the owner reads.
 *
 * When `outcome.kind === 'capability-degraded'`, the title itself changes
 * (`New mail — LIMITED VIEW` rather than plain `New mail`) so a degraded
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
    title: [literal(degraded ? 'New mail — LIMITED VIEW' : 'New mail')],
    fields,
  };
}

// ---------------------------------------------------------------------------
// The conservative fallback: full markup neutralization plus mention-
// breaking, applied only to `untrusted` span text. This is what any channel
// with no registered escaper gets — never the raw concatenation.
// ---------------------------------------------------------------------------

/**
 * Markup metacharacters across every channel `deliverSurfaceNotice` can fan
 * out to, for the conservative plain-text path: backtick / asterisk /
 * underscore / tilde / pipe (code, bold, italic, strikethrough, spoiler
 * markers), angle brackets / square brackets / parentheses (link and mention
 * syntax — parentheses listed explicitly rather than relying on `[` removal
 * alone to break `[text](url)`), and ampersand (HTML-entity interpretation
 * some delivery paths apply). Replaced with a space rather than deleted, so
 * removing a trigger character cannot mash two words into a different one.
 */
const PLAIN_TEXT_MARKUP_TRIGGER_CHARS = /[`*_~|<>[\]&()]/g;

/**
 * Discord and Slack both turn a literal `@everyone` / `@here` / `@role` (and
 * Slack's `@channel`) into a real mention when the text is un-escaped. A
 * zero-width space inserted right after every `@` that precedes a word
 * character breaks that exact contiguous match while staying invisible to a
 * human reading the notice — `user@example.com` still reads as
 * `user@example.com`.
 */
function breakMentionForms(text: string): string {
  return text.replace(/@(?=\w)/g, '@​');
}

function neutralizePlainText(text: string): string {
  const noMarkup = text.replace(PLAIN_TEXT_MARKUP_TRIGGER_CHARS, ' ');
  const noMentions = breakMentionForms(noMarkup);
  return noMentions.replace(REPEATED_SPACE, ' ').trim();
}

function flattenSpans(spans: readonly NoticeSpan[], escapeUntrusted: (text: string) => string): string {
  return spans.map((span) => (span.kind === 'literal' ? span.text : escapeUntrusted(span.text))).join('');
}

function flattenNotice(notice: StructuredNotice, escapeUntrusted: (text: string) => string): string {
  const lines = [flattenSpans(notice.title, escapeUntrusted)];
  for (const field of notice.fields) {
    lines.push(`${field.label}: ${flattenSpans(field.value, escapeUntrusted)}`);
  }
  return lines.join('\n');
}

/** The conservative fallback renderer: full neutralization, never raw concatenation. */
export function renderNoticeAsPlainText(notice: StructuredNotice): string {
  return flattenNotice(notice, neutralizePlainText);
}

// ---------------------------------------------------------------------------
// Per-channel escapers. Escape, don't strip: the owner sees the exact text
// the mail contained, rendered inert rather than mangled or live.
// ---------------------------------------------------------------------------

/**
 * Telegram MarkdownV2's full reserved set (bot API docs): every one of these
 * characters must be escaped with a preceding backslash WHEREVER it appears
 * as literal text, not only where it would otherwise form syntax — that is
 * MarkdownV2's own rule, not a simplification made here. A backslash in the
 * input is escaped first (via being included in the same character class),
 * so `\` itself cannot un-escape anything that follows it.
 */
function escapeTelegramMarkdownV2(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (ch) => `\\${ch}`);
}

/**
 * Discord markdown: backslash-escaping `` * _ ~ ` | `` and `>` renders each as
 * its literal character rather than triggering bold/italic/strikethrough/
 * code/spoiler/quote — this is the same convention widely used by Discord
 * bots, and Discord's client does not show the backslash for an escape that
 * would not otherwise have been syntax.
 *
 * `[` `]` `(` `)` are escaped too, and this is REQUIRED, not defensive —
 * live-verified rather than assumed either way:
 *
 *   - Masked links (`[text](url)`) DO render as clickable in bot-sent
 *     messages and webhook messages (and in embeds). They do NOT render for
 *     text a human typed directly into the client — Discord's own
 *     trade-off, specifically to stop a human hiding a malicious URL behind
 *     innocent display text. The daemon delivers over the bot/webhook
 *     paths — exactly where masked links work.
 *     https://github.com/discord/discord-api-docs/issues/6096
 *     https://gist.github.com/matthewzring/9f7bbfd102003963f9be7dbcf7d40e51
 *
 * Without this escape, a mail sender's chosen display text arrives in the
 * owner's Discord as a clickable link reading whatever the sender wrote —
 * `[Approved](https://evil.example)` renders live. An escaper that looks
 * optional gets deleted by the next person tidying up this file: it is not
 * optional, and it stays.
 *
 * Observed, and explicitly NOT relied upon: Discord runs its own filter that
 * blocks a bare URL placed in the TEXT portion of a masked link
 * (`[https://x](y)` gets flattened before it renders). That is Discord's own
 * mitigation, not a contract with this module — it can change without
 * notice, and it does not cover arbitrary attacker-chosen display text
 * (`[Approved](https://evil.example)` is exactly the shape it does not
 * stop). This escaper does not depend on it and neither should the next
 * person reading this comment.
 *
 * `@everyone` / `@here` / a raw role or channel mention are NOT defeated by
 * backslash-escaping the `@` in every Discord client, so they get the same
 * zero-width-space break used by the plain-text path instead.
 */
function escapeDiscordMarkdown(text: string): string {
  const escaped = text.replace(/[*_~`|>[\]()\\]/g, (ch) => `\\${ch}`);
  return breakMentionForms(escaped);
}

/**
 * Slack mrkdwn. `&`, `<`, `>` MUST be HTML-entity-escaped per Slack's own
 * formatting reference — this is not optional and it is also what defeats
 * `<url|text>` link syntax and `<!channel>` / `<@id>` mention syntax
 * completely, since both require a literal, unescaped `<`.
 *
 * Slack has no backslash-escape mechanism for `* _ ~ \`` (bold/italic/
 * strikethrough/code): unlike Telegram and Discord, there is no documented
 * way to make the character itself render literally while guaranteeing it
 * can never pair into real formatting. The zero-width-space break used
 * elsewhere in this module is applied here too, as the best available
 * mitigation — stated as such rather than as a guaranteed contract, because
 * Slack's own whitespace-adjacency rule for what breaks a delimiter pair is
 * not publicly specified to that level of precision. This is a COSMETIC
 * residual risk (accidental bold/italic), not the injection class this
 * module exists to close (a clickable link or a real mention), both of
 * which the entity-escaping above already defeats outright.
 */
function escapeSlackMrkdwn(text: string): string {
  const entityEscaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return entityEscaped.replace(/[*_~`]/g, (ch) => `${ch}​`);
}

/** Standard HTML entity escaping, for a channel that renders the notice as HTML. */
function escapeHtmlEntities(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * ntfy carries notice fields in HTTP headers (`X-Title`, `X-Tags`, …); a bare
 * `\r` or `\n` there is header injection, not markup. `stripControlAndLineBreaks`
 * in the producer already guarantees none reaches this function, but this
 * escaper re-asserts it as its own, independently testable layer — a defect
 * anywhere upstream of this point (a future producer change, a caller that
 * bypasses `renderInboundMailNotice`) must not compound into a live header
 * injection. ntfy does not parse markdown or mentions by default, so nothing
 * else is transformed.
 */
function escapeNtfyField(text: string): string {
  return text.replace(CONTROL_OR_LINE_BREAK, ' ').replace(REPEATED_SPACE, ' ').trim();
}

/**
 * Every channel this module ships an escaper for. Not a claim that these are
 * the only channels `deliverSurfaceNotice` can reach — see
 * `renderNoticeForChannel` for what an unregistered channel gets.
 */
export type NoticeChannel = 'telegram' | 'discord' | 'slack' | 'html' | 'ntfy';

const NOTICE_ESCAPERS: Readonly<Record<NoticeChannel, (text: string) => string>> = {
  telegram: escapeTelegramMarkdownV2,
  discord: escapeDiscordMarkdown,
  slack: escapeSlackMrkdwn,
  html: escapeHtmlEntities,
  ntfy: escapeNtfyField,
};

/**
 * Render a `StructuredNotice` for one channel. `channel` is a plain `string`
 * rather than `NoticeChannel` deliberately: a channel this module has no
 * escaper for — including one that does not exist yet — falls back to
 * `renderNoticeAsPlainText`, never to a raw, un-escaped concatenation of span
 * text. Wiring an actual channel's delivery path to call this (or to call its
 * own equivalent escaper directly) is the integration round's job; this
 * function and its escapers are what that round has to invoke rather than
 * invent.
 */
export function renderNoticeForChannel(notice: StructuredNotice, channel: string): string {
  const escaper = (NOTICE_ESCAPERS as Readonly<Record<string, (text: string) => string>>)[channel];
  if (!escaper) return renderNoticeAsPlainText(notice);
  return flattenNotice(notice, escaper);
}

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
