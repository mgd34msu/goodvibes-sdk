import type { DaemonControlRouteHandlers } from './context.js';
import type { RuntimeEventDomain } from '@pellux/goodvibes-contracts';
import { jsonErrorResponse } from './error-response.js';
import type { AuthenticatedPrincipal } from './http-policy.js';
import {
  createRouteBodySchema,
  createRouteBodySchemaRegistry,
  serializableJsonResponse,
  type JsonRecord,
} from './route-helpers.js';

interface GatewayMethodDescriptorLike {
  readonly access?: 'public' | 'authenticated' | 'admin' | 'remote-peer' | undefined;
}

interface GatewayMethodCatalogLike {
  list(options?: Record<string, unknown>): unknown;
  listEvents(options?: Record<string, unknown>): unknown;
  get(methodId: string): GatewayMethodDescriptorLike | null | undefined;
}

interface ControlPlaneGatewayLike {
  getSnapshot(): unknown;
  renderWebUi(): Response;
  listRecentEvents(limit: number): unknown;
  listSurfaceMessages(): unknown;
  listClients(): unknown;
  createEventStream(
    req: Request,
    input: Record<string, unknown>,
  ): Response | Promise<Response>;
}

interface ControlRouteContext {
  readonly authToken: string | null;
  readonly version: string;
  readonly sessionCookieName: string;
  readonly controlPlaneGateway: ControlPlaneGatewayLike;
  readonly extractAuthToken: (req: Request) => string;
  readonly resolveAuthenticatedPrincipal: (req: Request) => AuthenticatedPrincipal | null;
  readonly gatewayMethods: GatewayMethodCatalogLike;
  readonly getOperatorContract: () => unknown;
  readonly inspectInboundTls: (surface: 'controlPlane' | 'httpListener') => unknown;
  readonly inspectOutboundTls: () => unknown;
  readonly invokeGatewayMethodCall: (input: {
    readonly authToken: string;
    readonly methodId: string;
    readonly query?: Record<string, unknown> | undefined;
    readonly body?: unknown | undefined;
    readonly context?: {
      readonly principalId?: string | undefined;
      readonly principalKind?: 'user' | 'bot' | 'service' | 'token' | 'remote-peer' | undefined;
      readonly admin?: boolean | undefined;
      readonly scopes?: readonly string[] | undefined;
      readonly clientKind?: string | undefined;
    };
  }) => Promise<{ status: number; ok: boolean; body: unknown }>;
  readonly parseOptionalJsonBody: (req: Request) => Promise<JsonRecord | null | Response>;
  readonly requireAdmin: (req: Request) => Response | null;
  readonly requireAuthenticatedSession: (req: Request) => { username: string; roles: readonly string[] } | null;
}

type GatewayInvokeBody = {
  readonly query?: Record<string, unknown> | undefined;
  readonly body?: unknown | undefined;
};

const controlBodySchemas = createRouteBodySchemaRegistry({
  gatewayInvoke: createRouteBodySchema<GatewayInvokeBody>('POST /api/control/gateway-methods/:methodId/invoke', (body) => {
    const query = body.query && typeof body.query === 'object' && !Array.isArray(body.query)
      ? body.query as Record<string, unknown>
      : undefined;
    if (!Object.hasOwn(body, 'body')) {
      return jsonErrorResponse(
        { error: 'Missing required field: body. Expected envelope shape: { query?, body }' },
        { status: 400 },
      );
    }
    return {
      ...(query ? { query } : {}),
      body: body.body,
    };
  }),
});

