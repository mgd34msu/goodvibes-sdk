export interface SpanContext {
  traceId: string;
  spanId: string;
  traceFlags: number;
  traceState?: { serialize(): string } | null | undefined;
}

export interface Span {
  spanContext(): SpanContext;
}

export interface OtelApi {
  trace: {
    getActiveSpan(): Span | undefined;
  };
}

let cachedOtelApi: OtelApi | null | undefined = undefined;
let otelModuleOverride: OtelApi | null | undefined = undefined;

export function readCachedOtelApi(): OtelApi | null | undefined {
  return cachedOtelApi;
}

export function cacheOtelApi(api: OtelApi | null): void {
  cachedOtelApi = api;
}

export function readOtelModuleOverride(): OtelApi | null | undefined {
  return otelModuleOverride;
}

export function setOtelModuleOverride(api: OtelApi | null | undefined): void {
  otelModuleOverride = api;
}

export function resetOtelState(): void {
  cachedOtelApi = undefined;
  otelModuleOverride = undefined;
}
