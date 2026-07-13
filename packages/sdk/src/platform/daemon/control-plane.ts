import type { AgentManager } from '../tools/agent/index.js';
import type { UserAuthManager } from '../security/user-auth.js';
import { pairingPrincipalId } from '../pairing/pairing-token-store.js';
import {
  authenticateOperatorRequest,
  authenticateOperatorToken,
  extractOperatorAuthToken,
  isOperatorAdmin,
  type PairingTokenAuthenticator,
} from '../security/http-auth.js';
import type { ControlPlaneGateway, SharedSessionBroker } from '../control-plane/index.js';
import type { GatewayMethodCatalog, GatewayMethodDescriptor } from '../control-plane/index.js';
import type { RuntimeEventDomain } from '../runtime/events/index.js';
import { isRuntimeEventDomain } from '../runtime/events/index.js';
import type { DistributedRuntimeManager } from '../runtime/remote/index.js';
import { extractForwardedClientIp } from '../runtime/network/index.js';
import { resolveGatewayPathTemplate } from './helpers.js';
import { summarizeError } from '../utils/error-display.js';
import { validateInvocationInput } from '../control-plane/invoke-input-validation.js';
import { isGatewayVerbError } from '../control-plane/routes/gateway-verb-error.js';
import { SDKErrorCodes } from '@pellux/goodvibes-errors';
import {
  buildMissingScopeBody,
  resolveAuthenticatedPrincipal,
  type AuthenticatedPrincipal,
} from './http-policy.js';

export interface ControlPlaneWebSocketData {
  readonly channel: 'control-plane';
  authToken: string;
  principalId: string | null;
  principalKind: 'user' | 'bot' | 'service' | 'token' | null;
  admin: boolean;
  scopes: readonly string[];
  readonly domains: readonly RuntimeEventDomain[];
  readonly clientKind:
    | 'tui'
    | 'web'
    | 'slack'
    | 'discord'
    | 'ntfy'
    | 'webhook'
    | 'telegram'
    | 'google-chat'
    | 'signal'
    | 'whatsapp'
    | 'telephony'
    | 'imessage'
    | 'msteams'
    | 'bluebubbles'
    | 'mattermost'
    | 'matrix'
    | 'daemon';
  readonly remoteAddress?: string | undefined;
  clientId?: string | undefined;
  authenticated: boolean;
}

export interface DaemonControlPlaneContext {
  readonly authToken: () => string | null;
  /**
   * Per-pairing token authenticator. When present, a named per-device token is
   * checked (and its revocation honored) before the legacy shared token; absent
   * ⇒ only the shared token / user sessions authenticate.
   */
  readonly pairingTokens?: PairingTokenAuthenticator | undefined;
  readonly userAuth: UserAuthManager;
  readonly agentManager: AgentManager;
  readonly controlPlaneGateway: ControlPlaneGateway;
  readonly gatewayMethods: GatewayMethodCatalog;
  readonly distributedRuntime: DistributedRuntimeManager;
  readonly host: string;
  readonly port: number;
  readonly trustProxyEnabled: () => boolean;
  readonly dispatchApiRoutes: (req: Request) => Promise<Response | null>;
  readonly parseJsonBody: (req: Request) => Promise<Record<string, unknown> | Response>;
  readonly requireAuthenticatedSession: (req: Request) => { username: string; roles: readonly string[] } | null;
}

interface UpgradeCapableServer {
  upgrade(req: Request, options?: { data?: unknown }): boolean;
}

export class DaemonControlPlaneHelper {
  constructor(private readonly context: DaemonControlPlaneContext) {}

  private trustProxyEnabled(): boolean {
    return this.context.trustProxyEnabled();
  }

  extractAuthToken(req: Request): string {
    return extractOperatorAuthToken(req);
  }

  /** The shared operator-auth context: shared token + per-pairing tokens + user sessions. */
  private authContext(): {
    readonly sharedToken: string | null;
    readonly userAuth: UserAuthManager;
    readonly pairingTokens: PairingTokenAuthenticator | undefined;
  } {
    return {
      sharedToken: this.context.authToken(),
      userAuth: this.context.userAuth,
      pairingTokens: this.context.pairingTokens,
    };
  }

  checkAuth(req: Request): boolean {
    return authenticateOperatorRequest(req, this.authContext()) !== null;
  }

  requireAuthenticatedSession(req: Request): { username: string; roles: readonly string[] } | null {
    const authenticated = authenticateOperatorRequest(req, this.authContext());
    if (!authenticated || authenticated.kind !== 'session') return null;
    return {
      username: authenticated.username,
      roles: authenticated.roles,
    };
  }

