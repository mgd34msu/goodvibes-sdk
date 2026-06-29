/**
 * Shared provider-error helpers.
 *
 * Consolidated from three verbatim copies in lm-studio-helpers.ts,
 * llama-cpp.ts, and ollama.ts into a single definition.
 */

import { toProviderError } from '../utils/error-display.js';
import type { ProviderError } from '../types/errors.js';

/**
 * Extract an HTTP status code from an error object.
 * Checks `.status` before `.statusCode` to preserve provider-error convention.
 */
export function getErrorStatus(err: unknown): number | undefined {
  if (err && typeof err === 'object') {
    const record = err as { status?: unknown; statusCode?: unknown };
    if (typeof record.status === 'number') return record.status;
    if (typeof record.statusCode === 'number') return record.statusCode;
  }
  return undefined;
}

/**
 * Wrap an error into a ProviderError, attaching the HTTP status if present.
 */
export function normalizeProviderError(
  err: unknown,
  provider: string,
  operation: string,
  phase = 'request',
): ProviderError {
  const status = getErrorStatus(err);
  return toProviderError(err, {
    ...(status !== undefined ? { statusCode: status } : {}),
    provider,
    operation,
    phase,
  });
}
