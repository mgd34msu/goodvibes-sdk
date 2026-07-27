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
 * that string, and the adapter's only allowed move is to pass this function's
 * output straight through.
 *
 * ── The rule this file enforces structurally, not by convention ───────────
 *
 * "No raw body text ever reaches the notice" is not implemented as a rule
 * someone has to remember to follow. `InboundMailNoticeInput` below has no
 * body/text/preview field of any shape — there is no parameter position a
 * caller could put message content into, so the question "did we forget to
 * strip the body" cannot even be asked. `NO_BODY_FIELD_GUARD` at the bottom
 * of this file is a second, compiler-checked line against the same failure:
 * if a future edit ever adds a `body`-shaped field to the input type, that
 * line stops compiling.
 *
 * Subject and sender ARE accepted, because the owner needs to know who wrote
 * and what it was about — but both are attacker-controlled text, so both are
 * sanitized here rather than trusted: control characters and line breaks are
 * removed (so a subject cannot forge extra lines in the rendered notice or
 * anything that reads as a directive), length is capped, and markup
 * metacharacters that Telegram, Slack, and Discord each interpret differently
 * are neutralized for all three at once, since this function does not know
 * which of them the owner's notice route actually points at.
 *
 * Links never render as anything a person or a client could open. Only a
 * registrable domain (via platform/security/public-suffix.ts, punycode-
 * normalized first so a homograph domain renders as its own opaque ASCII
 * form rather than as the Latin lookalike it was built to resemble) plus a
 * verdict ever reaches the string.
 */

import { toASCII } from 'node:punycode';
import { registrableDomain } from '../security/public-suffix.js';
import type { DeliveredRecipient } from '../google/delivery-evidence.js';

// ---------------------------------------------------------------------------
// Types the caller supplies. Every field here is either daemon-generated
// (receivedAt) or attacker-reachable text that gets sanitized before it is
// ever placed in the output (senderDisplay, subject, outcome fields, link
// hosts, refusal reasons).
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
      /** Why the expectation was opened, e.g. "Create a GitHub account for the owner". Attacker-adjacent text — sanitized before use. */
      readonly purpose: string;
      /** The domain the expectation was scoped to. Sanitized and punycode-normalized before use, same as a link host. */
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
      /** A link in the message was refused by link validation (platform/security/link-validation.ts). */
      readonly kind: 'refused-link';
      /** A short, plain-language refusal reason. Sanitized before use. */
      readonly reason: string;
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
      /** What the account currently cannot do, e.g. "message bodies are not authorized under the granted scope". Sanitized before use. */
      readonly missingCapability: string;
    };

/** How a single link in the message was treated. Never carries a URL — see the module header. */
export type LinkVerdict = 'authorized' | 'refused' | 'unrecognized';

/**
 * One link's rendering summary. `host` is the raw hostname the link pointed
 * at (punycode or Unicode, either is fine — this module normalizes it before
 * display), never a full URL: there is no field here a caller could put a
 * path or query string into, so an assembled clickable URL cannot reach the
 * output no matter what the caller passes.
 */
export interface ValidatedLinkSummary {
  readonly host: string;
  readonly verdict: LinkVerdict;
  /** Set when verdict is 'refused'. A short, plain-language reason. Sanitized before use. */
  readonly refusalReason?: string | undefined;
}

export interface InboundMailNoticeInput {
  /** Sender's registrable domain and local part. Attacker-written — sanitized before use. */
  readonly senderDisplay: string;
  /** The message subject. Attacker-written — sanitized before use. */
  readonly subject: string;
  /** Evidence-backed delivery address, or null when none was available. Never a `To:` header claim. */
  readonly deliveredTo: DeliveredRecipient | null;
  readonly outcome: InboundOutcome;
  /** Every link found in the message, already run through link validation. */
  readonly links: readonly ValidatedLinkSummary[];
  /** ISO 8601 timestamp, daemon-generated (not attacker-reachable), but still defensively parsed below. */
  readonly receivedAt: string;
}

// ---------------------------------------------------------------------------
// Sanitization. Applied to every attacker-reachable string before it can
// appear anywhere in the rendered notice.
// ---------------------------------------------------------------------------

/** Cap applied to every free-text field. Generous enough to read, short enough to bound a notification payload. */
const MAX_FIELD_LENGTH = 200;
/** Tighter cap for a refusal reason, which is always a short, fixed-shape phrase. */
const MAX_REASON_LENGTH = 120;

