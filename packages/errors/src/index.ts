import type {
  DaemonErrorCategory,
  DaemonErrorSource,
  StructuredDaemonErrorBody,
} from './daemon-error-contract.js';

export type {
  DaemonErrorSource,
  StructuredDaemonErrorBody,
} from './daemon-error-contract.js';
export { DaemonErrorCategory } from './daemon-error-contract.js';

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
  | 'protocol'
  | 'rate-limit'
  | 'service'
  | 'internal'
  | 'tool'
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
      return 'protocol';
    case 'internal':
      return 'internal';
    case 'service':
      return 'service';
    case 'bad_request':
      return 'validation';
    case 'tool':
      return 'tool';
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
  readonly cause?: unknown;
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

const ERROR_CATEGORIES = new Set<ErrorCategory>([
  'authentication',
  'authorization',
  'bad_request',
  'billing',
  'config',
  'contract',
  'internal',
  'network',
  'not_found',
  'permission',
  'protocol',
  'rate_limit',
  'service',
  'timeout',
  'tool',
  'unknown',
]);

const GOODVIBES_SDK_ERROR_BRAND = Symbol.for('pellux.goodvibes.sdk.error');

function readErrorCategory(value: unknown): ErrorCategory | undefined {
  return typeof value === 'string' && ERROR_CATEGORIES.has(value as ErrorCategory)
    ? value as ErrorCategory
    : undefined;
}

const MAX_ERROR_CAUSE_DEPTH = 32;

function inferCategoryFromCause(cause: unknown, seen = new Set<object>(), depth = 0): ErrorCategory | undefined {
  if (depth >= MAX_ERROR_CAUSE_DEPTH) return undefined;
  if (!cause || typeof cause !== 'object') return undefined;
  const objectCause = cause as object;
  if (seen.has(objectCause)) return undefined;
  seen.add(objectCause);
  const record = cause as {
    readonly category?: unknown;
    readonly cause?: unknown;
    readonly originalError?: unknown;
    readonly error?: unknown;
  };
  const category = readErrorCategory(record.category);
  if (category && category !== 'unknown') return category;
  return inferCategoryFromCause(record.cause, seen, depth + 1)
    ?? inferCategoryFromCause(record.originalError, seen, depth + 1)
    ?? inferCategoryFromCause(record.error, seen, depth + 1);
}

/**
 * Base error class for all errors thrown by the GoodVibes SDK.
 *
 * Every error carries a structured `category` and `source` that allow
 * callers to handle specific failure modes without string-matching messages.
 *
 * ### Narrowing pattern
 * ```ts
 * import { GoodVibesSdkError, HttpStatusError, ConfigurationError } from '@pellux/goodvibes-sdk';
 *
 * try {
 *   await sdk.operator.agents.list();
 * } catch (err) {
 *   if (err instanceof HttpStatusError && err.category === 'rate_limit') {
 *     // Back off and retry after err.retryAfterMs
 *   } else if (err instanceof ConfigurationError) {
 *     // Invalid SDK setup — not recoverable
 *   } else if (err instanceof GoodVibesSdkError) {
 *     console.error(err.category, err.hint);
 *   }
 * }
 * ```
 */
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
  public override readonly cause?: unknown;

  static override [Symbol.hasInstance](value: unknown): boolean {
    if (this !== GoodVibesSdkError) {
      return typeof value === 'object'
        && value !== null
        && this.prototype.isPrototypeOf(value);
    }
    if (typeof value !== 'object' || value === null) return false;
    const record = value as Record<PropertyKey, unknown>;
    return record[GOODVIBES_SDK_ERROR_BRAND] === true;
  }

  constructor(message: string, options: GoodVibesSdkErrorOptions = {}) {
    const category = options.category
      ?? inferCategoryFromCause(options.cause)
      ?? inferCategory(options.status);
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = this.constructor.name;
    Object.defineProperty(this, GOODVIBES_SDK_ERROR_BRAND, {
      value: true,
      enumerable: false,
      configurable: false,
    });
    this.code = options.code;
    this.category = category;
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
    this.cause = options.cause;
  }

  toJSON(): Record<string, unknown> {
    return omitUndefined({
      name: this.name,
      message: this.message,
      kind: this.kind,
      code: this.code,
      category: this.category,
      source: this.source,
      recoverable: this.recoverable,
      status: this.status,
      url: this.url,
      method: this.method,
      body: this.body,
      hint: this.hint,
      provider: this.provider,
      operation: this.operation,
      phase: this.phase,
      requestId: this.requestId,
      providerCode: this.providerCode,
      providerType: this.providerType,
      retryAfterMs: this.retryAfterMs,
      cause: serializeCause(this.cause),
    });
  }
}

