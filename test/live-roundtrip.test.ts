import { afterEach, describe, expect, test } from 'bun:test';
import {
  createDaemonControlRouteHandlers,
  dispatchDaemonApiRoutes,
} from '../packages/daemon-sdk/src/index.js';
import {
  createGoodVibesSdk,
  createMemoryTokenStore,
} from '../packages/sdk/src/index.js';
import { withTestTimeout } from './_helpers/test-timeout.js';
import sdkPackage from '../packages/sdk/package.json' with { type: 'json' };

const activeServers: Array<{ stop: () => void }> = [];

afterEach(() => {
  while (activeServers.length > 0) activeServers.pop()?.stop();
});

function createRoundtripServer(): ReturnType<typeof Bun.serve> {
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname === '/login' && req.method === 'POST') {
        const body = await req.json() as Record<string, unknown>;
        if (body.username === 'alice' && body.password === 'secret') {
          return Response.json({
            authenticated: true,
            token: 'token-login',
            username: 'alice',
            expiresAt: Date.now() + 60_000,
          });
        }
        return Response.json({ error: 'invalid credentials' }, { status: 401 });
      }

      const handlers = createDaemonControlRouteHandlers({
        authToken: null,
        version: sdkPackage.version,
        sessionCookieName: 'goodvibes_session',
        controlPlaneGateway: {
          getSnapshot: () => ({
            server: {
              enabled: true,
              host: '127.0.0.1',
              port: 0,
              streamingMode: 'both',
              sessionTtlMs: 60_000,
            },
            totals: {
              clients: 0,
              activeClients: 0,
              surfaceMessages: 0,
              recentEvents: 0,
              requests: 0,
              errors: 0,
            },
            clients: [],
            messages: [],
            recentEvents: [],
          }),
          renderWebUi: () => new Response('<html></html>'),
          listRecentEvents: () => [],
          listSurfaceMessages: () => [],
          listClients: () => [],
          createEventStream: () => {
            const encoder = new TextEncoder();
            return new Response(new ReadableStream({
              start(controller) {
                controller.enqueue(encoder.encode('event: ready\ndata: {"ok":true}\n\n'));
                controller.enqueue(encoder.encode('id: evt-1\nevent: agents\ndata: {"type":"AGENT_COMPLETED","payload":{"agentId":"agent-1"}}\n\n'));
              },
              cancel() {},
            }), {
              headers: {
                'content-type': 'text/event-stream',
              },
            });
          },
        },
        extractAuthToken: (request) => request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '',
        resolveAuthenticatedPrincipal: (request) => {
          const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
          if (token === 'token-login') {
            return {
              principalId: 'alice',
              principalKind: 'token',
              admin: false,
              scopes: ['read:control-plane'],
            };
          }
          return null;
        },
        gatewayMethods: {
          list: () => [],
          listEvents: () => [],
          get: (methodId) => methodId.startsWith('control.')
            ? { dangerous: false, access: 'authenticated' }
            : null,
        },
        getOperatorContract: () => ({ version: 1 }),
        inspectInboundTls: () => ({ mode: 'off' }),
        inspectOutboundTls: () => ({ mode: 'system' }),
        invokeGatewayMethodCall: async (input) => {
          if (input.methodId === 'control.auth.current') {
            return {
              status: 200,
              ok: true,
              body: {
                authenticated: input.authToken === 'token-login',
                authMode: input.authToken === 'token-login' ? 'shared-token' : 'anonymous',
                tokenPresent: input.authToken === 'token-login',
                authorizationHeaderPresent: input.authToken === 'token-login',
                sessionCookiePresent: false,
                principalId: input.authToken === 'token-login' ? 'alice' : null,
                principalKind: input.authToken === 'token-login' ? 'token' : null,
                admin: false,
                scopes: input.authToken === 'token-login' ? ['read:control-plane'] : [],
                roles: [],
              },
            };
          }
          if (input.methodId === 'control.snapshot') {
            return {
              status: 200,
              ok: true,
              body: {
                server: {
                  enabled: true,
                  host: '127.0.0.1',
                  port: 0,
                  streamingMode: 'both',
                  sessionTtlMs: 60_000,
                },
                totals: {
                  clients: 0,
                  activeClients: 0,
                  surfaceMessages: 0,
                  recentEvents: 0,
                  requests: 0,
                  errors: 0,
                },
                clients: [],
                messages: [],
                recentEvents: [],
              },
            };
          }
          return {
            status: 404,
            ok: false,
            body: { error: `Unknown method ${input.methodId}` },
          };
        },
        parseOptionalJsonBody: async (request) => {
          const text = await request.text();
          return text.trim() ? JSON.parse(text) as Record<string, unknown> : null;
        },
        requireAdmin: () => null,
        requireAuthenticatedSession: () => ({ username: 'alice', roles: ['user'] }),
      }, req);

      const response = await dispatchDaemonApiRoutes(req, handlers as never);
      return response ?? Response.json({ error: 'not found' }, { status: 404 });
    },
  });
  activeServers.push(server);
  return server;
}

function createRoundtripSdk(server: ReturnType<typeof Bun.serve>) {
  const tokenStore = createMemoryTokenStore();
  const sdk = createGoodVibesSdk({
    baseUrl: server.url.origin,
    tokenStore,
    realtime: {
      sseReconnect: {
        enabled: false,
      },
    },
  });
  return { sdk, tokenStore };
}

describe('sdk live roundtrip', () => {
  test('round-trips login and authenticated control calls through daemon routes', async () => {
    const { sdk, tokenStore } = createRoundtripSdk(createRoundtripServer());

    const login = await sdk.auth.login({ username: 'alice', password: 'secret' });
    expect(login.token).toBe('token-login');
    expect(await tokenStore.getToken()).toBe('token-login');

    const current = await sdk.auth.current();
    expect(current).toMatchObject({
      authenticated: true,
      principalId: 'alice',
      principalKind: 'token',
    });

    const snapshot = await sdk.operator.control.snapshot();
    expect(snapshot.server.enabled).toBe(true);
    expect(snapshot.totals.clients).toBe(0);
    expect(snapshot.clients).toEqual([]);
  });

  test('streams SSE runtime events through daemon routes', async () => {
    const { sdk } = createRoundtripSdk(createRoundtripServer());
    await sdk.auth.login({ username: 'alice', password: 'secret' });

    let unsubscribe: (() => void) | undefined;
    const event = await withTestTimeout(new Promise<unknown>((resolve) => {
      unsubscribe = sdk.realtime.viaSse().agents.on('AGENT_COMPLETED', (payload) => {
        unsubscribe?.();
        resolve(payload);
      });
    }), 1_000, 'Timed out waiting for AGENT_COMPLETED SSE event.');
    unsubscribe?.();

    expect(event).toEqual({ agentId: 'agent-1' });
  });
});
