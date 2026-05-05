import { VERSION } from '../../version.js';
import { telemetryBufferFill } from '../metrics.js';
import { normalizeError, type NormalizedError } from '../../utils/error-display.js';
import type {
  AnyRuntimeEvent,
  RuntimeEventBus,
  RuntimeEventDomain,
  RuntimeEventEnvelope,
} from '../events/index.js';
import type { RuntimeStore } from '../store/index.js';
import type { TelemetryDomainState } from '../store/domains/telemetry.js';
import type {
  AttributeValue,
  ReadableSpan,
  SpanAttributes,
  SpanEvent,
  SpanKind,
  SpanStatus,
} from './types.js';
import { SpanKind as SpanKinds, SpanStatusCode } from './types.js';
import {
  ALL_DOMAINS,
  appendBounded,
  buildAttributes,
  buildListResponse,
  buildOtlpLogDocumentFromRecords,
  buildOtlpMetricDocumentFromState,
  buildOtlpTraceDocumentFromSpans,
  buildRecordId,
  buildSpanId,
  clampLimit,
  DEFAULT_ERROR_LIMIT,
  DEFAULT_EVENT_LIMIT,
  DEFAULT_SPAN_LIMIT,
  extractErrorCandidate,
  extractProvider,
  inferErrorSource,
  inferSeverity,
  isErrorEventType,
  normalizePayload,
  normalizeTraceId,
  SERVICE_NAME,
  summarizePayload,
  toAttributeValue,
  toObjectMap,
} from './api-helpers.js';
import {
  applyTelemetryRecordFilter,
  applyTelemetrySpanFilter,
} from './api-query.js';
import { createTelemetryEventStream } from './api-stream.js';
import {
  ingestExternalTelemetryLogs,
  ingestExternalTelemetryMetrics,
  ingestExternalTelemetryTraces,
} from './api-ingest.js';

export type TelemetrySeverity = 'debug' | 'info' | 'warn' | 'error';
export type TelemetryViewMode = 'safe' | 'raw';

export interface TelemetryFilter {
  readonly limit?: number | undefined;
  readonly since?: number | undefined;
  readonly until?: number | undefined;
  readonly domains?: readonly RuntimeEventDomain[] | undefined;
  readonly eventTypes?: readonly string[] | undefined;
  readonly severity?: TelemetrySeverity | undefined;
  readonly traceId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly turnId?: string | undefined;
  readonly agentId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly cursor?: string | undefined;
  readonly view?: TelemetryViewMode | undefined;
}

export interface TelemetryRecord {
  readonly id: string;
  readonly domain: RuntimeEventDomain;
  readonly type: string;
  readonly timestamp: number;
  readonly severity: TelemetrySeverity;
  readonly traceId: string;
  readonly sessionId: string;
  readonly turnId?: string | undefined;
  readonly agentId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly source: string;
  readonly message: string;
  readonly payload: unknown;
  readonly attributes: Record<string, unknown>;
  readonly error?: NormalizedError | undefined;
}

export interface TelemetryCapabilities {
  readonly signals: {
    readonly events: true;
    readonly errors: true;
    readonly metrics: true;
    readonly traces: boolean;
  };
  readonly encodings: {
    readonly json: true;
    readonly sse: true;
    readonly otlpJson: {
      readonly traces: true;
      readonly metrics: true;
      readonly logs: true;
    };
  };
}

export interface TelemetryAggregates {
  readonly totalEvents: number;
  readonly totalErrors: number;
  readonly totalWarnings: number;
  readonly totalSpans: number;
  readonly byDomain: Readonly<Record<string, number>>;
  readonly byEventType: Readonly<Record<string, number>>;
  readonly errorsByCategory: Readonly<Record<string, number>>;
}

export interface TelemetryRuntimeSnapshot {
  readonly sessionId: string;
  readonly sessionStatus: string;
  readonly traceContext?: TelemetryDomainState['traceContext'] | undefined;
  readonly sessionCorrelationId: string;
  readonly currentTurnCorrelationId?: string | undefined;
  readonly dbAvailable: boolean;
  readonly dbPath?: string | undefined;
  readonly tasks: {
    readonly total: number;
    readonly queued: number;
    readonly running: number;
    readonly blocked: number;
  };
  readonly agents: {
    readonly total: number;
    readonly active: number;
  };
  readonly approvals: {
    readonly pending: number;
  };
}

