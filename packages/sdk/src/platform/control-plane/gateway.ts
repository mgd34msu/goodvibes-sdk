import { randomUUID } from 'node:crypto';
import { createDomainDispatch } from '../runtime/store/index.js';
import type { DomainDispatch, RuntimeStore } from '../runtime/store/index.js';
import type { RuntimeEventBus, RuntimeEventDomain } from '../runtime/events/index.js';
import type { ControlPlaneClientRecord } from '../runtime/store/domains/control-plane.js';
import {
  emitControlPlaneAuthGranted,
  emitControlPlaneClientConnected,
  emitControlPlaneClientDisconnected,
  emitControlPlaneSubscriptionCreated,
  emitControlPlaneSubscriptionDropped,
} from '../runtime/emitters/index.js';
import { renderControlPlaneGatewayWebUi } from './gateway-web-ui.js';
import type {
  ControlPlaneClientDescriptor,
  ControlPlaneServerConfig,
  ControlPlaneSurfaceMessage,
} from './types.js';
import type { FeatureFlagReader } from '../runtime/feature-flags/index.js';
import { isFeatureGateEnabled, requireFeatureGate } from '../runtime/feature-flags/index.js';
import {
  DEFAULT_DOMAINS,
  DEFAULT_SERVER_CONFIG,
  canReplayEventToClient,
  hasReplayScope,
  normalizeRuntimeDomains,
  pruneDisconnectedClientRecords,
  serializeEnvelope,
  stripReplayScope,
  toClientDescriptor,
  type ControlPlaneEventReplayScope,
  type ControlPlaneRecentEvent,
  type ScopedControlPlaneRecentEvent,
} from './gateway-utils.js';
export type { ControlPlaneRecentEvent } from './gateway-utils.js';

export interface ControlPlaneGatewayConfig {
  readonly runtimeBus?: RuntimeEventBus | null;
  readonly runtimeStore?: RuntimeStore | null;
  readonly server?: Partial<ControlPlaneServerConfig>;
  readonly featureFlags?: FeatureFlagReader;
}

export interface ControlPlaneEventStreamOptions {
  readonly clientId?: string;
  readonly clientKind?:
    | 'tui'
    | 'web'
    | 'slack'
    | 'discord'
    | 'ntfy'
    | 'webhook'
    | 'homeassistant'
    | 'telegram'
    | 'google-chat'
    | 'signal'
    | 'whatsapp'
    | 'imessage'
    | 'msteams'
    | 'bluebubbles'
    | 'mattermost'
    | 'matrix'
    | 'daemon';
  readonly transport?: 'local' | 'http' | 'sse' | 'ws' | 'webhook';
  readonly label?: string;
  readonly domains?: readonly RuntimeEventDomain[];
  readonly principalId?: string;
  readonly principalKind?: 'user' | 'bot' | 'service' | 'token';
  readonly scopes?: readonly string[];
  readonly sessionId?: string;
  readonly routeId?: string;
  readonly surfaceId?: string;
  readonly remoteAddress?: string;
  readonly capabilities?: readonly string[];
}

interface LiveControlPlaneClient {
  readonly clientId: string;
  readonly kind:
    | 'tui'
    | 'web'
    | 'slack'
    | 'discord'
    | 'ntfy'
    | 'webhook'
    | 'homeassistant'
    | 'telegram'
    | 'google-chat'
    | 'signal'
    | 'whatsapp'
    | 'imessage'
    | 'msteams'
    | 'bluebubbles'
    | 'mattermost'
    | 'matrix'
    | 'daemon';
  readonly surfaceId?: string;
  readonly routeId?: string;
  readonly send: (event: string, payload: unknown, id?: string) => void;
}

interface WebSocketControlPlaneClient {
  readonly clientId: string;
  readonly traceId: string;
  readonly domains: Set<RuntimeEventDomain>;
  readonly unsubscribers: Map<RuntimeEventDomain, () => void>;
}

