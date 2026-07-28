/**
 * Gate notices reach every surface the gate covers.
 *
 * The defect this pins: `deliverSurfaceNotice` used to push through
 * `deliverSurfaceProgress`, which is implemented for slack, discord and ntfy
 * only. Telegram — the surface whose bot demonstrably answers chat messages,
 * because those answers go through the channel delivery router — had no notice
 * path at all. A work-shaped Telegram message therefore produced a proposal
 * that could never be shown, so the owner was asked nothing and saw nothing.
 *
 * The notice now goes through the SAME `channelPlugins.render` path a
 * conversational reply takes, so any surface with a registered channel plugin
 * can carry a proposal.
 */
import { describe, expect, test } from 'bun:test';
import { DaemonSurfaceDeliveryHelper } from '../packages/sdk/src/platform/daemon/surface-delivery.ts';
import type { AutomationRouteBinding } from '../packages/sdk/src/platform/automation/routes.ts';
import type { ChannelRenderRequest } from '../packages/sdk/src/platform/channels/types.ts';

interface RenderCall {
  readonly surface: string;
  readonly request: ChannelRenderRequest;
}

/**
 * `surfaceKind` is the real union, not `string`.
 *
 * Written as `string` behind a cast, this fixture could name a surface that
 * does not exist and the routing under test would have been exercised against
 * it. `kind` was missing entirely, and `metadata` is not a member of
 * AutomationRouteBinding at all.
 */
function makeBinding(surfaceKind: AutomationRouteBinding['surfaceKind']): AutomationRouteBinding {
  return {
    id: `route-${surfaceKind}`,
    kind: 'channel',
    surfaceKind,
    surfaceId: `surface-${surfaceKind}`,
    externalId: '55512345',
    channelId: '55512345',
    lastSeenAt: 0,
    createdAt: 0,
    updatedAt: 0,
    metadata: {},
  };
}

function makeHelper(options: {
  readonly render?: ((surface: string, request: ChannelRenderRequest) => Promise<unknown>) | undefined;
  readonly enabled?: ((surface: string) => boolean) | undefined;
  readonly calls?: RenderCall[] | undefined;
}): DaemonSurfaceDeliveryHelper {
  const calls = options.calls ?? [];
  return new DaemonSurfaceDeliveryHelper({
    pendingSurfaceReplies: new Map(),
    channelReplyPipeline: {},
    configManager: { get: () => undefined, getCategory: () => ({}) },
    serviceRegistry: { resolveSecret: async () => null },
    agentManager: {},
    sessionBroker: {},
    routeBindings: {},
    channelPlugins: {
      render: async (surface: string, request: ChannelRenderRequest) => {
        calls.push({ surface, request });
        return options.render ? await options.render(surface, request) : { delivered: true, metadata: {} };
      },
    },
    authToken: () => null,
    surfaceDeliveryEnabled: options.enabled ?? (() => true),
  } as never);
}

describe('surface notice delivery', () => {
  test('a Telegram notice is delivered through the channel render path', async () => {
    const calls: RenderCall[] = [];
    const helper = makeHelper({ calls });

    const outcome = await helper.deliverSurfaceNotice(
      makeBinding('telegram'),
      'That reads like work. Reply "yes" to start it.',
    );

    expect(outcome).toEqual({ delivered: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.surface).toBe('telegram');
    expect(calls[0]!.request.text).toBe('That reads like work. Reply "yes" to start it.');
    expect(calls[0]!.request.routeId).toBe('route-telegram');
    // The pending record carries the chat id the router turns into a
    // sendMessage target; without it the strategy throws "Missing Telegram chat id".
    expect((calls[0]!.request.pending as Record<string, unknown>).targetAddress).toBe('55512345');
  });

  test('every surface the conversation gate covers by default can carry a notice', async () => {
    // Straight from conversationGate.gatedSurfaces. A surface that is gated but
    // cannot be delivered to is a black hole: work is withheld and no question
    // is ever asked.
    const gated: readonly AutomationRouteBinding['surfaceKind'][] = [
      'ntfy', 'telegram', 'slack', 'discord', 'homeassistant', 'google-chat',
      'signal', 'whatsapp', 'telephony', 'imessage', 'msteams', 'bluebubbles',
      'mattermost', 'matrix',
    ];
    for (const surface of gated) {
      const calls: RenderCall[] = [];
      const helper = makeHelper({ calls });
      const outcome = await helper.deliverSurfaceNotice(makeBinding(surface), 'proposal');
      expect({ surface, outcome }).toEqual({ surface, outcome: { delivered: true } });
      expect(calls).toHaveLength(1);
    }
  });

  test('a channel that reports non-delivery refuses rather than claiming success', async () => {
    const helper = makeHelper({
      render: async () => ({ delivered: false, metadata: { reason: 'missing-bot-token' } }),
    });

    const outcome = await helper.deliverSurfaceNotice(makeBinding('telegram'), 'proposal');

    expect(outcome).toEqual({ delivered: false, reason: 'delivery-failed', error: 'missing-bot-token' });
  });

  test('a transport failure is reported as a refusal, not a delivery', async () => {
    const helper = makeHelper({
      render: async () => {
        throw new Error('Telegram delivery failed HTTP 401');
      },
    });

    const outcome = await helper.deliverSurfaceNotice(makeBinding('telegram'), 'proposal');

    expect(outcome.delivered).toBe(false);
    expect(outcome.delivered === false && outcome.reason).toBe('delivery-failed');
    expect(outcome.delivered === false && outcome.error).toContain('401');
  });

  test('with no plugin registered the direct push is used, and still refuses honestly', async () => {
    // render() returning null means no plugin owns the surface. The fallback is
    // deliverSurfaceProgress, which throws by name for surfaces it does not
    // implement — it must not read as a delivery.
    const helper = makeHelper({ render: async () => null });

    const outcome = await helper.deliverSurfaceNotice(makeBinding('telegram'), 'proposal');

    expect(outcome.delivered).toBe(false);
    expect(outcome.delivered === false && outcome.reason).toBe('delivery-failed');
    expect(outcome.delivered === false && outcome.error).toContain('not implemented for telegram');
  });

  test('a disabled surface refuses before any delivery is attempted', async () => {
    const calls: RenderCall[] = [];
    const helper = makeHelper({ calls, enabled: () => false });

    const outcome = await helper.deliverSurfaceNotice(makeBinding('telegram'), 'proposal');

    expect(outcome).toEqual({ delivered: false, reason: 'surface-delivery-disabled' });
    expect(calls).toHaveLength(0);
  });

  test('empty text and a missing binding are refused by name', async () => {
    const helper = makeHelper({});
    expect(await helper.deliverSurfaceNotice(undefined, 'proposal'))
      .toEqual({ delivered: false, reason: 'no-route-binding' });
    expect(await helper.deliverSurfaceNotice(makeBinding('telegram'), '   '))
      .toEqual({ delivered: false, reason: 'empty-text' });
  });
});