export interface TelemetrySnapshot {
  readonly version: 1;
  readonly view: TelemetryViewMode;
  readonly rawAccessible: boolean;
  readonly generatedAt: number;
  readonly service: {
    readonly name: string;
    readonly version: string;
  };
  readonly capabilities: TelemetryCapabilities;
  readonly runtime: TelemetryRuntimeSnapshot;
  readonly sessionMetrics: TelemetryDomainState['sessionMetrics'];
  readonly aggregates: TelemetryAggregates;
  readonly recent: {
    readonly events: TelemetryListResponse<TelemetryRecord>;
    readonly errors: TelemetryListResponse<TelemetryRecord>;
    readonly spans: TelemetryListResponse<ReadableSpan>;
  };
}

export interface TelemetryPageInfo {
  readonly limit: number;
  readonly returned: number;
  readonly hasMore: boolean;
  readonly cursor?: string | undefined;
  readonly nextCursor?: string | undefined;
}

export interface TelemetryListResponse<T> {
  readonly version: 1;
  readonly view: TelemetryViewMode;
  readonly rawAccessible: boolean;
  readonly items: readonly T[];
  readonly pageInfo: TelemetryPageInfo;
}

interface ActiveSyntheticSpan {
  readonly name: string;
  readonly kind: SpanKind;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string | undefined;
  readonly startTimeMs: number;
  readonly attributes: SpanAttributes;
}

interface TelemetryApiServiceOptions {
  readonly runtimeBus: RuntimeEventBus;
  readonly runtimeStore: RuntimeStore;
  readonly eventLimit?: number | undefined;
  readonly errorLimit?: number | undefined;
  readonly spanLimit?: number | undefined;
}

export class TelemetryApiService {
  private readonly runtimeBus: RuntimeEventBus;
  private readonly runtimeStore: RuntimeStore;
  private readonly eventLimit: number;
  private readonly errorLimit: number;
  private readonly spanLimit: number;
  private readonly records: TelemetryRecord[] = [];
  private readonly errors: TelemetryRecord[] = [];
  private readonly spans: ReadableSpan[] = [];
  private readonly eventCountsByDomain = new Map<string, number>();
  private readonly eventCountsByType = new Map<string, number>();
  private readonly errorCountsByCategory = new Map<string, number>();
  private readonly subscribers = new Set<(record: TelemetryRecord) => void>();
  private readonly unsubs: Array<() => void> = [];
  private readonly activeTurnSpans = new Map<string, ActiveSyntheticSpan>();
  private readonly activeTaskSpans = new Map<string, ActiveSyntheticSpan>();
  private readonly activeAgentSpans = new Map<string, ActiveSyntheticSpan>();
  private readonly activeToolSpans = new Map<string, ActiveSyntheticSpan>();
  private readonly turnSpanIds = new Map<string, string>();
  private readonly taskSpanIds = new Map<string, string>();
  private readonly agentSpanIds = new Map<string, string>();
  private seq = 0;

  constructor(options: TelemetryApiServiceOptions) {
    this.runtimeBus = options.runtimeBus;
    this.runtimeStore = options.runtimeStore;
    this.eventLimit = options.eventLimit ?? DEFAULT_EVENT_LIMIT;
    this.errorLimit = options.errorLimit ?? DEFAULT_ERROR_LIMIT;
    this.spanLimit = options.spanLimit ?? DEFAULT_SPAN_LIMIT;
    this.subscribeAllDomains();
  }

  dispose(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;
    this.subscribers.clear();
    this.activeTurnSpans.clear();
    this.activeTaskSpans.clear();
    this.activeAgentSpans.clear();
    this.activeToolSpans.clear();
  }

  subscribe(listener: (record: TelemetryRecord) => void): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  getCapabilities(): TelemetryCapabilities {
    return {
      signals: {
        events: true,
        errors: true,
        metrics: true,
        traces: this.spans.length > 0,
      },
      encodings: {
        json: true,
        sse: true,
        otlpJson: {
          traces: true,
          metrics: true,
          logs: true,
        },
      },
    };
  }

