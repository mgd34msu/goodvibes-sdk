/**
 * The wiring: a structured notice reaches a channel escaped for THAT channel.
 *
 * The escapers existed and nothing called them, `renderNoticeForChannel` had
 * no caller outside its own module, so every one of them was dead code and
 * the guarantee they describe was not in force anywhere. These cover the seam
 * that puts them in the delivery path.
 *
 * The mapping is asserted against what each send site actually does, because
 * the first version of that table was wrong in a way no test caught: it gave
 * Telegram MarkdownV2 escaping for a `sendMessage` that sets no `parse_mode`,
 * which would have shipped visible backslashes to the owner while leaving the
 * live risk, client-side auto-linking, untouched.
 */

import { describe, expect, test } from 'bun:test';
import {
  noticeChannelForSurface,
  renderNoticeForSurface,
} from '../packages/sdk/src/platform/email/inbound-notice-channels.ts';
import {
  receiptTimestamp,
  renderInboundMailNotice,
} from '../packages/sdk/src/platform/email/inbound-notice.ts';
import { DaemonSurfaceDeliveryHelper } from '../packages/sdk/src/platform/daemon/surface-delivery.ts';

function binding(surfaceKind: string): never {
  return {
    id: `route-${surfaceKind}`,
    surfaceKind,
    externalId: '55512345',
    channelId: '55512345',
    metadata: {},
  } as never;
}

/** The zero-width space the defanging escapers insert. */
const Z = '​';

function noticeWith(subject: string) {
  return renderInboundMailNotice({
    senderDisplay: 'noreply@github.com',
    subject,
    deliveredTo: null,
    outcome: { kind: 'inert' },
    links: [],
    receivedAt: receiptTimestamp(new Date('2026-07-28T12:00:00.000Z')),
  });
}

describe('a surface gets the escaper its own send site needs', () => {
  test.each([
    ['discord', 'discord'],
    ['slack', 'slack'],
    ['telegram', 'telegram'],
    ['ntfy', 'ntfy'],
  ])('%s resolves to its verified escaper', (surface, channel) => {
    expect(noticeChannelForSurface(surface)).toBe(channel);
  });

  test.each([
    'webhook', 'homeassistant', 'google-chat', 'signal', 'whatsapp',
    'telephony', 'imessage', 'msteams', 'bluebubbles', 'mattermost', 'matrix',
  ])('%s has no verified escaper, so it falls back rather than guessing', (surface) => {
    // deliverSurfaceNotice reaches fifteen surface kinds and only four have
    // had their send sites read. Mapping the rest on inference is how an
    // escaper ends up aimed at syntax the channel does not interpret while
    // missing the syntax it does, exactly what the Telegram entry did.
    expect(noticeChannelForSurface(surface)).toBe('plain');
  });

  test('a surface nobody has heard of still falls back, never throws', () => {
    expect(noticeChannelForSurface('some-surface-invented-next-year')).toBe('plain');
  });
});

describe('the rendered string is escaped for the destination, not for a guess', () => {
  test('Discord gets its masked link neutralized, because content always parses markdown', () => {
    const text = renderNoticeForSurface(noticeWith('[Approved](https://evil.example)'), 'discord');
    expect(text).not.toContain('[Approved](https://evil.example)');
  });

  test('Telegram gets the URL defanged and the markdown left alone', () => {
    // Both halves matter. The URL is the live risk on a no-parse_mode send;
    // the brackets are not, and escaping them would be noise the owner reads.
    const text = renderNoticeForSurface(noticeWith('[Approved](https://evil.example)'), 'telegram');
    expect(text).toContain(`[Approved](https://${Z}evil.example)`);
    expect(text).not.toContain('\\[');
  });

  test('an unverified surface gets fully-neutralized text, never the raw span', () => {
    const payload = '[Approved](https://evil.example) @everyone';
    const text = renderNoticeForSurface(noticeWith(payload), 'matrix');
    expect(text).not.toContain(payload);
    expect(text).not.toContain('@everyone');
    // The bare URL is defanged here too. The fallback is what every unmapped
    // surface gets, and it is reached WITHOUT going through the channel
    // dispatch's composition, so it needs its own defanging rather than
    // inheriting it.
    expect(text).not.toContain('https://evil.example');
    // Neutralized, but the words survive, the owner can still tell what the
    // mail said, which is the whole reason this escapes rather than strips.
    expect(text).toContain('Approved');
  });

  test('every surface renders SOMETHING; none produces an empty or raw notice', () => {
    const payload = '[Approved](https://evil.example)';
    for (const surface of [
      'discord', 'slack', 'telegram', 'ntfy', 'webhook', 'homeassistant',
      'google-chat', 'signal', 'whatsapp', 'telephony', 'imessage',
      'msteams', 'bluebubbles', 'mattermost', 'matrix',
    ]) {
      const text = renderNoticeForSurface(noticeWith(payload), surface);
      expect(text.length).toBeGreaterThan(0);
      expect(text).toContain('Subject:');
      // The one invariant that holds on every surface: the exact live form
      // never survives unchanged.
      expect(text).not.toContain(payload);
    }
  });
});

