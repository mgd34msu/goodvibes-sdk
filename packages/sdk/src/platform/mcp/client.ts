/**
 * McpClient — connects to a single MCP server process via stdio JSON-RPC 2.0.
 *
 * Protocol: newline-delimited JSON (each message is one JSON line on stdout/stdin).
 * Progressive loading: listTools() returns names + descriptions only.
 * getToolSchema() fetches full inputSchema on demand and caches it.
 */
import { logger } from '../utils/logger.js';
import { VERSION } from '../version.js';
import type { McpServerConfig } from './config.js';
import { summarizeError } from '../utils/error-display.js';

export interface McpProcessSpec {
  command: string;
  args?: string[] | undefined;
  env?: Record<string, string> | undefined;
  cwd?: string | undefined;
  summary?: string | undefined;
  sandboxSessionId?: string | undefined;
}

export interface McpToolInfo {
  name: string;
  description: string;
}

export interface McpToolSchema extends McpToolInfo {
  inputSchema: Record<string, unknown>;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown | undefined;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown | undefined;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId | null;
  result?: unknown | undefined;
  error?: { code: number; message: string; data?: unknown };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const PING_TIMEOUT_MS = 5_000;
const RESTART_DELAY_MS = 2_000;
const MAX_RESTART_ATTEMPTS = 3;

export type JsonRpcId = number | string;

export interface McpClientNotification {
  serverName: string;
  method: string;
  params?: unknown | undefined;
}

export interface McpClientServerRequest {
  serverName: string;
  id: JsonRpcId;
  method: string;
  params?: unknown | undefined;
}

export interface McpClientUnhandledResponse {
  serverName: string;
  id: JsonRpcId | null;
  hasError: boolean;
  error?: string | undefined;
}

export interface McpClientOptions {
  timeout?: number | undefined;
  processSpec?: McpProcessSpec | undefined;
  onNotification?: ((notification: McpClientNotification) => void) | undefined;
  onServerRequest?: ((request: McpClientServerRequest) => void) | undefined;
  onUnhandledResponse?: ((response: McpClientUnhandledResponse) => void) | undefined;
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === 'number' || typeof value === 'string';
}

function jsonRpcIdKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  return isRecord(value)
    && 'id' in value
    && (isJsonRpcId(value.id) || value.id === null)
    && typeof value.method !== 'string';
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  return isRecord(value)
    && typeof value.method === 'string'
    && isJsonRpcId(value.id);
}

function isJsonRpcNotification(value: unknown): value is JsonRpcNotification {
  return isRecord(value)
    && typeof value.method === 'string'
    && (!('id' in value) || value.id === null);
}

export class McpClient {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private nextId = 1;
  private pendingRequests = new Map<string, PendingRequest>();
  private buffer = '';
  private readLoopRunning = false;
  private restartCount = 0;
  private initialized = false;

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
    if (!this.proc) return false;
    try {
      return (this.proc as { exitCode: number | null }).exitCode === null;
    } catch {
      return false;
    }
  }

  /**
   * connect — Start the server process and perform MCP handshake (initialize).
   * After connect, listTools() is available.
   */
  async connect(): Promise<void> {
    if (this.proc && this.isConnected) return;
    await this._startProcess();
    await this._initialize();
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
      this.schemaCache.set(t.name, {
        name: t.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
      });
    }

    return this.schemaCache.get(toolName) ?? null;
  }

  /**
   * callTool — Execute a tool on the MCP server.
   * Fetches full schema on first use (if not already cached).
   */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.isConnected) {
      throw new Error(`McpClient(${this.config.name}): not connected`);
    }
    // Ensure schema is cached on first use
    if (!this.schemaCache.has(toolName)) {
      await this.getToolSchema(toolName);
    }
    return this._request('tools/call', { name: toolName, arguments: args });
  }

  /**
   * disconnect — Stop the server process and clean up.
   */
  async disconnect(): Promise<void> {
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
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async _startProcess(): Promise<void> {
    const processSpec = this.options?.processSpec;
    const cmd = processSpec?.command ?? this.config.command;
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
      this._startReadLoop();
    } catch (err) {
      logger.error('McpClient: failed to start process', { server: this.config.name, err: summarizeError(err) });
      this.proc = null;
      throw new Error(`McpClient(${this.config.name}): failed to start: ${summarizeError(err)}`);
    }
  }

  /** Perform MCP initialize handshake. */
  private async _initialize(): Promise<void> {
    if (this.initialized) return;
    try {
      await this._request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'goodvibes-sdk', version: VERSION },
      });
      this._notify('notifications/initialized', {});
      this.initialized = true;
    } catch (err) {
      logger.error('McpClient: initialize handshake failed', { server: this.config.name, err: summarizeError(err) });
      throw err;
    }
  }

  /** Send a JSON-RPC request; returns the result. */
  private _request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.proc) {
      return Promise.reject(new Error(`McpClient(${this.config.name}): not running`));
    }

    const id = this.nextId++;
    const pendingKey = jsonRpcIdKey(id);
    const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    const line = JSON.stringify(msg) + '\n';
    const timeoutMs = this.options?.timeout ?? DEFAULT_TIMEOUT_MS;

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
        // Reject remaining pending requests
        for (const [, pending] of this.pendingRequests) {
          clearTimeout(pending.timer);
          pending.reject(new Error(`McpClient(${this.config.name}): process exited unexpectedly`));
        }
        this.pendingRequests.clear();

        // Auto-restart if process crashed and we haven't exceeded retry limit
        if (this.restartCount < MAX_RESTART_ATTEMPTS) {
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
      pending.reject(new Error(`McpClient(${this.config.name}) RPC error ${response.error.code}: ${response.error.message}`));
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
    logger.info('McpClient: received unsupported server JSON-RPC request', {
      server: this.config.name,
      method: request.method,
      id: request.id,
    });
    const observed: McpClientServerRequest = {
      serverName: this.config.name,
      id: request.id,
      method: request.method,
      ...(request.params !== undefined ? { params: request.params } : {}),
    };
    this._callObserver('server request', () => this.options?.onServerRequest?.(observed));
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
      if (this.proc && this.isConnected) return; // Already restarted by something else
      try {
        await this._startProcess();
        await this._initialize();
        // Invalidate tool cache so it's re-fetched after restart
        this.toolInfoCache = null;
        logger.info('McpClient: restart successful', { server: this.config.name });
      } catch (err) {
        logger.error('McpClient: restart failed', { server: this.config.name, err: summarizeError(err) });
      }
    }, delay);
    timer.unref?.();
  }

  /**
   * ping — Send a ping to check if server is healthy.
   * Returns true if server responds within PING_TIMEOUT_MS.
   */
  async ping(): Promise<boolean> {
    if (!this.isConnected) return false;
    try {
      await this._request('ping', {});
      return true;
    } catch {
      return false;
    }
  }
}
