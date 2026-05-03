/**
 * OpenTelemetry traceparent/tracestate propagation helper.
 *
 * Zero-dependency: detects `@opentelemetry/api` at runtime.
 * If OTel is absent, all functions are no-ops.
 *
 * Dynamic detection uses an indirect import pattern to prevent bundlers
 * (esbuild, Rollup, Miniflare/workerd) from flagging the import as an
 * unresolvable dynamic specifier. The module name is never a literal in
 * any import() call that the bundler sees.
 *
 * W3C Trace Context spec: https://www.w3.org/TR/trace-context/
 */

interface SpanContext {
  traceId: string;
  spanId: string;
  traceFlags: number;
  traceState?: { serialize(): string } | null;
}

interface Span {
  spanContext(): SpanContext;
}

interface OtelApi {
  trace: {
    getActiveSpan(): Span | undefined;
  };
}

type SyncRequire = (moduleName: string) => unknown;

/** Cached result of OTel detection. `null` = not available. `undefined` = not yet probed. */
let otelApi: OtelApi | null | undefined = undefined;

/** Internal override value for the test injection seam. */
let _otelModuleOverride: OtelApi | null | undefined = undefined;

/**
 * Set the OTel module override for testing. Pass `undefined` to clear.
 * Calling this bypasses dynamic import and require-based detection.
 *
 * @internal — for testing only, do NOT use in production code.
 */
export function setOtelModuleOverride(api: OtelApi | null | undefined): void {
  _otelModuleOverride = api;
}

/**
 * Get the current OTel module override (for test inspection).
 * @internal
 */
export function getOtelModuleOverride(): OtelApi | null | undefined {
  return _otelModuleOverride;
}

/**
 * Reset both the module-level cache and the test injection seam.
 * Call this in `afterEach` when using `setOtelModuleOverride` in tests.
 *
 * @internal — for testing only.
 */
export function __resetOtelCache(): void {
  otelApi = undefined;
  _otelModuleOverride = undefined;
}

/**
 * Dynamic import that is opaque to bundlers.
 * `new Function(...)` is not statically analysed for import() specifiers.
 */
function dynamicImport(moduleName: string): Promise<unknown> {
  // Using Function constructor prevents bundler static analysis of import().
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  return new Function('m', 'return import(m)')(moduleName) as Promise<unknown>;
}

async function probeOtel(): Promise<OtelApi | null> {
  // Test injection seam takes highest priority.
  if (_otelModuleOverride !== undefined) return _otelModuleOverride;
  if (otelApi !== undefined) return otelApi;
  try {
    const mod = await dynamicImport('@opentelemetry/api');
    otelApi = mod as OtelApi;
  } catch (error) {
    void error;
    otelApi = null;
  }
  return otelApi;
}

function probeOtelSync(): OtelApi | null {
  // Test injection seam takes highest priority.
  if (_otelModuleOverride !== undefined) return _otelModuleOverride;
  if (otelApi !== undefined) return otelApi;
  try {
    // Use globalThis.require via indirect reference to avoid bundler module resolution.
    const nodeRequire = typeof globalThis !== 'undefined'
      ? (globalThis as { require?: SyncRequire }).require
      : undefined;
    if (typeof nodeRequire === 'function') {
      otelApi = nodeRequire('@opentelemetry/api') as OtelApi;
    } else {
      otelApi = null;
    }
  } catch (error) {
    void error;
    otelApi = null;
  }
  return otelApi;
}

function buildTraceparent(ctx: SpanContext): string {
  const flags = (ctx.traceFlags & 0xff).toString(16).padStart(2, '0');
  return `00-${ctx.traceId}-${ctx.spanId}-${flags}`;
}

/**
 * Inject W3C Trace Context headers (`traceparent`, `tracestate`) if an active
 * OTel span is available. Synchronous; uses require-based detection.
 *
 * @param headers - Mutable header record to augment in-place.
 */
export function injectTraceparent(headers: Record<string, string>): void {
  const api = probeOtelSync();
  if (!api) return;
  try {
    const span = api.trace.getActiveSpan();
    if (!span) return;
    const ctx = span.spanContext();
    if (!ctx.traceId || !ctx.spanId) return;
    headers['traceparent'] = buildTraceparent(ctx);
    const traceState = ctx.traceState?.serialize();
    if (traceState) {
      headers['tracestate'] = traceState;
    }
  } catch (error) {
    void error;
    // Never let OTel errors propagate into transport logic.
  }
}

/**
 * Async variant — probes OTel via dynamic import on first call, then caches.
 * Use for SSE/WS connection setup where async is acceptable.
 *
 * @param headers - Mutable header record to augment in-place.
 */
export async function injectTraceparentAsync(headers: Record<string, string>): Promise<void> {
  const api = await probeOtel();
  if (!api) return;
  try {
    const span = api.trace.getActiveSpan();
    if (!span) return;
    const ctx = span.spanContext();
    if (!ctx.traceId || !ctx.spanId) return;
    headers['traceparent'] = buildTraceparent(ctx);
    const traceState = ctx.traceState?.serialize();
    if (traceState) {
      headers['tracestate'] = traceState;
    }
  } catch (error) {
    void error;
    // Never let OTel errors propagate into transport logic.
  }
}
