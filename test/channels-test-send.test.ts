/**
 * channels-test-send.test.ts
 *
 * The channels.test.send verb, proven over a real GatewayMethodCatalog with the
 * handler attached the same way the daemon attaches it
 * (registerChannelTestGatewayMethods). Proves the descriptor + handler register
 * together and that a delivery FAILURE is an honest delivered:false outcome
 * carrying the real error — never a fabricated success, never a blanket throw.
 */
import { describe, expect, test } from 'bun:test';
import { GatewayMethodCatalog } from '../packages/sdk/src/platform/control-plane/method-catalog.ts';
import {
  registerChannelTestGatewayMethods,
  type ChannelTestDeliveryRouter,
} from '../packages/sdk/src/platform/control-plane/routes/channel-test.ts';
import type { ChannelDeliveryRequest } from '../packages/sdk/src/platform/channels/delivery/types.ts';
import { getBuiltinSetupSchema, CHANNEL_SETUP_VERSION } from '../packages/sdk/src/platform/channels/index.ts';

const ctx = { context: { admin: true } } as const;

function makeCatalog(router: ChannelTestDeliveryRouter): GatewayMethodCatalog {
  const catalog = new GatewayMethodCatalog();
  registerChannelTestGatewayMethods(catalog, router);
  return catalog;
}

describe('channels.test.send gateway verb', () => {
  test('descriptor and handler register together', () => {
    const catalog = makeCatalog({ deliver: async () => 'resp-1' });
    expect(catalog.get('channels.test.send')).not.toBeNull();
    expect(catalog.hasHandler('channels.test.send')).toBe(true);
  });

  test('a successful send reports delivered:true with the surface responseId and the delivery request it built', async () => {
    let seen: ChannelDeliveryRequest | undefined;
    const catalog = makeCatalog({
      deliver: async (req) => {
        seen = req;
        return 'msg-42';
      },
    });
    const result = await catalog.invoke('channels.test.send', {
      ...ctx,
      body: { surface: 'slack', address: '#ops' },
    }) as { surface: string; delivered: boolean; responseId?: string; address?: string };

    expect(result.delivered).toBe(true);
    expect(result.responseId).toBe('msg-42');
    expect(result.surface).toBe('slack');
    expect(result.address).toBe('#ops');
    expect(seen?.target).toEqual({ kind: 'surface', surfaceKind: 'slack', address: '#ops' });
    expect(typeof seen?.body).toBe('string');
    expect(seen?.body.length).toBeGreaterThan(0);
  });

  test('a delivery failure is an honest delivered:false with the real error, not a throw', async () => {
    const catalog = makeCatalog({
      deliver: async () => {
        throw new Error('Unsupported channel delivery target: surface:slack');
      },
    });
    const result = await catalog.invoke('channels.test.send', {
      ...ctx,
      body: { surface: 'slack' },
    }) as { delivered: boolean; error?: string };

    expect(result.delivered).toBe(false);
    expect(result.error).toContain('Unsupported channel delivery target');
  });

  test('a missing surface argument is an honest 400', async () => {
    const catalog = makeCatalog({ deliver: async () => undefined });
    await expect(catalog.invoke('channels.test.send', { ...ctx, body: {} })).rejects.toThrow(/surface/);
  });
});

describe('getBuiltinSetupSchema public export', () => {
  test('is reachable through the channels package index (the authoritative setup declaration)', () => {
    const slack = getBuiltinSetupSchema('slack');
    expect(slack.surface).toBe('slack');
    expect(slack.version).toBe(CHANNEL_SETUP_VERSION);
    expect(slack.fields.some((f) => f.kind === 'secret')).toBe(true);
    expect(slack.secretTargets.length).toBeGreaterThan(0);
  });
});
