import {
  DaemonErrorCategory,
  type DaemonErrorSource,
  GoodVibesSdkError,
  isStructuredDaemonErrorBody,
  type StructuredDaemonErrorBody,
} from '@pellux/goodvibes-errors';

export interface JsonErrorResponseOptions {
  readonly status?: number;
  readonly fallbackMessage?: string;
  readonly source?: DaemonErrorSource;
}

interface StructuredErrorLike {
  readonly message: string;
  readonly code?: string;
  readonly recoverable?: boolean;
  readonly status?: number;
  readonly statusCode?: number;
  readonly hint?: string;
  readonly guidance?: string;
  readonly source?: string;
  readonly category?: string;
  readonly provider?: string;
  readonly operation?: string;
  readonly phase?: string;
  readonly requestId?: string;
  readonly providerCode?: string;
  readonly providerType?: string;
  readonly retryAfterMs?: number;
}

interface ErrorPropertyLike {
  readonly error: string;
  readonly code?: string;
  readonly recoverable?: boolean;
  readonly status?: number;
  readonly statusCode?: number;
  readonly hint?: string;
  readonly guidance?: string;
  readonly source?: string;
  readonly category?: string;
  readonly provider?: string;
  readonly operation?: string;
  readonly phase?: string;
  readonly requestId?: string;
  readonly providerCode?: string;
  readonly providerType?: string;
  readonly retryAfterMs?: number;
}

const NETWORK_ERROR_PATTERNS: Array<{ pattern: RegExp; category: DaemonErrorCategory; message: (provider?: string) => string }> = [
  {
    pattern: /ECONNREFUSED/i,
    category: DaemonErrorCategory.NETWORK,
    message: (provider) => `Cannot connect to ${provider ?? 'the provider'}. Check whether the service is reachable.`,
  },
  {
    pattern: /ETIMEDOUT|ECONNABORTED/i,
    category: DaemonErrorCategory.TIMEOUT,
    message: () => 'Connection timed out before the request completed.',
  },
  {
    pattern: /ENOTFOUND|EAI_AGAIN/i,
    category: DaemonErrorCategory.NETWORK,
    message: (provider) => `DNS lookup failed for ${provider ?? 'the provider'}. Check the base URL and network.`,
  },
];

function normalizeCategory(value: string | undefined): DaemonErrorCategory | undefined {
  return value === 'authentication'
    || value === 'authorization'
    || value === 'billing'
    || value === 'rate_limit'
    || value === 'timeout'
    || value === 'network'
    || value === 'bad_request'
    || value === 'not_found'
    || value === 'permission'
    || value === 'tool'
    || value === 'config'
    || value === 'protocol'
    || value === 'service'
    || value === 'internal'
    || value === 'unknown'
    ? value
    : undefined;
}

function normalizeSource(value: string | undefined): DaemonErrorSource | undefined {
  return value === 'provider'
    || value === 'tool'
    || value === 'transport'
    || value === 'config'
    || value === 'permission'
    || value === 'runtime'
    || value === 'render'
    || value === 'acp'
    || value === 'unknown'
    ? value
    : undefined;
}

function readMessage(error: unknown, fallbackMessage?: string): string {
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (error && typeof error === 'object' && typeof (error as { error?: unknown }).error === 'string') {
    return ((error as { error: string }).error).trim();
  }
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    return ((error as { message: string }).message).trim();
  }
  return fallbackMessage ?? 'Unexpected error';
}

function inferCategory(status?: number, code?: string): DaemonErrorCategory {
  if (status === 401) return DaemonErrorCategory.AUTHENTICATION;
  if (status === 402) return DaemonErrorCategory.BILLING;
  if (status === 403) return DaemonErrorCategory.AUTHORIZATION;
  if (status === 404) return DaemonErrorCategory.NOT_FOUND;
  if (status === 408 || status === 504) return DaemonErrorCategory.TIMEOUT;
  if (status === 429) return DaemonErrorCategory.RATE_LIMIT;
  if (status === 400) return DaemonErrorCategory.BAD_REQUEST;
  if (status !== undefined && status >= 500) return DaemonErrorCategory.SERVICE;

  const normalizedCode = code?.toUpperCase();
  if (normalizedCode === 'ECONNREFUSED'
    || normalizedCode === 'ENOTFOUND'
    || normalizedCode === 'EAI_AGAIN'
    || normalizedCode === 'EHOSTUNREACH'
    || normalizedCode === 'ECONNRESET') {
    return DaemonErrorCategory.NETWORK;
  }
  if (normalizedCode === 'ETIMEDOUT' || normalizedCode === 'ECONNABORTED') return DaemonErrorCategory.TIMEOUT;
  return DaemonErrorCategory.UNKNOWN;
}

