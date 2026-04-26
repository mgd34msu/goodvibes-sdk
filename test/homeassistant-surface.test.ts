import { afterEach, describe, expect, test } from 'bun:test';
import type { ArtifactStore } from '../packages/sdk/src/_internal/platform/artifacts/index.js';
import { handleHomeAssistantSurfaceWebhook } from '../packages/sdk/src/_internal/platform/adapters/homeassistant/index.js';
import type { SurfaceAdapterContext } from '../packages/sdk/src/_internal/platform/adapters/types.js';
import type { AutomationRouteBinding } from '../packages/sdk/src/_internal/platform/automation/routes.js';
import type { ChannelPolicyDecision } from '../packages/sdk/src/_internal/platform/channels/types.js';
import { createHomeAssistantDeliveryStrategy } from '../packages/sdk/src/_internal/platform/channels/delivery/strategies-core.js';
import type { ChannelDeliveryRequest } from '../packages/sdk/src/_internal/platform/channels/delivery/types.js';
import {
  buildHomeAssistantManifest,
  listHomeAssistantTools,
} from '../packages/sdk/src/_internal/platform/channels/builtin/homeassistant.js';
import type { ConfigManager } from '../packages/sdk/src/_internal/platform/config/manager.js';
import type { ServiceRegistry } from '../packages/sdk/src/_internal/platform/config/service-registry.js';
import { HomeAssistantIntegration } from '../packages/sdk/src/_internal/platform/integrations/homeassistant.js';
import type { AgentRecord } from '../packages/sdk/src/_internal/platform/tools/agent/index.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('Home Assistant integration client', () => {
  test('uses HA REST API with bearer auth for state reads and service calls', async () => {
    const calls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({ url, init });
      const parsed = new URL(url);
      if (parsed.pathname === '/api/states') {
        return Response.json([{ entity_id: 'light.kitchen', state: 'on', attributes: { friendly_name: 'Kitchen' } }]);
      }
      if (parsed.pathname === '/api/services/light/turn_on') {
        return Response.json({ changed_states: [], service_response: { ok: true } });
      }
      return Response.json({ error: 'unexpected request' }, { status: 404 });
    }) as typeof fetch;

    const client = new HomeAssistantIntegration({
      baseUrl: 'http://homeassistant.local:8123/',
      accessToken: 'ha-token',
    });

    const states = await client.listStates();
    const result = await client.callService({
      domain: 'light',
      service: 'turn_on',
      serviceData: { entity_id: 'light.kitchen' },
      returnResponse: true,
    });

    expect(states).toHaveLength(1);
    expect(states[0]?.entity_id).toBe('light.kitchen');
    expect(new URL(calls[0]!.url).pathname).toBe('/api/states');
    expect((calls[0]!.init?.headers as Record<string, string>).Authorization).toBe('Bearer ha-token');
    expect(new URL(calls[1]!.url).pathname).toBe('/api/services/light/turn_on');
    expect(new URL(calls[1]!.url).search).toBe('?return_response');
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ entity_id: 'light.kitchen' });
    expect(result).toEqual({ changed_states: [], service_response: { ok: true } });
  });
});

