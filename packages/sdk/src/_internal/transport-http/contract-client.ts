// Synced from packages/transport-http/src/contract-client.ts
import { GoodVibesSdkError } from '../errors/index.js';
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

export function invokeContractRoute<T = unknown>(
  transport: HttpTransport,
  route: ContractRouteDefinition,
  input?: Record<string, unknown>,
  options: ContractInvokeOptions = {},
): Promise<T> {
  const resolved = transport.resolveContractRequest(route.method, route.path, input);
  return transport.requestJson<T>(resolved.url, {
    method: resolved.method,
    body: resolved.body,
    headers: options.headers,
    signal: options.signal,
  });
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