  requireAdmin(req: Request): Response | null {
    const authenticated = authenticateOperatorRequest(req, this.authContext());
    if (!authenticated) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (!isOperatorAdmin(authenticated)) {
      return Response.json({ error: 'Admin role required' }, { status: 403 });
    }
    return null;
  }

  async requireRemotePeer(req: Request, scope?: string): Promise<import('../runtime/remote/index.js').DistributedPeerAuth | Response> {
    const token = this.extractAuthToken(req);
    const auth = await this.context.distributedRuntime.authenticatePeerToken(
      token,
      extractForwardedClientIp(req, this.trustProxyEnabled()),
    );
    if (!auth) {
      return Response.json({ error: 'Unauthorized remote peer' }, { status: 401 });
    }
    if (scope && !auth.token.scopes.includes(scope)) {
      return Response.json({ error: `Remote peer token missing required scope: ${scope}` }, { status: 403 });
    }
    return auth;
  }

  describeAuthenticatedPrincipal(token: string): AuthenticatedPrincipal | null {
    const authenticated = authenticateOperatorToken(token, this.authContext());
    if (!authenticated) return null;
    if (authenticated.kind === 'shared-token') {
      return {
        principalId: 'shared-token',
        principalKind: 'token',
        admin: true,
        scopes: this.getGrantedGatewayScopes(true),
      };
    }
    if (authenticated.kind === 'pairing-token') {
      // A paired device is a distinct, per-token principal (`pairing:<id>`) with
      // full operator authority — so step-up credentials key per token and a
      // revoked device drops out cleanly.
      return {
        principalId: pairingPrincipalId(authenticated.tokenId),
        principalKind: 'token',
        admin: true,
        scopes: this.getGrantedGatewayScopes(true),
      };
    }
    const admin = authenticated.roles.includes('admin');
    return {
      principalId: authenticated.username,
      principalKind: 'user',
      admin,
      scopes: this.getGrantedGatewayScopes(admin),
    };
  }

  getGrantedGatewayScopes(includeWrite: boolean): readonly string[] {
    const scopes = new Set(this.context.gatewayMethods.getAllScopes({ includeWrite }));
    scopes.add('read:events');
    scopes.add('read:control-plane');
    scopes.add('read:telemetry');
    if (includeWrite) scopes.add('read:telemetry-sensitive');
    if (includeWrite) scopes.add('write:control-plane');
    return [...scopes].sort();
  }

  validateGatewayInvocation(
    descriptor: GatewayMethodDescriptor,
    context?: {
      readonly principalKind?: 'user' | 'bot' | 'service' | 'token' | 'remote-peer' | undefined;
      readonly scopes?: readonly string[] | undefined;
      readonly admin?: boolean | undefined;
    },
  ): { status: number; ok: false; body: Record<string, unknown> } | null {
    if (descriptor.invokable === false) {
      return {
        status: 400,
        ok: false,
        body: {
          error: `Gateway method is cataloged but not invokable through method dispatch: ${descriptor.id}`,
          // Machine-readable, following the SDKErrorCodes.SESSION_CLOSED precedent
          // (session-broker.ts) — consumers match on `code`, never on the message
          // string. See the `invokable` field's doc comment (method-catalog-shared.ts)
          // for what this status does and does not mean.
          code: SDKErrorCodes.NOT_INVOKABLE,
        },
      };
    }
    if (descriptor.access === 'public') {
      return null;
    }
    if (descriptor.access === 'admin' && !context?.admin) {
      return {
        status: 403,
        ok: false,
        body: { error: `Gateway method requires admin access: ${descriptor.id}` },
      };
    }
    if (descriptor.access === 'remote-peer' && context?.principalKind !== 'remote-peer') {
      return {
        status: 403,
        ok: false,
        body: { error: `Gateway method requires a remote-peer principal: ${descriptor.id}` },
      };
    }
    const body = buildMissingScopeBody(descriptor.id, descriptor.scopes, context?.scopes);
    if (body) {
      return {
        status: 403,
        ok: false,
        body,
      };
    }
    return null;
  }

