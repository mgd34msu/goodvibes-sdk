/**
 * error-codes.ts — the canonical {@link SDKErrorCode} union, its runtime-accessible
 * {@link SDKErrorCodes} mirror, and the two membership/narrowing helpers built on it.
 *
 * Split out of index.ts to stay under the repo's 800-line file cap (see
 * scripts/check-line-cap.ts) — this block is self-contained (no dependency on
 * GoodVibesSdkError or anything else in index.ts) and index.ts re-exports it
 * unchanged, so this is a pure file-organization move with no API surface change.
 */

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
  // Gateway method dispatch
  | 'NOT_INVOKABLE'
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
  NOT_INVOKABLE: 'NOT_INVOKABLE',
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
