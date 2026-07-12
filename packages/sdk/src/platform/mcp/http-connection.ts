/**
 * Streamable HTTP connection for the MCP client.
 *
 * Speaks both eras of the transport:
 * - modern (2026-07-28+): stateless POST per request; MCP-Protocol-Version,
 *   Mcp-Method and Mcp-Name headers; per-request `_meta`; no sessions.
 * - legacy (2025-03-26..2025-11-25): initialize handshake, Mcp-Session-Id
 *   header, MCP-Protocol-Version header from 2025-06-18 onward.
 *
 * Era detection follows the specification: attempt a modern request first;
 * a recognized modern JSON-RPC error identifies a modern server (negotiate,
 * don't fall back); anything else falls back to the initialize handshake.
 * The era is cached for the lifetime of this connection (one origin).
 */
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { isRecord } from '../utils/record-coerce.js';
import { buildStandardRequestHeaders } from './http-headers.js';
import {
  buildModernMeta,
  isModernVersion,
  isRecognizedModernErrorCode,
  MCP_HTTP_VERSION_HEADER_SINCE,
  MCP_LEGACY_REVISIONS,
  MCP_STATELESS_REVISION,
  MCP_SUPPORTED_VERSIONS,
  parseDiscoverSupportedVersions,
  parseSupportedVersionsFromError,
  selectMutualVersion,
  withModernMeta,
  type McpClientIdentity,
  type McpNegotiatedProtocol,
} from './protocol.js';

export interface McpHttpServerMessageHandlers {
  /** Server-to-client notification observed on a response stream. */
  onNotification?: ((method: string, params?: unknown) => void) | undefined;
  /**
   * Server-to-client JSON-RPC request observed on a legacy SSE stream.
   * Return a result to answer it; throw (or return undefined) to have the
   * connection answer method-not-found.
   */
  onServerRequest?: ((id: number | string, method: string, params?: unknown) => Promise<unknown> | unknown) | undefined;
}

export interface McpHttpConnectionOptions {
  readonly serverName: string;
  readonly url: string;
  readonly clientInfo: McpClientIdentity;
  readonly clientCapabilities: Record<string, unknown>;
  readonly timeoutMs: number;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly handlers?: McpHttpServerMessageHandlers | undefined;
}

interface JsonRpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

export class McpRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'McpRpcError';
  }
}

function parseJsonRpcError(body: unknown): JsonRpcErrorShape | null {
  if (!isRecord(body) || !isRecord(body.error)) return null;
  const { code, message } = body.error;
  if (typeof code !== 'number' || typeof message !== 'string') return null;
  return { code, message, data: body.error.data };
}

/** Parse `data:` payloads out of an SSE stream incrementally. */
class SseEventParser {
  private buffer = '';

  push(chunk: string): string[] {
    this.buffer += chunk;
    const events: string[] = [];
    let boundary: number;
    while ((boundary = this.buffer.search(/\r?\n\r?\n/)) !== -1) {
      const rawEvent = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary).replace(/^\r?\n\r?\n/, '');
      const dataLines = rawEvent
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''));
      if (dataLines.length > 0) events.push(dataLines.join('\n'));
    }
    return events;
  }
}

export class McpHttpConnection {
  private negotiatedProtocol: McpNegotiatedProtocol | null = null;
  private sessionId: string | null = null;
  private closed = false;
  private nextId = 1;

  constructor(private readonly options: McpHttpConnectionOptions) {}

  get isOpen(): boolean {
    return !this.closed && this.negotiatedProtocol !== null;
  }

  get negotiated(): McpNegotiatedProtocol | null {
    return this.negotiatedProtocol;
  }

