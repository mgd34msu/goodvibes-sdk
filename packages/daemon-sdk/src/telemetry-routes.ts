import type { DaemonApiRouteHandlers } from './context.js';
import { buildMissingScopeBody, type AuthenticatedPrincipal } from './http-policy.js';
import { decodeOtlpProtobuf } from './otlp-protobuf.js';
import type { RuntimeEventDomain } from '@pellux/goodvibes-contracts';
import { DaemonErrorCategory } from '@pellux/goodvibes-errors';

type TelemetrySeverity = 'debug' | 'info' | 'warn' | 'error';
type TelemetryViewMode = 'safe' | 'raw';

interface TelemetryFilter {
  readonly limit?: number;
  readonly since?: number;
  readonly until?: number;
  readonly domains?: readonly RuntimeEventDomain[];
  readonly eventTypes?: readonly string[];
  readonly severity?: TelemetrySeverity;
  readonly traceId?: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly agentId?: string;
  readonly taskId?: string;
  readonly cursor?: string;
  readonly view?: TelemetryViewMode;
}

interface TelemetryApiLike {
  getSnapshot(filter: TelemetryFilter, view: TelemetryViewMode, rawAccessible: boolean): {
    readonly generatedAt: number;
    readonly view: TelemetryViewMode;
    readonly rawAccessible: boolean;
    readonly runtime: unknown;
    readonly sessionMetrics: unknown;
    readonly aggregates: unknown;
  };
  listEventPage(filter: TelemetryFilter, view: TelemetryViewMode, rawAccessible: boolean): unknown;
  listErrorPage(filter: TelemetryFilter, view: TelemetryViewMode, rawAccessible: boolean): unknown;
  listSpanPage(filter: TelemetryFilter, view: TelemetryViewMode, rawAccessible: boolean): unknown;
  createStream(req: Request, filter: TelemetryFilter, view: TelemetryViewMode, rawAccessible: boolean): Response;
  buildOtlpTraceDocument(filter: TelemetryFilter, view: TelemetryViewMode): unknown;
  buildOtlpLogDocument(filter: TelemetryFilter, view: TelemetryViewMode): unknown;
  buildOtlpMetricDocument(): unknown;
}

/**
 * Ingest sink — receives parsed OTLP records forwarded by the POST receivers.
 * When null (no ingest sink wired), the route still accepts and acknowledges
 * payloads (to keep client exporters happy) but discards the data.
 */
interface TelemetryIngestSink {
  /** Ingest a batch of log records from an OTLP ExportLogsServiceRequest. */
  ingestLogs(payload: Record<string, unknown>): void;
  /** Ingest a batch of trace spans from an OTLP ExportTraceServiceRequest. */
  ingestTraces(payload: Record<string, unknown>): void;
  /** Ingest a batch of metric data points from an OTLP ExportMetricsServiceRequest. */
  ingestMetrics(payload: Record<string, unknown>): void;
}

interface TelemetryRouteContext {
  readonly telemetryApi: TelemetryApiLike | null;
  readonly resolveAuthenticatedPrincipal: (req: Request) => AuthenticatedPrincipal | null;
  /**
   * Sink for OTLP POST receivers. Must be provided by the caller.
   * In production `DaemonHttpRouter` this is the `TelemetryApiService` instance
   * which stores ingested records in its bounded event buffer (default 500
   * records) and makes them observable via GET /api/v1/telemetry/events.
   * Pass `null` only in test/stub contexts where ingestion is intentionally
   * a no-op — the receivers still return 200 to keep OTLP exporters happy but
   * discard the payload.
   */
  readonly ingestSink: TelemetryIngestSink | null;
}

