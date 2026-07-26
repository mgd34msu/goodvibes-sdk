/**
 * channel-delivery-binding-fallback.test.ts
 *
 * A recent working-tree change taught the builtin provider directory
 * (lookupBuiltinProviderDirectory) route-binding fallbacks, but the delivery
 * strategies that actually send the reply were not updated to match: several
 * of them read only request.target.address and ignored request.binding
 * entirely, so a reply arriving on a route bound purely by binding (no
 * explicit target.address) either went to the wrong destination or threw.
 *
 * Telegram (strategies-core.ts) already had the correct resolution chain:
 *   target.address -> binding.channelId -> binding.externalId -> config default
 *
 * These tests prove the same chain now holds for ntfy, slack, and discord,
 * and that discord's bot token is resolved through resolveSecretInput the
 * same way slack's and telegram's already are (a raw "goodvibes://secrets/..."
 * config value must never be sent as the literal token).
 */
import { afterEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import * as fetchWithTimeoutModule from '../packages/sdk/src/platform/utils/fetch-with-timeout.ts';
import {
  createDiscordDeliveryStrategy,
  createNtfyDeliveryStrategy,
  createSlackDeliveryStrategy,
} from '../packages/sdk/src/platform/channels/delivery/strategies-core.ts';
import type { ChannelDeliveryRequest } from '../packages/sdk/src/platform/channels/delivery/types.ts';
import type { ConfigManager } from '../packages/sdk/src/platform/config/manager.ts';
import type { ServiceRegistry } from '../packages/sdk/src/platform/config/service-registry.ts';
import type { ArtifactStore } from '../packages/sdk/src/platform/artifacts/index.ts';
import type { SecretsManager } from '../packages/sdk/src/platform/config/secrets.ts';

function fakeConfigManager(values: Record<string, unknown> = {}): ConfigManager {
  return { get: (key: string) => values[key] } as unknown as ConfigManager;
}

function fakeServiceRegistry(secrets: Record<string, string | undefined> = {}): ServiceRegistry {
  return {
    resolveSecret: async (service: string, key: string) => secrets[`${service}:${key}`],
    get: () => undefined,
  } as unknown as ServiceRegistry;
}

const fakeArtifactStore = {} as unknown as ArtifactStore;

/**
 * A resolver that holds no secrets. Every strategy that can read a
 * `goodvibes://secrets/...` credential now requires one — a composition that
 * omits it fails at construction rather than silently dropping replies on the
 * surfaces that use secret references. Cases below that supply a real value
 * build their own.
 */
function emptySecretsManager(): Pick<SecretsManager, 'get' | 'getGlobalHome'> {
  return {
    get: async () => null,
    getGlobalHome: () => '/home/test',
  } as unknown as Pick<SecretsManager, 'get' | 'getGlobalHome'>;
}

function baseRequest(overrides: Partial<ChannelDeliveryRequest>): ChannelDeliveryRequest {
  return {
    target: { kind: 'surface' },
    body: 'hello from the reply pipeline',
    title: 'Automation result',
    jobId: 'job-1',
    runId: 'run-1',
    includeLinks: false,
    ...overrides,
  };
}

describe('ntfy delivery resolves the topic from the binding (item 1)', () => {
  let spy: Mock<typeof fetchWithTimeoutModule.fetchWithTimeout>;

  afterEach(() => {
    spy.mockRestore();
  });

  test('no target.address: falls back to binding.channelId', async () => {
    spy = spyOn(fetchWithTimeoutModule, 'fetchWithTimeout').mockImplementation(
      async () => new Response(null, { status: 200 }),
    ) as Mock<typeof fetchWithTimeoutModule.fetchWithTimeout>;

    const strategy = createNtfyDeliveryStrategy(fakeConfigManager({}), fakeServiceRegistry(), fakeArtifactStore);
    const request = baseRequest({
      target: { kind: 'surface', surfaceKind: 'ntfy' },
      binding: {
        id: 'route-1',
        surfaceKind: 'ntfy',
        surfaceId: 'ntfy',
        externalId: 'binding-external-topic',
        channelId: 'binding-channel-topic',
        metadata: {},
      },
    });

    const result = await strategy.deliver(request);

    expect(result.responseId).toBe('binding-channel-topic');
    const [target] = spy.mock.calls[0]!;
    expect(String(target)).toContain('/binding-channel-topic');
  });

  test('no target.address and no channelId: falls back to binding.externalId', async () => {
    spy = spyOn(fetchWithTimeoutModule, 'fetchWithTimeout').mockImplementation(
      async () => new Response(null, { status: 200 }),
    ) as Mock<typeof fetchWithTimeoutModule.fetchWithTimeout>;

    const strategy = createNtfyDeliveryStrategy(fakeConfigManager({}), fakeServiceRegistry(), fakeArtifactStore);
    const request = baseRequest({
      target: { kind: 'surface', surfaceKind: 'ntfy' },
      binding: {
        id: 'route-1',
        surfaceKind: 'ntfy',
        surfaceId: 'ntfy',
        externalId: 'binding-external-topic',
        metadata: {},
      },
    });

    const result = await strategy.deliver(request);

    expect(result.responseId).toBe('binding-external-topic');
  });

  test('no target.address and no binding at all: falls back to the configured default topic', async () => {
    spy = spyOn(fetchWithTimeoutModule, 'fetchWithTimeout').mockImplementation(
      async () => new Response(null, { status: 200 }),
    ) as Mock<typeof fetchWithTimeoutModule.fetchWithTimeout>;

    const strategy = createNtfyDeliveryStrategy(
      fakeConfigManager({ 'surfaces.ntfy.topic': 'configured-default-topic' }),
      fakeServiceRegistry(),
      fakeArtifactStore,
    );
    const request = baseRequest({ target: { kind: 'surface', surfaceKind: 'ntfy' } });

    const result = await strategy.deliver(request);

    expect(result.responseId).toBe('configured-default-topic');
  });

  test('nothing resolves at all: throws the honest "Missing ntfy topic" error, never a silent send', async () => {
    spy = spyOn(fetchWithTimeoutModule, 'fetchWithTimeout').mockImplementation(
      async () => new Response(null, { status: 200 }),
    ) as Mock<typeof fetchWithTimeoutModule.fetchWithTimeout>;

    const strategy = createNtfyDeliveryStrategy(fakeConfigManager({}), fakeServiceRegistry(), fakeArtifactStore);
    const request = baseRequest({ target: { kind: 'surface', surfaceKind: 'ntfy' } });

    await expect(strategy.deliver(request)).rejects.toThrow('Missing ntfy topic');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('slack delivery resolves the channel from the binding (item 2)', () => {
  let spy: Mock<typeof fetchWithTimeoutModule.fetchWithTimeout>;

  afterEach(() => {
    spy.mockRestore();
  });

  test('no target.address: falls back to binding.channelId instead of throwing on a bare postWebhook', async () => {
    spy = spyOn(fetchWithTimeoutModule, 'fetchWithTimeout').mockImplementation(
      async () => new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as Mock<typeof fetchWithTimeoutModule.fetchWithTimeout>;

    const strategy = createSlackDeliveryStrategy(
      fakeServiceRegistry(),
      fakeConfigManager({ 'surfaces.slack.botToken': 'xoxb-fake-token' }),
      fakeArtifactStore,
      emptySecretsManager(),
    );
    const request = baseRequest({
      target: { kind: 'surface', surfaceKind: 'slack' },
      binding: {
        id: 'route-1',
        surfaceKind: 'slack',
        surfaceId: 'slack',
        externalId: 'C-external',
        channelId: 'C-binding-channel',
        metadata: {},
      },
    });

    const result = await strategy.deliver(request);

    expect(result.responseId).toBe('C-binding-channel');
    const [url, init] = spy.mock.calls[0]!;
    expect(String(url)).toBe('https://slack.com/api/chat.postMessage');
    const body = JSON.parse(String(init?.body)) as { channel: string };
    expect(body.channel).toBe('C-binding-channel');
  });

  test('no target.address and no binding: falls back to the configured default channel', async () => {
    spy = spyOn(fetchWithTimeoutModule, 'fetchWithTimeout').mockImplementation(
      async () => new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as Mock<typeof fetchWithTimeoutModule.fetchWithTimeout>;

    const strategy = createSlackDeliveryStrategy(
      fakeServiceRegistry(),
      fakeConfigManager({
        'surfaces.slack.botToken': 'xoxb-fake-token',
        'surfaces.slack.defaultChannel': 'C-configured-default',
      }),
      fakeArtifactStore,
      emptySecretsManager(),
    );
    const request = baseRequest({ target: { kind: 'surface', surfaceKind: 'slack' } });

    const result = await strategy.deliver(request);

    expect(result.responseId).toBe('C-configured-default');
  });
});

describe('discord delivery resolves the channel from the binding (item 3)', () => {
  let spy: Mock<typeof fetchWithTimeoutModule.instrumentedFetch>;
  const SNOWFLAKE = '123456789012345678';

  afterEach(() => {
    spy.mockRestore();
  });

  test('no target.address: falls back to binding.channelId instead of throwing on a bare postWebhook', async () => {
    spy = spyOn(fetchWithTimeoutModule, 'instrumentedFetch').mockImplementation(
      async () => new Response(null, { status: 200 }),
    ) as Mock<typeof fetchWithTimeoutModule.instrumentedFetch>;

    const strategy = createDiscordDeliveryStrategy(
      fakeServiceRegistry(),
      fakeConfigManager({ 'surfaces.discord.botToken': 'discord-fake-token' }),
      fakeArtifactStore,
      emptySecretsManager(),
    );
    const request = baseRequest({
      target: { kind: 'surface', surfaceKind: 'discord' },
      binding: {
        id: 'route-1',
        surfaceKind: 'discord',
        surfaceId: 'discord',
        externalId: 'external-id',
        channelId: SNOWFLAKE,
        metadata: {},
      },
    });

    const result = await strategy.deliver(request);

    expect(result.responseId).toBe(SNOWFLAKE);
    const [url, init] = spy.mock.calls[0]!;
    expect(String(url)).toBe(`https://discord.com/api/v10/channels/${SNOWFLAKE}/messages`);
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bot discord-fake-token');
  });

  test('no target.address and no binding: falls back to the configured default channel id', async () => {
    spy = spyOn(fetchWithTimeoutModule, 'instrumentedFetch').mockImplementation(
      async () => new Response(null, { status: 200 }),
    ) as Mock<typeof fetchWithTimeoutModule.instrumentedFetch>;

    const strategy = createDiscordDeliveryStrategy(
      fakeServiceRegistry(),
      fakeConfigManager({
        'surfaces.discord.botToken': 'discord-fake-token',
        'surfaces.discord.defaultChannelId': SNOWFLAKE,
      }),
      fakeArtifactStore,
      emptySecretsManager(),
    );
    const request = baseRequest({ target: { kind: 'surface', surfaceKind: 'discord' } });

    const result = await strategy.deliver(request);

    expect(result.responseId).toBe(SNOWFLAKE);
  });

  test('bot token stored as a goodvibes:// secret reference is resolved through resolveSecretInput, never sent literally (item 4)', async () => {
    spy = spyOn(fetchWithTimeoutModule, 'instrumentedFetch').mockImplementation(
      async () => new Response(null, { status: 200 }),
    ) as Mock<typeof fetchWithTimeoutModule.instrumentedFetch>;

    const secretsManager = {
      get: async (key: string) => (key === 'discord-bot-token' ? 'resolved-real-token' : null),
      getGlobalHome: () => '/home/test',
    } as unknown as Pick<SecretsManager, 'get' | 'getGlobalHome'>;

    const strategy = createDiscordDeliveryStrategy(
      fakeServiceRegistry(),
      fakeConfigManager({ 'surfaces.discord.botToken': 'goodvibes://secrets/goodvibes/discord-bot-token' }),
      fakeArtifactStore,
      secretsManager,
    );
    const request = baseRequest({
      target: { kind: 'surface', surfaceKind: 'discord' },
      binding: {
        id: 'route-1',
        surfaceKind: 'discord',
        surfaceId: 'discord',
        externalId: 'external-id',
        channelId: SNOWFLAKE,
        metadata: {},
      },
    });

    await strategy.deliver(request);

    const [, init] = spy.mock.calls[0]!;
    const authHeader = (init?.headers as Record<string, string>).Authorization;
    expect(authHeader).toBe('Bot resolved-real-token');
    expect(authHeader).not.toContain('goodvibes://');
  });
});
