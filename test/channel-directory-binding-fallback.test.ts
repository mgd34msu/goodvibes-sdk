/**
 * A reply must never need configuration.
 *
 * Every channel adapter upserts a route binding on ingress carrying the
 * conversation a message arrived from. The provider directory used to gate its
 * only candidate behind optional config (`surfaces.telegram.defaultChatId`,
 * `surfaces.slack.token`, and the equivalent field on eleven more surfaces) and
 * return ZERO candidates when those were empty, which is the out-of-the-box
 * state. A fresh install could receive a message, answer it internally, and
 * deliver nothing, with no error anywhere.
 *
 * This walks every managed surface with a completely EMPTY configuration and
 * one inbound route binding, and asserts the directory still offers that
 * conversation as a target.
 */
import { describe, expect, test } from 'bun:test';
import { lookupBuiltinProviderDirectory } from '../packages/sdk/src/platform/channels/builtin/targets.ts';
import type { ManagedSurface } from '../packages/sdk/src/platform/channels/builtin/shared.ts';

const SURFACES: readonly ManagedSurface[] = [
  'slack',
  'discord',
  'ntfy',
  'telegram',
  'google-chat',
  'signal',
  'whatsapp',
  'telephony',
  'imessage',
  'msteams',
  'bluebubbles',
  'mattermost',
  'matrix',
  'homeassistant',
] as unknown as readonly ManagedSurface[];

/** Config with every optional field empty, a freshly connected install. */
function emptyConfigManager() {
  const category = new Proxy({}, { get: () => new Proxy({}, { get: () => '' }) });
  return {
    get: () => '',
    getCategory: () => category,
  };
}

function contextWithBinding(surface: string) {
  return {
    deps: {
      configManager: emptyConfigManager(),
      serviceRegistry: { resolveSecret: async () => null, get: () => undefined },
      secretsManager: { get: () => null, getGlobalHome: () => undefined },
      routeBindings: {
        listBindings: () => [{
          id: `route-${surface}`,
          surfaceKind: surface,
          surfaceId: surface,
          externalId: 'inbound-conversation-1',
          channelId: 'inbound-conversation-1',
          title: 'Inbound conversation',
          metadata: {},
        }],
        getBinding: () => undefined,
        resolve: () => undefined,
      },
      channelPlugins: { queryDirectory: async () => [] },
    },
  };
}

describe('channel directory: a conversation that wrote to us is always a target', () => {
  for (const surface of SURFACES) {
    test(`${surface} offers the originating conversation with no configuration`, async () => {
      const entries = await lookupBuiltinProviderDirectory(
        contextWithBinding(surface) as never,
        surface,
        '',
        { limit: 20 },
      );
      expect(entries.length).toBeGreaterThan(0);
    });
  }
});
