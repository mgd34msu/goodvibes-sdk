/**
 * Runtime telemetry module, OTel-compatible tracing and metrics.
 *
 * Provides a lightweight telemetry provider factory that wires together
 * a RuntimeTracer and RuntimeMeter with configurable exporters.
 *
 * @example
 * ```ts
 * import { createTelemetryProvider } from './index.js';
 * import { LocalLedgerExporter } from './exporters/index.js';
 *
 * const { tracer, meter } = createTelemetryProvider({
 *   tracer: {
 *     scope: 'goodvibes-sdk',
 *     enabled: true,
 *     exporters: [new LocalLedgerExporter({ filePath: '/tmp/spans.jsonl' })],
 *   },
 *   meter: { scope: 'goodvibes-sdk' },
 * });
 * ```
 */
import { RuntimeTracer } from './tracer.js';
import { RuntimeMeter } from './meter.js';
import type { TelemetryProviderConfig } from './types.js';
import type { FeatureFlagManager } from '../feature-flags/index.js';
import { OtlpExporter } from './exporters/index.js';
import type { OtlpConfig } from './exporters/index.js';
import { logger } from '../../utils/logger.js';
import { installPlatformTracer } from '../metrics.js';

// Re-export all public types
export type {
  AttributeValue,
  SpanAttributes,
  SpanContext,
  SpanEvent,
  SpanKind,
  SpanStatus,
  SpanStatusCode,
  ReadableSpan,
  Span,
  SpanExporter,
  Counter,
  Histogram,
  HistogramSnapshot,
  Gauge,
  MetricLabels,
  TracerConfig,
  MeterConfig,
  TelemetryProviderConfig,
} from './types.js';
export { SpanStatusCode as SpanStatusCodes, SpanKind as SpanKinds } from './types.js';

// Re-export tracer and meter classes
export { RuntimeTracer } from './tracer.js';
export { RuntimeMeter } from './meter.js';
export type {
  TelemetrySeverity,
  TelemetryViewMode,
  TelemetryFilter,
  TelemetryRecord,
  TelemetryPageInfo,
  TelemetryListResponse,
  TelemetryCapabilities,
  TelemetryAggregates,
  TelemetryRuntimeSnapshot,
  TelemetrySnapshot,
} from './api.js';
export { TelemetryApiService } from './api.js';

// Re-export span helpers
export type {
  TurnSpanContext,
  TurnSpanEndContext,
  ToolSpanContext,
  ToolSpanEndContext,
  ToolPhase,
  LlmSpanContext,
  LlmSpanEndContext,
  LlmTokenUsage,
  PluginSpanContext,
  PluginSpanEndContext,
  PluginPhase,
  McpSpanContext,
  McpSpanEndContext,
  McpPhase,
  TransportSpanContext,
  TransportSpanEndContext,
  TransportPhase,
  TaskSpanContext,
  TaskSpanEndContext,
  TaskPhase,
  AgentSpanContext,
  AgentSpanEndContext,
  AgentPhase,
  PermissionSpanContext,
  PermissionSpanEndContext,
  PermissionPhase,
  SessionSpanContext,
  SessionSpanEndContext,
  SessionPhase,
  CompactionSpanContext,
  CompactionSpanEndContext,
  CompactionPhase,
  HealthCascadeSpanContext,
} from './spans/index.js';
export {
  startTurnSpan,
  endTurnSpan,
  startToolSpan,
  recordToolPhase,
  endToolSpan,
  startLlmSpan,
  recordLlmStreamStart,
  endLlmSpan,
  startPluginSpan,
  recordPluginPhase,
  endPluginSpan,
  startMcpSpan,
  recordMcpPhase,
  endMcpSpan,
  startTransportSpan,
  recordTransportPhase,
  endTransportSpan,
  startTaskSpan,
  recordTaskPhase,
  endTaskSpan,
  startAgentSpan,
  recordAgentPhase,
  endAgentSpan,
  startPermissionSpan,
  recordPermissionPhase,
  endPermissionSpan,
  startSessionSpan,
  recordSessionPhase,
  endSessionSpan,
  startCompactionSpan,
  recordCompactionPhase,
  endCompactionSpan,
  recordHealthCascadeSpan,
} from './spans/index.js';

// Re-export exporters
export type { LocalLedgerConfig, ConsoleVerbosity, ConsoleExporterConfig, OtlpConfig } from './exporters/index.js';
export { LocalLedgerExporter, ConsoleExporter, OtlpExporter } from './exporters/index.js';

