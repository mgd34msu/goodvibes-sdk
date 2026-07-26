/**
 * delivery-secret-resolver-required.test.ts
 *
 * A live defect: every Telegram reply was dropped at send time with
 * "Missing Telegram bot token", while the same daemon received Telegram
 * messages fine and answered on ntfy fine.
 *
 * The cause was not Telegram-specific. `surfaces.telegram.botToken` is stored
 * as a `goodvibes://secrets/...` reference, which resolves only when the
 * delivery strategy is handed a local secret resolver. The resolver comes from
 * the composition root's SecretsManager, and that parameter was OPTIONAL all
 * the way down the chain:
 *
 *   composition root -> AutomationDeliveryManager -> ChannelDeliveryRouter
 *     -> createDefaultChannelDeliveryStrategies -> createTelegramDeliveryStrategy
 *
 * The SDK's own composition passed it. Two shipped forks (goodvibes-tui and
 * goodvibes-agent) did not, and nothing failed until a user sent a message on a
 * surface whose credential is a secret reference. Surfaces whose credential
 * lives in plain config or the environment kept working, which is why the
 * failure looked surface-specific rather than structural.
 *
 * These tests pin the fix: the resolver is mandatory at every construction
 * seam, so a fork that forgets it fails loudly at composition time instead of
 * quietly at send time.
 */
import { describe, expect, test } from 'bun:test';
import { ChannelDeliveryRouter } from '../packages/sdk/src/platform/channels/delivery-router.ts';
import { AutomationDeliveryManager } from '../packages/sdk/src/platform/automation/delivery-manager.ts';
import { createTelegramDeliveryStrategy } from '../packages/sdk/src/platform/channels/delivery/strategies-core.ts';
import type { ConfigManager } from '../packages/sdk/src/platform/config/manager.ts';
import type { ServiceRegistry } from '../packages/sdk/src/platform/config/service-registry.ts';
import type { ArtifactStore } from '../packages/sdk/src/platform/artifacts/index.ts';
import type { SecretsManager } from '../packages/sdk/src/platform/config/secrets.ts';
import type { RouteBindingManager } from '../packages/sdk/src/platform/channels/route-bindings.ts';

const SECRET_REF = 'goodvibes://secrets/goodvibes/TELEGRAM_BOT_TOKEN';

function fakeConfigManager(values: Record<string, unknown> = {}): ConfigManager {
  return { get: (key: string) => values[key] } as unknown as ConfigManager;
}

function fakeServiceRegistry(): ServiceRegistry {
  return {
    resolveSecret: async () => undefined,
    get: () => undefined,
  } as unknown as ServiceRegistry;
}

function fakeArtifactStore(): ArtifactStore {
  return { get: () => undefined } as unknown as ArtifactStore;
}

function fakeSecretsManager(secrets: Record<string, string>): Pick<SecretsManager, 'get' | 'getGlobalHome'> {
  return {
    get: async (key: string) => secrets[key] ?? null,
    getGlobalHome: () => '/tmp/does-not-matter',
  } as unknown as Pick<SecretsManager, 'get' | 'getGlobalHome'>;
}

function fakeRouteBindings(): RouteBindingManager {
  return { listBindings: () => [] } as unknown as RouteBindingManager;
}

describe('a delivery path can never be built without a secret resolver', () => {
  test('ChannelDeliveryRouter refuses to build builtin strategies without secretsManager', () => {
    expect(() => new ChannelDeliveryRouter({
      configManager: fakeConfigManager(),
      serviceRegistry: fakeServiceRegistry(),
      artifactStore: fakeArtifactStore(),
    } as never)).toThrow(/secretsManager/);
  });

  test('the refusal names the consequence, not just the missing argument', () => {
    let message = '';
    try {
      new ChannelDeliveryRouter({
        configManager: fakeConfigManager(),
        serviceRegistry: fakeServiceRegistry(),
        artifactStore: fakeArtifactStore(),
      } as never);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('goodvibes://secrets/');
    expect(message.toLowerCase()).toContain('silently fails to send');
  });

  test('ChannelDeliveryRouter builds when secretsManager is supplied', () => {
    expect(() => new ChannelDeliveryRouter({
      configManager: fakeConfigManager(),
      serviceRegistry: fakeServiceRegistry(),
      artifactStore: fakeArtifactStore(),
      secretsManager: fakeSecretsManager({}),
    })).not.toThrow();
  });

  test('AutomationDeliveryManager refuses to build its own router without secretsManager', () => {
    expect(() => new AutomationDeliveryManager({
      configManager: fakeConfigManager(),
      serviceRegistry: fakeServiceRegistry(),
      artifactStore: fakeArtifactStore(),
      routeBindings: fakeRouteBindings(),
    } as never)).toThrow(/secretsManager/);
  });

  test('AutomationDeliveryManager builds when secretsManager is supplied', () => {
    expect(() => new AutomationDeliveryManager({
      configManager: fakeConfigManager(),
      serviceRegistry: fakeServiceRegistry(),
      artifactStore: fakeArtifactStore(),
      routeBindings: fakeRouteBindings(),
      secretsManager: fakeSecretsManager({}),
    })).not.toThrow();
  });

  test('an injected router still satisfies the manager — the guard is only for the builtin path', () => {
    expect(() => new AutomationDeliveryManager({
      routeBindings: fakeRouteBindings(),
      deliveryRouter: {} as never,
    })).not.toThrow();
  });
});

describe('the reference actually resolves once the resolver is present', () => {
  test('the telegram strategy sends the resolved token, never the literal reference', async () => {
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const strategy = createTelegramDeliveryStrategy(
        fakeConfigManager({ 'surfaces.telegram.botToken': SECRET_REF }),
        fakeServiceRegistry(),
        fakeArtifactStore(),
        fakeSecretsManager({ TELEGRAM_BOT_TOKEN: 'resolved-token-value' }),
      );
      await strategy.deliver({
        target: { kind: 'channel', surface: 'telegram', address: '12345' },
        body: 'hello',
        title: 'reply',
        jobId: 'job-1',
        runId: 'run-1',
        includeLinks: false,
      } as never);
    } finally {
      globalThis.fetch = originalFetch;
    }
    const url = calls.find((entry) => entry.includes('api.telegram.org')) ?? '';
    expect(url).toContain('resolved-token-value');
    expect(url).not.toContain('goodvibes');
    expect(url).not.toContain('secrets');
  });
});