function inferCategoryFromMessage(message: string): DaemonErrorCategory {
  const msg = message.toLowerCase();
  // Order matters: credential/authentication patterns are intentionally checked
  // before generic bad-request wording so provider credential failures remain
  // actionable for clients.
  if (/api[_\s-]?key|auth|token|credential|jwt|unauthoriz/.test(msg)) return DaemonErrorCategory.AUTHENTICATION;
  if (/forbidden|access denied|permission denied|not allowed/.test(msg)) return DaemonErrorCategory.AUTHORIZATION;
  if (/billing|payment required|credits?|quota|depleted|insufficient balance/.test(msg)) return DaemonErrorCategory.BILLING;
  if (/rate.limit|too many requests|throttl/.test(msg)) return DaemonErrorCategory.RATE_LIMIT;
  if (/timed?[\s_-]?out|etimedout|deadline exceeded/.test(msg)) return DaemonErrorCategory.TIMEOUT;
  if (/econnrefused|enotfound|ehostunreach|econnreset|socket hang up|fetch failed|dns|tls|ssl|certificate/.test(msg)) return DaemonErrorCategory.NETWORK;
  if (/not found|unknown model|no such model|unsupported model|unknown endpoint/.test(msg)) return DaemonErrorCategory.NOT_FOUND;
  if (/invalid request|bad request|invalid argument|schema|malformed|unsupported parameter/.test(msg)) return DaemonErrorCategory.BAD_REQUEST;
  if (/invalid json|parse|no response body|unexpected eof|stream ended|malformed response/.test(msg)) return DaemonErrorCategory.PROTOCOL;
  return DaemonErrorCategory.UNKNOWN;
}

function inferHint(category: DaemonErrorCategory, status?: number): string | undefined {
  switch (category) {
    case 'rate_limit':
      return 'The caller may retry automatically. If this persists, wait, lower request volume, or switch models/providers.';
    case 'authentication':
      return 'The provider rejected authentication. Possible causes include invalid or expired credentials, missing account/session state, account restrictions, or the wrong provider/endpoint receiving the request.';
    case 'authorization':
      return 'Possible causes include missing model access, account permissions, safety/policy restrictions, or provider routing to a service that does not expose this model.';
    case 'billing':
      return 'Check credits, subscription status, usage limits, or account entitlements.';
    case 'timeout':
      return 'Check network stability, provider latency, and request size.';
    case 'network':
      return 'Check connectivity, DNS, TLS certificates, base URL, or any local proxy/tunnel.';
    case 'bad_request':
      return 'Check model id, parameters, message format, and tool schema.';
    case 'not_found':
      return 'Check model id, provider selection, and API path.';
    case 'protocol':
      return 'Check upstream protocol support, streaming mode, and transport stability.';
    case 'service':
      return status === 503
        ? 'The provider is temporarily unavailable. Retry shortly or switch providers if the issue persists.'
        : 'The provider returned a server-side failure. Retry shortly or switch providers if the issue persists.';
    default:
      return undefined;
  }
}

function buildSummary(
  message: string,
  metadata: {
    readonly requestId?: string;
    readonly providerCode?: string;
    readonly phase?: string;
  },
): string {
  const tags: string[] = [];
  if (metadata.phase && !message.toLowerCase().includes(metadata.phase.toLowerCase())) tags.push(`phase=${metadata.phase}`);
  if (metadata.providerCode && !message.includes(metadata.providerCode)) tags.push(`code=${metadata.providerCode}`);
  if (metadata.requestId && !message.includes(metadata.requestId)) tags.push(`request_id=${metadata.requestId}`);
  return tags.length > 0 ? `${message} (${tags.join(', ')})` : message;
}

function getNetworkErrorMessage(message: string, provider?: string): { category: DaemonErrorCategory; summary: string } | undefined {
  for (const entry of NETWORK_ERROR_PATTERNS) {
    if (entry.pattern.test(message)) {
      return {
        category: entry.category,
        summary: entry.message(provider),
      };
    }
  }
  return undefined;
}

function isStructuredErrorLike(error: unknown): error is StructuredErrorLike {
  return Boolean(
    error
    && typeof error === 'object'
    && typeof (error as { message?: unknown }).message === 'string'
    && (
      typeof (error as { code?: unknown }).code === 'string'
      || typeof (error as { status?: unknown }).status === 'number'
      || typeof (error as { statusCode?: unknown }).statusCode === 'number'
      || typeof (error as { guidance?: unknown }).guidance === 'string'
      || typeof (error as { hint?: unknown }).hint === 'string'
      || typeof (error as { provider?: unknown }).provider === 'string'
      || typeof (error as { source?: unknown }).source === 'string'
      || typeof (error as { category?: unknown }).category === 'string'
    )
  );
}