  tryUpgradeControlPlaneWebSocket(
    req: Request,
    server: UpgradeCapableServer,
  ): Response | 'upgraded' | null {
    const url = new URL(req.url);
    if (url.pathname !== '/api/control-plane/ws' || req.method !== 'GET') {
      return null;
    }
    const token = this.extractAuthToken(req);
    const principal = resolveAuthenticatedPrincipal(req, this);
    if (!principal) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const rawDomains = url.searchParams.get('domains');
    const domains = parseRuntimeDomains(rawDomains);
    if (domains instanceof Response) return domains;
    const requestedKind = url.searchParams.get('clientKind');
    const clientKind = requestedKind === 'tui'
      || requestedKind === 'web'
      || requestedKind === 'slack'
      || requestedKind === 'discord'
      || requestedKind === 'ntfy'
      || requestedKind === 'daemon'
      || requestedKind === 'webhook'
      ? requestedKind
      : 'web';
    const upgraded = server.upgrade(req, {
      data: {
        channel: 'control-plane',
        authToken: token,
        principalId: principal?.principalId ?? null,
        principalKind: principal?.principalKind ?? null,
        scopes: principal?.scopes ?? [],
        admin: principal?.admin ?? false,
        domains,
        clientKind,
        remoteAddress: extractForwardedClientIp(req, this.trustProxyEnabled()),
        authenticated: true,
      } satisfies ControlPlaneWebSocketData,
    });
    return upgraded ? 'upgraded' : Response.json({ error: 'WebSocket upgrade failed' }, { status: 400 });
  }

  handleControlPlaneWebSocketOpen(ws: {
    data: ControlPlaneWebSocketData;
    send(message: string): void;
  }): void {
    const connection = this.context.controlPlaneGateway.openWebSocketClient({
      clientKind: ws.data.clientKind,
      transport: 'ws',
      domains: ws.data.authenticated ? ws.data.domains : [],
      ...(ws.data.principalId ? { principalId: ws.data.principalId } : {}),
      ...(ws.data.principalKind ? { principalKind: ws.data.principalKind } : {}),
      ...(ws.data.scopes.length > 0 ? { scopes: ws.data.scopes } : {}),
      remoteAddress: ws.data.remoteAddress,
    }, (event, payload) => {
      ws.send(JSON.stringify({ type: 'event', event, payload }));
    });
    ws.data.clientId = connection.clientId;
  }

  async handleControlPlaneWebSocketMessage(
    ws: {
      data: ControlPlaneWebSocketData;
      send(message: string): void;
    },
    message: string | Buffer | ArrayBuffer | Uint8Array,
  ): Promise<void> {
    const clientId = ws.data.clientId;
    if (!clientId) return;
    const text = typeof message === 'string'
      ? message
      : message instanceof Uint8Array
        ? new TextDecoder().decode(message)
        : message instanceof ArrayBuffer
          ? new TextDecoder().decode(new Uint8Array(message))
          : Buffer.from(message).toString('utf8');
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(text) as Record<string, unknown>;
    } catch {
      ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON frame' }));
      return;
    }

    this.context.controlPlaneGateway.touchWebSocketClient(clientId, {
      lastFrameType: typeof frame.type === 'string' ? frame.type : 'unknown',
    });

    if (frame.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
      return;
    }

    if (frame.type === 'auth') {
      const token = typeof frame.token === 'string' ? frame.token : ws.data.authToken;
      const principal = this.describeAuthenticatedPrincipal(token);
      if (!principal) {
        ws.send(JSON.stringify({ type: 'auth', ok: false, error: 'Unauthorized' }));
        return;
      }
      this.context.controlPlaneGateway.authenticateClient(clientId, {
        principalId: principal.principalId,
        principalKind: principal.principalKind,
        scopes: principal.scopes,
        ...(typeof frame.label === 'string' ? { label: frame.label } : {}),
        ...(Array.isArray(frame.capabilities) ? { capabilities: frame.capabilities.filter((value): value is string => typeof value === 'string') } : {}),
      });
      if (Array.isArray(frame.domains)) {
        const domains = normalizeFrameDomains(frame.domains);
        if (domains instanceof Response) {
          ws.send(JSON.stringify({ type: 'auth', ok: false, error: 'Invalid runtime event domain' }));
          return;
        }
        this.context.controlPlaneGateway.subscribeWebSocketClient(
          clientId,
          domains,
        );
      }
      ws.data.authToken = token;
      ws.data.principalId = principal.principalId;
      ws.data.principalKind = principal.principalKind;
      ws.data.scopes = principal.scopes;
      ws.data.admin = principal.admin;
      ws.data.authenticated = true;
      ws.send(JSON.stringify({ type: 'auth', ok: true, clientId, principalId: principal.principalId }));
      return;
    }