export class ControlPlaneGateway {
  private runtimeBus: RuntimeEventBus | null;
  private dispatch: DomainDispatch | null;
  private readonly serverConfig: ControlPlaneServerConfig;
  private readonly featureFlags: FeatureFlagReader;
  private readonly clients = new Map<string, ControlPlaneClientRecord>();
  private readonly liveClients = new Map<string, LiveControlPlaneClient>();
  private readonly websocketClients = new Map<string, WebSocketControlPlaneClient>();
  private readonly recentMessages: ControlPlaneSurfaceMessage[] = [];
  // Circular ring buffer for O(1) insert instead of O(n) unshift.
  private readonly _recentEventsRing: (ScopedControlPlaneRecentEvent | undefined)[];
  private _recentEventsHead = 0;
  private _recentEventsCount = 0;
  private readonly _recentEventsCapacity = 500;
  /** Back-compat accessor used by getSnapshot / listRecentEvents */
  private get recentEvents(): ScopedControlPlaneRecentEvent[] {
    const out: ScopedControlPlaneRecentEvent[] = [];
    const count = this._recentEventsCount;
    const cap = this._recentEventsCapacity;
    for (let i = 0; i < count; i++) {
      const idx = (this._recentEventsHead - 1 - i + cap) % cap;
      const entry = this._recentEventsRing[idx];
      if (entry) {
        out.push(entry);
      } else if (process.env.NODE_ENV !== 'production') {
        // Dev-only: undefined slot despite valid count — ring buffer accounting bug.
        console.error('[ControlPlaneGateway] recentEvents: undefined slot at ring index', idx, { head: this._recentEventsHead, count: this._recentEventsCount, i });
      }
    }
    return out;
  }
  private requestCount = 0;
  private errorCount = 0;
  private lastRequestAt: number | undefined;
  private _syncScheduled = false;
  private _lastEventAt = 0;

  constructor(config: ControlPlaneGatewayConfig = {}) {
    this._recentEventsRing = new Array(this._recentEventsCapacity);
    this.runtimeBus = config.runtimeBus ?? null;
    this.dispatch = config.runtimeStore ? createDomainDispatch(config.runtimeStore) : null;
    this.featureFlags = config.featureFlags ?? null;
    this.serverConfig = {
      ...DEFAULT_SERVER_CONFIG,
      ...config.server,
    };
    if (this.dispatch) {
      this.dispatch.syncControlPlaneState({
        enabled: this.isEnabled() && this.serverConfig.enabled,
        host: this.serverConfig.host,
        port: this.serverConfig.port,
        connectionState: this.isEnabled() && this.serverConfig.enabled ? 'disconnected' : 'disabled',
      }, 'control-plane.gateway.init');
    }
  }

  private isEnabled(): boolean {
    return isFeatureGateEnabled(this.featureFlags, 'control-plane-gateway');
  }

  private requireEnabled(operation: string): void {
    requireFeatureGate(this.featureFlags, 'control-plane-gateway', operation);
  }

  attachRuntime(config: {
    readonly runtimeBus?: RuntimeEventBus | null;
    readonly runtimeStore?: RuntimeStore | null;
  }): void {
    if (config.runtimeBus) {
      this.runtimeBus = config.runtimeBus;
    }
    if (config.runtimeStore) {
      this.dispatch = createDomainDispatch(config.runtimeStore);
      this.dispatch.syncControlPlaneState({
        enabled: this.isEnabled() && this.serverConfig.enabled,
        host: this.serverConfig.host,
        port: this.serverConfig.port,
        connectionState: this.isEnabled() && this.serverConfig.enabled ? 'disconnected' : 'disabled',
      }, 'control-plane.gateway.attach');
      for (const client of this.clients.values()) {
        this.dispatch.syncControlPlaneClient(client, 'control-plane.gateway.attach');
      }
    }
  }