describe('Home Assistant channel surface', () => {
  test('exposes a manifest and direct HA tools for the custom integration', () => {
    const config = {
      get(key: string): unknown {
        const values: Record<string, unknown> = {
          'controlPlane.baseUrl': 'http://daemon.local:8877',
          'web.publicBaseUrl': '',
          'surfaces.homeassistant.eventType': 'goodvibes_message',
          'surfaces.homeassistant.deviceId': 'daemon-main',
          'surfaces.homeassistant.deviceName': 'GoodVibes Main',
        };
        return values[key];
      },
    };

    const manifest = buildHomeAssistantManifest({ configManager: config });
    const tools = listHomeAssistantTools();

    expect(manifest.surface).toBe('homeassistant');
    expect(manifest.daemon.baseUrl).toBe('http://daemon.local:8877');
    expect(manifest.daemon.endpoints.webhook).toBe('/webhook/homeassistant');
    expect(manifest.capabilities).toContain('daemon-agent-tools');
    expect(manifest.events.outboundEventType).toBe('goodvibes_message');
    expect(tools.map((tool) => tool.name)).toContain('homeassistant_call_service');
    expect(tools.map((tool) => tool.name)).toContain('homeassistant_render_template');
  });

  test('delivers daemon output into the HA event bus', async () => {
    const calls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({ url, init });
      return Response.json({ message: 'Event goodvibes_message fired.' });
    }) as typeof fetch;

    const configManager = {
      get(key: string): unknown {
        const values: Record<string, unknown> = {
          'surfaces.homeassistant.instanceUrl': 'http://ha.local:8123',
          'surfaces.homeassistant.accessToken': 'ha-token',
          'surfaces.homeassistant.eventType': 'goodvibes_message',
          'controlPlane.baseUrl': '',
          'web.publicBaseUrl': '',
        };
        return values[key];
      },
    } as unknown as ConfigManager;
    const serviceRegistry = {
      get: () => undefined,
      resolveSecret: async () => null,
    } as unknown as ServiceRegistry;
    const strategy = createHomeAssistantDeliveryStrategy(
      configManager,
      serviceRegistry,
      {} as ArtifactStore,
    );
    const request: ChannelDeliveryRequest = {
      target: { kind: 'surface', surfaceKind: 'homeassistant', label: 'Kitchen' },
      body: 'The lights are on.',
      title: 'GoodVibes',
      jobId: 'job-1',
      runId: 'run-1',
      status: 'completed',
      includeLinks: false,
      binding: {
        id: 'binding-1',
        surfaceKind: 'homeassistant',
        surfaceId: 'ha-main',
        externalId: 'kitchen',
        channelId: 'area.kitchen',
        metadata: {},
      },
    };

    const result = await strategy.deliver(request);

    expect(result.responseId).toBe('goodvibes_message');
    expect(new URL(calls[0]!.url).pathname).toBe('/api/events/goodvibes_message');
    expect((calls[0]!.init?.headers as Record<string, string>).Authorization).toBe('Bearer ha-token');
    const eventPayload = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
    expect(eventPayload.source).toBe('goodvibes');
    expect(eventPayload.body).toBe('The lights are on.');
    expect(eventPayload.externalId).toBe('kitchen');
  });

  test('accepts signed Home Assistant prompts and queues an agent reply', async () => {
    const binding: AutomationRouteBinding = {
      id: 'route-ha-1',
      kind: 'channel',
      surfaceKind: 'homeassistant',
      surfaceId: 'ha-main',
      externalId: 'home',
      channelId: 'home',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastSeenAt: Date.now(),
      metadata: {},
    };
    let submittedBody = '';
    let queuedAgentId = '';
    let spawnProvider = '';

    const context = {
      serviceRegistry: {
        get: () => undefined,
        resolveSecret: async () => null,
      },
      configManager: {
        get(key: string): unknown {
          const values: Record<string, unknown> = {
            'surfaces.homeassistant.enabled': true,
            'surfaces.homeassistant.webhookSecret': 'shared-secret',
            'surfaces.homeassistant.defaultConversationId': 'goodvibes',
          };
          return values[key];
        },
      },
      routeBindings: {
        start: async () => undefined,
        upsertBinding: async (input: Partial<AutomationRouteBinding>) => {
          expect(input.surfaceKind).toBe('homeassistant');
          expect(input.externalId).toBe('home');
          return binding;
        },
      },
      sessionBroker: {
        submitMessage: async (input: { readonly body: string; readonly surfaceKind: string; readonly routing?: { readonly providerId?: string; readonly modelId?: string; readonly tools?: readonly string[] } }) => {
          submittedBody = input.body;
          expect(input.surfaceKind).toBe('homeassistant');
          expect(input.routing?.providerId).toBe('openai');
          expect(input.routing?.modelId).toBe('gpt-5.5');
          expect(input.routing?.tools).toEqual(['homeassistant_state']);
          return {
            session: {
              id: 'session-ha-1',
              kind: 'companion-task',
              title: 'Home Assistant',
              status: 'active',
              createdAt: Date.now(),
              updatedAt: Date.now(),
              lastActivityAt: Date.now(),
              messageCount: 1,
              pendingInputCount: 1,
              routeIds: [binding.id],
              surfaceKinds: ['homeassistant'],
              participants: [],
              metadata: {},
            },
            userMessage: {
              id: 'message-1',
              sessionId: 'session-ha-1',
              role: 'user',
              body: input.body,
              createdAt: Date.now(),
              metadata: {},
            },
            input: {
              id: 'input-1',
              sessionId: 'session-ha-1',
              intent: 'submit',
              state: 'queued',
              correlationId: 'input-1',
              body: input.body,
              createdAt: Date.now(),
              updatedAt: Date.now(),
              metadata: {},
            },
            intent: 'submit',
            mode: 'spawn',
            state: 'queued',
            task: 'Continue the Home Assistant session.',
            created: true,
          };
        },
        bindAgent: async () => undefined,
      },
      authorizeSurfaceIngress: async () => ({
        allowed: true,
        reason: 'allowed',
        policy: {},
      } as ChannelPolicyDecision),
      parseSurfaceControlCommand: () => null,
      performSurfaceControlCommand: async () => 'ok',
      performInteractiveSurfaceAction: async () => 'ok',
      trySpawnAgent: (input: { readonly provider?: string }, _label: string, sessionId?: string) => {
        expect(sessionId).toBe('session-ha-1');
        spawnProvider = input.provider ?? '';
        return {
          id: 'agent-ha-1',
          status: 'pending',
          task: 'Continue the Home Assistant session.',
          startedAt: Date.now(),
          tools: [],
        } as AgentRecord;
      },
      queueSurfaceReplyFromBinding: (_binding: AutomationRouteBinding | undefined, input: { readonly agentId: string }) => {
        queuedAgentId = input.agentId;
      },
    } as unknown as SurfaceAdapterContext;

    const response = await handleHomeAssistantSurfaceWebhook(new Request('http://daemon.local/webhook/homeassistant', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goodvibes-homeassistant-secret': 'shared-secret',
      },
      body: JSON.stringify({
        message: 'turn on the kitchen lights',
        conversationId: 'home',
        providerId: 'openai',
        modelId: 'gpt-5.5',
        tools: ['homeassistant_state'],
      }),
    }), context);
    const payload = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload.queued).toBe(true);
    expect(payload.agentId).toBe('agent-ha-1');
    expect(submittedBody).toBe('turn on the kitchen lights');
    expect(spawnProvider).toBe('openai');
    expect(queuedAgentId).toBe('agent-ha-1');
  });

  test('rejects Home Assistant webhook requests without the shared secret', async () => {
    const context = {
      serviceRegistry: {
        get: () => undefined,
        resolveSecret: async () => null,
      },
      configManager: {
        get(key: string): unknown {
          const values: Record<string, unknown> = {
            'surfaces.homeassistant.enabled': true,
            'surfaces.homeassistant.webhookSecret': 'shared-secret',
          };
          return values[key];
        },
      },
    } as unknown as SurfaceAdapterContext;

    const response = await handleHomeAssistantSurfaceWebhook(new Request('http://daemon.local/webhook/homeassistant', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    }), context);

    expect(response.status).toBe(401);
  });
});