    if (frame.type === 'subscribe') {
      if (!ws.data.authenticated) {
        ws.send(JSON.stringify({ type: 'error', error: 'Authenticate before subscribing' }));
        return;
      }
      const domains = Array.isArray(frame.domains)
        ? normalizeFrameDomains(frame.domains)
        : [];
      if (domains instanceof Response) {
        ws.send(JSON.stringify({ type: 'error', error: 'Invalid runtime event domain' }));
        return;
      }
      this.context.controlPlaneGateway.subscribeWebSocketClient(clientId, domains);
      ws.send(JSON.stringify({ type: 'subscribed', clientId, domains }));
      return;
    }

    if (frame.type === 'unsubscribe') {
      const domains = Array.isArray(frame.domains)
        ? normalizeFrameDomains(frame.domains)
        : undefined;
      if (domains instanceof Response) {
        ws.send(JSON.stringify({ type: 'error', error: 'Invalid runtime event domain' }));
        return;
      }
      this.context.controlPlaneGateway.unsubscribeWebSocketClient(clientId, domains);
      ws.send(JSON.stringify({ type: 'unsubscribed', clientId, domains: domains ?? [] }));
      return;
    }

    if (frame.type === 'call') {
      if (!ws.data.authenticated || !ws.data.principalId || !ws.data.principalKind) {
        ws.send(JSON.stringify({ type: 'error', error: 'Authenticate before invoking methods' }));
        return;
      }
      const id = typeof frame.id === 'string' ? frame.id : `call-${Date.now()}`;
      const methodId = typeof frame.methodId === 'string' ? frame.methodId : undefined;
      const response = methodId
        ? await this.invokeGatewayMethodCall({
            authToken: ws.data.authToken,
            methodId,
            query: typeof frame.query === 'object' && frame.query !== null ? frame.query as Record<string, unknown> : undefined,
            body: frame.body,
            context: {
              principalId: ws.data.principalId,
              principalKind: ws.data.principalKind,
              admin: ws.data.admin,
              scopes: ws.data.scopes,
              clientKind: ws.data.clientKind,
            },
          })
        : await this.invokeWebSocketControlPlaneCall({
            authToken: ws.data.authToken,
            method: typeof frame.method === 'string' ? frame.method.toUpperCase() : 'GET',
            path: typeof frame.path === 'string' ? frame.path : '/api/control-plane',
            query: typeof frame.query === 'object' && frame.query !== null ? frame.query as Record<string, unknown> : undefined,
            body: frame.body,
            context: {
              principalKind: ws.data.principalKind,
              admin: ws.data.admin,
              scopes: ws.data.scopes,
            },
          });
      ws.send(JSON.stringify({
        type: 'response',
        id,
        ok: response.ok,
        status: response.status,
        body: response.body,
      }));
      return;
    }

