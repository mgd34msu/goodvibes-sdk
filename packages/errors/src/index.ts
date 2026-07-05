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

/**
 * `'contract'` is an SDK-internal category used when the daemon returns
 * a response that violates the expected contract schema. It is NOT part of the
 * daemon wire schema (`DaemonErrorCategory`) and MUST NOT be marshalled over
 * the wire — doing so will cause the daemon to schema-reject the error envelope.
 * Treat `'contract'` as a local SDK sentinel only.
 */
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

/**
 * Exhaustive string-literal union of the canonical error codes produced by the
 * GoodVibes SDK. Use this type when you need to pattern-match on `err.code`
 * without losing exhaustiveness checking.
 *
 * The `code` field on {@link GoodVibesSdkError} is typed as
 * `SDKErrorCode | (string & {})` so that:
 * - SDK-produced errors surface as one of the known literals (IDE autocomplete
 *   and exhaustive switches work).
 * - Caller-supplied arbitrary string codes still type-check without casting.
 *
 * ### Consumer pattern
 * ```ts
 * import { isErrorCode, SDKErrorCodes } from '@pellux/goodvibes-errors';
 *
 * catch (err) {
 *   if (err instanceof GoodVibesSdkError) {
 *     if (isErrorCode(err, SDKErrorCodes.RATE_LIMITED)) {
 *       await delay(err.retryAfterMs ?? 1000);
 *     } else if (isErrorCode(err, SDKErrorCodes.AUTH_REQUIRED)) {
 *       await refreshToken();
 *     } else if (isErrorCode(err, SDKErrorCodes.TOKEN_EXPIRED)) {
 *       await refreshToken();
 *     }
 *   }
 * }
 * ```
 */
export type SDKErrorCode =
  // Authentication / authorization
  | 'AUTH_REQUIRED'
  | 'TOKEN_EXPIRED'
  | 'PERMISSION_DENIED'
  | 'PAYMENT_REQUIRED'
  // Rate limiting
  | 'RATE_LIMITED'
  // Networking
  | 'NETWORK_UNREACHABLE'
  | 'TIMEOUT'
  | 'CANCELLED'
  // Resource
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'SESSION_CLOSED'
  // Validation
  | 'VALIDATION_FAILED'
  // Agent execution
  | 'AGENT_TIMEOUT'
  | 'AGENT_FAILED'
  // Tool execution
  | 'TOOL_EXEC_FAILED'
  // Service-level
  | 'SERVICE_UNAVAILABLE'
  // SDK contract / internals
  | 'CONTRACT_MISMATCH'
  | 'PROTOCOL_ERROR'
  | 'INTERNAL_ERROR'
  | 'SDK_CONFIGURATION_ERROR'
  | 'SDK_CONTRACT_ERROR'
  | 'SDK_HTTP_STATUS_ERROR'
  // Catch-all
  | 'UNKNOWN';

/**
 * Runtime-accessible const object mirroring the {@link SDKErrorCode} union.
 * Prefer referencing these constants over raw string literals for refactor safety.
 *
 * @example
 * import { SDKErrorCodes } from '@pellux/goodvibes-errors';
 *
 * if (err.code === SDKErrorCodes.RATE_LIMITED) {
 *   await delay(err.retryAfterMs ?? 1000);
 * }
 */
export const SDKErrorCodes = {
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  PAYMENT_REQUIRED: 'PAYMENT_REQUIRED',
  RATE_LIMITED: 'RATE_LIMITED',
  NETWORK_UNREACHABLE: 'NETWORK_UNREACHABLE',
  TIMEOUT: 'TIMEOUT',
  CANCELLED: 'CANCELLED',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  SESSION_CLOSED: 'SESSION_CLOSED',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  AGENT_TIMEOUT: 'AGENT_TIMEOUT',
  AGENT_FAILED: 'AGENT_FAILED',
  TOOL_EXEC_FAILED: 'TOOL_EXEC_FAILED',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  CONTRACT_MISMATCH: 'CONTRACT_MISMATCH',
  PROTOCOL_ERROR: 'PROTOCOL_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SDK_CONFIGURATION_ERROR: 'SDK_CONFIGURATION_ERROR',
  SDK_CONTRACT_ERROR: 'SDK_CONTRACT_ERROR',
  SDK_HTTP_STATUS_ERROR: 'SDK_HTTP_STATUS_ERROR',
  UNKNOWN: 'UNKNOWN',
} as const satisfies Record<SDKErrorCode, SDKErrorCode>;

/**
 * The set of known {@link SDKErrorCode} values for runtime membership tests.
 * @internal
 */
const SDK_ERROR_CODE_SET = new Set<string>(Object.values(SDKErrorCodes));