  listClients(): ControlPlaneClientDescriptor[] {
    if (!this.isEnabled()) return [];
    pruneDisconnectedClientRecords(this.clients);
    return [...this.clients.values()]
      .sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0) || a.id.localeCompare(b.id))
      .map(toClientDescriptor);
  }

  getSnapshot(): Record<string, unknown> {
    if (!this.isEnabled()) {
      return {
        server: { ...this.serverConfig, enabled: false },
        disabled: true,
        featureFlag: 'control-plane-gateway',
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
      };
    }
    pruneDisconnectedClientRecords(this.clients);
    const active = [...this.clients.values()].filter((client) => client.connected);
    return {
      server: this.serverConfig,
      totals: {
        clients: this.clients.size,
        activeClients: active.length,
        surfaceMessages: this.recentMessages.length,
        recentEvents: this._recentEventsCount,
        requests: this.requestCount,
        errors: this.errorCount,
      },
      clients: this.listClients(),
      messages: this.listSurfaceMessages(20),
      recentEvents: this.listRecentEvents(30),
    };
  }

  listSurfaceMessages(limit = 50): ControlPlaneSurfaceMessage[] {
    if (!this.isEnabled()) return [];
    return this.recentMessages.slice(0, Math.max(1, limit));
  }

  listRecentEvents(limit = 100): ControlPlaneRecentEvent[] {
    if (!this.isEnabled()) return [];
    return this.recentEvents.slice(0, Math.max(1, limit)).map(stripReplayScope);
  }

  publishSurfaceMessage(input: Omit<ControlPlaneSurfaceMessage, 'id' | 'createdAt'>): ControlPlaneSurfaceMessage {
    this.requireEnabled('publish surface message');
    const message: ControlPlaneSurfaceMessage = {
      id: `cpmsg-${randomUUID().slice(0, 8)}`,
      createdAt: Date.now(),
      ...input,
    };
    this.recentMessages.unshift(message);
    if (this.recentMessages.length > 200) {
      this.recentMessages.length = 200;
    }
    const record = this.rememberEvent('surface-message', message, {
      ...(message.clientId ? { clientId: message.clientId } : {}),
      ...(message.routeId ? { routeId: message.routeId } : {}),
      ...(message.surfaceId ? { surfaceId: message.surfaceId } : {}),
    });
    for (const client of this.liveClients.values()) {
      if (client.kind !== 'web') continue;
      if (message.clientId && client.clientId !== message.clientId) continue;
      if (message.routeId && client.routeId !== message.routeId) continue;
      if (message.surfaceId && client.surfaceId !== message.surfaceId) continue;
      client.send('surface-message', message, record.id);
    }
    return message;
  }

  publishEvent(event: string, payload: unknown, filter?: {
    readonly clientKind?: LiveControlPlaneClient['kind'];
    readonly clientId?: string;
    readonly routeId?: string;
    readonly surfaceId?: string;
  }): void {
    if (!this.isEnabled()) return;
    const record = this.rememberEvent(event, payload, filter);
    for (const client of this.liveClients.values()) {
      if (filter?.clientKind && client.kind !== filter.clientKind) continue;
      if (filter?.clientId && client.clientId !== filter.clientId) continue;
      if (filter?.routeId && client.routeId !== filter.routeId) continue;
      if (filter?.surfaceId && client.surfaceId !== filter.surfaceId) continue;
      client.send(event, payload, record.id);
    }
  }

  recordApiRequest(input: {
    readonly method: string;
    readonly path: string;
    readonly status: number;
    readonly clientKind?: ControlPlaneEventStreamOptions['clientKind'];
    readonly error?: string;
  }): void {
    if (!this.isEnabled()) return;
    this.requestCount += 1;
    this.lastRequestAt = Date.now();
    if (input.status >= 400 || input.error) {
      this.errorCount += 1;
    }
    this.dispatch?.syncControlPlaneState({
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      lastRequestAt: this.lastRequestAt,
      ...(input.error ? { lastError: input.error } : {}),
    }, 'control-plane.gateway.api-request');
    this.rememberEvent('api-request', {
      method: input.method,
      path: input.path,
      status: input.status,
      clientKind: input.clientKind ?? 'web',
      ...(input.error ? { error: input.error } : {}),
    });
  }

  setServerState(patch: Partial<ControlPlaneServerConfig>): void {
    if (!this.isEnabled()) {
      Object.assign(this.serverConfig, { ...patch, enabled: false });
      this.dispatch?.syncControlPlaneState({
        enabled: false,
        host: this.serverConfig.host,
        port: this.serverConfig.port,
        connectionState: 'disabled',
      }, 'control-plane.gateway.state.disabled');
      return;
    }
    Object.assign(this.serverConfig, patch);
    const hasActiveClient = [...this.clients.values()].some((client) => client.connected);
    this.dispatch?.syncControlPlaneState({
      enabled: this.serverConfig.enabled,
      host: this.serverConfig.host,
      port: this.serverConfig.port,
      connectionState: this.serverConfig.enabled ? (hasActiveClient ? 'connected' : 'disconnected') : 'disabled',
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      lastRequestAt: this.lastRequestAt,
    }, 'control-plane.gateway.state');
  }

  openWebSocketClient(
    options: ControlPlaneEventStreamOptions,
    send: (event: string, payload: unknown, id?: string) => void,
  ): { clientId: string; domains: readonly RuntimeEventDomain[] } {
    this.requireEnabled('open websocket client');
    if (!this.runtimeBus) {
      throw new Error('Runtime event bus unavailable');
    }

    const selectedDomains = normalizeRuntimeDomains(options.domains);
    const clientId = options.clientId ?? `cp-${randomUUID().slice(0, 8)}`;
    const label = options.label ?? `${options.clientKind ?? 'web'}:${clientId}`;
    const now = Date.now();
    const surfaceKind = options.clientKind === 'daemon' ? 'service' : (options.clientKind ?? 'web');
    const clientRecord: ControlPlaneClientRecord = {
      id: clientId,
      kind: surfaceKind,
      label,
      transport: 'websocket',
      connected: true,
      sessionId: options.sessionId,
      routeId: options.routeId,
      surfaceId: options.surfaceId,
      authenticatedAt: now,
      lastSeenAt: now,
      remoteAddress: options.remoteAddress,
      capabilities: [...(options.capabilities ?? [])],
      metadata: {
        domains: selectedDomains,
        ...(options.principalId ? { userId: options.principalId } : {}),
      },
    };
    const traceId = `control-plane:${clientId}`;
    this.clients.set(clientId, clientRecord);
    this.liveClients.set(clientId, {
      clientId,
      kind: options.clientKind ?? 'web',
      surfaceId: options.surfaceId,
      routeId: options.routeId,
      send,
    });
    this.websocketClients.set(clientId, {
      clientId,
      traceId,
      domains: new Set(),
      unsubscribers: new Map(),
    });
    this.dispatch?.syncControlPlaneState({
      enabled: true,
      isRunning: true,
      connectionState: 'connected',
    }, 'control-plane.gateway.ws-connect');
    this.dispatch?.syncControlPlaneClient(clientRecord, 'control-plane.gateway.ws-connect');

    const eventClientKind = options.clientKind === 'daemon' ? 'service' : (options.clientKind ?? 'web');
    emitControlPlaneClientConnected(this.runtimeBus, {
      sessionId: options.sessionId ?? 'control-plane',
      source: 'control-plane.gateway',
      traceId,
    }, {
      clientId,
      clientKind: eventClientKind,
      transport: 'ws',
    });
    emitControlPlaneSubscriptionCreated(this.runtimeBus, {
      sessionId: options.sessionId ?? 'control-plane',
      source: 'control-plane.gateway',
      traceId,
    }, {
      clientId,
      subscriptionId: clientId,
      topics: selectedDomains,
    });
    if (options.principalId) {
      emitControlPlaneAuthGranted(this.runtimeBus, {
        sessionId: options.sessionId ?? 'control-plane',
        source: 'control-plane.gateway',
        traceId,
      }, {
        clientId,
        principalId: options.principalId,
        principalKind: options.principalKind ?? 'token',
        scopes: [...(options.scopes ?? ['read:events'])],
      });
    }

    this.subscribeWebSocketClient(clientId, selectedDomains);
    send('ready', { clientId, domains: selectedDomains, transport: 'websocket' });
    this.replayRecentTraffic(send, { ...options, clientId, domains: selectedDomains });
    return { clientId, domains: selectedDomains };
  }

  touchWebSocketClient(clientId: string, metadata: Record<string, unknown> = {}): void {
    if (!this.isEnabled()) return;
    const existing = this.clients.get(clientId);
    if (!existing) return;
    const updated: ControlPlaneClientRecord = {
      ...existing,
      lastSeenAt: Date.now(),
      metadata: {
        ...existing.metadata,
        ...metadata,
      },
    };
    this.clients.set(clientId, updated);
    this.dispatch?.syncControlPlaneClient(updated, 'control-plane.gateway.ws-touch');
  }

  authenticateClient(clientId: string, input: {
    readonly principalId: string;
    readonly principalKind?: 'user' | 'bot' | 'service' | 'token';
    readonly scopes?: readonly string[];
    readonly label?: string;
    readonly capabilities?: readonly string[];
  }): void {
    if (!this.isEnabled()) return;
    const existing = this.clients.get(clientId);
    if (!existing || !this.runtimeBus) return;
    const updated: ControlPlaneClientRecord = {
      ...existing,
      label: input.label ?? existing.label,
      authenticatedAt: Date.now(),
      lastSeenAt: Date.now(),
      capabilities: input.capabilities ? [...input.capabilities] : existing.capabilities,
      metadata: {
        ...existing.metadata,
        userId: input.principalId,
      },
    };
    this.clients.set(clientId, updated);
    this.dispatch?.syncControlPlaneClient(updated, 'control-plane.gateway.ws-auth');
    emitControlPlaneAuthGranted(this.runtimeBus, {
      sessionId: updated.sessionId ?? 'control-plane',
      source: 'control-plane.gateway',
      traceId: `control-plane:${clientId}:auth`,
    }, {
      clientId,
      principalId: input.principalId,
      principalKind: input.principalKind ?? 'token',
      scopes: [...(input.scopes ?? ['read:events'])],
    });
  }

  subscribeWebSocketClient(clientId: string, domains: readonly RuntimeEventDomain[]): void {
    if (!this.isEnabled()) return;
    const wsClient = this.websocketClients.get(clientId);
    if (!wsClient || !this.runtimeBus) return;
    const liveClient = this.liveClients.get(clientId);
    if (!liveClient) return;
    const nextDomains = [...new Set(domains)];
    for (const domain of nextDomains) {
      if (wsClient.unsubscribers.has(domain)) continue;
      const unsubscribe = this.runtimeBus.onDomain(domain, (envelope) => {
        this.touchWebSocketClient(clientId, { lastEventType: envelope.type });
        const serialized = serializeEnvelope(envelope);
        const record = this.rememberEvent(domain, serialized);
        liveClient.send(domain, serialized, record.id);
      });
      wsClient.unsubscribers.set(domain, unsubscribe);
      wsClient.domains.add(domain);
    }
    this.touchWebSocketClient(clientId, { domains: [...wsClient.domains] });
  }

  unsubscribeWebSocketClient(clientId: string, domains?: readonly RuntimeEventDomain[]): void {
    if (!this.isEnabled()) return;
    const wsClient = this.websocketClients.get(clientId);
    if (!wsClient) return;
    const targetDomains = domains?.length ? [...new Set(domains)] : [...wsClient.domains];
    for (const domain of targetDomains) {
      const unsubscribe = wsClient.unsubscribers.get(domain);
      unsubscribe?.();
      wsClient.unsubscribers.delete(domain);
      wsClient.domains.delete(domain);
    }
    this.touchWebSocketClient(clientId, { domains: [...wsClient.domains] });
  }

  closeWebSocketClient(clientId: string, reason = 'socket-closed'): void {
    if (!this.isEnabled()) return;
    const wsClient = this.websocketClients.get(clientId);
    if (!wsClient) return;
    if (this.runtimeBus) {
      emitControlPlaneSubscriptionDropped(this.runtimeBus, {
        sessionId: this.clients.get(clientId)?.sessionId ?? 'control-plane',
        source: 'control-plane.gateway',
        traceId: wsClient.traceId,
      }, {
        clientId,
        subscriptionId: clientId,
        reason,
      });
      emitControlPlaneClientDisconnected(this.runtimeBus, {
        sessionId: this.clients.get(clientId)?.sessionId ?? 'control-plane',
        source: 'control-plane.gateway',
        traceId: wsClient.traceId,
      }, {
        clientId,
        reason,
      });
    }
    this.unsubscribeWebSocketClient(clientId);
    this.websocketClients.delete(clientId);
    this.liveClients.delete(clientId);
    const previous = this.clients.get(clientId);
    if (!previous) return;
    const disconnected: ControlPlaneClientRecord = {
      ...previous,
      connected: false,
      lastSeenAt: Date.now(),
    };
    this.clients.set(clientId, disconnected);
    pruneDisconnectedClientRecords(this.clients);
    this.dispatch?.syncControlPlaneClient(disconnected, 'control-plane.gateway.ws-disconnect');
    this.dispatch?.syncControlPlaneState({
      enabled: true,
      isRunning: true,
      connectionState: [...this.clients.values()].some((client) => client.connected) ? 'connected' : 'disconnected',
    }, 'control-plane.gateway.ws-disconnect');
  }

  private replayRecentTraffic(
    send: (event: string, payload: unknown, id?: string) => void,
    options: ControlPlaneEventStreamOptions,
    sinceId?: string,
  ): void {
    const sinceIndex = sinceId ? this.recentEvents.findIndex((event) => event.id === sinceId) : -1;
    const recentEvents = sinceIndex >= 0
      ? this.recentEvents.slice(0, sinceIndex).reverse()
      : this.recentEvents.slice(0, 20).reverse();
    for (const recentEvent of recentEvents) {
      if (!canReplayEventToClient(recentEvent, options)) continue;
      send(recentEvent.event, recentEvent.payload, recentEvent.id);
    }
  }

  createEventStream(request: Request, options: ControlPlaneEventStreamOptions = {}): Response {
    if (!this.isEnabled()) {
      return Response.json({ error: 'control-plane-gateway feature flag is disabled' }, { status: 503 });
    }
    if (!this.runtimeBus) {
      return Response.json({ error: 'Runtime event bus unavailable' }, { status: 503 });
    }

    const encoder = new TextEncoder();
    const selectedDomains = normalizeRuntimeDomains(options.domains);
    const lastEventId = request.headers.get('last-event-id')?.trim() || undefined;
    const clientId = options.clientId ?? `cp-${randomUUID().slice(0, 8)}`;
    const label = options.label ?? `${options.clientKind ?? 'web'}:${clientId}`;
    const now = Date.now();
    const transport = options.transport ?? 'sse';
    const surfaceKind = options.clientKind === 'daemon' ? 'service' : (options.clientKind ?? 'web');
    const clientRecord: ControlPlaneClientRecord = {
      id: clientId,
      kind: surfaceKind,
      label,
      transport: transport === 'ws' ? 'websocket' : transport === 'local' ? 'local' : 'sse',
      connected: true,
      sessionId: options.sessionId,
      routeId: options.routeId,
      surfaceId: options.surfaceId,
      authenticatedAt: now,
      lastSeenAt: now,
      remoteAddress: options.remoteAddress,
      capabilities: [...(options.capabilities ?? [])],
      metadata: {
        domains: selectedDomains,
        ...(options.principalId ? { userId: options.principalId } : {}),
      },
    };
    this.clients.set(clientId, clientRecord);
    this.dispatch?.syncControlPlaneState({
      enabled: true,
      isRunning: true,
      connectionState: 'connected',
    }, 'control-plane.gateway.connect');
    this.dispatch?.syncControlPlaneClient(clientRecord, 'control-plane.gateway.connect');

    const traceId = `control-plane:${clientId}`;
    const eventClientKind = options.clientKind === 'daemon' ? 'service' : (options.clientKind ?? 'web');
    emitControlPlaneClientConnected(this.runtimeBus, {
      sessionId: options.sessionId ?? 'control-plane',
      source: 'control-plane.gateway',
      traceId,
    }, {
      clientId,
      clientKind: eventClientKind,
      transport,
    });
    emitControlPlaneSubscriptionCreated(this.runtimeBus, {
      sessionId: options.sessionId ?? 'control-plane',
      source: 'control-plane.gateway',
      traceId,
    }, {
      clientId,
      subscriptionId: clientId,
      topics: selectedDomains,
    });
    if (options.principalId) {
      emitControlPlaneAuthGranted(this.runtimeBus, {
        sessionId: options.sessionId ?? 'control-plane',
        source: 'control-plane.gateway',
        traceId,
      }, {
        clientId,
        principalId: options.principalId,
        principalKind: options.principalKind ?? 'token',
        scopes: [...(options.scopes ?? ['read:events'])],
      });
    }

    let teardown = (): void => {};
    // PERF-08: ReadableStream default HWM is 1, which causes startup `ready` + replay
    // enqueues to drop subsequent chunks before any consumer has pulled. Raise HWM to
    // 256 chunks so initial handshake + recent-traffic replay + live events fit without
    // tripping the backpressure guard for a healthy consumer.
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const send = (event: string, payload: unknown, id?: string): void => {
          // PERF-05: Drop event if the stream's internal queue is full (backpressure guard).
          // desiredSize <= 0 means the consumer is falling behind; dropping prevents
          // unbounded memory growth from enqueued-but-unread chunks.
          if ((controller.desiredSize ?? 1) <= 0) return;
          controller.enqueue(encoder.encode(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`));
        };
        const unsubs = selectedDomains.map((domain) => this.runtimeBus!.onDomain(domain, (envelope) => {
          const updated: ControlPlaneClientRecord = {
            ...clientRecord,
            lastSeenAt: Date.now(),
            metadata: {
              ...clientRecord.metadata,
              lastEventType: envelope.type,
            },
          };
          this.clients.set(clientId, updated);
          this.dispatch?.syncControlPlaneClient(updated, 'control-plane.gateway.heartbeat');
          const serialized = serializeEnvelope(envelope);
          const record = this.rememberEvent(domain, serialized);
          send(domain, serialized, record.id);
        }));
        this.liveClients.set(clientId, {
          clientId,
          kind: options.clientKind ?? 'web',
          surfaceId: options.surfaceId,
          routeId: options.routeId,
          send,
        });
        const heartbeat = setInterval(() => {
          send('heartbeat', { clientId, ts: Date.now() });
        }, 15_000);
        // Don't block clean process exit (PERF-07).
        (heartbeat as unknown as { unref?: () => void }).unref?.();
        teardown = () => {
          clearInterval(heartbeat);
          for (const unsub of unsubs) unsub();
          this.liveClients.delete(clientId);
          const previous = this.clients.get(clientId);
          if (previous) {
            const disconnected: ControlPlaneClientRecord = {
              ...previous,
              connected: false,
              lastSeenAt: Date.now(),
            };
            this.clients.set(clientId, disconnected);
            pruneDisconnectedClientRecords(this.clients);
            this.dispatch?.syncControlPlaneClient(disconnected, 'control-plane.gateway.disconnect');
            this.dispatch?.syncControlPlaneState({
              enabled: true,
              isRunning: true,
              connectionState: [...this.clients.values()].some((client) => client.connected) ? 'connected' : 'disconnected',
            }, 'control-plane.gateway.disconnect');
            emitControlPlaneSubscriptionDropped(this.runtimeBus!, {
              sessionId: options.sessionId ?? 'control-plane',
              source: 'control-plane.gateway',
              traceId,
            }, {
              clientId,
              subscriptionId: clientId,
              reason: 'stream-closed',
            });
            emitControlPlaneClientDisconnected(this.runtimeBus!, {
              sessionId: options.sessionId ?? 'control-plane',
              source: 'control-plane.gateway',
              traceId,
            }, {
              clientId,
              reason: 'stream-closed',
            });
          }
        };
        request.signal.addEventListener('abort', () => {
          teardown();
          controller.close();
        }, { once: true });
        send('ready', { clientId, domains: selectedDomains });
        this.replayRecentTraffic(send, { ...options, clientId, domains: selectedDomains }, lastEventId);
      },
      cancel: () => {
        teardown();
      },
    }, new CountQueuingStrategy({ highWaterMark: 256 }));

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
    });
  }

  renderWebUi(authTokenHint = ''): Response {
    if (!this.isEnabled()) {
      return Response.json({ error: 'control-plane-gateway feature flag is disabled' }, { status: 503 });
    }
    return renderControlPlaneGatewayWebUi(authTokenHint);
  }

  private _scheduleControlPlaneSync(): void {
    if (this._syncScheduled || !this.dispatch) return;
    this._syncScheduled = true;
    setImmediate(() => {
      this._syncScheduled = false;
      this.dispatch?.syncControlPlaneState({
        requestCount: this.requestCount,
        errorCount: this.errorCount,
        lastRequestAt: this.lastRequestAt,
        lastEventAt: this._lastEventAt,
      }, 'control-plane.gateway.event');
    });
  }

  private rememberEvent(
    event: string,
    payload: unknown,
    replayScope?: ControlPlaneEventReplayScope,
  ): ScopedControlPlaneRecentEvent {
    const record: ScopedControlPlaneRecentEvent = {
      id: `cpe-${randomUUID().slice(0, 8)}`,
      event,
      createdAt: Date.now(),
      payload,
      ...(replayScope && hasReplayScope(replayScope) ? { replayScope } : {}),
    };
    // O(1) circular ring buffer write — no array shifting.
    this._recentEventsRing[this._recentEventsHead] = record;
    this._recentEventsHead = (this._recentEventsHead + 1) % this._recentEventsCapacity;
    if (this._recentEventsCount < this._recentEventsCapacity) this._recentEventsCount++;
    this._lastEventAt = record.createdAt;
    // Debounced: coalesce N events/frame into 1 store sync.
    this._scheduleControlPlaneSync();
    return record;
  }
}

// Test export — exposes DEFAULT_DOMAINS for regression tests.
export { DEFAULT_DOMAINS as DEFAULT_DOMAINS_TEST_EXPORT };
