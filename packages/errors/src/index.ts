import type {
  DaemonErrorCategory,
  DaemonErrorSource,
  StructuredDaemonErrorBody,
} from './daemon-error-contract.js';

export type {
  DaemonErrorCategory,
  DaemonErrorSource,
  StructuredDaemonErrorBody,
} from './daemon-error-contract.js';

export type ErrorCategory = DaemonErrorCategory | 'contract';

export type ErrorSource = DaemonErrorSource | 'contract';

/**
 * Tagged union discriminant for all SDK errors. Use this for exhaustive
 * switch/if-else handling instead of `instanceof` chains.
 *
 * @example
 * if (error instanceof GoodVibesSdkError) {
 *   if (error.kind === 'rate-limit') {
 *     await delay(error.retryAfterMs ?? 1000);
 *   } else if (error.kind === 'auth') {
 *     // refresh credentials
 *   }
 * }
 */
export type SDKErrorKind =
  | 'auth'
  | 'config'
  | 'contract'
  | 'network'
  | 'not-found'
  | 'rate-limit'
  | 'server'
  | 'validation'
  | 'unknown';

function inferKind(category: ErrorCategory): SDKErrorKind {
  switch (category) {
    case 'authentication':
    case 'authorization':
    case 'billing':
    case 'permission':
      return 'auth';
    case 'config':
      return 'config';
    case 'contract':
      return 'contract';
    case 'network':
    case 'timeout':
      return 'network';
    case 'not_found':
      return 'not-found';
    case 'rate_limit':
      return 'rate-limit';
    case 'protocol':
    case 'service':
    case 'internal':
      return 'server';
    case 'bad_request':
      return 'validation';
    case 'tool':
    case 'unknown':
    default:
      return 'unknown';
  }
}

export interface GoodVibesSdkErrorOptions {
  readonly code?: string;
  readonly category?: ErrorCategory;
  readonly source?: ErrorSource;
  readonly recoverable?: boolean;
  readonly status?: number;
  readonly url?: string;
  readonly method?: string;
  readonly body?: unknown;
  readonly hint?: string;
  readonly provider?: string;
  readonly operation?: string;
  readonly phase?: string;
  readonly requestId?: string;
  readonly providerCode?: string;
  readonly providerType?: string;
  readonly retryAfterMs?: number;
}

export const RETRYABLE_STATUS_CODES: readonly number[] = [408, 429, 500, 502, 503, 504];

function inferCategory(status?: number): ErrorCategory {
  if (status === 400) return 'bad_request';
  if (status === 401) return 'authentication';
  if (status === 402) return 'billing';
  if (status === 403) return 'authorization';
  if (status === 404) return 'not_found';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate_limit';
  if (status !== undefined && status >= 500) return 'service';
  return 'unknown';
}

export class GoodVibesSdkError extends Error {
  public readonly kind: SDKErrorKind;
  public readonly code?: string;
  public readonly category: ErrorCategory;
  public readonly source: ErrorSource;
  public readonly recoverable: boolean;
  public readonly status?: number;
  public readonly url?: string;
  public readonly method?: string;
  public readonly body?: unknown;
  public readonly hint?: string;
  public readonly provider?: string;
  public readonly operation?: string;
  public readonly phase?: string;
  public readonly requestId?: string;
  public readonly providerCode?: string;
  public readonly providerType?: string;
  public readonly retryAfterMs?: number;

  constructor(message: string, options: GoodVibesSdkErrorOptions = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = options.code;
    this.category = options.category ?? inferCategory(options.status);
    this.kind = inferKind(this.category);
    this.source = options.source ?? 'unknown';
    this.recoverable = options.recoverable ?? (options.status !== undefined && RETRYABLE_STATUS_CODES.includes(options.status));
    this.status = options.status;
    this.url = options.url;
    this.method = options.method;
    this.body = options.body;
    this.hint = options.hint;
    this.provider = options.provider;
    this.operation = options.operation;
    this.phase = options.phase;
    this.requestId = options.requestId;
    this.providerCode = options.providerCode;
    this.providerType = options.providerType;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/**
 * @deprecated Use `error.kind === 'config'` instead of `instanceof ConfigurationError`.
 * This class is preserved for backward compatibility and still throws normally.
 */
export class ConfigurationError extends GoodVibesSdkError {
  constructor(message: string, options: GoodVibesSdkErrorOptions = {}) {
    super(message, {
      ...options,
      code: options.code ?? 'SDK_CONFIGURATION_ERROR',
      category: 'config',
      source: options.source ?? 'config',
      recoverable: false,
    });
  }
}

/**
 * @deprecated Use `error.kind === 'contract'` instead of `instanceof ContractError`.
 * This class is preserved for backward compatibility and still throws normally.
 */
export class ContractError extends GoodVibesSdkError {
  constructor(message: string, options: GoodVibesSdkErrorOptions = {}) {
    super(message, {
      ...options,
      code: options.code ?? 'SDK_CONTRACT_ERROR',
      category: 'contract',
      source: options.source ?? 'contract',
      recoverable: false,
    });
  }
}

/**
 * @deprecated Use `error.kind` instead of `instanceof HttpStatusError`.
 * For example: `error.kind === 'rate-limit'`, `error.kind === 'auth'`, `error.kind === 'server'`.
 * This class is preserved for backward compatibility and still throws normally.
 */
export class HttpStatusError extends GoodVibesSdkError {
  constructor(message: string, options: GoodVibesSdkErrorOptions = {}) {
    super(message, {
      ...options,
      code: options.code ?? 'SDK_HTTP_STATUS_ERROR',
      source: options.source ?? 'transport',
    });
  }
}

export function isStructuredDaemonErrorBody(value: unknown): value is StructuredDaemonErrorBody {
  return typeof value === 'object' && value !== null && typeof (value as { error?: unknown }).error === 'string';
}

export function createHttpStatusError(
  status: number,
  url: string,
  method: string,
  body: unknown,
  fallbackHint?: string,
): HttpStatusError {
  if (isStructuredDaemonErrorBody(body)) {
    return new HttpStatusError(body.error, {
      code: body.code,
      category: body.category,
      source: body.source ?? 'transport',
      recoverable: body.recoverable,
      status: body.status ?? status,
      url,
      method,
      body,
      hint: body.hint ?? fallbackHint,
      provider: body.provider,
      operation: body.operation,
      phase: body.phase,
      requestId: body.requestId,
      providerCode: body.providerCode,
      providerType: body.providerType,
      retryAfterMs: body.retryAfterMs,
    });
  }

  const message = typeof body === 'string' && body.trim()
    ? body.trim()
    : `Request failed with status ${status}`;

  return new HttpStatusError(message, {
    status,
    url,
    method,
    body,
    hint: fallbackHint,
  });
}