/**
 * Every ASCII control character, DEL, and the Unicode line/paragraph
 * separators — not just `\n` and `\r`. A subject containing ` ` renders
 * as a real line break in several renderers even though it is not `\n`, so
 * treating only `\n`/`\r` as "a newline" would leave an equivalent forgery
 * path open.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_OR_LINE_BREAK = new RegExp('[\\u0000-\\u001F\\u007F\\u2028\\u2029]', 'g');

/**
 * Markup metacharacters across the surfaces `deliverSurfaceNotice` can fan
 * out to. This function does not know which surface the owner's notice route
 * points at, so it neutralizes the union rather than guessing:
 *   - backtick / asterisk / underscore / tilde / pipe: code, bold, italic,
 *     strikethrough, and spoiler markers in Telegram MarkdownV2, Discord
 *     markdown, and Slack mrkdwn.
 *   - angle brackets / square brackets: link and mention syntax
 *     (`<http://x|text>` in Slack, `[text](url)` in Telegram/Discord).
 *   - ampersand: HTML-entity interpretation some delivery paths apply.
 * Replaced with a space rather than deleted, so removing a trigger character
 * cannot mash two words together into a different word.
 */
const MARKUP_TRIGGER_CHARS = /[`*_~|<>[\]&]/g;

/** Collapses the runs of spaces the two replacements above can produce. */
const REPEATED_SPACE = / {2,}/g;

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

/**
 * The one function every attacker-reachable FREE-TEXT string (subject,
 * sender display, an expectation's purpose, a refusal reason) passes through
 * before it can appear in the rendered notice. Order matters: control
 * characters and line breaks are removed FIRST (so a later step cannot
 * reintroduce a forged line from a character a markup replacement exposes),
 * then markup triggers, then mention forms, then whitespace is collapsed,
 * then the result is capped to length.
 */
function sanitizeField(raw: string, maxLength: number): string {
  const noControlChars = raw.replace(CONTROL_OR_LINE_BREAK, ' ');
  const noMarkup = noControlChars.replace(MARKUP_TRIGGER_CHARS, ' ');
  const noMentionForms = breakMentionForms(noMarkup);
  const collapsed = noMentionForms.replace(REPEATED_SPACE, ' ').trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

/**
 * The lighter sanitize used for a DELIVERY-EVIDENCE address (`deliveredTo`).
 * Unlike subject/sender, this value is not attacker-chosen free text — it is
 * the mailbox actually fetched from or the top-most delivery header, which
 * the sender cannot forge (see platform/google/delivery-evidence.ts) — and it
 * is, per the design, "the single most useful fact" the owner reads. Running
 * it through the full markup neutralizer would mangle characters that are
 * legitimate in a real address (`_`, `~`, and a bare `@`), reducing the one
 * value the notice is built to make trustworthy. Control characters and line
 * breaks are still removed (an address is still attacker-INFLUENCED insofar
 * as the sender picks who the alias resolves through), and length is still
 * capped, but no markup stripping and no mention-breaking apply.
 */
function sanitizeEvidenceField(raw: string, maxLength: number): string {
  const noControlChars = raw.replace(CONTROL_OR_LINE_BREAK, ' ');
  const collapsed = noControlChars.replace(REPEATED_SPACE, ' ').trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
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

/**
 * The registrable domain of `rawHost`, rendered so a homograph cannot read as
 * its lookalike. `toASCII` punycode-encodes any non-ASCII label BEFORE the
 * registrable-domain lookup and before the result is ever placed in a
 * string — a Cyrillic `аpple.com` becomes the opaque `xn--pple-43d.com`,
 * never the Latin string it was built to be mistaken for. An already-ASCII
 * host (including one already in `xn--` form) passes through unchanged.
 * Returns a fixed, safe placeholder for anything unparseable — including
 * anything that is not actually hostname-shaped — rather than falling back
 * to raw attacker text.
 */
function safeRegistrableDomain(rawHost: string): string {
  const trimmed = rawHost.trim().toLowerCase().replace(/\.+$/, '');
  if (trimmed.length === 0) return '(unrecognized link)';
  let ascii: string;
  try {
    ascii = toASCII(trimmed);
  } catch {
    return '(unrecognized link)';
  }
  if (!VALID_ASCII_HOSTNAME.test(ascii)) return '(unrecognized link)';
  const domain = registrableDomain(ascii);
  return domain ?? '(unrecognized link)';
}

// ---------------------------------------------------------------------------
// Per-field rendering. Each of these returns ONE line, never more — subject
// and sender are already newline-free by the time they arrive here, but the
// per-field structure means a future field added here inherits the same
// guarantee rather than needing to remember it.
// ---------------------------------------------------------------------------

function renderDeliveredToLine(deliveredTo: DeliveredRecipient | null): string {
  if (deliveredTo === null) return 'Delivered to: (no verified delivery evidence)';
  return `Delivered to: ${sanitizeEvidenceField(deliveredTo.address, MAX_FIELD_LENGTH)}`;
}

function renderOutcomeLine(outcome: InboundOutcome): string {
  switch (outcome.kind) {
    case 'matched-expectation': {
      const purpose = sanitizeField(outcome.purpose, MAX_FIELD_LENGTH);
      const domain = safeRegistrableDomain(outcome.serviceDomain);
      return `Matched an open expectation: ${purpose} (${domain}).`;
    }
    case 'expired-expectation':
      return 'The closest expectation had already expired — not renewed, not matched.';
    case 'refused-link': {
      const reason = sanitizeField(outcome.reason, MAX_REASON_LENGTH);
      return `A link in this message was refused: ${reason}.`;
    }
    case 'inert':
      return 'No expectation matched. Recorded, not actioned.';
    case 'capability-degraded': {
      const missing = sanitizeField(outcome.missingCapability, MAX_FIELD_LENGTH);
      return `LIMITED VIEW — this account cannot currently ${missing}. Read from envelope fields only; `
        + 'nothing here could match or satisfy a verification.';
    }
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

function renderLinkLine(link: ValidatedLinkSummary): string {
  const domain = safeRegistrableDomain(link.host);
  switch (link.verdict) {
    case 'authorized':
      return `  - ${domain} — matched the authorized service`;
    case 'refused': {
      const reason = link.refusalReason ? sanitizeField(link.refusalReason, MAX_REASON_LENGTH) : 'refused';
      return `  - ${domain} — refused (${reason}), not opened`;
    }
    case 'unrecognized':
    default:
      return `  - ${domain} — no expectation matched, not opened`;
  }
}

function renderReceivedAtLine(receivedAt: string): string {
  const parsed = new Date(receivedAt);
  const text = Number.isNaN(parsed.getTime())
    ? sanitizeField(receivedAt, 64)
    : parsed.toISOString();
  return `Received: ${text}`;
}

// ---------------------------------------------------------------------------
// The one exported entry point.
// ---------------------------------------------------------------------------

/**
 * Render an inbound-mail owner notice from structured fields only. The
 * output is the ONLY thing an adapter may pass to
 * `DaemonSurfaceDeliveryHelper.deliverSurfaceNotice` for inbound mail — never
 * a string assembled any other way.
 *
 * When `outcome.kind === 'capability-degraded'`, the header itself changes
 * (`New mail — LIMITED VIEW` rather than plain `New mail`) so a degraded
 * notice is never visually indistinguishable from a normal one — the owner
 * should be able to tell at a glance that he is seeing less than the full
 * picture, not have to read to the outcome line to find out.
 */
export function renderInboundMailNotice(input: InboundMailNoticeInput): string {
  const sender = sanitizeField(input.senderDisplay, MAX_FIELD_LENGTH) || '(unknown sender)';
  const subject = sanitizeField(input.subject, MAX_FIELD_LENGTH) || '(no subject)';
  const degraded = isCapabilityDegraded(input.outcome);

  const lines: string[] = [
    degraded ? 'New mail — LIMITED VIEW' : 'New mail',
    `From: ${sender}`,
    `Subject: ${subject}`,
    renderDeliveredToLine(input.deliveredTo),
    renderOutcomeLine(input.outcome),
  ];

  if (input.links.length > 0) {
    lines.push('Links:');
    for (const link of input.links) lines.push(renderLinkLine(link));
  }

  lines.push(renderReceivedAtLine(input.receivedAt));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Compiler-checked guard, independent of the review that added it: if a
// future edit ever adds a `body`, `text`, `content`, `preview`, or `snippet`
// field to InboundMailNoticeInput, this line stops compiling. It exists
// alongside the structural absence above (not instead of it) for the same
// reason InboundMailContext in platform/email/inbound/ gets a runtime
// own-property assertion on top of its type: a type shape can be widened by
// someone who does not read this file's header; a failing build is harder to
// miss than a comment.
// ---------------------------------------------------------------------------
type _ForbiddenBodyLikeField = Extract<keyof InboundMailNoticeInput, 'body' | 'text' | 'content' | 'preview' | 'snippet'>;
type _AssertNoBodyLikeField = _ForbiddenBodyLikeField extends never ? true : 'FAIL: a body-like field was added to InboundMailNoticeInput';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _assertNoBodyLikeField: _AssertNoBodyLikeField = true;
