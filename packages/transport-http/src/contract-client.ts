import { ContractError, GoodVibesSdkError } from '@pellux/goodvibes-errors';
import type { ZodType } from 'zod/v4';
import type { HttpTransport } from './http.js';
import { openServerSentEventStream, type ServerSentEventHandlers } from './sse-stream.js';

export interface ContractRouteDefinition {
  readonly method: string;
  readonly path: string;
}

export interface ContractRouteLike {
  readonly id: string;
}

export interface ContractInvokeOptions {
  readonly signal?: AbortSignal;
  readonly headers?: HeadersInit;
  /**
   * Optional Zod v4 schema to validate the parsed response body against.
   * When provided, a failed parse throws a {@link ContractError} with
   * field-level detail: operation, field path, expected type, and a
   * recovery hint.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly responseSchema?: ZodType<any>;
}

export interface ContractStreamOptions extends ContractInvokeOptions {
  readonly handlers: ServerSentEventHandlers;
}

export function buildContractInput(
  primaryKey: string,
  primaryValue: string,
  input?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    [primaryKey]: primaryValue,
    ...(input ?? {}),
  };
}

export function requireContractRoute<TRoute extends ContractRouteLike>(
  routes: readonly TRoute[],
  routeId: string,
  kind: string,
): TRoute {
  const route = routes.find((candidate) => candidate.id === routeId);
  if (!route) {
    throw new GoodVibesSdkError(`Unknown ${kind} "${routeId}". Verify the method/route id is correct and that your contract manifest is up to date.`, { category: 'contract', source: 'contract', recoverable: false });
  }
  return route;
}

export async function invokeContractRoute<T = unknown>(
  transport: HttpTransport,
  route: ContractRouteDefinition,
  input?: Record<string, unknown>,
  options: ContractInvokeOptions = {},
): Promise<T> {
  const resolved = transport.resolveContractRequest(route.method, route.path, input);
  const body = await transport.requestJson<T>(resolved.url, {
    method: resolved.method,
    body: resolved.body,
    headers: options.headers,
    signal: options.signal,
  });
  if (options.responseSchema) {
    const result = options.responseSchema.safeParse(body);
    if (!result.success) {
      const issue = result.error.issues[0];
      const fieldPath = issue ? issue.path.join('.') || '(root)' : '(unknown)';
      const expected = issue ? (issue as { readonly expected?: string }).expected ?? issue.code : 'unknown';
      const received = issue ? (issue as { readonly received?: string }).received ?? 'unknown' : 'unknown';
      throw new ContractError(
        `Response validation failed for "${route.method} ${route.path}": field "${fieldPath}" expected ${expected} but received ${received}. Ensure the server is running a compatible version of the GoodVibes daemon.`,
        { source: 'contract' },
      );
    }
    return result.data as T;
  }
  return body;
}

export async function openContractRouteStream(
  transport: HttpTransport,
  route: ContractRouteDefinition,
  input: Record<string, unknown> | undefined,
  options: ContractStreamOptions,
): Promise<() => void> {
  const resolved = transport.resolveContractRequest(route.method, route.path, input);
  return await openServerSentEventStream(
    transport.fetchImpl,
    resolved.url,
    options.handlers,
    {
      authToken: transport.authToken,
      headers: options.headers,
      signal: options.signal,
    },
  );
}
