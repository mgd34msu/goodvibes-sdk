import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTuiRoot } from './source-root.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');
const TUI_ROOT = resolveTuiRoot({ required: true });
const CHECK_ONLY = process.argv.includes('--check');

function ensureDir(path) {
  mkdirSync(dirname(path), { recursive: true });
}

function syncFile(target, content) {
  let current = null;
  try {
    current = readFileSync(target, 'utf8');
  } catch {
    current = null;
  }
  if (current === content) return false;
  if (CHECK_ONLY) {
    throw new Error(`transport seam is out of sync: ${target}`);
  }
  ensureDir(target);
  writeFileSync(target, content);
  return true;
}

function loadSource(path) {
  return readFileSync(resolve(TUI_ROOT, path), 'utf8');
}

function withHeader(content, sourcePath) {
  return `// Synced from goodvibes-tui/${sourcePath}\n${content}`;
}

const fileSpecs = [
  {
    source: 'src/runtime/transports/backoff.ts',
    target: 'packages/transport-http/src/backoff.ts',
    transform: (content) => content,
  },
  {
    source: 'src/runtime/transports/http-auth.ts',
    target: 'packages/transport-http/src/auth.ts',
    transform: (content) => content,
  },
  {
    source: 'src/runtime/transports/http-retry.ts',
    target: 'packages/transport-http/src/retry.ts',
    transform: (content) => content
      .replace("'./backoff.ts'", "'./backoff.js'"),
  },
  {
    source: 'src/runtime/transports/stream-reconnect.ts',
    target: 'packages/transport-http/src/reconnect.ts',
    transform: (content) => content
      .replace("'./backoff.ts'", "'./backoff.js'"),
  },
  {
    source: 'src/runtime/event-envelope.ts',
    target: 'packages/transport-core/src/event-envelope.ts',
    transform: (content) => content,
  },
  {
    source: 'src/runtime/event-feeds.ts',
    target: 'packages/transport-core/src/event-feeds.ts',
    transform: (content) => content.replace("'./event-envelope.ts'", "'./event-envelope.js'"),
  },
  {
    source: 'src/runtime/transports/client-transport.ts',
    target: 'packages/transport-core/src/client-transport.ts',
    transform: (content) => content,
  },
  {
    source: 'src/runtime/transports/direct-client.ts',
    target: 'packages/transport-direct/src/index.ts',
    transform: (content) => content.replace("'./client-transport.ts'", "'@pellux/goodvibes-transport-core'"),
  },
  {
    source: 'src/runtime/transports/domain-events.ts',
    target: 'packages/transport-realtime/src/domain-events.ts',
    transform: (content) => content
      .replace("'../event-envelope.ts'", "'@pellux/goodvibes-transport-core'")
      .replace("'../event-feeds.ts'", "'@pellux/goodvibes-transport-core'"),
  },
  {
    source: 'src/runtime/transports/runtime-events-client.ts',
    target: 'packages/transport-realtime/src/runtime-events.ts',
    transform: (content) => content
      .replace("import type { RuntimeEventDomain } from '../events/index.ts';\n", '')
      .replace("import { RUNTIME_EVENT_DOMAINS } from '../events/domain-map.ts';", "import { RUNTIME_EVENT_DOMAINS, type RuntimeEventDomain } from '@pellux/goodvibes-contracts';")
      .replace("import { resolveAuthToken, type AuthTokenResolver } from './http-auth.ts';\n", "import { resolveAuthToken, type AuthTokenResolver, type StreamReconnectPolicy, openRawServerSentEventStream as openServerSentEventStream } from '@pellux/goodvibes-transport-http';\n")
      .replace("import { buildUrl, normalizeBaseUrl } from './transport-paths.ts';\n", "import { buildUrl, normalizeBaseUrl } from '@pellux/goodvibes-transport-http';\n")
      .replace("import { openServerSentEventStream } from './sse-stream.ts';\n", '')
      .replace("import type { StreamReconnectPolicy } from './stream-reconnect.ts';\n", '')
      .replace("'./domain-events.ts'", "'./domain-events.js'"),
  },
  {
    source: 'src/runtime/transports/transport-paths.ts',
    target: 'packages/transport-http/src/paths.ts',
    transform: (content) => content,
  },
  {
    source: 'src/runtime/transports/http-json-transport.ts',
    target: 'packages/transport-http/src/http-core.ts',
    transform: (content) => content
      .replace("'./backoff.ts'", "'./backoff.js'")
      .replace("'./http-auth.ts'", "'./auth.js'")
      .replace("'./http-retry.ts'", "'./retry.js'")
      .replace("'./http-retry.ts'", "'./retry.js'")
      .replace("'./transport-paths.ts'", "'./paths.js'"),
  },
  {
    source: 'src/runtime/transports/contract-http-client.ts',
    target: 'packages/transport-http/src/contract-client.ts',
    transform: (content) => content
      .replace("import type { HttpJsonTransport } from './http-json-transport.ts';\n", "import type { HttpTransport } from './http.js';\n")
      .replace("import { openServerSentEventStream, type ServerSentEventHandlers } from './sse-stream.ts';", "import { openServerSentEventStream, type ServerSentEventHandlers } from './sse-stream.js';")
      .replace(/HttpJsonTransport/g, 'HttpTransport'),
  },
  {
    source: 'src/runtime/transports/sse-stream.ts',
    target: 'packages/transport-http/src/sse-stream.ts',
    transform: (content) => content
      .replace("'./backoff.ts'", "'./backoff.js'")
      .replace("'./http-auth.ts'", "'./auth.js'")
      .replace("'./stream-reconnect.ts'", "'./reconnect.js'")
      .replace("'./http-json-transport.ts'", "'./http-core.js'"),
  },
  {
    source: 'src/runtime/transports/operator-remote-client.ts',
    target: 'packages/operator-sdk/src/client-core.ts',
    transform: (content) => content
      .replace("import type { OperatorContractManifest, OperatorMethodContract } from '../../types/foundation-contract.ts';\n", "import type { OperatorContractManifest, OperatorMethodContract } from '@pellux/goodvibes-contracts';\n")
      .replace("} from '../../types/generated/foundation-client-types.ts';\n", "} from '@pellux/goodvibes-contracts';\n")
      .replace("import type { HttpJsonTransport } from './http-json-transport.ts';\n", "import type { HttpTransport } from '@pellux/goodvibes-transport-http';\n")
      .replace("} from './contract-http-client.ts';", "} from '@pellux/goodvibes-transport-http';")
      .replace(/HttpJsonTransport/g, 'HttpTransport'),
  },
  {
    source: 'src/runtime/transports/peer-remote-client.ts',
    target: 'packages/peer-sdk/src/client-core.ts',
    transform: (content) => content
      .replace("import type { PeerContractManifest, PeerEndpointContract } from '../../types/foundation-contract.ts';\n", "import type { PeerContractManifest, PeerEndpointContract } from '@pellux/goodvibes-contracts';\n")
      .replace("} from '../../types/generated/foundation-client-types.ts';\n", "} from '@pellux/goodvibes-contracts';\n")
      .replace("import type { HttpJsonTransport } from './http-json-transport.ts';\n", "import type { HttpTransport } from '@pellux/goodvibes-transport-http';\n")
      .replace("} from './contract-http-client.ts';", "} from '@pellux/goodvibes-transport-http';")
      .replace(/HttpJsonTransport/g, 'HttpTransport'),
  },
];