// Re-export instrumentation
export type { InstrumentationHandle } from './instrumentation/index.js';
export { DomainBridge, createInstrumentation } from './instrumentation/index.js';

/** Alias for TelemetryProviderConfig to match the factory parameter name. */
export type TelemetryConfig = TelemetryProviderConfig;

export interface TelemetryProviderOptions {
  readonly featureFlags?: Pick<FeatureFlagManager, 'isEnabled'> | null | undefined;
  readonly otlp?: OtlpConfig | undefined;
}

/**
 * The collector `telemetry.otelMode: 'remote-export'` exports to, when the
 * caller named none.
 *
 * The mode's description says spans go "to the configured collector", and there
 * is no goodvibes config key naming one, so this reads the OpenTelemetry
 * standard environment variables every collector deployment already sets, rather
 * than inventing a second place to say the same thing. The traces-specific
 * variable wins over the general one, which is the order the OTel specification
 * defines; the general one gets the conventional `/v1/traces` path appended.
 *
 * Returns undefined when neither is set, in which case remote-export records
 * spans in-process and says so once at construction, instead of silently
 * behaving like the mode below it.
 */
function otlpFromEnvironment(): OtlpConfig | undefined {
  const specific = process.env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT']?.trim();
  const general = process.env['OTEL_EXPORTER_OTLP_ENDPOINT']?.trim();
  const endpoint = specific && specific.length > 0
    ? specific
    : general && general.length > 0
      ? `${general.replace(/\/+$/, '')}/v1/traces`
      : undefined;
  if (endpoint === undefined) return undefined;
  return { endpoint, batchSize: 512, timeoutMs: 10_000 };
}

/**
 * Create a telemetry provider, a paired RuntimeTracer and RuntimeMeter.
 *
 * When no config is supplied, a no-op provider is returned:
 * - Tracer is disabled (all spans are no-ops).
 * - Meter is initialised with the default scope `'goodvibes-sdk'`.
 *
 * @param config - Optional telemetry provider configuration.
 * @returns An object with `tracer` and `meter` instances.
 */
export function createTelemetryProvider(config?: TelemetryConfig, options: TelemetryProviderOptions = {}): {
  tracer: RuntimeTracer;
  meter: RuntimeMeter;
} {
  const foundationEnabled = options.featureFlags?.isEnabled('otel-foundation') ?? false;
  const remoteExportEnabled = foundationEnabled && (options.featureFlags?.isEnabled('otel-remote-export') ?? false);
  // 'remote-export' asks for an OTLP exporter; the endpoint comes from the
  // caller when it has one and from the OTel standard environment otherwise.
  const otlp = remoteExportEnabled ? options.otlp ?? otlpFromEnvironment() : undefined;
  if (remoteExportEnabled && otlp === undefined) {
    logger.warn(
      '[telemetry] telemetry.otelMode is remote-export with no OTLP endpoint, spans are recorded in-process only. '
      + 'Set OTEL_EXPORTER_OTLP_TRACES_ENDPOINT (or OTEL_EXPORTER_OTLP_ENDPOINT) to export them.',
    );
  }
  const tracer = new RuntimeTracer(
    config?.tracer ?? {
      scope: 'goodvibes-sdk',
      enabled: foundationEnabled,
      exporters: otlp ? [new OtlpExporter(otlp)] : [],
    },
  );

  const meter = new RuntimeMeter(
    config?.meter ?? {
      scope: 'goodvibes-sdk',
    },
  );

  return { tracer, meter };
}

/**
 * Build the composed runtime's telemetry and make its tracer the platform's.
 *
 * The one line `createRuntimeServices` calls, and where `telemetry.otelMode`
 * stops being decorative: the mode drives the two feature gates
 * {@link createTelemetryProvider} reads, and installing the resulting tracer is
 * what gives the platform's instrumentation something to open spans on. Until
 * this existed the provider had no callers at all, so every mode behaved like
 * 'off'.
 *
 * Returns the provider so a host that wants the meter as well can keep it.
 */
export function installComposedTelemetry(
  featureFlags: Pick<FeatureFlagManager, 'isEnabled'>,
): { tracer: RuntimeTracer; meter: RuntimeMeter } {
  const provider = createTelemetryProvider(undefined, { featureFlags });
  installPlatformTracer(provider.tracer);
  return provider;
}