function parseNumber(value: string | null): number | undefined {
  if (value === null || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseCsv<T extends string>(value: string | null): readonly T[] | undefined {
  if (!value) return undefined;
  const parsed = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean) as T[];
  return parsed.length > 0 ? parsed : undefined;
}

function parseSeverity(value: string | null): TelemetrySeverity | undefined {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error'
    ? value
    : undefined;
}

function parseView(value: string | null): TelemetryViewMode | undefined {
  return value === 'safe' || value === 'raw' ? value : undefined;
}

function buildFilter(url: URL): TelemetryFilter {
  return {
    ...(parseNumber(url.searchParams.get('limit')) !== undefined ? { limit: parseNumber(url.searchParams.get('limit')) } : {}),
    ...(parseNumber(url.searchParams.get('since')) !== undefined ? { since: parseNumber(url.searchParams.get('since')) } : {}),
    ...(parseNumber(url.searchParams.get('until')) !== undefined ? { until: parseNumber(url.searchParams.get('until')) } : {}),
    ...(parseCsv<RuntimeEventDomain>(url.searchParams.get('domains')) ? { domains: parseCsv<RuntimeEventDomain>(url.searchParams.get('domains')) } : {}),
    ...(parseCsv<string>(url.searchParams.get('types')) ? { eventTypes: parseCsv<string>(url.searchParams.get('types')) } : {}),
    ...(parseSeverity(url.searchParams.get('severity')) ? { severity: parseSeverity(url.searchParams.get('severity')) } : {}),
    ...(url.searchParams.get('traceId') ? { traceId: url.searchParams.get('traceId') ?? undefined } : {}),
    ...(url.searchParams.get('sessionId') ? { sessionId: url.searchParams.get('sessionId') ?? undefined } : {}),
    ...(url.searchParams.get('turnId') ? { turnId: url.searchParams.get('turnId') ?? undefined } : {}),
    ...(url.searchParams.get('agentId') ? { agentId: url.searchParams.get('agentId') ?? undefined } : {}),
    ...(url.searchParams.get('taskId') ? { taskId: url.searchParams.get('taskId') ?? undefined } : {}),
    ...(url.searchParams.get('cursor') ? { cursor: url.searchParams.get('cursor') ?? undefined } : {}),
    ...(parseView(url.searchParams.get('view')) ? { view: parseView(url.searchParams.get('view')) } : {}),
  };
}

// ---------------------------------------------------------------------------
// OTLP ingest helpers
// ---------------------------------------------------------------------------

/** Max ingest payload (4 MiB) — reject larger bodies with 413 */
const OTLP_INGEST_MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Accepted content-types for OTLP/HTTP ingest. */
const OTLP_JSON_CONTENT_TYPE = 'application/json';
const OTLP_PROTOBUF_CONTENT_TYPES = new Set(['application/x-protobuf', 'application/protobuf']);

type OtlpIngestKind = 'logs' | 'traces' | 'metrics';

const OTLP_PARTIAL_SUCCESS_KEYS: Record<OtlpIngestKind, string> = {
  logs: 'partialSuccess',
  traces: 'partialSuccess',
  metrics: 'partialSuccess',
};

/**
 * Validate and parse an OTLP HTTP ingest request body.
 * Returns a parsed JSON Record on success, or a Response (error) on failure.
 *
 * Protocol: OTLP/HTTP spec §4.2 — supports JSON and binary protobuf service
 * requests for logs, traces, and metrics.
 */
async function parseOtlpBody(
  req: Request,
  kind: OtlpIngestKind,
): Promise<Record<string, unknown> | Response> {
  const contentType = (req.headers.get('content-type') ?? '').toLowerCase().split(';')[0].trim();

  const acceptsJson = contentType === OTLP_JSON_CONTENT_TYPE;
  const acceptsProtobuf = OTLP_PROTOBUF_CONTENT_TYPES.has(contentType);
  if (!acceptsJson && !acceptsProtobuf) {
    return Response.json(
      {
        error: `Unsupported Content-Type '${contentType}' for OTLP ingest`,
        code: 'UNSUPPORTED_MEDIA_TYPE',
        category: DaemonErrorCategory.BAD_REQUEST,
        hint: `Use '${OTLP_JSON_CONTENT_TYPE}' or 'application/x-protobuf'.`,
      },
      { status: 415 },
    );
  }

  const raw = await req.arrayBuffer();
  if (raw.byteLength > OTLP_INGEST_MAX_BODY_BYTES) {
    return Response.json(
      {
        error: `OTLP ingest payload too large (${raw.byteLength} > ${OTLP_INGEST_MAX_BODY_BYTES} bytes)`,
        code: 'PAYLOAD_TOO_LARGE',
        category: DaemonErrorCategory.BAD_REQUEST,
      },
      { status: 413 },
    );
  }

  if (acceptsProtobuf) {
    try {
      return decodeOtlpProtobuf(kind, new Uint8Array(raw));
    } catch {
      return Response.json(
        { error: 'OTLP ingest body is not valid protobuf', code: 'INVALID_PAYLOAD', category: DaemonErrorCategory.BAD_REQUEST },
        { status: 400 },
      );
    }
  }

  try {
    const text = new TextDecoder().decode(raw);
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return Response.json(
        { error: 'OTLP ingest body must be a JSON object', code: 'INVALID_PAYLOAD', category: DaemonErrorCategory.BAD_REQUEST },
        { status: 400 },
      );
    }
    return parsed as Record<string, unknown>;
  } catch {
    return Response.json(
      { error: 'OTLP ingest body is not valid JSON', code: 'INVALID_PAYLOAD', category: DaemonErrorCategory.BAD_REQUEST },
      { status: 400 },
    );
  }
}

function otlpIngestSuccess(kind: OtlpIngestKind): Response {
  // Per OTLP/HTTP spec: respond with ExportXxxServiceResponse shape.
  // partialSuccess omitted when empty (all records accepted).
  return Response.json({ [OTLP_PARTIAL_SUCCESS_KEYS[kind]]: {} });
}