export function createDaemonControlRouteHandlers(
  context: ControlRouteContext,
  request: Request,
): DaemonControlRouteHandlers {
  const hasAuthorizationHeader = Boolean(request.headers.get('authorization')?.trim());
  const sessionCookiePresent = (request.headers.get('cookie') ?? '')
    .split(';')
    .some((segment) => segment.trim().startsWith(`${context.sessionCookieName}=`));

  return {
    getStatus: () => Response.json({
      status: 'running',
      version: context.version,
      network: {
        controlPlane: context.inspectInboundTls('controlPlane'),
        httpListener: context.inspectInboundTls('httpListener'),
        outbound: context.inspectOutboundTls(),
      },
    }),
    getCurrentAuth: (req) => {
      const token = context.extractAuthToken(req).trim();
      const principal = context.resolveAuthenticatedPrincipal(req);
      const session = principal?.principalKind === 'user'
        ? context.requireAuthenticatedSession(req)
        : null;
      const authMode = principal
        ? (principal.principalKind === 'token' && principal.principalId === 'shared-token' ? 'shared-token' : 'session')
        : token.length > 0
          ? 'invalid'
          : 'anonymous';
      const snapshot = {
        authenticated: principal !== null,
        authMode,
        tokenPresent: token.length > 0,
        authorizationHeaderPresent: hasAuthorizationHeader,
        sessionCookiePresent,
        principalId: principal?.principalId ?? null,
        principalKind: principal?.principalKind ?? null,
        admin: principal?.admin ?? false,
        scopes: principal?.scopes ?? [],
        roles: session?.roles ?? [],
      };

      return Response.json(snapshot);
    },
    getControlPlaneSnapshot: () => Response.json(context.controlPlaneGateway.getSnapshot()),
    getOperatorContract: () => serializableJsonResponse({ contract: context.getOperatorContract() }),
    getControlPlaneWeb: () => context.controlPlaneGateway.renderWebUi(),
    getControlPlaneRecentEvents: (limit) => Response.json({ events: context.controlPlaneGateway.listRecentEvents(limit) }),
    getControlPlaneMessages: () => Response.json({ messages: context.controlPlaneGateway.listSurfaceMessages() }),
    getControlPlaneClients: () => Response.json({ clients: context.controlPlaneGateway.listClients() }),
    getGatewayMethods: (url) => {
      const category = url.searchParams.get('category') ?? undefined;
      const source = url.searchParams.get('source');
      return serializableJsonResponse({
        methods: context.gatewayMethods.list({
          ...(category ? { category } : {}),
          ...(source === 'builtin' || source === 'plugin' ? { source } : {}),
        }),
      });
    },
    getGatewayEvents: (url) => {
      const category = url.searchParams.get('category') ?? undefined;
      const source = url.searchParams.get('source');
      const domain = url.searchParams.get('domain') ?? undefined;
      return serializableJsonResponse({
        events: context.gatewayMethods.listEvents({
          ...(category ? { category } : {}),
          ...(source === 'builtin' || source === 'plugin' ? { source } : {}),
          ...(domain ? { domain: domain as RuntimeEventDomain } : {}),
        }),
      });
    },
    getGatewayMethod: (methodId) => {
      const method = context.gatewayMethods.get(methodId);
      return method
        ? serializableJsonResponse({ method })
        : jsonErrorResponse({ error: 'Unknown gateway method' }, { status: 404 });
    },
    invokeGatewayMethod: async (methodId, req) => {
      const descriptor = context.gatewayMethods.get(methodId);
      if (!descriptor) return jsonErrorResponse({ error: 'Unknown gateway method' }, { status: 404 });
      const access = descriptor.access ?? 'admin';
      if (access === 'admin' || access === 'remote-peer') {
        const admin = context.requireAdmin(req);
        if (admin) return admin;
      }
      const principal = context.resolveAuthenticatedPrincipal(req);
      if (access === 'authenticated' && !principal) {
        return jsonErrorResponse({ error: 'Unauthorized' }, { status: 401 });
      }
      const parsedBody = await context.parseOptionalJsonBody(req);
      if (parsedBody instanceof Response) return parsedBody;
      const payload = controlBodySchemas.gatewayInvoke.parse(parsedBody ?? {});
      if (payload instanceof Response) return payload;
      const response = await context.invokeGatewayMethodCall({
        authToken: context.extractAuthToken(req),
        methodId,
        query: payload.query,
        body: payload.body,
        context: {
          principalId: principal?.principalId,
          principalKind: principal?.principalKind,
          admin: principal?.admin,
          scopes: principal?.scopes,
          clientKind: 'web',
        },
      });
      return Response.json(response.body, { status: response.status });
    },
    createControlPlaneEventStream: (req) => {
      const url = new URL(req.url);
      const rawDomains = url.searchParams.get('domains');
      const domains = (rawDomains ? rawDomains.split(',').map((value) => value.trim()).filter(Boolean) : []) as RuntimeEventDomain[];
      const principal = context.resolveAuthenticatedPrincipal(req);
      if (!principal) return jsonErrorResponse({ error: 'Unauthorized' }, { status: 401 });
      return context.controlPlaneGateway.createEventStream(req, {
        clientKind: 'web',
        transport: 'sse',
        domains,
        principalId: principal.principalId,
        principalKind: principal.principalKind,
        scopes: principal.scopes,
      });
    },
  };
}