  private get fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? fetch;
  }

  /**
   * Detect the server's era and negotiate a protocol version.
   * Modern attempt first; recognized modern errors negotiate; anything else
   * falls back to the legacy initialize handshake.
   */
  async negotiate(): Promise<McpNegotiatedProtocol> {
    if (this.negotiatedProtocol) return this.negotiatedProtocol;
    let modernOutcome: { supported: string[] } | 'legacy';
    try {
      const result = await this.postAndParse('server/discover', withModernMeta({}, this.modernMeta(MCP_STATELESS_REVISION)), {
        era: 'modern',
        version: MCP_STATELESS_REVISION,
      });
      const supported = parseDiscoverSupportedVersions(result) ?? [MCP_STATELESS_REVISION];
      modernOutcome = { supported };
    } catch (err) {
      if (err instanceof McpRpcError && isRecognizedModernErrorCode(err.code)) {
        // A modern server that rejected our preferred version: negotiate.
        const supported = parseSupportedVersionsFromError(err.data);
        if (!supported) {
          throw new Error(`MCP server '${this.options.serverName}' rejected protocol version ${MCP_STATELESS_REVISION} without advertising supported versions: ${err.message}`);
        }
        modernOutcome = { supported };
      } else {
        modernOutcome = 'legacy';
      }
    }

    if (modernOutcome !== 'legacy') {
      const mutual = selectMutualVersion(modernOutcome.supported);
      if (!mutual) {
        throw new Error(
          `MCP server '${this.options.serverName}' shares no protocol version with this client `
          + `(server: ${modernOutcome.supported.join(', ')}; client: ${MCP_SUPPORTED_VERSIONS.join(', ')})`,
        );
      }
      if (isModernVersion(mutual)) {
        this.negotiatedProtocol = { era: 'modern', version: mutual, transport: 'http' };
        return this.negotiatedProtocol;
      }
      // Dual-era server whose newest mutual version is handshake-based.
    }

    return this.negotiateLegacy();
  }

  private async negotiateLegacy(): Promise<McpNegotiatedProtocol> {
    const requested = MCP_LEGACY_REVISIONS[0];
    const result = await this.postAndParse('initialize', {
      protocolVersion: requested,
      capabilities: this.options.clientCapabilities,
      clientInfo: this.options.clientInfo,
    }, { era: 'legacy', version: requested, initialize: true });
    const serverVersion = isRecord(result) && typeof result.protocolVersion === 'string'
      ? result.protocolVersion
      : requested;
    if (!MCP_SUPPORTED_VERSIONS.includes(serverVersion)) {
      throw new Error(`MCP server '${this.options.serverName}' negotiated unsupported protocol version ${serverVersion} (client supports: ${MCP_SUPPORTED_VERSIONS.join(', ')})`);
    }
    this.negotiatedProtocol = { era: 'legacy', version: serverVersion, transport: 'http' };
    await this.notify('notifications/initialized', {});
    return this.negotiatedProtocol;
  }

  /** Send a request and return its JSON-RPC result. */
  async request(method: string, params: unknown, extraHeaders?: Record<string, string>): Promise<unknown> {
    const negotiated = this.negotiatedProtocol;
    if (!negotiated) throw new Error(`MCP server '${this.options.serverName}': not connected`);
    const finalParams = negotiated.era === 'modern'
      ? withModernMeta(params, this.modernMeta(negotiated.version))
      : params;
    return this.postAndParse(method, finalParams, {
      era: negotiated.era,
      version: negotiated.version,
      ...(extraHeaders ? { extraHeaders } : {}),
    });
  }

  /** Send a notification (expects 202, no body). */
  async notify(method: string, params: unknown): Promise<void> {
    const negotiated = this.negotiatedProtocol;
    const era = negotiated?.era ?? 'legacy';
    const version = negotiated?.version ?? MCP_LEGACY_REVISIONS[0];
    const body = { jsonrpc: '2.0', method, params };
    try {
      await this.post(body, { era, version, method, params });
    } catch (err) {
      logger.warn('McpHttpConnection: failed to send notification', {
        server: this.options.serverName,
        method,
        err: summarizeError(err),
      });
    }
  }

  /** Best-effort session termination (legacy sessions only). */
  async close(): Promise<void> {
    this.closed = true;
    if (this.sessionId) {
      try {
        await this.fetchImpl(this.options.url, {
          method: 'DELETE',
          headers: { 'Mcp-Session-Id': this.sessionId },
        });
      } catch {
        // Session termination is best-effort; the server may not support DELETE.
      }
      this.sessionId = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private modernMeta(version: string): Record<string, unknown> {
    return buildModernMeta(version, this.options.clientInfo, this.options.clientCapabilities);
  }

  private buildHeaders(input: {
    era: 'modern' | 'legacy';
    version: string;
    method: string;
    params: unknown;
    initialize?: boolean | undefined;
    extraHeaders?: Record<string, string> | undefined;
  }): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (input.era === 'modern') {
      headers['MCP-Protocol-Version'] = input.version;
      Object.assign(headers, buildStandardRequestHeaders(input.method, input.params));
    } else {
      // The version header exists from 2025-06-18 on and is not sent on the
      // initialize request itself (the version is not negotiated yet).
      if (!input.initialize && input.version >= MCP_HTTP_VERSION_HEADER_SINCE) {
        headers['MCP-Protocol-Version'] = input.version;
      }
      if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    }
    if (input.extraHeaders) Object.assign(headers, input.extraHeaders);
    return headers;
  }

  private async postAndParse(
    method: string,
    params: unknown,
    options: { era: 'modern' | 'legacy'; version: string; initialize?: boolean; extraHeaders?: Record<string, string> },
  ): Promise<unknown> {
    const id = this.nextId++;
    const body = { jsonrpc: '2.0', id, method, params };
    const response = await this.post(body, { ...options, method, params });

    if (response.status === 202) {
      throw new Error(`MCP server '${this.options.serverName}': request '${method}' was accepted as a notification (202) instead of answered`);
    }
    if (!response.ok) {
      const errorBody = await response.json().catch(() => null);
      const rpcError = parseJsonRpcError(errorBody);
      if (rpcError) throw new McpRpcError(rpcError.code, rpcError.message, rpcError.data);
      throw new Error(`MCP server '${this.options.serverName}': HTTP ${response.status} for '${method}'`);
    }

    this.captureSessionId(response);
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
      return this.readSseResponse(response, id, method);
    }
    const parsed: unknown = await response.json();
    return this.resolveJsonRpcResponse(parsed, method);
  }

  private async post(
    body: unknown,
    options: { era: 'modern' | 'legacy'; version: string; method: string; params: unknown; initialize?: boolean; extraHeaders?: Record<string, string> },
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    try {
      return await this.fetchImpl(this.options.url, {
        method: 'POST',
        headers: this.buildHeaders(options),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private captureSessionId(response: Response): void {
    const session = response.headers.get('mcp-session-id');
    if (session) this.sessionId = session;
  }

  private resolveJsonRpcResponse(message: unknown, method: string): unknown {
    if (!isRecord(message)) {
      throw new Error(`MCP server '${this.options.serverName}': non-object JSON-RPC response for '${method}'`);
    }
    const rpcError = parseJsonRpcError(message);
    if (rpcError) throw new McpRpcError(rpcError.code, rpcError.message, rpcError.data);
    return message.result;
  }

  private async readSseResponse(response: Response, requestId: number, method: string): Promise<unknown> {
    const bodyStream = response.body;
    if (!bodyStream) throw new Error(`MCP server '${this.options.serverName}': empty SSE body for '${method}'`);
    const reader = bodyStream.getReader();
    const decoder = new TextDecoder();
    const parser = new SseEventParser();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const payload of parser.push(decoder.decode(value, { stream: true }))) {
          let message: unknown;
          try {
            message = JSON.parse(payload);
          } catch {
            logger.warn('McpHttpConnection: unparseable SSE event', { server: this.options.serverName });
            continue;
          }
          if (!isRecord(message)) continue;
          if (message.id === requestId && !('method' in message)) {
            return this.resolveJsonRpcResponse(message, method);
          }
          this.dispatchStreamMessage(message);
        }
      }
    } finally {
      reader.releaseLock();
    }
    throw new Error(`MCP server '${this.options.serverName}': SSE stream for '${method}' ended without a response`);
  }

  private dispatchStreamMessage(message: Record<string, unknown>): void {
    const method = typeof message.method === 'string' ? message.method : null;
    if (!method) return;
    const id = message.id;
    if (typeof id === 'number' || typeof id === 'string') {
      // Legacy servers may send JSON-RPC requests on SSE streams; answer via POST.
      void this.answerServerRequest(id, method, message.params);
      return;
    }
    try {
      this.options.handlers?.onNotification?.(method, message.params);
    } catch (err) {
      logger.warn('McpHttpConnection: notification observer threw', {
        server: this.options.serverName,
        err: summarizeError(err),
      });
    }
  }

  private async answerServerRequest(id: number | string, method: string, params: unknown): Promise<void> {
    const negotiated = this.negotiatedProtocol;
    const era = negotiated?.era ?? 'legacy';
    const version = negotiated?.version ?? MCP_LEGACY_REVISIONS[0];
    let body: Record<string, unknown>;
    try {
      const handler = this.options.handlers?.onServerRequest;
      const result = handler ? await handler(id, method, params) : undefined;
      body = result === undefined
        ? { jsonrpc: '2.0', id, error: { code: -32601, message: `Client method '${method}' is not supported` } }
        : { jsonrpc: '2.0', id, result };
    } catch (err) {
      body = { jsonrpc: '2.0', id, error: { code: -32603, message: summarizeError(err) } };
    }
    try {
      await this.post(body, { era, version, method, params });
    } catch (err) {
      logger.warn('McpHttpConnection: failed to answer server request', {
        server: this.options.serverName,
        method,
        err: summarizeError(err),
      });
    }
  }
}
