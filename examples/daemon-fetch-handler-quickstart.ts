/**
 * Compose a minimal fetch handler from daemon route-handler factories.
 */
import {
  createDaemonControlRouteHandlers,
  createDaemonTelemetryRouteHandlers,
  jsonErrorResponse,
} from '@pellux/goodvibes-sdk/daemon';
import { getOperatorContract } from '@pellux/goodvibes-sdk/contracts';
import sdkPackage from '@pellux/goodvibes-sdk/package.json' with { type: 'json' };

const controlHandlers = createDaemonControlRouteHandlers({
  authToken: null,
  version: sdkPackage.version,
  sessionCookieName: 'goodvibes_session',
  controlPlaneGateway: {
    getSnapshot: () => ({ ok: true }),
    renderWebUi: () => new Response('<html><body>GoodVibes</body></html>', {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }),
    listRecentEvents: () => [],
    listSurfaceMessages: () => [],
    listClients: () => [],
    // The quickstart returns one SSE event; daemon hosts can keep this stream open.
    createEventStream: () => new Response('event: ready\ndata: {"ok":true}\n\n', {
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
    }),
  },
  login: async () => Response.json({
    error: 'This quickstart does not implement username/password login',
  }, { status: 404 }),
  extractAuthToken: () => '',
  resolveAuthenticatedPrincipal: () => ({
    principalId: 'quickstart-admin',
    principalKind: 'user',
    admin: true,
    scopes: ['*'],
  }),
  gatewayMethods: {
    list: () => [],
    listEvents: () => [],
    get: () => null,
  },
  getOperatorContract,
  invokeGatewayMethodCall: async () => ({
    status: 404,
    ok: false,
    // Gateway method response shape, not a GoodVibesSdkError envelope.
    body: { error: 'No gateway methods are registered in this quickstart' },
  }),
  parseOptionalJsonBody: async (request) => {
    // Parse request JSON in your daemon host; this quickstart keeps the body optional.
    const text = await request.text();
    return text.trim() ? JSON.parse(text) as Record<string, unknown> : null;
  },
  requireAdmin: () => null,
  requireAuthenticatedSession: () => null,
});

const telemetryHandlers = createDaemonTelemetryRouteHandlers({
  telemetryApi: null,
  ingestSink: null,
  resolveAuthenticatedPrincipal: () => null,
});

export async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/api/control-plane/status') {
    return await controlHandlers.getStatus(request);
  }
  if (request.method === 'GET' && url.pathname === '/api/v1/telemetry') {
    return await telemetryHandlers.getTelemetrySnapshot(request);
  }
  return jsonErrorResponse(`Route not found: ${url.pathname}`, {
    status: 404,
    source: 'runtime',
  });
}
