import {
  type DaemonErrorCategory,
  type DaemonErrorSource,
  GoodVibesSdkError,
  isStructuredDaemonErrorBody,
  type StructuredDaemonErrorBody,
} from '@goodvibes/errors';

export interface JsonErrorResponseOptions {
  readonly status?: number;
  readonly fallbackMessage?: string;
  readonly source?: DaemonErrorSource;
}

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

export function buildErrorResponseBody(
  error: unknown,
  options: JsonErrorResponseOptions = {},
): StructuredDaemonErrorBody {
  if (isStructuredDaemonErrorBody(error)) {
    return error;
  }
  if (error instanceof GoodVibesSdkError) {
    return {
      error: error.message,
      ...(error.hint ? { hint: error.hint } : {}),
      ...(error.code ? { code: error.code } : {}),
      ...(normalizeCategory(error.category) ? { category: normalizeCategory(error.category) } : {}),
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
  return {
    error: readMessage(error, options.fallbackMessage),
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
