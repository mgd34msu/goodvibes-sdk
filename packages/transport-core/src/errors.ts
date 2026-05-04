import { GoodVibesSdkError } from '@pellux/goodvibes-errors';

export function isAbortError(error: unknown): boolean {
  return Boolean(
    error
      && typeof error === 'object'
      && 'name' in error
      && (error as { readonly name?: unknown }).name === 'AbortError',
  );
}

export function describeUnknownTransportError(error: unknown): string {
  if (typeof error === 'string') return error;
  if (typeof error === 'number' || typeof error === 'boolean' || error === null || error === undefined) {
    return String(error);
  }
  if (typeof error !== 'object') return String(error);

  const record = error as Record<string, unknown>;
  const nested = record.error;
  const nestedMessage = nested instanceof Error
    ? nested.message
    : nested && typeof nested === 'object' && typeof (nested as { readonly message?: unknown }).message === 'string'
      ? (nested as { readonly message: string }).message
      : undefined;
  const target = record.target && typeof record.target === 'object'
    ? `[target:${(record.target as { readonly constructor?: { readonly name?: string } }).constructor?.name ?? 'object'}]`
    : undefined;
  const fields = [
    typeof record.name === 'string' ? `name=${record.name}` : undefined,
    typeof record.type === 'string' ? `type=${record.type}` : undefined,
    typeof record.message === 'string' ? `message=${record.message}` : undefined,
    typeof record.reason === 'string' ? `reason=${record.reason}` : undefined,
    typeof record.code === 'number' ? `code=${record.code}` : undefined,
    nestedMessage ? `error=${nestedMessage}` : undefined,
    target,
  ].filter(Boolean);
  return fields.length > 0 ? fields.join(' ') : Object.prototype.toString.call(error);
}

export function transportErrorFromUnknown(error: unknown, context: string): Error {
  if (error instanceof Error) return error;
  const code = typeof error === 'object'
    && error !== null
    && typeof (error as { readonly code?: unknown }).code === 'string'
    ? (error as { readonly code: string }).code
    : '';
  // NIT-6: include undici/Bun error codes alongside Node-style errno codes.
  // MIN-8: recoverable is ONLY set to true for recognized network-layer error codes
  // (errno values, undici codes, and 'fetch failed'). Unknown/unrecognized codes
  // (including programmer errors wrapped as non-Error objects) get recoverable:false
  // so they do not trigger retry loops.
  const recoverable = /^(?:EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EPIPE|ECONNABORTED)$/.test(code)
    || /^UND_ERR_/.test(code)
    || code === 'fetch failed';
  return new GoodVibesSdkError(`${context}: ${describeUnknownTransportError(error)}`, {
    category: 'network',
    source: 'transport',
    recoverable,
  });
}
