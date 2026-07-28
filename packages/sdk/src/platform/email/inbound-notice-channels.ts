/**
 * Turning a `StructuredNotice` into one channel's wire string.
 *
 * Split out of `inbound-notice.ts` so the producer and the escapers are
 * separate modules, which is the module family's own thesis made structural:
 * the producer never holds a channel-formatted string, and nothing here can
 * reach the fields the producer decided to include. The dependency runs one
 * way — this file imports the note's types and sanitizing primitives, and
 * `inbound-notice.ts` imports nothing from here.
 *
 * Escape, do not strip. The owner is meant to see `[Approved](https://evil.example)`
 * exactly as the mail wrote it, rendered inert — not a row of blanks that
 * leaves him unable to tell whether the mail said that or we did.
 */

import {
  CONTROL_OR_LINE_BREAK,
  REPEATED_SPACE,
  type NoticeSpan,
  type StructuredNotice,
} from './inbound-notice.js';

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
  // Defanged here as well as at the channel dispatch: this function is the
  // fallback an UNMAPPED surface gets, and it is reached without going
  // through `renderNoticeForChannel`'s composition.
  return defangUrlForms(noMentions).replace(REPEATED_SPACE, ' ').trim();
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
 *
 * NOT CURRENTLY REACHED, and the reason is the whole point of the escaper
 * below it. `TelegramApi.sendMessage` (platform/channels/telegram/api.ts)
 * posts `chat_id`, `text`, `disable_web_page_preview` and an optional
 * `message_thread_id` — it sets no `parse_mode`, and `parse_mode` appears
 * nowhere in `packages/sdk/src` outside this file's comments. With it omitted
 * Telegram performs no entity parsing at all, so there is no markdown to
 * escape: running this would put literal backslashes in front of every dot
 * and hyphen the owner reads (`Confirm your account\.`) to prevent syntax
 * that is never interpreted.
 *
 * Kept, not deleted, because it is exactly right the moment the send site
 * changes. THE TRIGGER: if `parse_mode: 'MarkdownV2'` is ever added to
 * `sendMessage`, this becomes required and `defangTelegramPlainText` becomes
 * insufficient — swap the entry in `NOTICE_ESCAPERS`. A grep for `parse_mode`
 * lands here.
 */
function escapeTelegramMarkdownV2(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (ch) => `\\${ch}`);
}

/**
 * A URL-shaped substring, defanged so a client cannot auto-link it.
 *
 * A zero-width space after the scheme separator (and after a bare `www.`)
 * breaks the contiguous match every auto-linker looks for while staying
 * invisible to a person reading the notice — `https://evil.example` still
 * reads as `https://evil.example` and is no longer tappable. The same
 * technique `breakMentionForms` already uses, for the same reason: escape,
 * do not strip. The owner is meant to SEE what the mail said.
 */
function defangUrlForms(text: string): string {
  return text
    .replace(/(\w+:\/\/)/gi, (scheme) => `${scheme}​`)
    .replace(/\b(www\.)/gi, (prefix) => `${prefix}​`);
}

/**
 * The Telegram path, for a send site that sets no `parse_mode`.
 *
 * With no parse mode there is no markdown, so markdown escaping would be
 * noise. What Telegram DOES still do to plain text is client-side entity
 * detection: a bare `https://…` in an attacker-written subject becomes
 * tappable, and `@name` becomes a mention — neither of which markdown
 * escaping touches, which is why the MarkdownV2 escaper above was not merely
 * unnecessary here but aimed at the wrong thing.
 *
 * `disable_web_page_preview: true` at the send site suppresses the PREVIEW
 * card; it does not stop the link being a link. §7 already requires links to
 * reach the owner as a registrable domain plus a verdict; this closes the
 * same hole for URLs the sender embedded in free text such as a subject.
 */
function defangTelegramPlainText(text: string): string {
  // URL defanging is applied by `renderNoticeForChannel` for every channel;
  // this path adds the mention break, which is Telegram-specific.
  return breakMentionForms(text);
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
  const headerSafe = text.replace(CONTROL_OR_LINE_BREAK, ' ').replace(REPEATED_SPACE, ' ').trim();
  // URLs and mentions are defanged for the same reason as on Telegram, and
  // the reason this was added: without it ntfy — a MAPPED surface — was
  // getting weaker treatment than an UNMAPPED one, because the plain-text
  // fallback already breaks both. A surface being recognised must never mean
  // it is protected less. Markdown characters are deliberately left alone:
  // the send site sets no `Markdown` header (platform/integrations/ntfy.ts
  // `publish` sets Title, Priority, Tags and Click only), so `*bold*` is
  // inert there and escaping it would be mangling the owner reads.
  return breakMentionForms(headerSafe);
}

