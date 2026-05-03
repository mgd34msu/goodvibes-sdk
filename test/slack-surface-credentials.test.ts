import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getBuiltinSetupSchema } from '../packages/sdk/src/platform/channels/builtin/setup-schema.js';
import { buildBuiltinAccount } from '../packages/sdk/src/platform/channels/builtin/accounts.js';
import { runBuiltinAccountAction } from '../packages/sdk/src/platform/channels/builtin/account-actions.js';
import { ChannelProviderRuntimeManager } from '../packages/sdk/src/platform/channels/provider-runtime.js';
import { DaemonSurfaceDeliveryHelper } from '../packages/sdk/src/platform/daemon/surface-delivery.js';
import { ServiceRegistry } from '../packages/sdk/src/platform/config/service-registry.js';
import type { BuiltinChannelRuntimeDeps } from '../packages/sdk/src/platform/channels/builtin/shared.js';
import type { ChannelSurface } from '../packages/sdk/src/platform/channels/types.js';
import type { ConfigManager } from '../packages/sdk/src/platform/config/manager.js';
import type { SecretsManager } from '../packages/sdk/src/platform/config/secrets.js';
import type { SubscriptionManager } from '../packages/sdk/src/platform/config/subscriptions.js';

type MutableConfig = ConfigManager & { readonly values: Map<string, unknown> };

function makeConfigManager(initial: Record<string, unknown> = {}): MutableConfig {
  const values = new Map<string, unknown>([
    ['surfaces.slack.enabled', false],
    ['surfaces.slack.signingSecret', ''],
    ['surfaces.slack.botToken', ''],
    ['surfaces.slack.appToken', ''],
    ['surfaces.slack.defaultChannel', ''],
    ['surfaces.slack.workspaceId', ''],
    ['surfaces.ntfy.baseUrl', 'https://ntfy.sh'],
    ...Object.entries(initial),
  ]);
  return {
    values,
    get(key: string) {
      return values.get(key);
    },
    set(key: string, value: unknown) {
      values.set(key, value);
    },
    getCategory() {
      return {};
    },
  } as unknown as MutableConfig;
}

function makeSecrets(initial: Record<string, string> = {}): Pick<SecretsManager, 'get' | 'set' | 'delete' | 'getGlobalHome'> {
  const values = new Map(Object.entries(initial));
  return {
    async get(key: string) {
      return values.get(key) ?? null;
    },
    async set(key: string, value: string) {
      values.set(key, value);
    },
    async delete(key: string) {
      values.delete(key);
    },
    getGlobalHome() {
      return tmpdir();
    },
  };
}

function makeServiceRegistry(resolveSecret: ServiceRegistry['resolveSecret'] = async () => null): ServiceRegistry {
  return {
    resolveSecret,
    get: () => null,
    getAll: () => ({}),
  } as unknown as ServiceRegistry;
}

function makeBuiltinDeps(
  configManager: MutableConfig,
  secretsManager: Pick<SecretsManager, 'get' | 'set' | 'delete' | 'getGlobalHome'>,
  serviceRegistry = makeServiceRegistry(),
): BuiltinChannelRuntimeDeps {
  return {
    configManager,
    secretsManager,
    serviceRegistry,
    surfaceDeliveryEnabled: () => Boolean(configManager.get('surfaces.slack.enabled')),
    providerRuntime: undefined,
    routeBindings: {},
    channelPolicy: {},
    channelPlugins: {},
    deliveryRouter: {},
    buildSurfaceAdapterContext: () => ({}),
    buildGenericWebhookAdapterContext: () => ({}),
    deliverSurfaceProgress: async () => {},
    deliverSlackAgentReply: async () => {},
    deliverDiscordAgentReply: async () => {},
    deliverNtfyAgentReply: async () => {},
    deliverWebhookAgentReply: async () => {},
    deliverSlackApprovalUpdate: async () => {},
    deliverDiscordApprovalUpdate: async () => {},
    deliverNtfyApprovalUpdate: async () => {},
    deliverWebhookApprovalUpdate: async () => {},
  } as unknown as BuiltinChannelRuntimeDeps;
}

function restoreGlobalWebSocket(descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) {
    Object.defineProperty(globalThis, 'WebSocket', descriptor);
  }
}

