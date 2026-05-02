import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
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
import { HomeAssistantConversationRoutes } from '../packages/sdk/src/_internal/platform/daemon/http/homeassistant-routes.js';
import { HomeAssistantIntegration } from '../packages/sdk/src/_internal/platform/integrations/homeassistant.js';

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

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
    expect(manifest.capabilities).not.toContain('agent-task-ingress');
    expect(manifest.capabilities).toContain('daemon-agent-tools');
    expect(manifest.recommendedServices.map((service) => service.name)).not.toContain('goodvibes.run_agent');
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
      agentId: 'agent-ha-1',
      sessionId: 'session-ha-1',
      includeLinks: false,
      binding: {
        id: 'binding-1',
        surfaceKind: 'homeassistant',
        surfaceId: 'ha-main',
        externalId: 'kitchen',
        channelId: 'area.kitchen',
        metadata: {
          messageId: 'ha-msg-1',
          conversationId: 'kitchen',
        },
      },
      metadata: {
        pending: {
          messageId: 'ha-msg-1',
          conversationId: 'kitchen',
        },
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
    expect(eventPayload.sessionId).toBe('session-ha-1');
    expect(eventPayload.replyToMessageId).toBe('ha-msg-1');
    expect(eventPayload.conversationId).toBe('kitchen');
  });

  test('accepts signed Home Assistant prompts and uses isolated remote chat', async () => {
    let chatBody = '';
    let chatProvider = '';
    let chatModel = '';
    let chatTools: readonly string[] | undefined;

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
      authorizeSurfaceIngress: async () => ({
        allowed: true,
        reason: 'allowed',
        policy: {},
      } as ChannelPolicyDecision),
      parseSurfaceControlCommand: () => null,
      performSurfaceControlCommand: async () => 'ok',
      performInteractiveSurfaceAction: async () => 'ok',
      postHomeAssistantChatMessage: async (input: {
        readonly body: string;
        readonly providerId?: string;
        readonly modelId?: string;
        readonly tools?: readonly string[];
        readonly publishEvent?: boolean;
      }) => {
        chatBody = input.body;
        chatProvider = input.providerId ?? '';
        chatModel = input.modelId ?? '';
        chatTools = input.tools;
        expect(input.publishEvent).toBe(true);
        return {
          sessionId: 'ha-chat-session-1',
          routeId: 'route-ha-1',
          messageId: 'ha-message-1',
          assistantMessageId: 'ha-assistant-1',
          response: 'The kitchen lights are on.',
          delivered: true,
        };
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
    expect(payload.queued).toBe(false);
    expect(payload.agentId).toBeUndefined();
    expect(payload.sessionId).toBe('ha-chat-session-1');
    expect(chatBody).toBe('turn on the kitchen lights');
    expect(chatProvider).toBe('openai');
    expect(chatModel).toBe('gpt-5.5');
    expect(chatTools).toEqual(['homeassistant_state']);
  });

  test('supports submit-and-wait conversation routes with daemon-owned isolated chat sessions', async () => {
    const sessions = new Map<string, Record<string, unknown>>();
    let bindingMetadata: Record<string, unknown> | undefined;
    let patchedMetadata: Record<string, unknown> | undefined;
    let postedContent = '';
    const chatManager = {
      init: async () => undefined,
      getSession: (sessionId: string) => sessions.get(sessionId) ?? null,
      createSession: (input: Record<string, unknown>) => {
        const session = {
          id: 'ha-chat-session-remote',
          kind: 'companion-chat',
          title: String(input.title),
          provider: input.provider ?? null,
          model: input.model ?? null,
          systemPrompt: input.systemPrompt ?? null,
          status: 'active',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          closedAt: null,
          messageCount: 0,
        };
        sessions.set(session.id, session);
        return session;
      },
      updateSession: (sessionId: string, input: Record<string, unknown>) => {
        const session = { ...(sessions.get(sessionId) ?? {}), ...input, updatedAt: Date.now() };
        sessions.set(sessionId, session);
        return session;
      },
      postMessageAndWaitForReply: async (_sessionId: string, content: string) => {
        postedContent = content;
        return {
          messageId: 'chat-user-message-1',
          assistantMessageId: 'chat-assistant-message-1',
          response: 'The lights are on.',
        };
      },
      postMessage: async () => 'chat-user-message-1',
      closeSession: () => null,
    };

    const routes = new HomeAssistantConversationRoutes({
      configManager: {
        get(key: string): unknown {
          const values: Record<string, unknown> = {
            'surfaces.homeassistant.enabled': true,
            'surfaces.homeassistant.defaultConversationId': 'goodvibes',
            'surfaces.homeassistant.eventType': 'goodvibes_message',
            'surfaces.homeassistant.remoteSessionTtlMs': 20 * 60_000,
          };
          return values[key];
        },
      },
      routeBindings: {
        start: async () => undefined,
        upsertBinding: async (input: Partial<AutomationRouteBinding>) => {
          bindingMetadata = input.metadata;
          return {
            id: 'route-ha-conv',
            kind: 'channel',
            surfaceKind: 'homeassistant',
            surfaceId: String(input.surfaceId),
            externalId: String(input.externalId),
            channelId: String(input.channelId),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            lastSeenAt: Date.now(),
            metadata: input.metadata ?? {},
          } as AutomationRouteBinding;
        },
        patchBinding: async (_id: string, input: { readonly metadata?: Record<string, unknown> }) => {
          patchedMetadata = input.metadata;
          return null;
        },
      },
      chatManager,
      parseJsonBody: async (req: Request) => await req.json() as Record<string, unknown>,
      resolveDefaultProviderModel: () => ({ provider: 'openai', model: 'gpt-5.5' }),
    } as ConstructorParameters<typeof HomeAssistantConversationRoutes>[0]);

    const response = await routes.handle(new Request('http://daemon.local/api/homeassistant/conversation', {
      method: 'POST',
      body: JSON.stringify({
        message: 'turn on the lights',
        conversationId: 'assist-home',
        messageId: 'ha-message-1',
      }),
    }));
    const payload = await response!.json() as Record<string, unknown>;

    expect(response!.status).toBe(200);
    expect(payload.status).toBe('completed');
    expect(payload.mode).toBe('remote-chat');
    expect((payload.assistant as Record<string, unknown>).text).toBe('The lights are on.');
    expect(payload.sessionId).toBe('ha-chat-session-remote');
    expect(payload.agentId).toBeUndefined();
    expect(bindingMetadata?.messageId).toBe('ha-message-1');
    expect(patchedMetadata?.homeAssistantChatSessionId).toBe('ha-chat-session-remote');
    expect(postedContent).toContain('turn on the lights');
    expect(String(sessions.get('ha-chat-session-remote')?.systemPrompt)).toContain('Use Home Assistant tools');
    expect(String(sessions.get('ha-chat-session-remote')?.systemPrompt)).toContain('Do not emit JSON summaries');
  });

  test('expires idle Home Assistant remote sessions before accepting a later turn', async () => {
    const oldSession = {
      id: 'session-old',
      kind: 'companion-chat',
      title: 'Home Assistant',
      provider: 'openai',
      model: 'gpt-5.5',
      systemPrompt: null,
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
      closedAt: null,
      messageCount: 1,
    };
    const sessions = new Map<string, Record<string, unknown>>([['session-old', oldSession]]);
    let closedSessionId = '';

    const routes = new HomeAssistantConversationRoutes({
      configManager: {
        get(key: string): unknown {
          const values: Record<string, unknown> = {
            'surfaces.homeassistant.enabled': true,
            'surfaces.homeassistant.defaultConversationId': 'goodvibes',
            'surfaces.homeassistant.remoteSessionTtlMs': 60_000,
          };
          return values[key];
        },
      },
      routeBindings: {
        start: async () => undefined,
        upsertBinding: async (input: Partial<AutomationRouteBinding>) => ({
          id: 'route-ha-expire',
          kind: 'channel',
          surfaceKind: 'homeassistant',
          surfaceId: String(input.surfaceId),
          externalId: String(input.externalId),
          channelId: String(input.channelId),
          createdAt: Date.now(),
          updatedAt: Date.now(),
          lastSeenAt: Date.now(),
          metadata: {
            ...(input.metadata ?? {}),
            homeAssistantChatSessionId: 'session-old',
          },
        } as AutomationRouteBinding),
        patchBinding: async () => null,
      },
      chatManager: {
        init: async () => undefined,
        getSession: (sessionId: string) => sessions.get(sessionId) as never,
        createSession: (input: Record<string, unknown>) => {
          const session = {
            ...oldSession,
            id: 'session-new',
            provider: input.provider ?? null,
            model: input.model ?? null,
            systemPrompt: input.systemPrompt ?? null,
            updatedAt: Date.now(),
          };
          sessions.set(session.id, session);
          return session;
        },
        updateSession: (sessionId: string, input: Record<string, unknown>) => {
          const session = { ...(sessions.get(sessionId) ?? {}), ...input, updatedAt: Date.now() };
          sessions.set(sessionId, session);
          return session;
        },
        postMessage: async () => 'chat-user-message-2',
        postMessageAndWaitForReply: async () => ({ messageId: 'chat-user-message-2', response: 'hello' }),
        closeSession: (sessionId: string) => {
          closedSessionId = sessionId;
          return sessions.get(sessionId) as never;
        },
      },
      parseJsonBody: async (req: Request) => await req.json() as Record<string, unknown>,
      resolveDefaultProviderModel: () => ({ provider: 'openai', model: 'gpt-5.5' }),
    } as ConstructorParameters<typeof HomeAssistantConversationRoutes>[0]);

    const response = await routes.handle(new Request('http://daemon.local/api/homeassistant/conversation', {
      method: 'POST',
      body: JSON.stringify({ message: 'hello', conversationId: 'assist-home', wait: false }),
    }));
    const payload = await response!.json() as Record<string, unknown>;

    expect(response!.status).toBe(202);
    expect(payload.sessionExpired).toBe(true);
    expect(payload.newSession).toBe(true);
    expect(payload.sessionId).toBe('session-new');
    expect(closedSessionId).toBe('session-old');
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
