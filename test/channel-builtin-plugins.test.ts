import { describe, expect, test } from 'bun:test';
import { ChannelPluginRegistry } from '../packages/sdk/src/platform/channels/plugin-registry.js';
import { BuiltinChannelRuntime } from '../packages/sdk/src/platform/channels/builtin-runtime.js';
import type { ChannelSurface } from '../packages/sdk/src/platform/channels/types.js';
import type { BuiltinChannelRuntimeDeps, ManagedSurface } from '../packages/sdk/src/platform/channels/builtin/shared.js';

const EXPECTED_SURFACES = [
  'tui',
  'web',
  'slack',
  'discord',
  'ntfy',
  'webhook',
  'homeassistant',
  'telegram',
  'google-chat',
  'signal',
  'whatsapp',
  'imessage',
  'msteams',
  'bluebubbles',
  'mattermost',
  'matrix',
] as const satisfies readonly ChannelSurface[];

const WEBHOOK_BACKED_SURFACES = [
  'slack',
  'discord',
  'ntfy',
  'webhook',
  'homeassistant',
  'telegram',
  'google-chat',
  'signal',
  'whatsapp',
  'imessage',
  'msteams',
  'bluebubbles',
  'mattermost',
  'matrix',
] as const satisfies readonly ManagedSurface[];

function createBuiltinRuntimeDeps(channelPlugins: ChannelPluginRegistry): BuiltinChannelRuntimeDeps {
  return {
    channelPlugins,
    configManager: {
      get: () => undefined,
      getCategory: () => ({
        slack: {},
        discord: {},
        ntfy: {},
        webhook: {},
        homeassistant: {},
        telegram: {},
        googleChat: {},
        signal: {},
        whatsapp: { provider: 'meta-cloud' },
        imessage: {},
        msteams: {},
        bluebubbles: {},
        mattermost: {},
        matrix: {},
      }),
      set: () => undefined,
    },
    secretsManager: {
      get: () => undefined,
      set: async () => undefined,
    },
    serviceRegistry: {
      get: () => undefined,
      resolveSecret: async () => null,
    },
    routeBindings: {
      start: async () => undefined,
      getBinding: () => undefined,
      listBindings: () => [],
    },
    channelPolicy: {
      start: async () => undefined,
      getPolicy: () => undefined,
      upsertPolicy: async (_surface: string, input: Record<string, unknown>) => input,
    },
    deliveryRouter: {},
    surfaceDeliveryEnabled: () => false,
    buildSurfaceAdapterContext: () => ({}),
    buildGenericWebhookAdapterContext: () => ({}),
    deliverSurfaceProgress: async () => undefined,
    deliverSlackAgentReply: async () => undefined,
    deliverDiscordAgentReply: async () => undefined,
    deliverNtfyAgentReply: async () => undefined,
    deliverWebhookAgentReply: async () => undefined,
    deliverSlackApprovalUpdate: async () => undefined,
    deliverDiscordApprovalUpdate: async () => undefined,
    deliverNtfyApprovalUpdate: async () => undefined,
    deliverWebhookApprovalUpdate: async () => undefined,
  } as unknown as BuiltinChannelRuntimeDeps;
}

describe('built-in channel plugin contract', () => {
  test('registers every SDK-owned surface with stable ids and lookup keys', () => {
    const registry = new ChannelPluginRegistry();
    new BuiltinChannelRuntime(createBuiltinRuntimeDeps(registry)).registerPlugins();

    const descriptors = registry.listDescriptors();
    expect(descriptors.map((entry) => entry.surface).sort()).toEqual([...EXPECTED_SURFACES].sort());
    for (const surface of EXPECTED_SURFACES) {
      const plugin = registry.getBySurface(surface);
      expect(plugin?.id).toBe(`surface:${surface}`);
      expect(plugin?.displayName).toEqual(expect.any(String));
      expect(plugin?.capabilities).not.toEqual([]);
    }
  });

  test('exposes webhook-backed plugin paths for all remote channel adapters', () => {
    const registry = new ChannelPluginRegistry();
    new BuiltinChannelRuntime(createBuiltinRuntimeDeps(registry)).registerPlugins();

    for (const surface of WEBHOOK_BACKED_SURFACES) {
      const plugin = registry.getBySurface(surface);
      expect(plugin?.webhookPath).toEqual(expect.any(String));
      expect(registry.getByPath(plugin!.webhookPath!)).toBe(plugin);
    }
  });
});