  getSnapshot(
    filter: TelemetryFilter = {},
    view: TelemetryViewMode = filter.view ?? 'safe',
    rawAccessible = view === 'raw',
  ): TelemetrySnapshot {
    const state = this.runtimeStore.getState();
    const telemetry = state.telemetry;
    const limit = clampLimit(filter.limit, 20);
    return {
      version: 1,
      view,
      rawAccessible,
      generatedAt: Date.now(),
      service: {
        name: SERVICE_NAME,
        version: VERSION,
      },
      capabilities: this.getCapabilities(),
      runtime: {
        sessionId: state.session.id,
        sessionStatus: state.session.status,
        traceContext: telemetry.traceContext,
        sessionCorrelationId: telemetry.sessionCorrelationId,
        ...(telemetry.currentTurnCorrelationId ? { currentTurnCorrelationId: telemetry.currentTurnCorrelationId } : {}),
        dbAvailable: telemetry.dbAvailable,
        ...(telemetry.dbPath ? { dbPath: telemetry.dbPath } : {}),
        tasks: {
          total: state.tasks.tasks.size,
          queued: state.tasks.queuedIds.length,
          running: state.tasks.runningIds.length,
          blocked: state.tasks.blockedIds.length,
        },
        agents: {
          total: state.agents.agents.size,
          active: state.agents.activeAgentIds.length,
        },
        approvals: {
          pending: state.permissions.awaitingDecision ? 1 : 0,
        },
      },
      sessionMetrics: telemetry.sessionMetrics,
      aggregates: this.getAggregates(),
      recent: {
        events: this.listEventPage({ ...filter, limit }, view, rawAccessible),
        errors: this.listErrorPage({ ...filter, limit }, view, rawAccessible),
        spans: this.listSpanPage({ ...filter, limit }, view, rawAccessible),
      },
    };
  }

  getAggregates(): TelemetryAggregates {
    const totalErrors = [...this.errorCountsByCategory.values()].reduce((sum, count) => sum + count, 0);
    const totalWarnings = this.listEvents({ severity: 'warn', limit: this.records.length }).length;
    return {
      totalEvents: this.records.length,
      totalErrors,
      totalWarnings,
      totalSpans: this.spans.length,
      byDomain: toObjectMap(this.eventCountsByDomain),
      byEventType: toObjectMap(this.eventCountsByType),
      errorsByCategory: toObjectMap(this.errorCountsByCategory),
    };
  }

  listEvents(filter: TelemetryFilter = {}, view: TelemetryViewMode = filter.view ?? 'safe'): readonly TelemetryRecord[] {
    return this.listEventPage(filter, view, view === 'raw').items;
  }

  listErrors(filter: TelemetryFilter = {}, view: TelemetryViewMode = filter.view ?? 'safe'): readonly TelemetryRecord[] {
    return this.listErrorPage(filter, view, view === 'raw').items;
  }

  listSpans(filter: TelemetryFilter = {}, view: TelemetryViewMode = filter.view ?? 'safe'): readonly ReadableSpan[] {
    return this.listSpanPage(filter, view, view === 'raw').items;
  }

  listEventPage(
    filter: TelemetryFilter = {},
    view: TelemetryViewMode = filter.view ?? 'safe',
    rawAccessible = view === 'raw',
  ): TelemetryListResponse<TelemetryRecord> {
    const { items, pageInfo } = applyTelemetryRecordFilter(this.records, filter, view);
    return buildListResponse(items, view, rawAccessible, pageInfo);
  }

  listErrorPage(
    filter: TelemetryFilter = {},
    view: TelemetryViewMode = filter.view ?? 'safe',
    rawAccessible = view === 'raw',
  ): TelemetryListResponse<TelemetryRecord> {
    const { items, pageInfo } = applyTelemetryRecordFilter(this.errors, filter, view);
    return buildListResponse(items, view, rawAccessible, pageInfo);
  }

  listSpanPage(
    filter: TelemetryFilter = {},
    view: TelemetryViewMode = filter.view ?? 'safe',
    rawAccessible = view === 'raw',
  ): TelemetryListResponse<ReadableSpan> {
    const { items, pageInfo } = applyTelemetrySpanFilter(this.spans, filter, view);
    return buildListResponse(items, view, rawAccessible, pageInfo);
  }

  createStream(
    request: Request,
    filter: TelemetryFilter = {},
    view: TelemetryViewMode = filter.view ?? 'safe',
    rawAccessible = view === 'raw',
  ): Response {
    return createTelemetryEventStream({
      request,
      filter,
      view,
      rawAccessible,
      records: this.records,
      listEventPage: (nextFilter, nextView, nextRawAccessible) =>
        this.listEventPage(nextFilter, nextView, nextRawAccessible),
      subscribe: (listener) => this.subscribe(listener),
      getCapabilities: () => this.getCapabilities(),
      getSubscriberCount: () => this.subscribers.size,
    });
  }

  buildOtlpTraceDocument(filter: TelemetryFilter = {}, view: TelemetryViewMode = filter.view ?? 'safe'): Record<string, unknown> {
    return buildOtlpTraceDocumentFromSpans(this.listSpans(filter, view));
  }