function serializeCause(cause: unknown, seen = new Set<object>(), depth = 0): unknown {
  if (cause === undefined) return undefined;
  if (depth >= MAX_ERROR_CAUSE_DEPTH) return undefined;
  if (cause instanceof Error) {
    const record: Record<string, unknown> = { name: cause.name, message: cause.message };
    // Walk .cause, .originalError, .error chains symmetrically with inferCategoryFromCause.
    const causeRecord = cause as { readonly cause?: unknown; readonly originalError?: unknown; readonly error?: unknown };
    const nestedCause = causeRecord.cause ?? causeRecord.originalError ?? causeRecord.error;
    if (nestedCause !== undefined) {
      const objectKey = causeRecord.cause !== undefined ? 'cause' : causeRecord.originalError !== undefined ? 'originalError' : 'error';
      const serialized = typeof nestedCause === 'object' && nestedCause !== null
        ? (seen.has(nestedCause as object) ? '[Circular]' : serializeCause(nestedCause, new Set([...seen, nestedCause as object]), depth + 1))
        : serializeCause(nestedCause, seen, depth + 1);
      if (serialized !== undefined) record[objectKey] = serialized;
    }
    return omitUndefined(record as Record<string, unknown>);
  }
  if (typeof cause === 'object' && cause !== null) {
    if (seen.has(cause as object)) return '[Circular]';
    // Serialize plain-object causes (e.g. from transport error payloads) as-is.
    return cause;
  }
  return cause;
}

function omitUndefined(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

/**
 * Thrown when the SDK is misconfigured (e.g. missing `baseUrl`, no fetch
 * implementation available, or calling a mutation on a read-only auth resolver).
 *
 * Always non-recoverable (`recoverable: false`).
 * Category: `'config'`. Kind: `'config'`.
 *
 * @example
 * import { ConfigurationError } from '@pellux/goodvibes-sdk';
 *
 * try {
 *   await sdk.auth.setToken('x');
 * } catch (err) {
 *   if (err instanceof ConfigurationError) {
 *     // SDK was constructed with getAuthToken — token mutation not supported
 *   }
 * }
 */
export class ConfigurationError extends GoodVibesSdkError {
  static override [Symbol.hasInstance](value: unknown): boolean {
    if (this !== ConfigurationError) {
      return typeof value === 'object'
        && value !== null
        && this.prototype.isPrototypeOf(value);
    }
    // Require both the brand (real SDK error instance) and matching code
    // to prevent plain objects like { code: 'SDK_CONFIGURATION_ERROR' } from passing.
    return GoodVibesSdkError[Symbol.hasInstance](value)
      && (value as Record<PropertyKey, unknown>).code === 'SDK_CONFIGURATION_ERROR';
  }

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
 * Thrown when a response from the daemon violates the expected contract
 * (unexpected shape, missing required fields, etc.).
 *
 * Always non-recoverable (`recoverable: false`).
 * Category: `'contract'`. Kind: `'contract'`.
 *
 * @example
 * import { ContractError } from '@pellux/goodvibes-sdk';
 *
 * try {
 *   const result = await sdk.operator.agents.get({ id: agentId });
 * } catch (err) {
 *   if (err instanceof ContractError) {
 *     // Daemon returned an unexpected shape — SDK version mismatch?
 *     console.error('Contract violation:', err.message);
 *   }
 * }
 */
export class ContractError extends GoodVibesSdkError {
  static override [Symbol.hasInstance](value: unknown): boolean {
    if (this !== ContractError) {
      return typeof value === 'object'
        && value !== null
        && this.prototype.isPrototypeOf(value);
    }
    // Require both the brand (real SDK error instance) and matching code
    // to prevent plain objects like { code: 'SDK_CONTRACT_ERROR' } from passing.
    return GoodVibesSdkError[Symbol.hasInstance](value)
      && (value as Record<PropertyKey, unknown>).code === 'SDK_CONTRACT_ERROR';
  }

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
 * Thrown when the daemon returns a non-2xx HTTP status code.
 *
 * The `category` field is inferred from the status code:
 * - `401` → `'authentication'`  `402` → `'billing'`  `403` → `'authorization'`
 * - `404` → `'not_found'`  `408` → `'timeout'`  `429` → `'rate_limit'`
 * - `5xx` → `'service'`
 *
 * Use `recoverable` to decide whether to retry, and `retryAfterMs` for
 * the backoff hint on rate-limit responses.
 *
 * @example
 * import { HttpStatusError } from '@pellux/goodvibes-sdk';
 *
 * try {
 *   await sdk.operator.agents.list();
 * } catch (err) {
 *   if (err instanceof HttpStatusError) {
 *     if (err.category === 'rate_limit') {
 *       await delay(err.retryAfterMs ?? 1000);
 *     } else if (!err.recoverable) {
 *       throw err; // Surface non-retryable errors immediately
 *     }
 *   }
 * }
 */
export class HttpStatusError extends GoodVibesSdkError {
  static override [Symbol.hasInstance](value: unknown): boolean {
    if (this !== HttpStatusError) {
      return typeof value === 'object'
        && value !== null
        && this.prototype.isPrototypeOf(value);
    }
    // Require both the brand (real SDK error instance) and matching code
    // to prevent plain objects like { code: 'SDK_HTTP_STATUS_ERROR' } from passing.
    return GoodVibesSdkError[Symbol.hasInstance](value)
      && (value as Record<PropertyKey, unknown>).code === 'SDK_HTTP_STATUS_ERROR';
  }

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
      status,
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