/**
 * Returns `true` when `err.code` equals the given {@link SDKErrorCode},
 * narrowing the type of `err.code` to the specific literal.
 *
 * Works with any object that has a `code?: string` field — not limited to
 * {@link GoodVibesSdkError} subclasses.
 *
 * @example
 * import { isErrorCode, SDKErrorCodes, GoodVibesSdkError } from '@pellux/goodvibes-errors';
 *
 * if (err instanceof GoodVibesSdkError && isErrorCode(err, SDKErrorCodes.RATE_LIMITED)) {
 *   console.log('retry after', err.retryAfterMs);
 * }
 *
 * @param err - Any object with an optional `code` string field.
 * @param code - The {@link SDKErrorCode} literal to match against.
 */
export function isErrorCode<C extends SDKErrorCode>(
  err: { readonly code?: SDKErrorCode | (string & {}) | undefined },
  code: C,
): err is { readonly code: C } {
  return err.code === code;
}

/**
 * Returns `true` when `value` is a known {@link SDKErrorCode} string.
 * Useful for discriminating structured errors received over the wire.
 *
 * @param value - The string to test.
 */
export function isKnownErrorCode(value: string): value is SDKErrorCode {
  return SDK_ERROR_CODE_SET.has(value);
}

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

/**
 * Infers the canonical {@link SDKErrorCode} from an {@link ErrorCategory}.
 * Used internally to populate `code` when no explicit code is provided.
 * @internal
 */
function inferCodeFromCategory(category: ErrorCategory): SDKErrorCode {
  switch (category) {
    case 'authentication': return 'AUTH_REQUIRED';
    case 'authorization': return 'PERMISSION_DENIED';
    case 'billing': return 'PAYMENT_REQUIRED';
    case 'permission': return 'PERMISSION_DENIED';
    case 'config': return 'SDK_CONFIGURATION_ERROR';
    case 'contract': return 'CONTRACT_MISMATCH';
    case 'network': return 'NETWORK_UNREACHABLE';
    case 'timeout': return 'TIMEOUT';
    case 'not_found': return 'NOT_FOUND';
    case 'rate_limit': return 'RATE_LIMITED';
    case 'protocol': return 'PROTOCOL_ERROR';
    case 'internal': return 'INTERNAL_ERROR';
    case 'service': return 'SERVICE_UNAVAILABLE';
    case 'bad_request': return 'VALIDATION_FAILED';
    case 'tool': return 'TOOL_EXEC_FAILED';
    case 'unknown':
    default:
      return 'UNKNOWN';
  }
}

export interface GoodVibesSdkErrorOptions {
  /**
   * A typed error code for programmatic matching. May be an {@link SDKErrorCode}
   * literal or any custom string for caller-supplied codes.
   * When omitted, the SDK infers a code from `category` or `status`.
   */
  readonly code?: SDKErrorCode | (string & {}) | undefined;
  readonly category?: ErrorCategory | undefined;
  readonly source?: ErrorSource | undefined;
  readonly recoverable?: boolean | undefined;
  readonly status?: number | undefined;
  readonly url?: string | undefined;
  readonly method?: string | undefined;
  readonly body?: unknown | undefined;
  readonly hint?: string | undefined;
  readonly provider?: string | undefined;
  readonly operation?: string | undefined;
  readonly phase?: string | undefined;
  readonly requestId?: string | undefined;
  readonly providerCode?: string | undefined;
  readonly providerType?: string | undefined;
  readonly retryAfterMs?: number | undefined;
  readonly cause?: unknown | undefined;
}

export const RETRYABLE_STATUS_CODES: readonly number[] = [408, 429, 500, 502, 503, 504];

function inferCategory(status?: number): ErrorCategory {
  if (status === 400) return 'bad_request';
  if (status === 401) return 'authentication';
  if (status === 402) return 'billing';
  if (status === 403) return 'authorization';
  if (status === 404) return 'not_found';
  if (status === 408) return 'timeout';
  if (status === 409) return 'unknown'; // 409 Conflict — caller must supply category explicitly
  if (status === 429) return 'rate_limit';
  if (status !== undefined && status >= 500) return 'service';
  return 'unknown';
}

/**
 * Infers the canonical {@link SDKErrorCode} for HTTP status codes that have a
 * direct 1-to-1 mapping, used when no explicit code is present in the response
 * body. Returns `undefined` when the code should fall through to category-based
 * inference (e.g. for structured-body responses that supply their own category).
 * @internal
 */