  buildOtlpLogDocument(filter: TelemetryFilter = {}, view: TelemetryViewMode = filter.view ?? 'safe'): Record<string, unknown> {
    return buildOtlpLogDocumentFromRecords(this.listEvents(filter, view));
  }

  buildOtlpMetricDocument(): Record<string, unknown> {
    return buildOtlpMetricDocumentFromState(this.runtimeStore.getState(), this.getAggregates());
  }

  private subscribeAllDomains(): void {
    for (const domain of ALL_DOMAINS) {
      this.unsubs.push(this.runtimeBus.onDomain(domain, (envelope) => {
        this.handleEnvelope(domain, envelope as RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>);
      }));
    }
  }

  private handleEnvelope(
    domain: RuntimeEventDomain,
    envelope: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>,
  ): void {
    const payload = normalizePayload(envelope.payload);
    const errorCandidate = extractErrorCandidate(payload);
    const normalizedError = errorCandidate && isErrorEventType(envelope.type)
      ? normalizeError(errorCandidate, {
        source: inferErrorSource(domain),
        ...(extractProvider(payload) ? { provider: extractProvider(payload) } : {}),
      })
      : undefined;
    const attributes = buildAttributes(domain, envelope, payload);
    const record: TelemetryRecord = {
      id: buildRecordId(domain, envelope, this.seq++),
      domain,
      type: envelope.type,
      timestamp: envelope.ts,
      severity: inferSeverity(envelope.type, normalizedError),
      traceId: normalizeTraceId(envelope.traceId),
      sessionId: envelope.sessionId ?? '',
      ...(envelope.turnId ? { turnId: envelope.turnId } : {}),
      ...(envelope.agentId ? { agentId: envelope.agentId } : {}),
      ...(envelope.taskId ? { taskId: envelope.taskId } : {}),
      source: envelope.source ?? '',
      message: summarizePayload(envelope.type, payload),
      payload,
      attributes,
      ...(normalizedError ? { error: normalizedError } : {}),
    };

    appendBounded(this.records, record, this.eventLimit);
    this.eventCountsByDomain.set(domain, (this.eventCountsByDomain.get(domain) ?? 0) + 1);
    this.eventCountsByType.set(envelope.type, (this.eventCountsByType.get(envelope.type) ?? 0) + 1);
    if (normalizedError) {
      appendBounded(this.errors, record, this.errorLimit);
      this.errorCountsByCategory.set(normalizedError.category, (this.errorCountsByCategory.get(normalizedError.category) ?? 0) + 1);
    }
    telemetryBufferFill.set(this.records.length / this.eventLimit);
    this.captureSyntheticSpan(record);
    this.notify(record);
  }