describe('Slack surface credentials', () => {
  test('setup schema exposes Slack app token as a service-backed secret target', () => {
    const schema = getBuiltinSetupSchema('slack');
    const appToken = schema.secretTargets.find((target) => target.id === 'appToken');
    expect(appToken?.serviceName).toBe('slack');
    expect(appToken?.serviceField).toBe('appToken');
    expect(appToken?.envKeys).toContain('SLACK_APP_TOKEN');
    expect(appToken?.configKeys).toContain('surfaces.slack.appToken');
  });

  test('service registry resolves Slack app-level tokens', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'goodvibes-slack-services-'));
    try {
      const servicesPath = join(dir, 'services.json');
      writeFileSync(servicesPath, JSON.stringify({
        slack: {
          name: 'slack',
          authType: 'bearer',
          tokenKey: 'SLACK_BOT_TOKEN',
          appTokenKey: 'SLACK_APP_TOKEN',
        },
      }), 'utf-8');
      const secrets = makeSecrets({ SLACK_APP_TOKEN: 'xapp-service-token' });
      const registry = new ServiceRegistry(servicesPath, {
        secretsManager: secrets as SecretsManager,
        subscriptionManager: { getAccessToken: () => null } as unknown as SubscriptionManager,
      });

      expect(await registry.resolveSecret('slack', 'appToken')).toBe('xapp-service-token');
      expect((await registry.inspect('slack'))?.hasAppToken).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('direct Slack setup stores usable GoodVibes secret refs', async () => {
    const configManager = makeConfigManager();
    const secretsManager = makeSecrets();
    const deps = makeBuiltinDeps(configManager, secretsManager);
    const accountContext = {
      deps,
      providerRuntimeStatus: () => null,
    };
    const buildAccount = (surface: ChannelSurface) => buildBuiltinAccount(accountContext, surface);

    const result = await runBuiltinAccountAction({
      deps,
      buildAccount,
      resolveAccount: async (surface, accountId) => {
        const account = await buildAccount(surface);
        return account.id === accountId ? account : null;
      },
    }, 'slack', 'setup', undefined, {
      botToken: 'xoxb-direct-token',
      appToken: 'xapp-direct-token',
      signingSecret: 'direct-signing-secret',
      defaultChannel: 'C123',
      workspaceId: 'T123',
    });

    expect(result.ok).toBe(true);
    expect(await secretsManager.get('SLACK_BOT_TOKEN')).toBe('xoxb-direct-token');
    expect(await secretsManager.get('SLACK_APP_TOKEN')).toBe('xapp-direct-token');
    expect(await secretsManager.get('SLACK_SIGNING_SECRET')).toBe('direct-signing-secret');
    expect(configManager.get('surfaces.slack.botToken')).toBe('goodvibes://secrets/goodvibes/SLACK_BOT_TOKEN');
    expect(configManager.get('surfaces.slack.appToken')).toBe('goodvibes://secrets/goodvibes/SLACK_APP_TOKEN');
    expect(configManager.get('surfaces.slack.signingSecret')).toBe('goodvibes://secrets/goodvibes/SLACK_SIGNING_SECRET');
    expect(configManager.get('surfaces.slack.enabled')).toBe(true);
  });

  test('Socket Mode runtime resolves Slack app token from GoodVibes config refs', async () => {
    const originalFetch = globalThis.fetch;
    const originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
    let authorization: string | null = null;
    globalThis.fetch = (async (_input, init) => {
      authorization = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
      return Response.json({ ok: true, url: 'ws://slack.test/socket' });
    }) as typeof fetch;
    class FakeWebSocket {
      static readonly OPEN = 1;
      readyState = 1;
      constructor(readonly url: string) {}
      addEventListener() {}
      send() {}
      close() {
        this.readyState = 3;
      }
    }
    Object.defineProperty(globalThis, 'WebSocket', {
      value: FakeWebSocket,
      configurable: true,
      writable: true,
    });

    try {
      const configManager = makeConfigManager({
        'surfaces.slack.enabled': true,
        'surfaces.slack.appToken': 'goodvibes://secrets/goodvibes/SLACK_APP_TOKEN',
        'surfaces.slack.botToken': 'goodvibes://secrets/goodvibes/SLACK_BOT_TOKEN',
      });
      const manager = new ChannelProviderRuntimeManager({
        configManager,
        secretsManager: makeSecrets({
          SLACK_APP_TOKEN: 'xapp-config-ref',
          SLACK_BOT_TOKEN: 'xoxb-config-ref',
        }),
        serviceRegistry: makeServiceRegistry(),
        buildSurfaceAdapterContext: () => ({} as never),
      });

      const result = await manager.start('slack');
      expect(result.ok).toBe(true);
      expect(authorization).toBe('Bearer xapp-config-ref');
      manager.stop('slack');
    } finally {
      globalThis.fetch = originalFetch;
      restoreGlobalWebSocket(originalWebSocket);
    }
  });

  test('Slack final delivery resolves bot token from GoodVibes config refs', async () => {
    const originalFetch = globalThis.fetch;
    let authorization: string | null = null;
    globalThis.fetch = (async (_input, init) => {
      authorization = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
      return Response.json({ ok: true, ts: '1.0', channel: 'C123' });
    }) as typeof fetch;

    try {
      const helper = new DaemonSurfaceDeliveryHelper({
        pendingSurfaceReplies: new Map(),
        channelReplyPipeline: {},
        configManager: makeConfigManager({
          'surfaces.slack.botToken': 'goodvibes://secrets/goodvibes/SLACK_BOT_TOKEN',
        }),
        secretsManager: makeSecrets({ SLACK_BOT_TOKEN: 'xoxb-delivery-ref' }),
        serviceRegistry: makeServiceRegistry(),
        agentManager: {},
        sessionBroker: {},
        routeBindings: {},
        channelPlugins: {},
        authToken: () => null,
        surfaceDeliveryEnabled: () => true,
      } as never);

      await helper.deliverSlackAgentReply({
        surfaceKind: 'slack',
        agentId: 'agent-1',
        task: 'test task',
        createdAt: 0,
        channelId: 'C123',
      }, 'done');

      expect(authorization).toBe('Bearer xoxb-delivery-ref');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
