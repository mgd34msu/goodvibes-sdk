import {
  createDaemonControlRouteHandlers,
  createDaemonTelemetryRouteHandlers,
} from '@goodvibes/daemon-sdk';

const controlHandlers = createDaemonControlRouteHandlers({
  authToken: null,
  version: '0.18.2',
  sessionCookieName: 'goodvibes_session',
  controlPlaneGateway: {
    getSnapshot: () => ({ ok: true }),
    renderWebUi: () => new Response('<html><body>GoodVibes</body></html>', {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }),
    listRecentEvents: () => [],
    listSurfaceMessages: () => [],
    listClients: () => [],
    createEventStream: () => new Response('not implemented', { status: 501 }),
  },
  extractAuthToken: () => '',
  resolveAuthenticatedPrincipal: () => null,
  gatewayMethods: {
    list: () => [],
    listEvents: () => [],
    get: () => null,
  },
  getOperatorContract: () => ({ version: 1 }),
  inspectInboundTls: () => ({ mode: 'off' }),
  inspectOutboundTls: () => ({ mode: 'system' }),
  invokeGatewayMethodCall: async () => ({ status: 501, ok: false, body: { error: 'not implemented' } }),
  parseOptionalJsonBody: async () => null,
  requireAdmin: () => null,
  requireAuthenticatedSession: () => null,
}, new Request('http://127.0.0.1/api/control-plane/status'));

const telemetryHandlers = createDaemonTelemetryRouteHandlers({
  telemetryApi: null,
  resolveAuthenticatedPrincipal: () => null,
});

export async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/api/control-plane/status') {
    return await controlHandlers.getStatus();
  }
  if (request.method === 'GET' && url.pathname === '/api/v1/telemetry') {
    return await telemetryHandlers.getTelemetrySnapshot(request);
  }
  return Response.json({ error: 'Not found' }, { status: 404 });
}