describe('the delivery seam picks the escaper from the binding, not from the caller', () => {
  test('a structured notice is escaped for the surface it is actually bound for', async () => {
    // The point of the companion: the destination is not knowable at the call
    // site, so a caller holding a StructuredNotice cannot pick the wrong
    // escaper, or skip escaping, because it never holds a string to pass.
    const calls: { surface: string; text: string }[] = [];
    const helper = new DaemonSurfaceDeliveryHelper({
      pendingSurfaceReplies: new Map(),
      channelReplyPipeline: {},
      configManager: { get: () => undefined, getCategory: () => ({}) },
      serviceRegistry: { resolveSecret: async () => null },
      agentManager: {},
      sessionBroker: {},
      routeBindings: {},
      channelPlugins: {
        render: async (surface: string, request: { text: string }) => {
          calls.push({ surface, text: request.text });
          return { delivered: true, metadata: {} };
        },
      },
      authToken: () => null,
      surfaceDeliveryEnabled: () => true,
    } as never);

    const notice = noticeWith('[Approved](https://evil.example)');

    const discord = await helper.deliverStructuredNotice(binding('discord'), notice);
    const telegram = await helper.deliverStructuredNotice(binding('telegram'), notice);

    expect(discord).toEqual({ delivered: true });
    expect(telegram).toEqual({ delivered: true });
    expect(calls).toHaveLength(2);

    // Different surfaces, different escaping, proof the binding chose it.
    expect(calls[0]!.surface).toBe('discord');
    expect(calls[1]!.surface).toBe('telegram');
    expect(calls[0]!.text).not.toBe(calls[1]!.text);

    // Telegram keeps the brackets (nothing parses them there) and loses the
    // tappable URL; Discord neutralizes the masked-link form outright.
    expect(calls[1]!.text).toContain(`[Approved](https://${Z}evil.example)`);
    expect(calls[0]!.text).not.toContain('[Approved](https://evil.example)');

    // Neither delivers the raw live form.
    for (const call of calls) {
      expect(call.text).not.toContain('[Approved](https://evil.example)');
    }
  });

  test('a notice with no route binding is refused, not rendered for a surface that does not exist', async () => {
    const helper = new DaemonSurfaceDeliveryHelper({
      pendingSurfaceReplies: new Map(),
      channelReplyPipeline: {},
      configManager: { get: () => undefined, getCategory: () => ({}) },
      serviceRegistry: { resolveSecret: async () => null },
      agentManager: {},
      sessionBroker: {},
      routeBindings: {},
      channelPlugins: { render: async () => ({ delivered: true, metadata: {} }) },
      authToken: () => null,
      surfaceDeliveryEnabled: () => true,
    } as never);

    const outcome = await helper.deliverStructuredNotice(undefined, noticeWith('anything'));
    expect(outcome.delivered).toBe(false);
    // SurfaceNoticeDelivery is discriminated on `delivered`; only the false arm
    // carries a reason.
    if (outcome.delivered) throw new Error('unreachable: asserted false above');
    expect(outcome.reason).toBe('no-route-binding');
  });
});
