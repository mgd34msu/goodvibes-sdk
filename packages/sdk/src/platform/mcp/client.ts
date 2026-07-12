/**
 * McpClient — connects to a single MCP server over stdio (spawned process,
 * newline-delimited JSON-RPC 2.0) or Streamable HTTP (config `url`).
 *
 * Protocol currency: speaks the stateless 2026-07-28 revision (per-request
 * `_meta`, `server/discover`, Multi Round-Trip Requests) and the
 * handshake-based revisions back through 2024-11-05. Era detection follows
 * the specification: probe `server/discover` first, fall back to
 * `initialize` on any error that is not a recognized modern error. The
 * negotiated version is exposed via `protocolInfo` for diagnostics.
 *
 * Progressive loading: connect() fetches no tool data at all; listTools()
 * returns names + descriptions only; getToolSchema() fetches full
 * inputSchema on demand and caches it.
 */
import { logger } from '../utils/logger.js';
import { VERSION } from '../version.js';
import type { McpServerConfig } from './config.js';
import { summarizeError } from '../utils/error-display.js';
import { isRecord } from '../utils/record-coerce.js';
import { McpHttpConnection, McpRpcError } from './http-connection.js';
import type {
  McpClientNotification,
  McpClientOptions,
  McpClientServerRequest,
  McpClientUnhandledResponse,
  McpToolInfo,
  McpToolSchema,
} from './client-types.js';
import {
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  jsonRpcIdKey,
  type JsonRpcId,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from './jsonrpc.js';
import { buildParamHeaders, hasValidHeaderAnnotations } from './http-headers.js';
import {
  buildModernMeta,
  isInputRequiredResult,
  isModernVersion,
  isRecognizedModernErrorCode,
  MCP_LEGACY_REVISIONS,
  MCP_STATELESS_REVISION,
  MCP_SUPPORTED_VERSIONS,
  parseDiscoverSupportedVersions,
  parseSupportedVersionsFromError,
  selectMutualVersion,
  withModernMeta,
  type McpNegotiatedProtocol,
} from './protocol.js';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const PING_TIMEOUT_MS = 5_000;
const RESTART_DELAY_MS = 2_000;
const MAX_RESTART_ATTEMPTS = 3;
/** Era-detection probe: a legacy server answers `server/discover` quickly with method-not-found; this bound covers servers that stay silent instead. */
const DISCOVER_PROBE_TIMEOUT_MS = 3_000;
/** Upper bound on Multi Round-Trip Request retries for one tool call. */
const MAX_MRTR_ROUND_TRIPS = 4;

export type { JsonRpcId } from './jsonrpc.js';
export type {
  McpClientNotification,
  McpClientOptions,
  McpClientServerRequest,
  McpClientUnhandledResponse,
  McpElicitationResolver,
  McpProcessSpec,
  McpToolInfo,
  McpToolSchema,
} from './client-types.js';

export class McpClient {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private nextId = 1;
  private pendingRequests = new Map<string, PendingRequest>();
  private buffer = '';
  private readLoopRunning = false;
  private restartCount = 0;
  private initialized = false;
  /** Set true by disconnect() to suppress the read-loop's auto-restart. Reset on each successful _startProcess(). */
  private intentionalClose = false;

  /** Streamable HTTP connection when the server is configured with a `url`. */
  private http: McpHttpConnection | null = null;

  /** Outcome of protocol version negotiation, for diagnostics. */
  private negotiated: McpNegotiatedProtocol | null = null;

  /** Cache: tool name → full schema (populated lazily on first callTool) */
  private schemaCache = new Map<string, McpToolSchema>();

  /** Minimal tool info loaded at connect time (name + description only) */
  private toolInfoCache: McpToolInfo[] | null = null;

  constructor(
    private config: McpServerConfig,
    private options?: McpClientOptions,
  ) {}

  get name(): string {
    return this.config.name;
  }

  get isConnected(): boolean {
    if (this.http) return this.http.isOpen;
    if (!this.proc) return false;
    try {
      return (this.proc as { exitCode: number | null }).exitCode === null;
    } catch {
      return false;
    }
  }

  /** The negotiated protocol (era, version, transport), or null before connect. */
  get protocolInfo(): McpNegotiatedProtocol | null {
    return this.negotiated;
  }

  /**
   * connect — Start the transport and negotiate a protocol version.
   * After connect, listTools() is available. No tool data is fetched here.
   */
  async connect(): Promise<void> {
    if (this.config.url) {
      if (this.http?.isOpen) return;
      this.http = new McpHttpConnection({
        serverName: this.config.name,
        url: this.config.url,
        clientInfo: { name: 'goodvibes-sdk', version: VERSION },
        clientCapabilities: this._clientCapabilities(),
        timeoutMs: this.options?.timeout ?? DEFAULT_TIMEOUT_MS,
        fetchImpl: this.options?.fetchImpl,
        handlers: {
          onNotification: (method, params) => {
            this._handleNotification({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) });
          },
          onServerRequest: (id, method, params) => this._answerServerRequestOverHttp(id, method, params),
        },
      });
      this.negotiated = await this.http.negotiate();
      return;
    }
    if (this.proc && this.isConnected) return;
    await this._startProcess();
    await this._negotiate();
  }

  /**
   * listTools — Return tool names and descriptions (progressive loading).
   * Full schemas are NOT fetched here; call getToolSchema() to get them.
   */
  async listTools(): Promise<McpToolInfo[]> {
    if (!this.isConnected) {
      throw new Error(`McpClient(${this.config.name}): not connected`);
    }
    if (this.toolInfoCache) return this.toolInfoCache;

    const result = await this._request<{ tools: Array<{ name: string; description?: string }> }>('tools/list');
    this.toolInfoCache = (result.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? '',
    }));
    return this.toolInfoCache;
  }

  /**
   * getToolSchema — Fetch full JSON schema for a tool (lazy, cached).
   * MCP protocol provides full schemas in tools/list; we cache them on first access.
   */
  async getToolSchema(toolName: string): Promise<McpToolSchema | null> {
    if (this.schemaCache.has(toolName)) {
      return this.schemaCache.get(toolName)!;
    }

    if (!this.isConnected) {
      throw new Error(`McpClient(${this.config.name}): not connected`);
    }

    // Fetch all tools with full schemas and cache them all at once
    const result = await this._request<{
      tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
    }>('tools/list');

    for (const t of result.tools ?? []) {
      const inputSchema = t.inputSchema ?? { type: 'object', properties: {} };
      // On the HTTP transport the specification requires excluding tool
      // definitions whose x-mcp-header annotations are invalid.
      if (this.http && !hasValidHeaderAnnotations(inputSchema)) {
        logger.warn('McpClient: excluding tool with invalid x-mcp-header annotations', {
          server: this.config.name,
          tool: t.name,
        });
        continue;
      }
      this.schemaCache.set(t.name, {
        name: t.name,
        description: t.description ?? '',
        inputSchema,
      });
    }

    return this.schemaCache.get(toolName) ?? null;
  }

  /**
   * callTool — Execute a tool on the MCP server.
   * Fetches full schema on first use (if not already cached).
   * Modern-era servers may answer with an input_required interim result
   * (Multi Round-Trip Requests); elicitation input requests are resolved
   * through the wired resolver and the call is retried with inputResponses.
   */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.isConnected) {
      throw new Error(`McpClient(${this.config.name}): not connected`);
    }
    // Ensure schema is cached on first use
    if (!this.schemaCache.has(toolName)) {
      await this.getToolSchema(toolName);
    }

    let params: Record<string, unknown> = { name: toolName, arguments: args };
    for (let roundTrip = 0; roundTrip <= MAX_MRTR_ROUND_TRIPS; roundTrip++) {
      const result = await this._request('tools/call', params, this._toolCallHeaders(toolName, args));
      if (this.negotiated?.era !== 'modern' || !isInputRequiredResult(result)) {
        return result;
      }
      const inputResponses = await this._resolveInputRequests(toolName, result.inputRequests);
      params = {
        name: toolName,
        arguments: args,
        ...(inputResponses ? { inputResponses } : {}),
        ...(typeof result.requestState === 'string' ? { requestState: result.requestState } : {}),
      };
    }
    throw new Error(`McpClient(${this.config.name}): tool '${toolName}' still required input after ${MAX_MRTR_ROUND_TRIPS} round trips`);
  }

  /** Mcp-Param-* headers for a tools/call on the modern HTTP transport. */
  private _toolCallHeaders(toolName: string, args: Record<string, unknown>): Record<string, string> | undefined {
    if (!this.http || this.negotiated?.era !== 'modern') return undefined;
    const schema = this.schemaCache.get(toolName);
    if (!schema) return undefined;
    const headers = buildParamHeaders(schema.inputSchema, args);
    return Object.keys(headers).length > 0 ? headers : undefined;
  }

  /** Resolve MRTR input requests; only elicitation is answerable client-side. */
  private async _resolveInputRequests(
    toolName: string,
    inputRequests: Record<string, unknown> | undefined,
  ): Promise<Record<string, unknown> | null> {
    if (!inputRequests) return null;
    const resolver = this.options?.onElicitation;
    const responses: Record<string, unknown> = {};
    for (const [key, request] of Object.entries(inputRequests)) {
      const method = isRecord(request) && typeof request.method === 'string' ? request.method : 'unknown';
      if (method !== 'elicitation/create' || !resolver) {
        throw new Error(
          `McpClient(${this.config.name}): tool '${toolName}' requested '${method}' input this client cannot provide`,
        );
      }
      const params = isRecord(request) ? request.params : undefined;
      responses[key] = await resolver({ serverName: this.config.name, id: key, params });
    }
    return responses;
  }

  /**
   * disconnect — Stop the server process and clean up.
   */
  async disconnect(): Promise<void> {
    // Mark this as a deliberate shutdown so the read-loop finally does not
    // resurrect the process via _scheduleRestart(). Set synchronously before
    // any await so it is already true when the detached read loop runs.
    this.intentionalClose = true;
    if (this.http) {
      await this.http.close();
      this.http = null;
      this.negotiated = null;
      return;
    }
    if (!this.proc) return;
    // Reject all pending requests
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`McpClient(${this.config.name}): disconnected`));
    }
    this.pendingRequests.clear();

    try {
      (this.proc.stdin as import('bun').FileSink).end();
      this.proc.kill();
      await this.proc.exited;
    } catch (err: unknown) {
      // The process may already be gone; record the shutdown error for ops.
      logger.warn('[McpClient] error during process shutdown', { error: String(err) });
    } finally {
      this.proc = null;
      this.buffer = '';
      this.readLoopRunning = false;
      this.initialized = false;
      this.negotiated = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async _startProcess(): Promise<void> {
    const processSpec = this.options?.processSpec;
    const cmd = processSpec?.command ?? this.config.command;
    if (!cmd) {
      throw new Error(`McpClient(${this.config.name}): no command configured (stdio servers need 'command'; HTTP servers need 'url')`);
    }
    const args = processSpec?.args ?? this.config.args ?? [];
    const env = { ...process.env, ...(this.config.env ?? {}), ...(processSpec?.env ?? {}) };
    const cwd = processSpec?.cwd;

    try {
      this.proc = Bun.spawn([cmd, ...args], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        env,
        ...(cwd ? { cwd } : {}),
      });
      this.buffer = '';
      this.restartCount = 0;
      this.intentionalClose = false;
      this._startReadLoop();
    } catch (err) {
      logger.error('McpClient: failed to start process', { server: this.config.name, err: summarizeError(err) });
      this.proc = null;
      throw new Error(`McpClient(${this.config.name}): failed to start: ${summarizeError(err)}`);
    }
  }

  /** Capabilities advertised to the server (both eras). */
  private _clientCapabilities(): Record<string, unknown> {
    // Advertise the elicitation capability only when a resolver is wired, so
    // a spec-compliant server knows it may ask the user for input (and does
    // not when we would only reject it).
    return this.options?.onElicitation ? { elicitation: {} } : {};
  }

  /**
   * Detect the server's era and negotiate a protocol version (stdio).
   *
   * Probe with `server/discover` first, as the specification directs for
   * dual-era stdio clients. A recognized modern error negotiates from the
   * server's advertised versions; any other error (or probe silence) falls
   * back to the `initialize` handshake.
   */
  private async _negotiate(): Promise<void> {
    if (this.initialized) return;
    let modernSupported: string[] | 'legacy';
    try {
      const meta = buildModernMeta(MCP_STATELESS_REVISION, { name: 'goodvibes-sdk', version: VERSION }, this._clientCapabilities());
      const result = await this._rawRequest('server/discover', withModernMeta({}, meta), DISCOVER_PROBE_TIMEOUT_MS);
      modernSupported = parseDiscoverSupportedVersions(result) ?? [MCP_STATELESS_REVISION];
    } catch (err) {
      const supported = err instanceof McpRpcError && isRecognizedModernErrorCode(err.code)
        ? parseSupportedVersionsFromError(err.data)
        : null;
      modernSupported = supported ?? 'legacy';
    }

    if (modernSupported !== 'legacy') {
      const mutual = selectMutualVersion(modernSupported);
      if (!mutual) {
        throw new Error(
          `McpClient(${this.config.name}): no shared protocol version `
          + `(server: ${modernSupported.join(', ')}; client: ${MCP_SUPPORTED_VERSIONS.join(', ')})`,
        );
      }
      if (isModernVersion(mutual)) {
        // Stateless era: no handshake; every request carries _meta.
        this.negotiated = { era: 'modern', version: mutual, transport: 'stdio' };
        this.initialized = true;
        return;
      }
      // Dual-era server whose newest mutual version is handshake-based.
    }

    try {
      const requested = MCP_LEGACY_REVISIONS[0];
      const result = await this._rawRequest('initialize', {
        protocolVersion: requested,
        capabilities: this._clientCapabilities(),
        clientInfo: { name: 'goodvibes-sdk', version: VERSION },
      });
      const serverVersion = isRecord(result) && typeof result.protocolVersion === 'string'
        ? result.protocolVersion
        : requested;
      if (!MCP_SUPPORTED_VERSIONS.includes(serverVersion)) {
        throw new Error(`server negotiated unsupported protocol version ${serverVersion} (client supports: ${MCP_SUPPORTED_VERSIONS.join(', ')})`);
      }
      this._notify('notifications/initialized', {});
      this.negotiated = { era: 'legacy', version: serverVersion, transport: 'stdio' };
      this.initialized = true;
    } catch (err) {
      logger.error('McpClient: initialize handshake failed', { server: this.config.name, err: summarizeError(err) });
      throw err;
    }
  }

  /**
   * Send a JSON-RPC request; returns the result. In the modern era the
   * request params carry the per-request `_meta` the revision requires.
   */
  private _request<T = unknown>(method: string, params?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
    let finalParams = params;
    if (this.negotiated?.era === 'modern') {
      const meta = buildModernMeta(this.negotiated.version, { name: 'goodvibes-sdk', version: VERSION }, this._clientCapabilities());
      finalParams = withModernMeta(params, meta);
    }
    if (this.http) {
      return this.http.request(method, finalParams, extraHeaders) as Promise<T>;
    }
    return this._rawRequest<T>(method, finalParams);
  }

  /** Send a JSON-RPC request over stdio without protocol decoration. */
  private _rawRequest<T = unknown>(method: string, params?: unknown, timeoutOverrideMs?: number): Promise<T> {
    if (!this.proc) {
      return Promise.reject(new Error(`McpClient(${this.config.name}): not running`));
    }

    const id = this.nextId++;
    const pendingKey = jsonRpcIdKey(id);
    const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    const line = JSON.stringify(msg) + '\n';
    const timeoutMs = timeoutOverrideMs ?? this.options?.timeout ?? DEFAULT_TIMEOUT_MS;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(pendingKey);
        reject(new Error(`McpClient(${this.config.name}): request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();

      this.pendingRequests.set(pendingKey, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      try {
        (this.proc?.stdin as import('bun').FileSink | undefined)?.write(line);
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(pendingKey);
        reject(new Error(`McpClient(${this.config.name}): write failed: ${summarizeError(err)}`));
      }
    });
  }

  /** Send a JSON-RPC notification (no response expected). */
  private _notify(method: string, params?: unknown): void {
    if (!this.proc || !this.isConnected) {
      logger.warn('McpClient: skipped JSON-RPC notification because process is not connected', { server: this.config.name, method });
      return;
    }
    try {
      const msg = { jsonrpc: '2.0', method, params };
      (this.proc.stdin as import('bun').FileSink).write(JSON.stringify(msg) + '\n');
    } catch (err) {
      logger.warn('McpClient: failed to send JSON-RPC notification', { server: this.config.name, method, err: summarizeError(err) });
    }
  }

  private _startReadLoop(): void {
    if (this.readLoopRunning || !this.proc) return;
    this.readLoopRunning = true;

    const proc = this.proc;
    const decoder = new TextDecoder();

    (async () => {
      try {
        const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          this.buffer += decoder.decode(value, { stream: true });
          this._processBuffer();
        }
      } catch (err) {
        logger.warn('McpClient: stdout read loop ended', { server: this.config.name, err: summarizeError(err) });
      } finally {
        this.readLoopRunning = false;
        // The process is gone; any restart must re-negotiate the protocol.
        this.initialized = false;
        this.negotiated = null;
        // Reject remaining pending requests
        for (const [, pending] of this.pendingRequests) {
          clearTimeout(pending.timer);
          pending.reject(new Error(`McpClient(${this.config.name}): process exited unexpectedly`));
        }
        this.pendingRequests.clear();

        // Auto-restart only on an unexpected crash — never after a deliberate disconnect.
        if (this.intentionalClose) {
          // Deliberate shutdown: leave the process down.
        } else if (this.restartCount < MAX_RESTART_ATTEMPTS) {
          this._scheduleRestart();
        } else {
          logger.info('McpClient: exceeded max restart attempts', { server: this.config.name });
        }
      }
    })();
  }

  private _processBuffer(): void {
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (!line) continue;
      this._dispatchLine(line);
    }
  }

  private _dispatchLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      logger.warn('McpClient: failed to parse JSON line', { server: this.config.name, err: summarizeError(err), line: line.slice(0, 200) });
      return;
    }

    if (!isRecord(msg)) {
      logger.warn('McpClient: ignored non-object JSON-RPC line', { server: this.config.name, line: line.slice(0, 200) });
      return;
    }

    if (isJsonRpcResponse(msg)) {
      this._handleResponse(msg);
      return;
    }

    if (isJsonRpcRequest(msg)) {
      this._handleServerRequest(msg);
      return;
    }

    if (isJsonRpcNotification(msg)) {
      this._handleNotification(msg);
      return;
    }

    logger.warn('McpClient: ignored unsupported JSON-RPC message', { server: this.config.name, line: line.slice(0, 200) });
  }

  private _handleResponse(response: JsonRpcResponse): void {
    const pendingKey = response.id === null ? null : jsonRpcIdKey(response.id);
    if (pendingKey === null) {
      this._handleUnhandledResponse(response);
      return;
    }
    const pending = pendingKey ? this.pendingRequests.get(pendingKey) : undefined;
    if (!pending) {
      this._handleUnhandledResponse(response);
      return;
    }

    clearTimeout(pending.timer);
    this.pendingRequests.delete(pendingKey);
    if (response.error) {
      pending.reject(new McpRpcError(
        response.error.code,
        `McpClient(${this.config.name}) RPC error ${response.error.code}: ${response.error.message}`,
        response.error.data,
      ));
    } else {
      pending.resolve(response.result);
    }
  }

  private _handleNotification(notification: JsonRpcNotification): void {
    logger.debug('McpClient: received JSON-RPC notification', {
      server: this.config.name,
      method: notification.method,
    });
    const observed: McpClientNotification = {
      serverName: this.config.name,
      method: notification.method,
      ...(notification.params !== undefined ? { params: notification.params } : {}),
    };
    this._callObserver('notification', () => this.options?.onNotification?.(observed));
  }

  private _handleServerRequest(request: JsonRpcRequest): void {
    const observed: McpClientServerRequest = {
      serverName: this.config.name,
      id: request.id,
      method: request.method,
      ...(request.params !== undefined ? { params: request.params } : {}),
    };
    // The observer (a Lifecycle hook) fires for every server request regardless
    // of whether we can answer it.
    this._callObserver('server request', () => this.options?.onServerRequest?.(observed));

    // Elicitation is the one server→client request we can genuinely answer: route
    // it to the wired resolver (the approval broker) and write its outcome back as
    // the JSON-RPC result instead of rejecting with -32601.
    const elicit = this.options?.onElicitation;
    if (request.method === 'elicitation/create' && elicit) {
      logger.info('McpClient: brokering elicitation/create request', {
        server: this.config.name,
        id: request.id,
      });
      void elicit({ serverName: this.config.name, id: request.id, params: request.params })
        .then((outcome) => {
          this._sendJsonRpcResult(request.id, outcome);
        })
        .catch((err: unknown) => {
          logger.warn('McpClient: elicitation resolver failed', {
            server: this.config.name,
            id: request.id,
            err: summarizeError(err),
          });
          // A resolver failure is not the same as an unsupported method — report
          // an internal error so the server can distinguish the two.
          this._sendJsonRpcError(request.id, -32603, 'Elicitation request could not be resolved');
        });
      return;
    }

    logger.info('McpClient: received unsupported server JSON-RPC request', {
      server: this.config.name,
      method: request.method,
      id: request.id,
    });
    this._sendJsonRpcError(request.id, -32601, `Client method '${request.method}' is not supported`);
  }

  private _handleUnhandledResponse(response: JsonRpcResponse): void {
    const error = response.error
      ? `${response.error.code}: ${response.error.message}`
      : undefined;
    logger.warn('McpClient: received JSON-RPC response with no pending request', {
      server: this.config.name,
      id: response.id,
      hasError: response.error !== undefined,
      ...(error ? { error } : {}),
    });
    const observed: McpClientUnhandledResponse = {
      serverName: this.config.name,
      id: response.id,
      hasError: response.error !== undefined,
      ...(error ? { error } : {}),
    };
    this._callObserver('unhandled response', () => this.options?.onUnhandledResponse?.(observed));
  }

  private _sendJsonRpcError(id: JsonRpcId, code: number, message: string): void {
    if (!this.proc || !this.isConnected) return;
    try {
      const response: JsonRpcResponse = {
        jsonrpc: '2.0',
        id,
        error: { code, message },
      };
      (this.proc.stdin as import('bun').FileSink).write(JSON.stringify(response) + '\n');
    } catch (err) {
      logger.warn('McpClient: failed to send JSON-RPC error response', {
        server: this.config.name,
        id,
        err: summarizeError(err),
      });
    }
  }

  private _sendJsonRpcResult(id: JsonRpcId, result: unknown): void {
    if (!this.proc || !this.isConnected) return;
    try {
      const response: JsonRpcResponse = {
        jsonrpc: '2.0',
        id,
        result,
      };
      (this.proc.stdin as import('bun').FileSink).write(JSON.stringify(response) + '\n');
    } catch (err) {
      logger.warn('McpClient: failed to send JSON-RPC result response', {
        server: this.config.name,
        id,
        err: summarizeError(err),
      });
    }
  }

  private _callObserver(label: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      logger.warn(`McpClient: ${label} observer threw`, {
        server: this.config.name,
        err: summarizeError(err),
      });
    }
  }

  private _scheduleRestart(): void {
    this.restartCount++;
    const delay = RESTART_DELAY_MS * this.restartCount;
    logger.info('McpClient: scheduling restart', { server: this.config.name, attempt: this.restartCount, delayMs: delay });

    const timer = setTimeout(async () => {
      if (this.intentionalClose) return; // Deliberately disconnected — do not restart
      if (this.proc && this.isConnected) return; // Already restarted by something else
      try {
        await this._startProcess();
        await this._negotiate();
        // Invalidate tool caches so they're re-fetched after restart (the
        // restarted server may advertise changed tool lists or schemas).
        this.toolInfoCache = null;
        this.schemaCache.clear();
        logger.info('McpClient: restart successful', { server: this.config.name });
      } catch (err) {
        logger.error('McpClient: restart failed', { server: this.config.name, err: summarizeError(err) });
      }
    }, delay);
    timer.unref?.();
  }

  /**
   * ping — Check whether the server is healthy.
   * The 2026-07-28 revision removed `ping`; modern-era servers are probed
   * with `server/discover` instead. Legacy servers keep the classic ping.
   */
  async ping(): Promise<boolean> {
    if (!this.isConnected) return false;
    const method = this.negotiated?.era === 'modern' ? 'server/discover' : 'ping';
    try {
      await this._request(method, {});
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Answer a server-to-client JSON-RPC request arriving on a legacy HTTP SSE
   * stream. Elicitation routes to the wired resolver; everything else is
   * unsupported (the connection answers method-not-found for undefined).
   */
  private async _answerServerRequestOverHttp(id: JsonRpcId, method: string, params: unknown): Promise<unknown> {
    this._callObserver('server request', () => this.options?.onServerRequest?.({
      serverName: this.config.name,
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    }));
    const elicit = this.options?.onElicitation;
    if (method === 'elicitation/create' && elicit) {
      return elicit({ serverName: this.config.name, id, params });
    }
    return undefined;
  }
}
