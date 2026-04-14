import {
  type DaemonErrorCategory,
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

const NETWORK_ERROR_PATTERNS: Array<{ pattern: RegExp; category: DaemonErrorCategory; message: (provider?: string) => string }> = [
  {
    pattern: /ECONNREFUSED/i,
    category: 'network',
    message: (provider) => `Cannot connect to ${provider ?? 'the provider'}. Check whether the service is reachable.`,
  },
  {
    pattern: /ETIMEDOUT|ECONNABORTED|timed?[\s_-]?out/i,
    category: 'timeout',
    message: () => 'Connection timed out before the request completed.',
  },
  {
    pattern: /ENOTFOUND|EAI_AGAIN/i,
    category: 'network',
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

function inferCategory(message: string, status?: number): DaemonErrorCategory {
  const msg = message.toLowerCase();
  if (status === 401) return 'authentication';
  if (status === 402) return 'billing';
  if (status === 403) return 'authorization';
  if (status === 404) return 'not_found';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate_limit';
  if (status === 400) return 'bad_request';
  if (status !== undefined && status >= 500) return 'service';

  if (/api[_\s-]?key|auth|token|credential|jwt|unauthoriz/.test(msg)) return 'authentication';
  if (/forbidden|access denied|permission denied|not allowed/.test(msg)) return 'authorization';
  if (/billing|payment required|credits?|quota|depleted|insufficient balance/.test(msg)) return 'billing';
  if (/rate.limit|too many requests|throttl/.test(msg)) return 'rate_limit';
  if (/timed?[\s_-]?out|etimedout|deadline exceeded/.test(msg)) return 'timeout';
  if (/econnrefused|enotfound|ehostunreach|econnreset|socket hang up|fetch failed|dns|tls|ssl|certificate/.test(msg)) return 'network';
  if (/not found|unknown model|no such model|unsupported model|unknown endpoint/.test(msg)) return 'not_found';
  if (/invalid request|bad request|invalid argument|schema|malformed|unsupported parameter/.test(msg)) return 'bad_request';
  if (/invalid json|parse|no response body|unexpected eof|stream ended|malformed response/.test(msg)) return 'protocol';
  return 'unknown';
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
      return 'Check upstream compatibility, streaming mode, and transport stability.';
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

export function buildErrorResponseBody(
  error: unknown,
  options: JsonErrorResponseOptions = {},
): StructuredDaemonErrorBody {
  if (isStructuredDaemonErrorBody(error)) {
    return error;
  }
  if (error instanceof GoodVibesSdkError) {
    const network = getNetworkErrorMessage(error.message, error.provider);
    const category = normalizeCategory(error.category) ?? network?.category ?? inferCategory(error.message, error.status);
    const hint = error.hint ?? inferHint(category, error.status);
    const summary = buildSummary(network?.summary ?? error.message, {
      requestId: error.requestId,
      providerCode: error.providerCode,
      phase: error.phase,
    });
    return {
      error: summary,
      ...(hint ? { hint } : {}),
      ...(error.code ? { code: error.code } : {}),
      category,
      ...(normalizeSource(error.source) ? { source: normalizeSource(error.source) } : {}),
      recoverable: error.recoverable,
      ...(error.status !== undefined ? { status: error.status } : {}),
      ...(error.provider ? { provider: error.provider } : {}),
      ...(error.operation ? { operation: error.operation } : {}),
      ...(error.phase ? { phase: error.phase } : {}),
      ...(error.requestId ? { requestId: error.requestId } : {}),
      ...(error.providerCode ? { providerCode: error.providerCode } : {}),
      ...(error.providerType ? { providerType: error.providerType } : {}),
      ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
    };
  }
  const message = readMessage(error, options.fallbackMessage);
  const network = getNetworkErrorMessage(message);
  const category = network?.category ?? inferCategory(message, options.status);
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
    body.status === undefined && options.status !== undefined
      ? { ...body, status: options.status }
      : body,
    { status },
  );
}

export function summarizeErrorForRecord(error: unknown, options: JsonErrorResponseOptions = {}): string {
  return buildErrorResponseBody(error, options).error;
}