function isErrorPropertyLike(error: unknown): error is ErrorPropertyLike {
  return Boolean(
    error
    && typeof error === 'object'
    && typeof (error as { error?: unknown }).error === 'string'
  );
}

function readNumberProperty(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readStringProperty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readBooleanProperty(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function buildErrorResponseBody(
  error: unknown,
  options: JsonErrorResponseOptions = {},
): StructuredDaemonErrorBody {
  if (isStructuredDaemonErrorBody(error)) {
    return error;
  }
  if (error instanceof GoodVibesSdkError || isStructuredErrorLike(error)) {
    const status = error instanceof GoodVibesSdkError
      ? error.status
      : error.status ?? error.statusCode;
    const provider = error.provider;
    const message = error.message;
    const providerCode = error.providerCode;
    const phase = error.phase;
    const requestId = error.requestId;
    const network = getNetworkErrorMessage(message, provider);
    const inferred = inferCategory(status, error.code ?? providerCode);
    const messageCategory = inferred === DaemonErrorCategory.UNKNOWN
      ? inferCategoryFromMessage(message)
      : inferred;
    const category = normalizeCategory(error.category) ?? network?.category ?? messageCategory;
    const hint = (error instanceof GoodVibesSdkError ? error.hint : error.hint ?? error.guidance) ?? inferHint(category, status);
    const summary = buildSummary(network?.summary ?? message, {
      requestId,
      providerCode,
      phase,
    });
    return {
      error: summary,
      ...(hint ? { hint } : {}),
      ...(error.code ? { code: error.code } : {}),
      category,
      ...(normalizeSource(error.source) ? { source: normalizeSource(error.source) } : {}),
      ...(error.recoverable !== undefined ? { recoverable: error.recoverable } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(provider ? { provider } : {}),
      ...(error.operation ? { operation: error.operation } : {}),
      ...(phase ? { phase } : {}),
      ...(requestId ? { requestId } : {}),
      ...(providerCode ? { providerCode } : {}),
      ...(error.providerType ? { providerType: error.providerType } : {}),
      ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
    };
  }
  if (isErrorPropertyLike(error)) {
    const status = readNumberProperty(error.status) ?? readNumberProperty(error.statusCode) ?? options.status;
    const code = readStringProperty(error.code);
    const provider = readStringProperty(error.provider);
    const providerCode = readStringProperty(error.providerCode);
    const phase = readStringProperty(error.phase);
    const requestId = readStringProperty(error.requestId);
    const source = normalizeSource(readStringProperty(error.source));
    const recoverable = readBooleanProperty(error.recoverable);
    const operation = readStringProperty(error.operation);
    const providerType = readStringProperty(error.providerType);
    const retryAfterMs = readNumberProperty(error.retryAfterMs);
    const message = error.error.trim() || options.fallbackMessage || 'Unexpected error';
    const network = getNetworkErrorMessage(message, provider);
    const inferred = inferCategory(status, code ?? providerCode);
    const messageCategory = inferred === DaemonErrorCategory.UNKNOWN
      ? inferCategoryFromMessage(message)
      : inferred;
    const category = normalizeCategory(readStringProperty(error.category)) ?? network?.category ?? messageCategory;
    const hint = readStringProperty(error.hint) ?? readStringProperty(error.guidance) ?? inferHint(category, status);
    return {
      error: buildSummary(network?.summary ?? message, { requestId, providerCode, phase }),
      ...(hint ? { hint } : {}),
      ...(code ? { code } : {}),
      category,
      ...(source ? { source } : {}),
      ...(recoverable !== undefined ? { recoverable } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(provider ? { provider } : {}),
      ...(operation ? { operation } : {}),
      ...(phase ? { phase } : {}),
      ...(requestId ? { requestId } : {}),
      ...(providerCode ? { providerCode } : {}),
      ...(providerType ? { providerType } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    };
  }
  const message = readMessage(error, options.fallbackMessage);
  const network = getNetworkErrorMessage(message);
  const inferred = inferCategory(options.status);
  const messageCategory = inferred === DaemonErrorCategory.UNKNOWN
    ? inferCategoryFromMessage(message)
    : inferred;
  const category = network?.category ?? messageCategory;
  const hint = inferHint(category, options.status);
  return {
    error: network?.summary ?? message,
    ...(hint ? { hint } : {}),
    category,
    ...(options.source ? { source: options.source } : {}),
    ...(options.status !== undefined ? { status: options.status } : {}),
  };
}

export function jsonErrorResponse(error: unknown, options: JsonErrorResponseOptions = {}): Response {
  const body = buildErrorResponseBody(error, options);
  const status = options.status ?? body.status ?? 500;
  return Response.json(
    { ...body, status },
    { status },
  );
}

export function summarizeErrorForRecord(error: unknown, options: JsonErrorResponseOptions = {}): string {
  return buildErrorResponseBody(error, options).error;
}
