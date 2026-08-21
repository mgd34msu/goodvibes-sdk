/**
 * notice-text.ts, making attacker-chosen text inert before it reaches a
 * notification the owner reads and acts on.
 *
 * ── The defect class this exists for ──────────────────────────────────────
 *
 * The inbound-mail notice sanitized its delivered-to address for control
 * characters only, on the premise that a sender cannot forge which mailbox
 * received the mail. That premise is true about the MAILBOX and false about the
 * local part in front of the `@`, which under catch-all or plus-addressing is
 * whatever the sender chose to type. So
 * `[Approved](https://evil.example)@ourdomain.com` rendered as a clickable link,
 * and `@everyone@ourdomain.com` formed a real mention, on the one field the
 * notice existed to make trustworthy.
 *
 * The reasoning that produced it is the part worth remembering: **a field is not
 * safe because part of its provenance is verified.** "The sender cannot forge
 * which mailbox this arrived at" is a different claim from "the sender cannot
 * influence this string", and only the second one licenses skipping
 * neutralisation.
 *
 * Payment notices are a strictly worse version of the same surface: a merchant
 * page controls the item title, the seller name and the shipping labels, the
 * owner reads them on his phone under a ten-minute clock, and his reply
 * authorises a charge.
 *
 * ── Where per-channel escaping lives, and why this is not it ──────────────
 *
 * This function does NOT know which channel a notice will fan out to. Telegram
 * MarkdownV2, Slack mrkdwn, Discord markdown, ntfy and a bare terminal each
 * escape differently and have different mention forms, and a trigger set tuned
 * for one lets something through on another.
 *
 * So the split is deliberate:
 *
 *  - **Here (source):** neutralise the UNION of trigger characters, so the value
 *    is inert whatever the route turns out to be. This is the defence that does
 *    not depend on guessing the destination, and it is the one that has to hold.
 *  - **Channel adapter (delivery):** whatever escaping that specific channel's
 *    formatter requires. That is a rendering concern belonging to the code that
 *    knows the wire format.
 *
 * Neutralising the union at the source is not a substitute for correct per-
 * channel escaping; it is what keeps a missing escape from becoming a clickable
 * link in a message about money.
 *
 * ── Convergence note ──────────────────────────────────────────────────────
 *
 * `platform/email/inbound-notice.ts` (branch `inbound-email-config`, commit
 * `140cbcb4`) currently carries its own copy of this logic, written first. This
 * module is deliberately behaviourally identical, same trigger sets, same
 * mention-breaking, same ordering, so the two can be collapsed onto this one
 * when that branch merges. Two copies of a security escaper is the drift class
 * that lets one of them quietly fall behind.
 */

/** Control characters and the Unicode line separators, which can forge a line. */
const CONTROL_OR_LINE_BREAK = new RegExp('[\\u0000-\\u001F\\u007F\\u2028\\u2029]', 'g');

/**
 * Markup metacharacters across every surface a notice can reach.
 *
 *  - backtick / asterisk / underscore / tilde / pipe, code, bold, italic,
 *    strikethrough and spoiler markers in Telegram MarkdownV2, Discord markdown
 *    and Slack mrkdwn.
 *  - angle brackets / square brackets / parentheses, link and mention syntax
 *    (`<http://x|text>` in Slack, `[text](url)` in Telegram and Discord).
 *    Parentheses are listed explicitly even though removing `[` already breaks
 *    the `[text](url)` pair: leaving that as the only thing stopping `(url)`
 *    from surviving is an implicit dependency between two character sets that a
 *    later edit to either could break silently.
 *  - ampersand, HTML entity forms on surfaces that render them.
 */
const MARKUP_TRIGGER_CHARS = /[`*_~|<>[\]&()]/g;

/**
 * The same set MINUS underscore, for fields where underscore is common and
 * legibility matters, an email local part, an owner's own product description.
 *
 * Underscore is the weakest trigger in the set: unpaired it renders literally,
 * and paired it is at worst cosmetic italics. It can never build a link or a
 * mention. Every other character here can, and is removed regardless of field.
 */
const LEGIBLE_MARKUP_TRIGGER_CHARS = /[`*~|<>[\]&()]/g;

const REPEATED_SPACE = / {2,}/g;

/**
 * Break `@everyone`, `@here`, `@channel` and `@role` mention forms.
 *
 * Discord and Slack turn a literal contiguous `@word` into a real mention when
 * the text is un-escaped. A zero-width space after every `@` that precedes a
 * word character breaks the contiguous match while staying invisible to a human
 * reader, `user@example.com` still reads as `user@example.com`.
 */
export function breakMentionForms(text: string): string {
  return text.replace(/@(?=\w)/g, '@​');
}

function sanitize(raw: string, maxLength: number, triggers: RegExp): string {
  // Order matters. Control characters and line breaks go FIRST, so that a later
  // step cannot reintroduce a forged line from a character a markup replacement
  // exposes. Then markup, then mention forms, then whitespace, then the cap.
  const noControlChars = raw.replace(CONTROL_OR_LINE_BREAK, ' ');
  const noMarkup = noControlChars.replace(triggers, ' ');
  const noMentionForms = breakMentionForms(noMarkup);
  const collapsed = noMentionForms.replace(REPEATED_SPACE, ' ').trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

/**
 * The sanitize every ATTACKER-CHOSEN free-text string passes through before it
 * can appear in a notice: a merchant's item title, seller or store name, a
 * shipping-option label, promotional text, a currency string, an email subject.
 *
 * Assume attacker-chosen unless the string demonstrably originated with the
 * owner. Provenance being partly verified is not an exemption, see the header.
 */
export function sanitizeNoticeField(raw: string, maxLength = 120): string {
  return sanitize(raw, maxLength, MARKUP_TRIGGER_CHARS);
}

/**
 * The sanitize for a field the OWNER authored, where underscore is worth
 * keeping for legibility.
 *
 * Still sanitized rather than trusted: threading provenance correctly is a thing
 * code gets wrong, and neutralising his own text costs nothing but the
 * underscore exemption. A guarantee that holds only while every call site stays
 * correct is not a guarantee.
 */
export function sanitizeOwnerNoticeField(raw: string, maxLength = 120): string {
  return sanitize(raw, maxLength, LEGIBLE_MARKUP_TRIGGER_CHARS);
}

/** A hostname and nothing else: letters, digits and hyphens per label. */
const PLAIN_HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/**
 * True when `host` is a bare hostname carrying no markup potential at all.
 *
 * Used as an assertion on a merchant identity that was supposedly computed by
 * `registrableDomain()` rather than read off a page. A computed value should
 * always pass; if one ever does not, the identity did not come from where the
 * caller believed, and rendering it would be exactly the defect this module is
 * about.
 */
export function isPlainHostname(host: string): boolean {
  return PLAIN_HOSTNAME.test(host);
}
