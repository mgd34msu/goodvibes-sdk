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
import { HomeAssistantConversationRoutes } from '../packages/sdk/src/_internal/platform/daemon/http/homeassistant-routes.js';
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

  test('accepts signed Home Assistant prompts and queues a direct non-WRFC reply', async () => {
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
      trySpawnAgent: (input: {
        readonly provider?: string;
        readonly executionProtocol?: string;
        readonly reviewMode?: string;
        readonly dangerously_disable_wrfc?: boolean;
      }, _label: string, sessionId?: string) => {
        expect(sessionId).toBe('session-ha-1');
        expect(input.executionProtocol).toBe('direct');
        expect(input.reviewMode).toBe('none');
        expect(input.dangerously_disable_wrfc).toBe(true);
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

  test('supports submit-and-wait conversation routes with daemon-owned remote sessions', async () => {
    const sessions = new Map<string, Record<string, unknown>>();
    const agents = new Map<string, AgentRecord>();
    let bindingMetadata: Record<string, unknown> | undefined;
    let createdKind = '';
    let submittedSessionId = '';

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
        patchBinding: async () => null,
      },
      sessionBroker: {
        start: async () => undefined,
        createSession: async (input: Record<string, unknown>) => {
          createdKind = String(input.kind);
          const session = {
            id: 'session-ha-remote',
            kind: input.kind,
            title: 'Home Assistant',
            status: 'active',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            lastActivityAt: Date.now(),
            messageCount: 0,
            pendingInputCount: 0,
            routeIds: ['route-ha-conv'],
            surfaceKinds: ['homeassistant'],
            participants: [],
            metadata: input.metadata ?? {},
          };
          sessions.set(session.id, session);
          return session;
        },
        submitMessage: async (input: { readonly sessionId?: string; readonly body: string }) => {
          submittedSessionId = input.sessionId ?? '';
          return {
            session: sessions.get(submittedSessionId),
            input: { id: 'input-ha-1', routing: {} },
            userMessage: null,
            mode: 'spawn',
            task: input.body,
            created: false,
          };
        },
        bindAgent: async () => undefined,
        getSession: (sessionId: string) => sessions.get(sessionId) as never,
        getMessages: () => [],
        closeSession: async () => null,
      },
      agentManager: {
        getStatus: (agentId: string) => agents.get(agentId) ?? null,
        cancel: () => true,
      },
      parseJsonBody: async (req: Request) => await req.json() as Record<string, unknown>,
      trySpawnAgent: (input, _label, sessionId) => {
        expect(sessionId).toBe('session-ha-remote');
        expect(input.executionProtocol).toBe('direct');
        expect(input.reviewMode).toBe('none');
        expect(input.dangerously_disable_wrfc).toBe(true);
        const record = {
          id: 'agent-ha-remote',
          task: 'turn on the lights',
          template: 'general',
          status: 'completed',
          startedAt: Date.now(),
          completedAt: Date.now(),
          tools: [],
          toolCallCount: 0,
          orchestrationDepth: 0,
          executionProtocol: 'direct',
          reviewMode: 'none',
          communicationLane: 'direct',
          fullOutput: 'The lights are on.',
        } as AgentRecord;
        agents.set(record.id, record);
        return record;
      },
      queueSurfaceReplyFromBinding: () => undefined,
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
    expect(payload.mode).toBe('direct');
    expect((payload.assistant as Record<string, unknown>).text).toBe('The lights are on.');
    expect(payload.sessionId).toBe('session-ha-remote');
    expect(createdKind).toBe('homeassistant-remote');
    expect(bindingMetadata?.messageId).toBe('ha-message-1');
  });

  test('expires idle Home Assistant remote sessions before accepting a later turn', async () => {
    const oldSession = {
      id: 'session-old',
      kind: 'homeassistant-remote',
      title: 'Home Assistant',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
      lastActivityAt: Date.now() - 61_000,
      messageCount: 1,
      pendingInputCount: 0,
      routeIds: ['route-ha-expire'],
      surfaceKinds: ['homeassistant'],
      participants: [],
      metadata: {},
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
          sessionId: 'session-old',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          lastSeenAt: Date.now(),
          metadata: input.metadata ?? {},
        } as AutomationRouteBinding),
        patchBinding: async () => null,
      },
      sessionBroker: {
        start: async () => undefined,
        createSession: async () => {
          const session = { ...oldSession, id: 'session-new', lastActivityAt: Date.now() };
          sessions.set(session.id, session);
          return session;
        },
        submitMessage: async () => ({
          session: sessions.get('session-new'),
          input: { id: 'input-ha-2', routing: {} },
          userMessage: null,
          mode: 'spawn',
          task: 'hello',
          created: false,
        }),
        bindAgent: async () => undefined,
        getSession: (sessionId: string) => sessions.get(sessionId) as never,
        getMessages: () => [],
        closeSession: async (sessionId: string) => {
          closedSessionId = sessionId;
          return sessions.get(sessionId) as never;
        },
      },
      agentManager: {
        getStatus: () => null,
        cancel: () => true,
      },
      parseJsonBody: async (req: Request) => await req.json() as Record<string, unknown>,
      trySpawnAgent: (input) => {
        expect(input.executionProtocol).toBe('direct');
        expect(input.reviewMode).toBe('none');
        expect(input.dangerously_disable_wrfc).toBe(true);
        return {
          id: 'agent-ha-2',
          status: 'running',
          task: 'hello',
          startedAt: Date.now(),
          tools: [],
        } as AgentRecord;
      },
      queueSurfaceReplyFromBinding: () => undefined,
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