const staticFiles = [
  {
    target: 'packages/transport-core/src/index.ts',
    content: [
      "export type { EventEnvelope, EventEnvelopeContext } from './event-envelope.js';",
      "export { createEventEnvelope } from './event-envelope.js';",
      "export type { RuntimeEventFeed, RuntimeEventFeeds, EnvelopeSubscriber } from './event-feeds.js';",
      "export { createRuntimeEventFeed, createRuntimeEventFeeds } from './event-feeds.js';",
      "export type { ClientTransport } from './client-transport.js';",
      "export { createClientTransport } from './client-transport.js';",
      '',
    ].join('\n'),
  },
  {
    target: 'packages/transport-realtime/src/index.ts',
    content: [
      "export type {",
      "  DomainEventConnector,",
      "  DomainEvents,",
      "  SerializedEventEnvelope,",
      "} from './domain-events.js';",
      "export { createRemoteDomainEvents } from './domain-events.js';",
      "export type { RemoteRuntimeEvents, SerializedRuntimeEnvelope } from './runtime-events.js';",
      "export {",
      "  buildEventSourceUrl,",
      "  buildWebSocketUrl,",
      "  createEventSourceConnector,",
      "  createRemoteRuntimeEvents,",
      "  createWebSocketConnector,",
      "} from './runtime-events.js';",
      "export type { RuntimeEventConnectorOptions } from './runtime-events.js';",
      '',
    ].join('\n'),
  },
  {
    target: 'packages/transport-http/src/http.ts',
    content: [
      "import { ConfigurationError, ContractError, createHttpStatusError } from '@pellux/goodvibes-errors';",
      "import {",
      "  type AuthTokenResolver,",
      "  type HeaderResolver,",
      "  type MaybePromise,",
      "  mergeHeaders,",
      "  resolveAuthToken,",
      "  resolveHeaders,",
      "} from './auth.js';",
      "import {",
      "  type BackoffPolicy,",
      "  type ResolvedBackoffPolicy,",
      "  computeBackoffDelay,",
      "  normalizeBackoffPolicy,",
      "  sleepWithSignal,",
      "} from './backoff.js';",
      "import {",
      "  type HttpRetryPolicy,",
      "  type ResolvedHttpRetryPolicy,",
      "  DEFAULT_HTTP_RETRY_POLICY,",
      "  getHttpRetryDelay,",
      "  isRetryableHttpStatus,",
      "  isRetryableNetworkError,",
      "  normalizeHttpRetryPolicy,",
      "  resolveHttpRetryPolicy,",
      "} from './retry.js';",
      "import {",
      "  type ResolvedStreamReconnectPolicy,",
      "  type StreamReconnectPolicy,",
      "  DEFAULT_STREAM_RECONNECT_POLICY,",
      "  getStreamReconnectDelay,",
      "  normalizeStreamReconnectPolicy,",
      "} from './reconnect.js';",
      "import {",
      "  createFetch,",
      "  createHttpJsonTransport,",
      "  createJsonInit,",
      "  createJsonRequestInit,",
      "  readJsonBody,",
      "  type HttpJsonRequestOptions,",
      "  type HttpJsonTransport,",
      "  type HttpJsonTransportOptions,",
      "  type JsonObject,",
      "  type JsonValue,",
      "  type ResolvedContractRequest,",
      "} from './http-core.js';",
      '',
      "export type {",
      "  AuthTokenResolver,",
      "  BackoffPolicy,",
      "  HeaderResolver,",
      "  HttpJsonRequestOptions,",
      "  HttpRetryPolicy,",
      "  JsonObject,",
      "  JsonValue,",
      "  MaybePromise,",
      "  ResolvedBackoffPolicy,",
      "  ResolvedContractRequest,",
      "  ResolvedHttpRetryPolicy,",
      "  ResolvedStreamReconnectPolicy,",
      "  StreamReconnectPolicy,",
      "};",
      "export type HttpTransportOptions = HttpJsonTransportOptions;",
      "export type HttpTransport = HttpJsonTransport;",
      "export {",
      "  createFetch,",
      "  createJsonInit,",
      "  createJsonRequestInit,",
      "  readJsonBody,",
      "  mergeHeaders,",
      "  resolveAuthToken,",
      "  resolveHeaders,",
      "  computeBackoffDelay,",
      "  normalizeBackoffPolicy,",
      "  sleepWithSignal,",
      "  DEFAULT_HTTP_RETRY_POLICY,",
      "  getHttpRetryDelay,",
      "  isRetryableHttpStatus,",
      "  isRetryableNetworkError,",
      "  normalizeHttpRetryPolicy,",
      "  resolveHttpRetryPolicy,",
      "  DEFAULT_STREAM_RECONNECT_POLICY,",
      "  getStreamReconnectDelay,",
      "  normalizeStreamReconnectPolicy,",
      "};",
      '',
      "type TransportFailure = {",
      "  readonly transport: {",
      "    readonly status: number;",
      "    readonly url: string;",
      "    readonly body: unknown;",
      "    readonly method?: string;",
      "  };",
      "};",
      '',
      "function isTransportError(error: unknown): error is TransportFailure {",
      "  return Boolean(",
      "    error",
      "    && typeof error === 'object'",
      "    && 'transport' in error",
      "    && (error as TransportFailure).transport",
      "    && typeof (error as TransportFailure).transport.status === 'number'",
      "    && typeof (error as TransportFailure).transport.url === 'string'",
      "  );",
      "}",
      '',
      "export function normalizeTransportError(error: unknown): Error {",
      "  if (isTransportError(error)) {",
      "    return createHttpStatusError(",
      "      error.transport.status,",
      "      error.transport.url,",
      "      typeof error.transport.method === 'string' ? error.transport.method : 'GET',",
      "      error.transport.body,",
      "    );",
      "  }",
      "  if (error instanceof Error) {",
      "    if (error.message === 'Fetch implementation is required' || error.message === 'Transport baseUrl is required') {",
      "      return new ConfigurationError(error.message);",
      "    }",
      "    if (error.message.startsWith('Missing required path parameter')) {",
      "      return new ContractError(error.message);",
      "    }",
      "  }",
      "  return error instanceof Error ? error : new Error(String(error));",
      "}",
      '',
      "export function createHttpTransport(options: HttpTransportOptions): HttpTransport {",
      "  const transport = createHttpJsonTransport(options);",
      "  return {",
      "    ...transport,",
      "    async requestJson<T>(pathOrUrl: string, requestOptions: HttpJsonRequestOptions = {}): Promise<T> {",
      "      try {",
      "        return await transport.requestJson(pathOrUrl, requestOptions);",
      "      } catch (error) {",
      "        throw normalizeTransportError(error);",
      "      }",
      "    },",
      "    resolveContractRequest(method: string, path: string, input: Record<string, unknown> = {}): ResolvedContractRequest {",
      "      try {",
      "        return transport.resolveContractRequest(method, path, input);",
      "      } catch (error) {",
      "        throw normalizeTransportError(error);",
      "      }",
      "    },",
      "  };",
      "}",
      '',
    ].join('\n'),
  },
  {
    target: 'packages/transport-http/src/sse.ts',
    content: [
      "import { openServerSentEventStream as openServerSentEventStreamCore, type ServerSentEventHandlers, type ServerSentEventOptions as CoreServerSentEventOptions } from './sse-stream.js';",
      "import { type HttpTransport, normalizeTransportError } from './http.js';",
      '',
      "export type { ServerSentEventHandlers };",
      "export interface ServerSentEventOptions extends Omit<CoreServerSentEventOptions, 'authToken'> {}",
      '',
      "export async function openServerSentEventStream(",
      "  transport: HttpTransport,",
      "  pathOrUrl: string,",
      "  handlers: ServerSentEventHandlers,",
      "  options: ServerSentEventOptions = {},",
      "): Promise<() => void> {",
      "  const url = pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')",
      "    ? pathOrUrl",
      "    : transport.buildUrl(pathOrUrl);",
      "  try {",
      "    return await openServerSentEventStreamCore(transport.fetchImpl, url, handlers, {",
      "      ...options,",
      "      authToken: transport.authToken,",
      "      getAuthToken: transport.getAuthToken.bind(transport),",
      "    });",
      "  } catch (error) {",
      "    throw normalizeTransportError(error);",
      "  }",
      "}",
      '',
    ].join('\n'),
  },
  {
    target: 'packages/transport-http/src/index.ts',
    content: [
      "export type {",
      "  ContractInvokeOptions,",
      "  ContractRouteDefinition,",
      "  ContractRouteLike,",
      "  ContractStreamOptions,",
      "} from './contract-client.js';",
      "export {",
      "  buildContractInput,",
      "  invokeContractRoute,",
      "  openContractRouteStream,",
      "  requireContractRoute,",
      "} from './contract-client.js';",
      "export type {",
      "  HttpJsonRequestOptions,",
      "  HttpTransport,",
      "  HttpTransportOptions,",
      "  JsonObject,",
      "  JsonValue,",
      "  ResolvedContractRequest,",
      "} from './http.js';",
      "export {",
      "  createFetch,",
      "  createHttpTransport,",
      "  createJsonInit,",
      "  createJsonRequestInit,",
      "  normalizeTransportError,",
      "  readJsonBody,",
      "} from './http.js';",
      "export type { ServerSentEventHandlers, ServerSentEventOptions } from './sse.js';",
      "export { openServerSentEventStream } from './sse.js';",
      "export type { ServerSentEventHandlers as RawServerSentEventHandlers, ServerSentEventOptions as RawServerSentEventOptions } from './sse-stream.js';",
      "export { openServerSentEventStream as openRawServerSentEventStream } from './sse-stream.js';",
      "export type { AuthTokenResolver, HeaderResolver, MaybePromise } from './auth.js';",
      "export { mergeHeaders, resolveAuthToken, resolveHeaders } from './auth.js';",
      "export type { BackoffPolicy, ResolvedBackoffPolicy } from './backoff.js';",
      "export { computeBackoffDelay, normalizeBackoffPolicy, sleepWithSignal } from './backoff.js';",
      "export type { HttpRetryPolicy, ResolvedHttpRetryPolicy } from './retry.js';",
      "export { DEFAULT_HTTP_RETRY_POLICY, getHttpRetryDelay, isRetryableHttpStatus, isRetryableNetworkError, normalizeHttpRetryPolicy, resolveHttpRetryPolicy } from './retry.js';",
      "export type { StreamReconnectPolicy, ResolvedStreamReconnectPolicy } from './reconnect.js';",
      "export { DEFAULT_STREAM_RECONNECT_POLICY, getStreamReconnectDelay, normalizeStreamReconnectPolicy } from './reconnect.js';",
      "export type { TransportPaths } from './paths.js';",
      "export { buildUrl, createTransportPaths, normalizeBaseUrl } from './paths.js';",
      '',
    ].join('\n'),
  },
];

let changed = false;
for (const spec of fileSpecs) {
  const content = withHeader(spec.transform(loadSource(spec.source)), spec.source);
  changed = syncFile(resolve(SDK_ROOT, spec.target), content) || changed;
}

for (const spec of staticFiles) {
  changed = syncFile(resolve(SDK_ROOT, spec.target), spec.content) || changed;
}

if (CHECK_ONLY) {
  console.log('transport seams are in sync');
} else if (changed) {
  console.log('transport seams synced from goodvibes-tui');
} else {
  console.log('transport seams already up to date');
}