    ws.send(JSON.stringify({ type: 'error', error: 'Unsupported frame type' }));
  }

  handleControlPlaneWebSocketClose(ws: {
    data: ControlPlaneWebSocketData;
  }): void {
    if (!ws.data.clientId) return;
    this.context.controlPlaneGateway.closeWebSocketClient(ws.data.clientId, 'socket-closed');
  }

  async invokeWebSocketControlPlaneCall(input: {
    readonly authToken: string;
    readonly method: string;
    readonly path: string;
    readonly query?: Record<string, unknown> | undefined;
    readonly body?: unknown | undefined;
    readonly context?: {
      readonly principalKind?: 'user' | 'bot' | 'service' | 'token' | 'remote-peer' | undefined;
      readonly admin?: boolean | undefined;
      readonly scopes?: readonly string[] | undefined;
    };
  }): Promise<{ status: number; ok: boolean; body: unknown }> {
    const matchedDescriptor = this.context.gatewayMethods.findByHttpBinding(input.method, input.path);
    if (matchedDescriptor) {
      const denied = this.validateGatewayInvocation(matchedDescriptor, input.context);
      if (denied) return denied;
      // Same input gate for the method+path WS call path (no bypass of the HTTP
      // methodId gate). Only POST/PATCH carry a validatable body here.
      if (input.method === 'POST' || input.method === 'PATCH') {
        const invalid = validateInvocationInput(matchedDescriptor, input.body);
        if (invalid) {
          return { status: 400, ok: false, body: { error: invalid.detail, code: invalid.code } };
        }
      }
    }
    const url = new URL(`http://${this.context.host}:${this.context.port}${input.path.startsWith('/') ? input.path : `/${input.path}`}`);
    for (const [key, value] of Object.entries(input.query ?? {})) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
    const request = new Request(url.toString(), {
      method: input.method,
      headers: {
        Authorization: `Bearer ${input.authToken}`,
        ...(input.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
    });
    const response = await this.context.dispatchApiRoutes(request) ?? Response.json({ error: 'Not found' }, { status: 404 });
    const raw = await response.text();
    let body: unknown = raw;
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    } else {
      body = null;
    }
    return {
      status: response.status,
      ok: response.ok,
      body,
    };
  }

  async invokeGatewayMethodCall(input: {
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
  }): Promise<{ status: number; ok: boolean; body: unknown }> {
    const descriptor = this.context.gatewayMethods.get(input.methodId);
    if (!descriptor) {
      return {
        status: 404,
        ok: false,
        body: {
          error: `Unknown gateway method: ${input.methodId}`,
          // Machine-readable, mirroring the NOT_INVOKABLE convention just below
          // (validateGatewayInvocation) — the uncataloged-id 404 gets its own code so
          // no consumer has to string-match "Unknown gateway method".
          code: SDKErrorCodes.METHOD_NOT_FOUND,
        },
      };
    }
    const denied = this.validateGatewayInvocation(descriptor, input.context);
    if (denied) return denied;
    // Input validation gate: reject a wrong-typed / missing-required body against
    // the verb's typed inputSchema before the handler runs (honest 400, not silent
    // coercion). Only body-carrying invocations are checked — a handler method
    // (no http binding) or a POST/PATCH verb receives its params in the body;
    // GET/DELETE params arrive as query strings that cannot be soundly type-checked.
    const carriesBody = !descriptor.http || descriptor.http.method === 'POST' || descriptor.http.method === 'PATCH';
    if (carriesBody) {
      const invalid = validateInvocationInput(descriptor, input.body);
      if (invalid) {
        return { status: 400, ok: false, body: { error: invalid.detail, code: invalid.code } };
      }
    }
    if (this.context.gatewayMethods.hasHandler(input.methodId)) {
      try {
        const body = await this.context.gatewayMethods.invoke(input.methodId, {
          body: input.body,
          query: input.query,
          context: {
            authToken: input.authToken,
            principalId: input.context?.principalId,
            principalKind: input.context?.principalKind,
            admin: input.context?.admin,
            scopes: input.context?.scopes,
            clientKind: input.context?.clientKind,
          },
        });
        return { status: 200, ok: true, body };
      } catch (error) {
        // A handler-registered verb (fleet.*, checkpoints.*,
        // sessions.search — see CHANGELOG 1.0.0) may throw a GatewayVerbError to report an honest
        // caller-error status (400/404) instead of the blanket 500 below —
        // see routes/gateway-verb-error.ts for why this seam is needed.
        if (isGatewayVerbError(error)) {
          return {
            status: error.status,
            ok: false,
            body: { error: error.message, code: error.code },
          };
        }
        return {
          status: 500,
          ok: false,
          body: { error: summarizeError(error) },
        };
      }
    }
    if (!descriptor.http) {
      return { status: 501, ok: false, body: { error: `Gateway method is not invokable: ${input.methodId}` } };
    }
    const resolvedPath = resolveGatewayPathTemplate(descriptor.http.path, input.query, input.body);
    if (!resolvedPath.path) {
      return {
        status: 400,
        ok: false,
        body: {
          error: `Missing path parameter${resolvedPath.missing.length === 1 ? '' : 's'} for ${input.methodId}: ${resolvedPath.missing.join(', ')}`,
          missing: [...resolvedPath.missing],
        },
      };
    }
    return this.invokeWebSocketControlPlaneCall({
      authToken: input.authToken,
      method: descriptor.http.method,
      path: resolvedPath.path,
      query: input.query,
      body: descriptor.http.method === 'GET' || descriptor.http.method === 'DELETE' ? undefined : input.body,
      context: {
        principalKind: input.context?.principalKind,
        admin: input.context?.admin,
        scopes: input.context?.scopes,
      },
    });
  }
}

function parseRuntimeDomains(rawDomains: string | null): RuntimeEventDomain[] | Response {
  if (!rawDomains) return [];
  return normalizeFrameDomains(rawDomains.split(',').map((value) => value.trim()).filter(Boolean));
}

function normalizeFrameDomains(values: readonly unknown[]): RuntimeEventDomain[] | Response {
  const domains: RuntimeEventDomain[] = [];
  const invalid: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') {
      invalid.push(String(value));
      continue;
    }
    const trimmed = value.trim();
    if (!isRuntimeEventDomain(trimmed)) {
      invalid.push(trimmed);
      continue;
    }
    domains.push(trimmed);
  }
  if (invalid.length > 0) {
    return Response.json({
      error: 'Invalid runtime event domain',
      invalid,
    }, { status: 400 });
  }
  return [...new Set(domains)];
}
