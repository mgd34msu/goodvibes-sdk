/**
 * Four holes in the notice escaper layer, three latent and one live.
 *
 * The layer's thesis is that the producer never holds a channel-formatted
 * string and the escapers never choose what to include. That holds. What did
 * not hold is that every path through the escapers neutralises the same
 * things: line breaks were stripped on ONE of six paths, the field label
 * reached the wire through none of them, a bare-domain URL was defanged by
 * nothing, and the one span built from a server's own wording was marked
 * literal.
 *
 * Three are not reachable through inbound mail today. They are tested anyway,
 * because each is a trap for the NEXT producer rather than a bug in this one,
 * and §11.1 puts a second producer (payments) on this exact path.
 */
import { describe, expect, test } from 'bun:test';
import {
  renderNoticeAsPlainText,
  renderNoticeForChannel,
  renderNoticeForSurface,
} from '../packages/sdk/src/platform/email/inbound-notice-channels.ts';
import { receiptTimestamp, renderInboundMailNotice } from '../packages/sdk/src/platform/email/inbound-notice.ts';
import type { StructuredNotice } from '../packages/sdk/src/platform/email/inbound-notice.ts';

/** Written as escapes on purpose: these are invisible in a source file. */
const LINE_SEPARATOR = '\u2028';
const PARAGRAPH_SEPARATOR = '\u2029';
const ZERO_WIDTH_SPACE = '\u200b';

/**
 * Built from escapes: a character class of these is unreadable inline.
 *
 * DO NOT "simplify" this by importing `CONTROL_OR_LINE_BREAK` from the module
 * under test. It was written that way first, and it made the U+0085 case pass
 * vacuously: the assertion mirrored the implementation, so when the production
 * class was missing NEL the test was missing it too and both agreed. A test
 * that restates the implementation cannot detect the implementation being
 * wrong. The code points are listed here independently, on purpose.
 */
const LINE_BREAK_CODE_POINTS = new RegExp('[\\u0000-\\u001F\\u007F\\u0085\\u2028\\u2029]');

/** Every channel the dispatch maps, plus the fallbacks. */
const CHANNELS = ['telegram', 'discord', 'slack', 'ntfy', 'matrix', 'unmapped-surface'] as const;

function noticeWith(untrustedText: string, label = 'Subject'): StructuredNotice {
  return {
    title: [{ kind: 'literal', text: 'Mail arrived' }],
    fields: [{ label, value: [{ kind: 'untrusted', text: untrustedText }] }],
  };
}

function everyRendering(notice: StructuredNotice): { name: string; text: string }[] {
  return [
    ...CHANNELS.map((channel) => ({ name: channel, text: renderNoticeForChannel(notice, channel) })),
    { name: 'plain-text-fallback', text: renderNoticeAsPlainText(notice) },
    { name: 'surface-fallback', text: renderNoticeForSurface(notice, 'not-a-real-surface') },
  ];
}

// ---------------------------------------------------------------------------
// M1, a newline in untrusted text forges a labelled line
// ---------------------------------------------------------------------------

describe('an untrusted span cannot forge a line on ANY path', () => {
  test('a newline never survives into a rendered notice', () => {
    // The forgery: attacker text that ends one line and starts another which
    // reads like one of ours.
    const notice = noticeWith('harmless\nAmount: $10,000.00');
    for (const { name, text } of everyRendering(notice)) {
      // One field, so exactly one line after the title.
      expect({ name, lines: text.split('\n').length }).toEqual({ name, lines: 2 });
    }
  });

  test('the other line-break code points are neutralised too', () => {
    // Treating only `\n` as "a newline" leaves the same forgery open through a
    // carriage return, a vertical tab, or a Unicode line separator.
    const raws = [
      'a\rAmount: 1',
      'a\u000bAmount: 1',
      'a\u0085Amount: 1',
      `a${LINE_SEPARATOR}Amount: 1`,
      `a${PARAGRAPH_SEPARATOR}Amount: 1`,
    ];
    for (const raw of raws) {
      for (const { name, text } of everyRendering(noticeWith(raw))) {
        // The ONE newline a notice is entitled to is the separator this
        // renderer puts between the title and each field. Everything after it
        // came from the span, so that is where a forgery would show; scanning
        // the whole string would flag our own join.
        const lines = text.split('\n');
        const label = JSON.stringify(raw);
        expect({ name, raw: label, lines: lines.length })
          .toEqual({ name, raw: label, lines: 2 });
        expect({ name, raw: label, leaked: LINE_BREAK_CODE_POINTS.test(lines[1] ?? '') })
          .toEqual({ name, raw: label, leaked: false });
      }
    }
  });
});

