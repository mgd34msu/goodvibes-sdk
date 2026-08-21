/**
 * payments-notice-delivery.test.ts, the notice actually leaves the process.
 *
 * ══ What was broken, and what these prove ═════════════════════════════════
 *
 * `message.ts` rendered a notice and returned a string; `windows.ts` consumed a
 * per-channel delivery report and decided from it; nothing performed the send
 * in between. A purchase would render a notice into nothing and then evaluate
 * the window against a report nobody produced, so an in-budget purchase would
 * proceed on a "silence" that was really a message never sent.
 *
 * These run the whole path against a FAKE CHANNEL that records what it
 * received: render → deliver → report → window → outcome. The four cases are
 * the two window kinds crossed with delivered and undeliverable, because that
 * is exactly the matrix the owner's undeliverable ruling covers and the two
 * kinds resolve it oppositely:
 *
 *   in-budget, delivered, silence      ⇒ PROCEEDS  (veto: he had the chance)
 *   in-budget, undeliverable           ⇒ PROCEEDS  (he already authorised it)
 *   over-budget, delivered, silence    ⇒ REFUSED   (approval: silence denies)
 *   over-budget, undeliverable         ⇒ REFUSED   (nobody to ask)
 */
import { describe, expect, test } from 'bun:test';

import {
  createChannelPaymentNotifier,
  parsePaymentReply,
  type PaymentNoticeTarget,
} from '../packages/sdk/src/platform/payments/notice-delivery.js';
import {
  advanceApproval,
  advanceVeto,
  type ApprovalState,
  type ChannelDelivery,
  type VetoState,
} from '../packages/sdk/src/platform/payments/windows.js';
import { sanitizeNoticeField } from '../packages/sdk/src/platform/security/notice-text.js';
import type { CommandAuthorityChannel } from '../packages/sdk/src/platform/payments/types.js';

/** A channel that records what it was handed, or refuses to take it. */
function fakeChannel(options: { readonly failing?: boolean } = {}) {
  const sent: string[] = [];
  return {
    sent,
    router: {
      async deliver(request: never): Promise<string | undefined> {
        if (options.failing === true) {
          // The shape a real strategy fails in: a missing binding, an expired
          // token. It throws rather than returning falsy, which is what makes
          // `delivered` a fact rather than an assumption.
          throw new Error('Missing telegram chat id for this binding');
        }
        sent.push((request as unknown as { content: string }).content);
        return 'msg-1';
      },
    },
  };
}

function targets(): readonly PaymentNoticeTarget[] {
  return [{ channel: 'telegram', request: { target: { kind: 'channel' } }, backfillable: true }];
}

const silentReplies = {
  async waitForAnswer(): Promise<null> {
    return null;
  },
};

function answering(answer: 'approve' | 'deny' | 'acknowledge' | 'object') {
  return {
    async waitForAnswer(): Promise<{ answer: typeof answer; channel: CommandAuthorityChannel }> {
      return { answer, channel: 'telegram' };
    },
  };
}