/**
 * Every channel this module ships an escaper for. Not a claim that these are
 * the only channels `deliverSurfaceNotice` can reach — see
 * `renderNoticeForChannel` for what an unregistered channel gets.
 */
export type NoticeChannel = 'telegram' | 'discord' | 'slack' | 'html' | 'ntfy';

const NOTICE_ESCAPERS: Readonly<Record<NoticeChannel, (text: string) => string>> = {
  // Plain-text defanging, NOT MarkdownV2 — see the two comments above
  // `defangTelegramPlainText` for the send-site evidence and the trigger that
  // would make the markdown escaper the right one instead.
  telegram: defangTelegramPlainText,
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
  // URL defanging runs on EVERY channel, composed here rather than repeated
  // inside each escaper.
  //
  // It was originally only on the Telegram path, and the asymmetry was a gap
  // rather than a design: a bare `https://evil.example` sitting in an
  // attacker-written subject is auto-linked by Slack's mrkdwn, by Discord, by
  // ntfy's clients and by the plain-text fallback just as much as by
  // Telegram — none of which needs any markup to do it. §7 requires links to
  // reach the owner as a registrable domain plus a verdict; a raw URL in free
  // text that he can tap contradicts that on every surface, not just one.
  //
  // Composed at the dispatch so a NEW escaper cannot forget it. Putting it
  // inside each escaper would make it four places to keep in step, which is
  // the shape this module family keeps finding defects in.
  return flattenNotice(notice, (text) => defangUrlForms(escaper(text)));
}

// ---------------------------------------------------------------------------
// Which escaper a delivery surface gets
// ---------------------------------------------------------------------------

/**
 * The surface kinds whose rendering this module has actually VERIFIED against
 * their send sites, mapped to the escaper each one needs.
 *
 * Everything absent from this table — and `deliverSurfaceNotice` reaches
 * fifteen surface kinds — resolves to the fully-neutralized plain-text
 * fallback. That default is the point of the table rather than an oversight:
 * mapping a surface on inference is how an escaper ends up aimed at syntax the
 * channel does not interpret while missing the syntax it does, which is
 * precisely what the Telegram entry did before it was checked.
 *
 * Verified, with the evidence:
 *   - `discord` — the body goes to `payload.content`
 *     (platform/integrations/discord.ts), and Discord always parses markdown
 *     in `content` with no opt-in.
 *   - `slack`  — the body lands in a `{ type: 'mrkdwn' }` block via
 *     `formatAgentResult` (platform/integrations/slack.ts), so mrkdwn is
 *     interpreted.
 *   - `telegram` — `sendMessage` sets no `parse_mode`, so the risk is
 *     client-side auto-linking and mentions rather than markup.
 *   - `ntfy` — the message is the request BODY; only the `Title` is an HTTP
 *     header, and `toHeaderSafeTitle` already guards that at the send site.
 *     The escaper here is a second, independently testable layer.
 *
 * `html` is deliberately not mapped from any surface: no delivery path in
 * this codebase renders the notice as HTML. It stays in `NOTICE_ESCAPERS` for
 * a surface that does, and is reached only by passing 'html' explicitly.
 */
const NOTICE_CHANNEL_BY_SURFACE: Readonly<Record<string, NoticeChannel>> = {
  discord: 'discord',
  slack: 'slack',
  telegram: 'telegram',
  ntfy: 'ntfy',
};

/**
 * The channel key to render a notice for, given the surface it is bound for.
 *
 * Returns a string rather than `NoticeChannel` so an unmapped surface flows
 * straight into `renderNoticeForChannel`'s fallback instead of forcing a cast
 * or a throw at the call site — an unrecognised surface must produce a
 * neutralized notice, never an error and never a raw one.
 */
export function noticeChannelForSurface(surfaceKind: string): string {
  return NOTICE_CHANNEL_BY_SURFACE[surfaceKind] ?? 'plain';
}

/**
 * Render a notice for the surface it will be delivered on.
 *
 * The one function a delivery path should call. It resolves the escaper from
 * the surface rather than taking a channel name from a caller, so a caller
 * cannot pick the wrong escaper — or skip escaping — by passing the wrong
 * string.
 */
export function renderNoticeForSurface(notice: StructuredNotice, surfaceKind: string): string {
  return renderNoticeForChannel(notice, noticeChannelForSurface(surfaceKind));
}