  private captureSyntheticSpan(record: TelemetryRecord): void {
    switch (record.type) {
      case 'TURN_SUBMITTED':
        if (record.turnId) {
          const spanId = buildSpanId(`turn:${record.turnId}`);
          this.turnSpanIds.set(record.turnId, spanId);
          this.activeTurnSpans.set(record.turnId, {
            name: 'turn.lifecycle',
            kind: SpanKinds.INTERNAL,
            traceId: record.traceId,
            spanId,
            startTimeMs: record.timestamp,
            attributes: this.buildSpanAttributes(record, { startEventType: record.type }),
          });
        }
        return;
      case 'TASK_STARTED':
        if (record.taskId) {
          const spanId = buildSpanId(`task:${record.taskId}`);
          this.taskSpanIds.set(record.taskId, spanId);
          this.activeTaskSpans.set(record.taskId, {
            name: 'task.lifecycle',
            kind: SpanKinds.INTERNAL,
            traceId: record.traceId,
            spanId,
            startTimeMs: record.timestamp,
            attributes: this.buildSpanAttributes(record, { startEventType: record.type }),
          });
        }
        return;
      case 'AGENT_SPAWNING':
      case 'AGENT_RUNNING':
        if (record.agentId && !this.activeAgentSpans.has(record.agentId)) {
          const spanId = buildSpanId(`agent:${record.agentId}`);
          const parentSpanId = record.taskId ? this.taskSpanIds.get(record.taskId) : undefined;
          this.agentSpanIds.set(record.agentId, spanId);
          this.activeAgentSpans.set(record.agentId, {
            name: 'agent.lifecycle',
            kind: SpanKinds.INTERNAL,
            traceId: record.traceId,
            spanId,
            ...(parentSpanId ? { parentSpanId } : {}),
            startTimeMs: record.timestamp,
            attributes: this.buildSpanAttributes(record, { startEventType: record.type }),
          });
        }
        return;
      case 'TOOL_EXECUTING':
        if (typeof record.attributes.callId === 'string') {
          const callId = record.attributes.callId;
          const spanId = buildSpanId(`tool:${callId}`);
          const parentSpanId = record.agentId
            ? this.agentSpanIds.get(record.agentId)
            : record.taskId
              ? this.taskSpanIds.get(record.taskId)
              : record.turnId
                ? this.turnSpanIds.get(record.turnId)
                : undefined;
          this.activeToolSpans.set(callId, {
            name: 'tool.execute',
            kind: SpanKinds.INTERNAL,
            traceId: record.traceId,
            spanId,
            ...(parentSpanId ? { parentSpanId } : {}),
            startTimeMs: record.timestamp,
            attributes: this.buildSpanAttributes(record, { startEventType: record.type }),
          });
        }
        return;
      case 'TURN_COMPLETED':
      case 'TURN_ERROR':
      case 'TURN_CANCEL':
      case 'PREFLIGHT_FAIL':
        this.completeSyntheticSpan(record.turnId, this.activeTurnSpans, record, 'turn.lifecycle');
        return;
      case 'TASK_COMPLETED':
      case 'TASK_FAILED':
      case 'TASK_CANCELLED':
        this.completeSyntheticSpan(record.taskId, this.activeTaskSpans, record, 'task.lifecycle');
        return;
      case 'AGENT_COMPLETED':
      case 'AGENT_FAILED':
      case 'AGENT_CANCELLED':
        this.completeSyntheticSpan(record.agentId, this.activeAgentSpans, record, 'agent.lifecycle');
        return;
      case 'TOOL_SUCCEEDED':
      case 'TOOL_FAILED':
      case 'TOOL_CANCELLED': {
        const callId = typeof record.attributes.callId === 'string' ? record.attributes.callId : undefined;
        this.completeSyntheticSpan(callId, this.activeToolSpans, record, 'tool.execute');
        return;
      }
      default:
        return;
    }
  }

  private completeSyntheticSpan(
    key: string | undefined,
    activeMap: Map<string, ActiveSyntheticSpan>,
    record: TelemetryRecord,
    defaultName: string,
  ): void {
    const active = key ? activeMap.get(key) : undefined;
    const durationMs = typeof record.attributes.durationMs === 'number' ? Math.max(0, record.attributes.durationMs) : undefined;
    const synthesized: ActiveSyntheticSpan = active ?? {
      name: defaultName,
      kind: SpanKinds.INTERNAL,
      traceId: record.traceId,
      spanId: buildSpanId(`${defaultName}:${key ?? record.id}`),
      startTimeMs: durationMs !== undefined ? Math.max(0, record.timestamp - durationMs) : record.timestamp,
      attributes: this.buildSpanAttributes(record, { synthesized: true }),
    };
    if (key) activeMap.delete(key);

    const status: SpanStatus = record.error
      ? { code: SpanStatusCode.ERROR, message: record.error.summary }
      : { code: SpanStatusCode.OK };
    const events: SpanEvent[] = [
      {
        name: record.type,
        timestamp: record.timestamp,
        attributes: Object.fromEntries(
          Object.entries(this.buildSpanAttributes(record, { endEventType: record.type }))
            .map(([spanKey, value]) => [spanKey, toAttributeValue(value)])
            .filter((entry): entry is [string, AttributeValue] => entry[1] !== undefined),
        ),
      },
    ];

    appendBounded(this.spans, Object.freeze({
      name: synthesized.name,
      kind: synthesized.kind,
      spanContext: {
        traceId: synthesized.traceId,
        spanId: synthesized.spanId,
        isValid: true,
      },
      ...(synthesized.parentSpanId ? { parentSpanId: synthesized.parentSpanId } : {}),
      startTimeMs: synthesized.startTimeMs,
      endTimeMs: record.timestamp,
      durationMs: Math.max(0, record.timestamp - synthesized.startTimeMs),
      attributes: {
        ...synthesized.attributes,
        ...Object.fromEntries(
          Object.entries(this.buildSpanAttributes(record, { endEventType: record.type }))
            .map(([spanKey, value]) => [spanKey, toAttributeValue(value)])
            .filter((entry): entry is [string, AttributeValue] => entry[1] !== undefined),
        ),
      },
      events,
      status,
      instrumentationScope: `${SERVICE_NAME}/telemetry`,
    }), this.spanLimit);
  }