describe('the notice reaches a channel, and the report is what really happened', () => {
  test('a delivered notice is sent once, with the rendered text, and reports delivered', async () => {
    const channel = fakeChannel();
    const notifier = createChannelPaymentNotifier({
      router: channel.router,
      targets: targets(),
      replies: silentReplies,
    });

    const deliveries = await notifier.deliver({ kind: 'veto', message: 'About to buy this' });

    expect(channel.sent).toEqual(['About to buy this']);
    expect(deliveries).toEqual([{ channel: 'telegram', delivered: true, backfillable: true }]);
  });

  test('a channel that throws reports delivered:false rather than assuming a send', async () => {
    const channel = fakeChannel({ failing: true });
    const failures: string[] = [];
    const notifier = createChannelPaymentNotifier({
      router: channel.router,
      targets: targets(),
      replies: silentReplies,
      onDeliveryFailure: ({ channel: name, reason }) => failures.push(`${name}:${reason}`),
    });

    const deliveries = await notifier.deliver({ kind: 'veto', message: 'About to buy this' });

    expect(channel.sent).toEqual([]);
    expect(deliveries[0]?.delivered).toBe(false);
    expect(failures[0]).toContain('telegram');
    // The notice never enters the failure log: it names the merchant, the item
    // and the total, and an operator log is a wider read path than the channel.
    expect(failures[0]).not.toContain('About to buy this');
  });

  test('one channel failing and another working is reported per channel', async () => {
    const good = fakeChannel();
    let call = 0;
    const notifier = createChannelPaymentNotifier({
      router: {
        async deliver(request: never): Promise<string | undefined> {
          call += 1;
          if (call === 1) throw new Error('Missing slack binding');
          return good.router.deliver(request);
        },
      },
      targets: [
        { channel: 'tui', request: {}, backfillable: false },
        { channel: 'telegram', request: {}, backfillable: true },
      ],
      replies: silentReplies,
    });

    const deliveries = await notifier.deliver({ kind: 'approval', message: 'Approval needed' });
    expect(deliveries.map((d) => [d.channel, d.delivered])).toEqual([['tui', false], ['telegram', true]]);
  });
});

// ═══ The four cases the undeliverable ruling covers ════════════════════════

describe('render → deliver → report → window, for each of the four cases', () => {
  async function runWindow(input: {
    readonly kind: 'approval' | 'veto';
    readonly deliverable: boolean;
  }): Promise<{ state: string; sent: string[] }> {
    const channel = fakeChannel({ failing: !input.deliverable });
    const notifier = createChannelPaymentNotifier({
      router: channel.router,
      targets: targets(),
      replies: silentReplies,
    });
    const deliveries: readonly ChannelDelivery[] = await notifier.deliver({
      kind: input.kind,
      message: 'the rendered notice',
    });

    if (input.kind === 'approval') {
      let state: ApprovalState = advanceApproval('pending-dispatch', { kind: 'dispatched', deliveries });
      if (state === 'awaiting-approval') {
        const answer = await notifier.awaitAnswer({ kind: 'approval', deadlineMs: 0 });
        state = advanceApproval(state, answer === null ? { kind: 'deadline' } : { kind: 'approve', channel: answer.channel });
      }
      return { state, sent: channel.sent };
    }
    let state: VetoState = advanceVeto('pending-dispatch', { kind: 'dispatched', deliveries });
    if (state === 'open') {
      const answer = await notifier.awaitAnswer({ kind: 'veto', deadlineMs: 0 });
      state = advanceVeto(state, answer === null ? { kind: 'deadline' } : { kind: 'object', channel: answer.channel });
    }
    return { state, sent: channel.sent };
  }

  test('in-budget, delivered, silence ⇒ proceeds', async () => {
    const result = await runWindow({ kind: 'veto', deliverable: true });
    expect(result.sent.length).toBe(1);
    expect(result.state).toBe('proceeding-silent');
  });

  test('in-budget, undeliverable ⇒ proceeds, because he already authorised it', async () => {
    const result = await runWindow({ kind: 'veto', deliverable: false });
    expect(result.sent.length).toBe(0);
    expect(result.state).toBe('proceeding-undelivered');
  });

  test('over-budget, delivered, silence ⇒ denied', async () => {
    const result = await runWindow({ kind: 'approval', deliverable: true });
    expect(result.sent.length).toBe(1);
    expect(result.state).toBe('denied-timeout');
  });

  test('over-budget, undeliverable ⇒ denied, because there is nobody to ask', async () => {
    const result = await runWindow({ kind: 'approval', deliverable: false });
    expect(result.sent.length).toBe(0);
    expect(result.state).toBe('denied-undeliverable');
  });

  test('the two kinds resolve the SAME undeliverable report oppositely', async () => {
    const veto = await runWindow({ kind: 'veto', deliverable: false });
    const approval = await runWindow({ kind: 'approval', deliverable: false });
    // The ruling in one assertion: identical delivery facts, opposite outcomes.
    expect(veto.state).toBe('proceeding-undelivered');
    expect(approval.state).toBe('denied-undeliverable');
  });
});

