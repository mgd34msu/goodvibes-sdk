/**
 * Platform-service config interfaces: provider batching, the Cloudflare edge
 * estate, telemetry export, and at-rest redaction/retention. Split out of
 * schema-types.ts so that file stays under its grandfathered line ceiling;
 * re-exported from schema-types.ts so import sites are unchanged.
 */
export type BatchMode = 'off' | 'explicit' | 'eligible-by-default';
export type BatchFallbackMode = 'live' | 'fail';
export type BatchQueueBackend = 'local' | 'cloudflare';

export interface BatchConfig {
  mode: BatchMode;
  fallback: BatchFallbackMode;
  queueBackend: BatchQueueBackend;
  tickIntervalMs: number;
  maxDelayMs: number;
  maxJobsPerProviderBatch: number;
  maxQueuePayloadBytes: number;
  maxQueueMessagesPerDay: number;
}

export interface CloudflareConfig {
  enabled: boolean;
  freeTierMode: boolean;
  accountId: string;
  apiTokenRef: string;
  zoneId: string;
  zoneName: string;
  workerName: string;
  workerSubdomain: string;
  workerHostname: string;
  workerBaseUrl: string;
  daemonBaseUrl: string;
  daemonHostname: string;
  workerTokenRef: string;
  workerClientTokenRef: string;
  workerCron: string;
  queueName: string;
  deadLetterQueueName: string;
  tunnelName: string;
  tunnelId: string;
  tunnelTokenRef: string;
  accessAppId: string;
  accessServiceTokenId: string;
  accessServiceTokenRef: string;
  kvNamespaceName: string;
  kvNamespaceId: string;
  durableObjectNamespaceName: string;
  durableObjectNamespaceId: string;
  r2BucketName: string;
  secretsStoreName: string;
  secretsStoreId: string;
  maxQueueOpsPerDay: number;
}

export interface TelemetryConfig {
  /**
   * When true, raw prompt/response content remains visible in telemetry events
   * (and view='raw' is permitted for operators). Default false: those fields are
   * redacted via the standard sanitizer at safe-view egress. Set true only in
   * non-production environments; a startup WARN is logged.
   */
  includeRawPrompts: boolean;
  /**
   * Export permission/policy decision-log records to an OTLP endpoint. Off by default (export-only, no
   * ingestion). When enabled with an endpoint, each decision is mapped to OTLP span and/or log semantics
   * and POSTed as OTLP/HTTP JSON. See `decisionOtlpSignal` for which record shape is emitted.
   */
  decisionOtlpEnabled: boolean;
  /** OTLP/HTTP JSON endpoint base for decision-log export (empty = disabled). */
  decisionOtlpEndpoint: string;
  /** Which OTLP record shape to emit for each decision: span, log, or both. */
  decisionOtlpSignal: 'span' | 'log' | 'both';
  /**
   * OpenTelemetry instrumentation mode: off (no OTel SDK init), in-process
   * (spans created and exported in-process only), or remote-export (spans
   * additionally exported over OTLP/gRPC to the configured collector).
   * Switching away from off requires a restart. Default off.
   */
  otelMode: 'off' | 'in-process' | 'remote-export';
}

/** At-rest redaction + retention policy for the transcript journal and execution ledger. */
export interface AtRestConfig {
  /** Redact secret/credential patterns at write time (default true). */
  redactionEnabled: boolean;
  /** Age cap (days) for on-disk journal/ledger files (default 30). */
  retentionMaxAgeDays: number;
  /** Total-size cap (MB) across the on-disk journal/ledger file set (default 512). */
  retentionMaxTotalMb: number;
}