function unavailable(): Response {
  return Response.json({
    error: 'Telemetry API unavailable',
    code: 'TELEMETRY_UNAVAILABLE',
    category: DaemonErrorCategory.SERVICE,
    source: 'runtime',
    recoverable: true,
    hint: 'Start the daemon runtime and ensure the runtime store is available before reading telemetry.',
    status: 503,
  }, { status: 503 });
}

function invalidCursor(error: unknown): Response {
  return Response.json({
    error: error instanceof Error ? error.message : 'Invalid telemetry cursor',
    code: 'INVALID_CURSOR',
    category: DaemonErrorCategory.BAD_REQUEST,
    source: 'runtime',
    recoverable: false,
    hint: 'Use the nextCursor returned by the previous telemetry page, or omit cursor to start from the newest records.',
    status: 400,
  }, { status: 400 });
}

function authenticateTelemetryRequest(
  context: TelemetryRouteContext,
  req: Request,
  requestedView: TelemetryViewMode,
): { principal: AuthenticatedPrincipal; view: TelemetryViewMode; rawAccessible: boolean } | Response {
  const principal = context.resolveAuthenticatedPrincipal(req);
  if (!principal) {
    return Response.json({
      error: 'Authentication required for telemetry access',
      code: 'AUTH_REQUIRED',
      category: DaemonErrorCategory.AUTHENTICATION,
      source: 'runtime',
      recoverable: false,
      hint: 'Authenticate with the operator shared token or an authenticated user session before calling telemetry APIs.',
      status: 401,
    }, { status: 401 });
  }

  const missingRead = buildMissingScopeBody('telemetry access', ['read:telemetry'], principal.scopes);
  if (missingRead) {
    return Response.json({
      error: missingRead.error,
      code: 'MISSING_SCOPE',
      category: DaemonErrorCategory.AUTHORIZATION,
      source: 'permission',
      recoverable: false,
      hint: 'Use a token or session with the read:telemetry scope, or elevate to an admin/shared-token session.',
      status: 403,
      detail: JSON.stringify(missingRead),
    }, { status: 403 });
  }

  const rawAccessible = principal.admin || principal.scopes.includes('read:telemetry-sensitive');
  if (requestedView === 'raw' && !rawAccessible) {
    return Response.json({
      error: 'Raw telemetry view requires elevated telemetry scope',
      code: 'MISSING_SCOPE',
      category: DaemonErrorCategory.AUTHORIZATION,
      source: 'permission',
      recoverable: false,
      hint: 'Use an admin/shared-token session or a token granted read:telemetry-sensitive to access raw telemetry payloads.',
      status: 403,
    }, { status: 403 });
  }

  return {
    principal,
    view: requestedView,
    rawAccessible,
  };
}

export function createDaemonTelemetryRouteHandlers(
  context: TelemetryRouteContext,
): Pick<
  DaemonApiRouteHandlers,
  | 'getTelemetrySnapshot'
  | 'getTelemetryEvents'
  | 'getTelemetryErrors'
  | 'getTelemetryTraces'
  | 'getTelemetryMetrics'
  | 'createTelemetryEventStream'
  | 'getTelemetryOtlpTraces'
  | 'getTelemetryOtlpLogs'
  | 'getTelemetryOtlpMetrics'
  | 'postTelemetryOtlpLogs'
  | 'postTelemetryOtlpTraces'
  | 'postTelemetryOtlpMetrics'