// ═══ An explicit answer short-circuits ═════════════════════════════════════

describe('an explicit answer during the window', () => {
  test('an acknowledgement on a veto short-circuits to proceeding immediately', async () => {
    const channel = fakeChannel();
    const notifier = createChannelPaymentNotifier({
      router: channel.router,
      targets: targets(),
      replies: answering('acknowledge'),
    });
    const deliveries = await notifier.deliver({ kind: 'veto', message: 'n' });
    let state: VetoState = advanceVeto('pending-dispatch', { kind: 'dispatched', deliveries });
    const answer = await notifier.awaitAnswer({ kind: 'veto', deadlineMs: 0 });
    expect(answer?.answer).toBe('acknowledge');
    state = advanceVeto(state, { kind: 'acknowledge', channel: 'telegram' });
    expect(state).toBe('proceeding-acknowledged');
  });

  test('an objection cancels rather than proceeding', async () => {
    const channel = fakeChannel();
    const notifier = createChannelPaymentNotifier({
      router: channel.router,
      targets: targets(),
      replies: answering('object'),
    });
    const deliveries = await notifier.deliver({ kind: 'veto', message: 'n' });
    let state: VetoState = advanceVeto('pending-dispatch', { kind: 'dispatched', deliveries });
    const answer = await notifier.awaitAnswer({ kind: 'veto', deadlineMs: 0 });
    state = advanceVeto(state, { kind: 'object', channel: answer!.channel });
    expect(state).toBe('cancelled');
  });
});

// ═══ Reading an answer ═════════════════════════════════════════════════════

describe('reading a reply as an answer', () => {
  test('the same word means opposite things on the two windows', () => {
    expect(parsePaymentReply('go', 'approval')).toBe('approve');
    expect(parsePaymentReply('go', 'veto')).toBe('acknowledge');
    expect(parsePaymentReply('stop', 'approval')).toBe('deny');
    expect(parsePaymentReply('stop', 'veto')).toBe('object');
  });

  test('a leading answer word still counts', () => {
    expect(parsePaymentReply('stop please', 'veto')).toBe('object');
    expect(parsePaymentReply('go ahead', 'veto')).toBe('acknowledge');
  });

  test('anything unrecognised is NO answer, so the window\'s own silence rule decides', () => {
    // Not guessed into an approval. On the veto path a guess buys something.
    expect(parsePaymentReply('what is this', 'veto')).toBe(null);
    expect(parsePaymentReply('hmm, maybe later?', 'approval')).toBe(null);
    expect(parsePaymentReply('', 'veto')).toBe(null);
  });
});

// ═══ Per-channel markup ════════════════════════════════════════════════════

describe('merchant text cannot build channel markup in a notice', () => {
  test('a Discord masked link cannot survive a merchant-derived field', () => {
    const hostile = '[Click here](https://evil.example/steal) and **approve**';
    const safe = sanitizeNoticeField(hostile, 200);
    // Brackets and parens are what a masked link is made of, and Discord
    // renders them in bot and webhook messages.
    for (const character of ['[', ']', '(', ')', '*', '`', '_', '~', '|', '<', '>']) {
      expect(safe).not.toContain(character);
    }
  });

  test('a mention form is broken so it cannot ping', () => {
    expect(sanitizeNoticeField('@everyone buy this', 200)).not.toMatch(/@everyone/);
  });

  test('a forged line cannot be injected into the notice body', () => {
    const forged = 'Keyboard\nTOTAL: USD 1.00\nApproved already';
    const safe = sanitizeNoticeField(forged, 200);
    expect(safe).not.toContain('\n');
  });
});
