import type { DaemonControlRouteHandlers, GatewayRestVerbInvocation } from './context.js';
import { isRuntimeEventDomain, type RuntimeEventDomain } from '@pellux/goodvibes-contracts';
import { SDKErrorCodes } from '@pellux/goodvibes-errors';
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
  readonly login?: ((req: Request) => Promise<Response> | Response) | undefined;
  /**
   * Undelivered daemon receipts ("updated from X to Y at HH:MM",
   * "restarted after a crash at HH:MM"). Invoked ONLY when a /status reader
   * explicitly opts in with `?receipts=consume`; the provider marks the
   * returned receipts delivered, so consumption stays exactly-once across
   * consuming readers. A plain /status read (identity probe, keepalive,
   * version poll) neither receives nor consumes receipts.
   */
  readonly collectReceipts?: (() => readonly { id: string; text: string; at: number }[]) | undefined;
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
): DaemonControlRouteHandlers {
  return {
    postLogin: (req) => context.login
      ? context.login(req)
      : jsonErrorResponse({ error: 'Login is not configured for this daemon host.' }, { status: 404 }),
    getStatus: (req) => {
      const principal = context.resolveAuthenticatedPrincipal(req);
      if (!principal) return jsonErrorResponse({ error: 'Unauthorized' }, { status: 401 });
      // Receipt consumption is explicit: only a reader that passes
      // ?receipts=consume receives undelivered receipts (and marks them
      // delivered — exactly once). Every other /status read is
      // receipt-neutral, so an identity probe or keepalive that parses only
      // status/version can never eat a receipt before a rendering surface.
      const consumeReceipts = new URL(req.url).searchParams.get('receipts') === 'consume';
      return Response.json({
        status: 'running',
        version: context.version,
        ...(consumeReceipts && context.collectReceipts ? { receipts: context.collectReceipts() } : {}),
      });
    },
    getCurrentAuth: (req) => {
      const token = context.extractAuthToken(req).trim();
      const principal = context.resolveAuthenticatedPrincipal(req);
      const session = principal?.principalKind === 'user'
        ? context.requireAuthenticatedSession(req)
        : null;
      const authorizationHeaderPresent = Boolean(req.headers.get('authorization')?.trim());
      const sessionCookiePresent = (req.headers.get('cookie') ?? '')
        .split(';')
        .some((segment) => segment.trim().startsWith(`${context.sessionCookieName}=`));
      const authMode = principal
        ? (principal.principalKind === 'token' && principal.principalId === 'shared-token' ? 'shared-token' : 'session')
        : token.length > 0
          ? 'invalid'
          : 'anonymous';
      const snapshot = {
        authenticated: principal !== null,
        authMode,
        tokenPresent: token.length > 0,
        authorizationHeaderPresent,
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
        // Machine-readable: METHOD_NOT_FOUND distinguishes "this id isn't cataloged at
        // all" from NOT_INVOKABLE ("cataloged but refuses dispatch") so a capability
        // probe (e.g. webui's isMethodUnavailableError) never has to string-match
        // "Unknown gateway method".
        : jsonErrorResponse({ error: 'Unknown gateway method', code: SDKErrorCodes.METHOD_NOT_FOUND }, { status: 404 });
    },
    invokeGatewayMethod: async (methodId, req) => {
      const descriptor = context.gatewayMethods.get(methodId);
      if (!descriptor) {
        return jsonErrorResponse({ error: 'Unknown gateway method', code: SDKErrorCodes.METHOD_NOT_FOUND }, { status: 404 });
      }
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
    invokeGatewayRestVerb: async (invocation: GatewayRestVerbInvocation) => {
      // REST parity for a handler-backed gateway verb reached by its advertised
      // path (gateway-rest-routes.ts). Not a second implementation: resolve the
      // principal, fold the path params into BOTH query and body (so query-reading
      // GET/DELETE verbs and body-schema-validated POST verbs both see them), and
      // delegate to the same invokeGatewayMethodCall the methodId-invoke endpoint
      // above uses — identical access gate, identical in-process handler.
      const { methodId, req, params } = invocation;
      const descriptor = context.gatewayMethods.get(methodId);
      const access = descriptor?.access ?? 'admin';
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
      const bodyRecord = parsedBody && typeof parsedBody === 'object' && !Array.isArray(parsedBody)
        ? parsedBody
        : {};
      const query: Record<string, unknown> = { ...params };
      for (const [key, value] of new URL(req.url).searchParams) query[key] = value;
      const response = await context.invokeGatewayMethodCall({
        authToken: context.extractAuthToken(req),
        methodId,
        query,
        body: { ...params, ...bodyRecord },
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
      // filter unknown domains at the SDK boundary instead of casting unchecked input.
      const domains = (rawDomains ? rawDomains.split(',').map((v) => v.trim()).filter(Boolean) : [])
        .filter(isRuntimeEventDomain) as RuntimeEventDomain[];
      const principal = context.resolveAuthenticatedPrincipal(req);
      if (!principal) return jsonErrorResponse({ error: 'Unauthorized' }, { status: 401 });
      return context.controlPlaneGateway.createEventStream(req, {
        clientKind: 'web',
        transport: 'sse',
        domains,
        principalId: principal.principalId,
        principalKind: principal.principalKind,
        scopes: principal.scopes,
        // Carry admin so the per-channel scope filter (e.g. read:sessions on
        // session-update) honors the single-admin-token collapse.
        admin: principal.admin,
      });
    },
  };
}
