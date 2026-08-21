/**
 * google-chat was the one managed surface whose delivery strategy could not
 * answer a conversation it had received a message from.
 *
 * `createGoogleChatDeliveryStrategy` built the destination from
 * `target.address` / the service registry / config / env only, and read the
 * route binding solely for `threadKey`. A route bound purely by binding, the
 * out-of-the-box state after an inbound message, with no configured webhook,
 * threw `Missing Google Chat webhook URL` and the reply reached nobody.
 *
 * Two strategies in the same file already treat binding metadata as a valid
 * source for the destination: webhook reads `metadata.callbackUrl` and slack
 * reads `metadata.responseUrl`. This proves google-chat now matches them, and
 * that it did not lose the precedence the other sources had.
 */
import { afterEach, describe, expect, test, spyOn, type Mock } from 'bun:test';
import { createGoogleChatDeliveryStrategy } from '../packages/sdk/src/platform/channels/delivery/strategies-core.ts';
import type { ChannelDeliveryRequest } from '../packages/sdk/src/platform/channels/delivery/types.ts';
import type { ConfigManager } from '../packages/sdk/src/platform/config/manager.ts';
import type { ServiceRegistry } from '../packages/sdk/src/platform/config/service-registry.ts';
import type { ArtifactStore } from '../packages/sdk/src/platform/artifacts/index.ts';

const BINDING_WEBHOOK = 'https://chat.googleapis.com/v1/spaces/AAAA-binding/messages?key=k&token=t';
const CONFIG_WEBHOOK = 'https://chat.googleapis.com/v1/spaces/AAAA-config/messages?key=k&token=t';
const ADDRESS_WEBHOOK = 'https://chat.googleapis.com/v1/spaces/AAAA-address/messages?key=k&token=t';

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
 * Bun's `typeof fetch` includes a `preconnect` static method that plain mock
 * functions don't have. Attach a no-op stub so test doubles satisfy the type
 * without pretending to implement real preconnect behavior.
 */
function withPreconnect(
  impl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof globalThis.fetch {
  return Object.assign(impl, {
    preconnect: (_url: string | URL, _options?: { dns?: boolean; tcp?: boolean; http?: boolean; https?: boolean }) => {},
  });
}

function requestWithBindingMetadata(metadata: Record<string, unknown>): ChannelDeliveryRequest {
  return {
    target: { kind: 'surface', surfaceKind: 'google-chat' },
    body: 'hello from the reply pipeline',
    title: 'Automation result',
    jobId: 'job-1',
    runId: 'run-1',
    includeLinks: false,
    binding: {
      id: 'route-1',
      surfaceKind: 'google-chat',
      surfaceId: 'google-chat',
      externalId: 'spaces/AAAA-binding',
      threadId: 'thread-77',
      metadata,
    },
  } as unknown as ChannelDeliveryRequest;
}

describe('google chat delivery resolves the webhook from the route binding', () => {
  let spy: Mock<typeof fetch>;

  afterEach(() => {
    spy?.mockRestore();
  });

  function mockFetch(): void {
    spy = spyOn(globalThis, 'fetch').mockImplementation(
      withPreconnect(async () => new Response(JSON.stringify({ name: 'spaces/AAAA/messages/msg-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })),
    ) as unknown as Mock<typeof fetch>;
  }

  test('no address, no service registry, no config: uses binding.metadata.webhookUrl', async () => {
    mockFetch();
    const strategy = createGoogleChatDeliveryStrategy(
      fakeConfigManager({}),
      fakeServiceRegistry(),
      fakeArtifactStore,
    );

    const result = await strategy.deliver(requestWithBindingMetadata({ webhookUrl: BINDING_WEBHOOK }));

    expect(result.responseId).toBe('spaces/AAAA/messages/msg-1');
    const [target] = spy.mock.calls[0]!;
    expect(String(target)).toBe(BINDING_WEBHOOK);
  });

  test('the thread key from the binding still rides along with it', async () => {
    mockFetch();
    const strategy = createGoogleChatDeliveryStrategy(
      fakeConfigManager({}),
      fakeServiceRegistry(),
      fakeArtifactStore,
    );

    await strategy.deliver(requestWithBindingMetadata({ webhookUrl: BINDING_WEBHOOK }));

    const [, init] = spy.mock.calls[0]!;
    const payload = JSON.parse(String(init?.body)) as { thread?: { threadKey?: string } };
    expect(payload.thread?.threadKey).toBe('thread-77');
  });

  test('binding metadata does not outrank an explicit target address', async () => {
    mockFetch();
    const strategy = createGoogleChatDeliveryStrategy(
      fakeConfigManager({}),
      fakeServiceRegistry(),
      fakeArtifactStore,
    );
    const request = {
      ...requestWithBindingMetadata({ webhookUrl: BINDING_WEBHOOK }),
      target: { kind: 'surface', surfaceKind: 'google-chat', address: ADDRESS_WEBHOOK },
    } as unknown as ChannelDeliveryRequest;

    await strategy.deliver(request);

    expect(String(spy.mock.calls[0]![0])).toBe(ADDRESS_WEBHOOK);
  });

  test('binding metadata outranks the configured default, matching the webhook strategy', async () => {
    mockFetch();
    const strategy = createGoogleChatDeliveryStrategy(
      fakeConfigManager({ 'surfaces.googleChat.webhookUrl': CONFIG_WEBHOOK }),
      fakeServiceRegistry(),
      fakeArtifactStore,
    );

    await strategy.deliver(requestWithBindingMetadata({ webhookUrl: BINDING_WEBHOOK }));

    expect(String(spy.mock.calls[0]![0])).toBe(BINDING_WEBHOOK);
  });

  test('a binding with no webhook metadata still falls through to config', async () => {
    mockFetch();
    const strategy = createGoogleChatDeliveryStrategy(
      fakeConfigManager({ 'surfaces.googleChat.webhookUrl': CONFIG_WEBHOOK }),
      fakeServiceRegistry(),
      fakeArtifactStore,
    );

    await strategy.deliver(requestWithBindingMetadata({}));

    expect(String(spy.mock.calls[0]![0])).toBe(CONFIG_WEBHOOK);
  });

  test('a blank webhookUrl in metadata is not treated as a destination', async () => {
    mockFetch();
    const strategy = createGoogleChatDeliveryStrategy(
      fakeConfigManager({ 'surfaces.googleChat.webhookUrl': CONFIG_WEBHOOK }),
      fakeServiceRegistry(),
      fakeArtifactStore,
    );

    await strategy.deliver(requestWithBindingMetadata({ webhookUrl: '   ' }));

    expect(String(spy.mock.calls[0]![0])).toBe(CONFIG_WEBHOOK);
  });

  test('with nothing anywhere it still reports the missing webhook', async () => {
    mockFetch();
    const strategy = createGoogleChatDeliveryStrategy(
      fakeConfigManager({}),
      fakeServiceRegistry(),
      fakeArtifactStore,
    );

    await expect(strategy.deliver(requestWithBindingMetadata({}))).rejects.toThrow('Missing Google Chat webhook URL');
  });
});
