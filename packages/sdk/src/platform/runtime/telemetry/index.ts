/**
 * Runtime telemetry module — OTel-compatible tracing and metrics.
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
  readonly featureFlags?: Pick<FeatureFlagManager, 'isEnabled'> | null;
  readonly otlp?: OtlpConfig;
}

/**
 * Create a telemetry provider — a paired RuntimeTracer and RuntimeMeter.
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
  const tracer = new RuntimeTracer(
    config?.tracer ?? {
      scope: 'goodvibes-sdk',
      enabled: foundationEnabled,
      exporters: remoteExportEnabled && options.otlp ? [new OtlpExporter(options.otlp)] : [],
    },
  );

  const meter = new RuntimeMeter(
    config?.meter ?? {
      scope: 'goodvibes-sdk',
    },
  );

  return { tracer, meter };
}