> {
  return {
    getTelemetrySnapshot: (req) => {
      if (!context.telemetryApi) return unavailable();
      const url = new URL(req.url);
      const filter = buildFilter(url);
      const access = authenticateTelemetryRequest(context, req, filter.view ?? 'safe');
      if (access instanceof Response) return access;
      return Response.json(context.telemetryApi.getSnapshot(filter, access.view, access.rawAccessible));
    },
    getTelemetryEvents: (req) => {
      if (!context.telemetryApi) return unavailable();
      const url = new URL(req.url);
      const filter = buildFilter(url);
      const access = authenticateTelemetryRequest(context, req, filter.view ?? 'safe');
      if (access instanceof Response) return access;
      try {
        return Response.json(context.telemetryApi.listEventPage(filter, access.view, access.rawAccessible));
      } catch (error) {
        return invalidCursor(error);
      }
    },
    getTelemetryErrors: (req) => {
      if (!context.telemetryApi) return unavailable();
      const url = new URL(req.url);
      const filter = buildFilter(url);
      const access = authenticateTelemetryRequest(context, req, filter.view ?? 'safe');
      if (access instanceof Response) return access;
      try {
        return Response.json(context.telemetryApi.listErrorPage(filter, access.view, access.rawAccessible));
      } catch (error) {
        return invalidCursor(error);
      }
    },
    getTelemetryTraces: (req) => {
      if (!context.telemetryApi) return unavailable();
      const url = new URL(req.url);
      const filter = buildFilter(url);
      const access = authenticateTelemetryRequest(context, req, filter.view ?? 'safe');
      if (access instanceof Response) return access;
      try {
        return Response.json(context.telemetryApi.listSpanPage(filter, access.view, access.rawAccessible));
      } catch (error) {
        return invalidCursor(error);
      }
    },
    getTelemetryMetrics: (req) => {
      if (!context.telemetryApi) return unavailable();
      const url = new URL(req.url);
      const filter = buildFilter(url);
      const access = authenticateTelemetryRequest(context, req, filter.view ?? 'safe');
      if (access instanceof Response) return access;
      const snapshot = context.telemetryApi.getSnapshot(filter, access.view, access.rawAccessible);
      return Response.json({
        version: 1,
        generatedAt: snapshot.generatedAt,
        view: snapshot.view,
        rawAccessible: snapshot.rawAccessible,
        runtime: snapshot.runtime,
        sessionMetrics: snapshot.sessionMetrics,
        aggregates: snapshot.aggregates,
      });
    },
    createTelemetryEventStream: (req) => {
      if (!context.telemetryApi) return unavailable();
      const filter = buildFilter(new URL(req.url));
      const access = authenticateTelemetryRequest(context, req, filter.view ?? 'safe');
      if (access instanceof Response) return access;
      try {
        return context.telemetryApi.createStream(req, filter, access.view, access.rawAccessible);
      } catch (error) {
        return invalidCursor(error);
      }
    },
    getTelemetryOtlpTraces: (req) => {
      if (!context.telemetryApi) return unavailable();
      const url = new URL(req.url);
      const filter = buildFilter(url);
      const access = authenticateTelemetryRequest(context, req, filter.view ?? 'safe');
      if (access instanceof Response) return access;
      return Response.json(context.telemetryApi.buildOtlpTraceDocument(filter, access.view));
    },
    getTelemetryOtlpLogs: (req) => {
      if (!context.telemetryApi) return unavailable();
      const url = new URL(req.url);
      const filter = buildFilter(url);
      const access = authenticateTelemetryRequest(context, req, filter.view ?? 'safe');
      if (access instanceof Response) return access;
      return Response.json(context.telemetryApi.buildOtlpLogDocument(filter, access.view));
    },
    getTelemetryOtlpMetrics: (req) => {
      if (!context.telemetryApi) return unavailable();
      const access = authenticateTelemetryRequest(context, req, 'safe');
      if (access instanceof Response) return access;
      return Response.json(context.telemetryApi.buildOtlpMetricDocument());
    },
    // -------------------------------------------------------------------------
    // OTLP POST ingest receivers
    // -------------------------------------------------------------------------
    postTelemetryOtlpLogs: async (req) => {
      const auth = context.resolveAuthenticatedPrincipal(req);
      if (!auth) {
        return Response.json(
          { error: 'Authentication required for OTLP ingest', code: 'AUTH_REQUIRED', category: DaemonErrorCategory.AUTHENTICATION, status: 401 },
          { status: 401 },
        );
      }
      const bodyOrErr = await parseOtlpBody(req, 'logs');
      if (bodyOrErr instanceof Response) return bodyOrErr;
      context.ingestSink?.ingestLogs(bodyOrErr);
      return otlpIngestSuccess('logs');
    },
    postTelemetryOtlpTraces: async (req) => {
      const auth = context.resolveAuthenticatedPrincipal(req);
      if (!auth) {
        return Response.json(
          { error: 'Authentication required for OTLP ingest', code: 'AUTH_REQUIRED', category: DaemonErrorCategory.AUTHENTICATION, status: 401 },
          { status: 401 },
        );
      }
      const bodyOrErr = await parseOtlpBody(req, 'traces');
      if (bodyOrErr instanceof Response) return bodyOrErr;
      context.ingestSink?.ingestTraces(bodyOrErr);
      return otlpIngestSuccess('traces');
    },
    postTelemetryOtlpMetrics: async (req) => {
      const auth = context.resolveAuthenticatedPrincipal(req);
      if (!auth) {
        return Response.json(
          { error: 'Authentication required for OTLP ingest', code: 'AUTH_REQUIRED', category: DaemonErrorCategory.AUTHENTICATION, status: 401 },
          { status: 401 },
        );
      }
      const bodyOrErr = await parseOtlpBody(req, 'metrics');
      if (bodyOrErr instanceof Response) return bodyOrErr;
      context.ingestSink?.ingestMetrics(bodyOrErr);
      return otlpIngestSuccess('metrics');
    },
  };
}
