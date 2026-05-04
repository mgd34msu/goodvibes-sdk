/**
 * OTLP HTTP span exporter with fail-safe queue and retry.
 *
 * All exports are non-blocking — spans are enqueued immediately and
 * exported asynchronously. Export failures are logged but never thrown.
 * The runtime is never blocked by OTLP connectivity issues.
 *
 * Compatible with the OTLP/HTTP JSON format for traces (v1/traces).
 */
import type { ReadableSpan, SpanExporter } from '../types.js';
import type { OtlpConfig, ExportResult } from './types.js';
import { DEFAULT_OTLP_CONFIG, DEFAULT_QUEUE_CONFIG } from './types.js';
import { ExportQueue } from './queue.js';
import { logger } from '../../../utils/logger.js';
import { instrumentedFetch } from '../../../utils/fetch-with-timeout.js';

/**
 * Serialises a ReadableSpan[] into OTLP/HTTP JSON format (simplified).
 *
 * This produces a minimal protobuf-JSON compatible payload understood by
 * OTLP receivers (e.g. OpenTelemetry Collector, Tempo, Jaeger v2).
 */
function serialiseSpans(spans: ReadableSpan[]): string {
  if (spans.length === 0) return JSON.stringify({ resourceSpans: [] });
  const resourceSpans = [
    {
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: 'goodvibes-sdk' } },
        ],
      },
      scopeSpans: [
        {
          scope: { name: spans[0]?.instrumentationScope ?? 'goodvibes-sdk' },
          spans: spans.map((s) => ({
            traceId: s.spanContext.traceId,
            spanId: s.spanContext.spanId,
            parentSpanId: s.parentSpanId ?? '',
            name: s.name,
            kind: s.kind,
            startTimeUnixNano: String(s.startTimeMs * 1_000_000),
            endTimeUnixNano: String(s.endTimeMs * 1_000_000),
            attributes: Object.entries(s.attributes).map(([key, value]) => ({
              key,
              value: attributeValue(value),
            })),
            events: s.events.map((e) => ({
              name: e.name,
              timeUnixNano: String(e.timestamp * 1_000_000),
              attributes: Object.entries(e.attributes ?? {}).map(([k, v]) => ({
                key: k,
                value: attributeValue(v),
              })),
            })),
            status: { code: s.status.code, message: s.status.message ?? '' },
          })),
        },
      ],
    },
  ];
  return JSON.stringify({ resourceSpans });
}

/** Maps an AttributeValue to an OTLP AnyValue object. */
function attributeValue(
  v: string | number | boolean | string[] | number[] | boolean[],
): Record<string, unknown> {
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'number') return { doubleValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  if (Array.isArray(v)) {
    if (v.length === 0) return { arrayValue: { values: [] } };
    const first = v[0]!;
    if (typeof first === 'string')
      return {
        arrayValue: {
          values: (v as string[]).map((s) => ({ stringValue: s })),
        },
      };
    if (typeof first === 'number')
      return {
        arrayValue: {
          values: (v as number[]).map((n) => ({ doubleValue: n })),
        },
      };
    return {
      arrayValue: {
        values: (v as boolean[]).map((b) => ({ boolValue: b })),
      },
    };
  }
  return { stringValue: String(v) };
}

/**
 * Non-blocking OTLP/HTTP span exporter.
 *
 * Spans are batched and exported via an internal fail-safe queue.
 * The exporter never throws — failures are logged and retried per
 * the configured retry policy.
 *
 * @example
 * ```ts
 * const exporter = new OtlpExporter({
 *   endpoint: 'http://localhost:4318/v1/traces',
 *   batchSize: 256,
 *   timeoutMs: 8000,
 *   headers: { 'x-api-key': 'my-token' },
 * });
 * ```
 */
export class OtlpExporter implements SpanExporter {
  readonly name = 'otlp';

  private readonly _config: Required<Omit<OtlpConfig, 'queue' | 'retry' | 'headers'>> & {
    readonly headers: Record<string, string>;
  };
  private readonly _queue: ExportQueue;
  private readonly _pending: ReadableSpan[] = [];

  constructor(config: OtlpConfig) {
    this._config = {
      endpoint: config.endpoint,
      batchSize: config.batchSize ?? DEFAULT_OTLP_CONFIG.batchSize,
      timeoutMs: config.timeoutMs ?? DEFAULT_OTLP_CONFIG.timeoutMs,
      headers: config.headers ?? {},
    };

    const queueConfig = {
      ...DEFAULT_QUEUE_CONFIG,
      ...config.queue,
      retry: {
        ...DEFAULT_QUEUE_CONFIG.retry,
        ...config.queue?.retry,
        ...config.retry,
      },
    };

    this._queue = new ExportQueue(
      (batch) => this._httpExport(batch),
      queueConfig,
      (result) => this._onExportResult(result),
    );
  }

  /**
   * Accept completed spans.
   *
   * Spans are accumulated into the pending buffer. When the buffer
   * reaches `batchSize`, a batch is enqueued for async export.
   * Remaining spans are flushed on `flush()` or `shutdown()`.
   *
   * Never throws.
   */
  async export(spans: ReadableSpan[]): Promise<void> {
    try {
      this._pending.push(...spans);
      while (this._pending.length >= this._config.batchSize) {
        const batch = this._pending.splice(0, this._config.batchSize);
        this._queue.enqueue(batch);
      }
    } catch (err) {
      // OBS-07: use structured logger, not console
      logger.error('[OtlpExporter] export() error (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Flush any pending (unbatched) spans and wait for queue to drain.
   * Never throws.
   */
  async flush(): Promise<void> {
    try {
      if (this._pending.length > 0) {
        const batch = this._pending.splice(0);
        this._queue.enqueue(batch);
      }
      await this._queue.drain();
    } catch (err) {
      // OBS-07: use structured logger, not console
      logger.error('[OtlpExporter] flush() error (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Flush remaining spans and shut down the export queue.
   * Best-effort — waits up to drainTimeoutMs.
   * Never throws.
   */
  async shutdown(): Promise<void> {
    try {
      if (this._pending.length > 0) {
        const batch = this._pending.splice(0);
        this._queue.enqueue(batch);
      }
      await this._queue.shutdown();
    } catch (err) {
      // OBS-07: use structured logger, not console
      logger.error('[OtlpExporter] shutdown() error (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ── Private HTTP transport ────────────────────────────────────────────────

  /**
   * Performs the actual HTTP POST to the OTLP endpoint.
   * Called exclusively by the ExportQueue — must not throw.
   */
  private async _httpExport(batch: ReadableSpan[]): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this._config.timeoutMs,
    );
    timer.unref?.();

    try {
      const body = serialiseSpans(batch);
      const response = await instrumentedFetch(this._config.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this._config.headers,
        },
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(
          `OTLP endpoint returned HTTP ${response.status}: ${response.statusText}`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Result callback — logs failures without throwing.
   */
  private _onExportResult(result: ExportResult): void {
    if (result.code === 'failure') {
      // OBS-07: use structured logger so OTLP exporter failures appear in activity log
      logger.error('[OtlpExporter] Export failed permanently — spans lost', {
        spanCount: result.spanCount,
        attempts: result.attempts,
        error: result.error,
      });
    } else if (result.code === 'dropped') {
      // OBS-07: use structured logger
      logger.warn('[OtlpExporter] Dropped spans due to queue overflow', {
        spanCount: result.spanCount,
      });
    }
  }
}