function inferCodeFromStatus(status: number): SDKErrorCode | undefined {
  switch (status) {
    case 400: return 'VALIDATION_FAILED';
    case 401: return 'AUTH_REQUIRED';
    case 402: return 'PAYMENT_REQUIRED';
    case 403: return 'PERMISSION_DENIED';
    case 404: return 'NOT_FOUND';
    case 408: return 'TIMEOUT';
    case 409: return 'CONFLICT';
    case 429: return 'RATE_LIMITED';
    default:
      if (status >= 500) return 'SERVICE_UNAVAILABLE';
      return undefined;
  }
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
const HTTP_STATUS_ERROR_BRAND = Symbol.for('pellux.goodvibes.sdk.http-status-error');

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
    readonly category?: unknown | undefined;
    readonly cause?: unknown | undefined;
    readonly originalError?: unknown | undefined;
    readonly error?: unknown | undefined;
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
 * Every error carries a structured `category`, `source`, and `code` that allow
 * callers to handle specific failure modes without string-matching messages.
 *
 * The `code` field is typed as `SDKErrorCode | (string & {})` — SDK-produced
 * errors always carry a known {@link SDKErrorCode}, while caller-supplied codes
 * remain valid arbitrary strings.
 *
 * ### Narrowing by code
 * ```ts
 * import { GoodVibesSdkError, isErrorCode, SDKErrorCodes } from '@pellux/goodvibes-errors';
 *
 * catch (err) {
 *   if (err instanceof GoodVibesSdkError) {
 *     if (isErrorCode(err, SDKErrorCodes.RATE_LIMITED)) {
 *       await delay(err.retryAfterMs ?? 1000);
 *     } else if (isErrorCode(err, SDKErrorCodes.TOKEN_EXPIRED)) {
 *       await refreshToken();
 *     }
 *   }
 * }
 * ```
 *
 * ### Narrowing by kind
 * ```ts
 * import { GoodVibesSdkError, HttpStatusError, ConfigurationError } from '@pellux/goodvibes-errors';
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
  /**
   * Typed error code for programmatic matching. SDK-produced errors always set
   * a {@link SDKErrorCode}; caller-supplied codes may be any string.
   *
   * **Note:** `code` and `category` are inferred independently and can diverge.
   * For example, `new GoodVibesSdkError('…', { status: 409 })` yields
   * `code === 'CONFLICT'` (from `inferCodeFromStatus`) while
   * `category === 'unknown'` (because `inferCategory` intentionally returns
   * `'unknown'` for 409 — the caller must supply `category` explicitly to get
   * a meaningful category for conflict-style errors).
   */
  public readonly code: SDKErrorCode | (string & {});
  public readonly category: ErrorCategory;
  public readonly source: ErrorSource;
  public readonly recoverable: boolean;
  public readonly status?: number | undefined;
  public readonly url?: string | undefined;
  public readonly method?: string | undefined;
  public readonly body?: unknown | undefined;
  public readonly hint?: string | undefined;
  public readonly provider?: string | undefined;
  public readonly operation?: string | undefined;
  public readonly phase?: string | undefined;
  public readonly requestId?: string | undefined;
  public readonly providerCode?: string | undefined;
  public readonly providerType?: string | undefined;
  public readonly retryAfterMs?: number | undefined;
  public override readonly cause?: unknown | undefined;

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
    // Infer code from status first (most specific), then from category.
    // Explicit caller-supplied code always wins.
    this.code = options.code
      ?? (options.status !== undefined ? inferCodeFromStatus(options.status) : undefined)
      ?? inferCodeFromCategory(category);
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
 * Category: `'config'`. Kind: `'config'`. Code: `'SDK_CONFIGURATION_ERROR'`.
 *
 * @example
 * import { ConfigurationError } from '@pellux/goodvibes-errors';
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
  /**
   * Brand contract — `code` is the source of truth, not the prototype chain.
   * A `GoodVibesSdkError` constructed directly with `code: 'SDK_CONFIGURATION_ERROR'`
   * will pass `instanceof ConfigurationError` even if its prototype is only
   * `GoodVibesSdkError`. Callers that need strict prototype checking should use
   * `Object.getPrototypeOf(err) === ConfigurationError.prototype` instead.
   */
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
 * Category: `'contract'`. Kind: `'contract'`. Code: `'SDK_CONTRACT_ERROR'`.
 *
 * @example
 * import { ContractError } from '@pellux/goodvibes-errors';
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
  /**
   * Brand contract — `code` is the source of truth, not the prototype chain.
   * A `GoodVibesSdkError` constructed directly with `code: 'SDK_CONTRACT_ERROR'`
   * will pass `instanceof ContractError` even if its prototype is only
   * `GoodVibesSdkError`. Callers that need strict prototype checking should use
   * `Object.getPrototypeOf(err) === ContractError.prototype` instead.
   */
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
 * - Any other status (or when constructed without a `status`) → `'unknown'`
 *
 * The `code` field is inferred from `status` automatically:
 * - `400` → `'VALIDATION_FAILED'`
 * - `401` → `'AUTH_REQUIRED'`
 * - `402` → `'PAYMENT_REQUIRED'`
 * - `403` → `'PERMISSION_DENIED'`
 * - `404` → `'NOT_FOUND'`
 * - `408` → `'TIMEOUT'`
 * - `409` → `'CONFLICT'`
 * - `429` → `'RATE_LIMITED'`
 * - `5xx` → `'SERVICE_UNAVAILABLE'`
 *
 * When constructed without a `status` argument (e.g. as a typed
 * wrapper around a structured daemon error that provides its own `category`),
 * the category defaults to `'unknown'`. Callers relying on category-based
 * routing should always prefer the structured-body factory
 * (`createHttpStatusError`) or check `err.category` directly rather than
 * assuming a specific category from constructor arguments alone.
 *
 * Use `recoverable` to decide whether to retry, and `retryAfterMs` for
 * the backoff hint on rate-limit responses.
 *
 * @example
 * import { HttpStatusError } from '@pellux/goodvibes-errors';
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
  /**
   * Brand contract: `instanceof HttpStatusError` relies on a dedicated Symbol
   * brand stamped in the constructor, enabling cross-realm identity checks that
   * are independent of the `code` field.
   *
   * A `GoodVibesSdkError` constructed directly with `code: 'SDK_HTTP_STATUS_ERROR'`
   * will also pass `instanceof HttpStatusError` for backward compatibility with
   * callers that serialise/deserialise errors by code. Callers that need strict
   * prototype checking should use
   * `Object.getPrototypeOf(err) === HttpStatusError.prototype` instead.
   */
  static override [Symbol.hasInstance](value: unknown): boolean {
    if (this !== HttpStatusError) {
      return typeof value === 'object'
        && value !== null
        && this.prototype.isPrototypeOf(value);
    }
    if (!GoodVibesSdkError[Symbol.hasInstance](value)) return false;
    const record = value as Record<PropertyKey, unknown>;
    // Primary: dedicated brand symbol (set in constructor — works in same realm).
    if (record[HTTP_STATUS_ERROR_BRAND] === true) return true;
    // Fallback: code-based brand for cross-realm / serialised-error compat.
    return record.code === 'SDK_HTTP_STATUS_ERROR';
  }

  constructor(message: string, options: GoodVibesSdkErrorOptions = {}) {
    super(message, {
      ...options,
      // Default code retains 'SDK_HTTP_STATUS_ERROR' when no explicit code is
      // supplied. Use createHttpStatusError() for status-specific semantic codes.
      code: options.code ?? 'SDK_HTTP_STATUS_ERROR',
      source: options.source ?? 'transport',
    });
    // Stamp the brand AFTER super() so the symbol is always present on instances
    // produced by this constructor (regardless of which code was stored).
    Object.defineProperty(this, HTTP_STATUS_ERROR_BRAND, {
      value: true,
      enumerable: false,
      configurable: false,
    });
  }
}

export function isStructuredDaemonErrorBody(value: unknown): value is StructuredDaemonErrorBody {
  return typeof value === 'object' && value !== null && typeof (value as { error?: unknown }).error === 'string';
}

/**
 * Creates an {@link HttpStatusError} from an HTTP response.
 *
 * When `body` is a {@link StructuredDaemonErrorBody}, its fields are used
 * directly (including any explicit `code`). When the body is unstructured,
 * the `code` is inferred from `status` via status-based inference (`inferCodeFromStatus`).
 *
 * The structured body path respects the body-supplied `code` over status
 * inference, preserving full backward compatibility for callers that supply
 * custom codes in the daemon response.
 *
 * @param status - HTTP status code.
 * @param url - Request URL.
 * @param method - HTTP method.
 * @param body - Parsed response body (may be structured or unstructured).
 * @param fallbackHint - Human-readable hint when the body provides none.
 */
export function createHttpStatusError(
  status: number,
  url: string,
  method: string,
  body: unknown,
  fallbackHint?: string,
): HttpStatusError {
  if (isStructuredDaemonErrorBody(body)) {
    // Code precedence (highest to lowest):
    //   1. Explicit code in the body (daemon-supplied)
    //   2. Category-derived code when body supplies a category (category is
    //      more semantically specific than the HTTP status in this case)
    //   3. Status-derived code as final fallback
    const structuredCode =
      body.code
      ?? (body.category !== undefined ? inferCodeFromCategory(body.category) : undefined)
      ?? inferCodeFromStatus(status)
      ?? 'UNKNOWN';
    return new HttpStatusError(body.error, {
      code: structuredCode,
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
    // Explicitly inject the status-inferred code so HttpStatusError's own
    // default ('SDK_HTTP_STATUS_ERROR') does not suppress the specific code.
    code: inferCodeFromStatus(status) ?? 'SDK_HTTP_STATUS_ERROR',
    status,
    url,
    method,
    body,
    hint: fallbackHint,
  });
}