// ---------------------------------------------------------------------------
// M2, the label is the one part that reaches the wire unescaped
// ---------------------------------------------------------------------------

describe('a field label cannot forge a line either', () => {
  test('a newline in a label is neutralised on every path', () => {
    // Labels are ours and hardcoded, so this is not live. Nothing in the type
    // says so: `label` is a bare string while title and value are spans.
    const notice = noticeWith('ordinary', 'Subject\nAmount: $10,000.00');
    for (const { name, text } of everyRendering(notice)) {
      expect({ name, lines: text.split('\n').length }).toEqual({ name, lines: 2 });
    }
  });
});

// ---------------------------------------------------------------------------
// M3, LIVE: a bare-domain URL is tappable on every channel
// ---------------------------------------------------------------------------

describe('a bare-domain URL is defanged, not only a schemed one', () => {
  test('host/path in attacker text never renders as a contiguous link', () => {
    const notice = noticeWith('Confirm at evil.example/verify?t=abc123');
    for (const { name, text } of everyRendering(notice)) {
      // The zero-width space breaks the client-side linkifier's match.
      expect({ name, contiguous: text.includes('evil.example/verify') })
        .toEqual({ name, contiguous: false });
      // ...and the host still reads exactly as the mail wrote it.
      expect(text).toContain('evil.example');
      expect(text).toContain(ZERO_WIDTH_SPACE);
    }
  });

  test('the forms that already worked still work', () => {
    for (const raw of ['https://evil.example/x', 'www.evil.example/x']) {
      for (const { name, text } of everyRendering(noticeWith(raw))) {
        expect({ name, raw, live: text.includes(raw) })
          .toEqual({ name, raw, live: false });
      }
    }
  });

  test('ordinary text carrying dots is NOT mangled', () => {
    // A defanger that mauls prose gets switched off. Version numbers,
    // filenames and sentences carry dots and are not URLs.
    for (const raw of ['see report.pdf here', 'version 1.2.3 shipped', 'Ends here. Starts there']) {
      const text = renderNoticeForChannel(noticeWith(raw), 'slack');
      expect({ raw, mangled: text.includes(ZERO_WIDTH_SPACE) })
        .toEqual({ raw, mangled: false });
    }
  });
});

// ---------------------------------------------------------------------------
// M4, the server's own wording is not ours
// ---------------------------------------------------------------------------

describe('a capability reason quoting the server is escaped like any untrusted text', () => {
  /** The shape `renderInboundMailNotice` now builds for `capability-degraded`. */
  const notice: StructuredNotice = {
    title: [{ kind: 'literal', text: 'Mail arrived' }],
    fields: [{
      label: 'Outcome',
      value: [
        { kind: 'literal', text: 'LIMITED VIEW, this account cannot currently ' },
        { kind: 'untrusted', text: '*read bodies*' },
        { kind: 'literal', text: '. Read from envelope fields only.' },
      ],
    }],
  };

  test('markup in the missing-capability wording does not render as markup', () => {
    // Discord and Slack both take `*text*` as emphasis when it is not escaped.
    expect(renderNoticeForChannel(notice, 'discord')).not.toContain('*read bodies*');
    expect(renderNoticeForChannel(notice, 'slack')).not.toContain('*read bodies*');
  });

  test('our own wording either side of it is untouched', () => {
    expect(renderNoticeForChannel(notice, 'discord')).toContain('LIMITED VIEW');
    expect(renderNoticeForChannel(notice, 'discord')).toContain('Read from envelope fields only.');
  });

  test('the PRODUCER marks the server wording untrusted, not literal', () => {
    // The test above proves the escapers handle an untrusted span correctly.
    // This one proves the producer actually emits one, without it, the fix
    // could be reverted in `inbound-notice.ts` and nothing would notice.
    const produced = renderInboundMailNotice({
      senderDisplay: 'someone@sender.test',
      subject: 'a subject',
      deliveredTo: null,
      outcome: { kind: 'capability-degraded', missingCapability: '*read bodies*' },
      links: [],
      // ReceiptTimestamp is branded and its only constructor takes a Date,
      // deliberately, so an attacker-supplied string can never become one.
      receivedAt: receiptTimestamp(new Date('2026-07-28T09:00:00.000Z')),
    });
    const outcome = produced.fields.find((field) => field.label === 'Outcome');
    const carrying = outcome?.value.find((span) => span.text.includes('read bodies'));
    expect(carrying?.kind).toBe('untrusted');
  });
});