  private buildSpanAttributes(record: TelemetryRecord, extra: Record<string, unknown> = {}): SpanAttributes {
    const attributes: SpanAttributes = {
      telemetryDomain: record.domain,
      eventType: record.type,
      source: record.source,
      severity: record.severity,
      ...(record.turnId ? { turnId: record.turnId } : {}),
      ...(record.agentId ? { agentId: record.agentId } : {}),
      ...(record.taskId ? { taskId: record.taskId } : {}),
      ...extra,
    };
    for (const [key, value] of Object.entries(record.attributes)) {
      const attributeValue = toAttributeValue(value);
      if (attributeValue !== undefined) {
        attributes[key] = attributeValue;
      }
    }
    if (record.error) {
      attributes.errorCategory = record.error.category;
      attributes.errorSource = record.error.source;
      if (record.error.code) attributes.errorCode = record.error.code;
      if (record.error.statusCode !== undefined) attributes.errorStatusCode = record.error.statusCode;
      if (record.error.provider) attributes.errorProvider = record.error.provider;
      if (record.error.operation) attributes.errorOperation = record.error.operation;
    }
    return attributes;
  }

  /**
   * Implement TelemetryIngestSink.ingestLogs — delegates to ingestExternalLogs.
   * Satisfies the interface expected by DaemonHttpRouterContext.ingestSink.
   */
  ingestLogs(payload: Record<string, unknown>): void {
    this.ingestExternalLogs(payload);
  }

  /**
   * Implement TelemetryIngestSink.ingestTraces — delegates to ingestExternalTraces.
   */
  ingestTraces(payload: Record<string, unknown>): void {
    this.ingestExternalTraces(payload);
  }

  /**
   * Implement TelemetryIngestSink.ingestMetrics — delegates to ingestExternalMetrics.
   */
  ingestMetrics(payload: Record<string, unknown>): void {
    this.ingestExternalMetrics(payload);
  }

  /**
   * Ingest an externally-received OTLP log payload into this service's event
   * buffer. Each entry in `resourceLogs[].scopeLogs[].logRecords[]` is mapped
   * to a TelemetryRecord and appended to `this.records` with domain 'telemetry'.
   * Records are bounded by eventLimit (default 500). Subscribers are notified.
   * Call is synchronous and never throws.
   */
  ingestExternalLogs(payload: Record<string, unknown>): void {
    ingestExternalTelemetryLogs({
      payload,
      eventLimit: this.eventLimit,
      records: this.records,
      recordEvent: (type, record) => this.recordIngestedEvent(type, record),
      nextSequence: () => this.seq++,
    });
  }

  /**
   * Ingest an externally-received OTLP trace payload into this service's span
   * buffer. Each entry in `resourceSpans[].scopeSpans[].spans[]` is mapped
   * to a ReadableSpan and appended to `this.spans`, bounded by spanLimit.
   */
  ingestExternalTraces(payload: Record<string, unknown>): void {
    ingestExternalTelemetryTraces({
      payload,
      eventLimit: this.eventLimit,
      records: this.records,
      spanLimit: this.spanLimit,
      spans: this.spans,
      recordEvent: (type, record) => this.recordIngestedEvent(type, record),
      nextSequence: () => this.seq++,
      peekSequence: () => this.seq,
    });
  }

  /**
   * Ingest an externally-received OTLP metrics payload. Creates a synthetic
   * TelemetryRecord tagged 'OTLP_METRICS_INGEST' and appends it to the event
   * buffer so it is visible on GET /api/v1/telemetry/events.
   * Sentinel is only emitted when at least one metric datapoint is present.
   */
  ingestExternalMetrics(payload: Record<string, unknown>): void {
    ingestExternalTelemetryMetrics({
      payload,
      eventLimit: this.eventLimit,
      records: this.records,
      recordEvent: (type, record) => this.recordIngestedEvent(type, record),
      nextSequence: () => this.seq++,
    });
  }

  private recordIngestedEvent(type: string, record: TelemetryRecord): void {
    this.eventCountsByDomain.set('ops', (this.eventCountsByDomain.get('ops') ?? 0) + 1);
    this.eventCountsByType.set(type, (this.eventCountsByType.get(type) ?? 0) + 1);
    this.notify(record);
  }

  private notify(record: TelemetryRecord): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber(record);
      } catch {
        // Telemetry subscribers must never break the runtime.
      }
    }
  }
}
