/**
 * mcp/server/stdio-server.ts
 *
 * A minimal, dependency-free Model Context Protocol server that speaks JSON-RPC
 * 2.0 over a newline-delimited stream (stdio is the local-first default). It
 * exposes the GoodVibes operator surface as MCP tools (tool-definitions.ts) and
 * dispatches every tools/call through an injected invoker, so the transport that
 * reaches the daemon is the consumer's choice — the operator client, an
 * in-process handler, anything — and this module stays pure protocol plumbing.
 *
 * Implemented against the protocol directly rather than pulling in an MCP SDK
 * dependency: the surface is small (initialize / tools/list / tools/call /
 * ping), and keeping it in-tree preserves the repo's dependency and audit
 * discipline.
 */
import type { McpToolDefinition, OperatorMcpToolSet } from './tool-definitions.js';

/** The default MCP protocol version this server advertises when the client sends none. */
export const DEFAULT_MCP_PROTOCOL_VERSION = '2025-06-18';

/** Invokes an operator method by id with a params object, returning its result. */
export type OperatorMcpInvoker = (
  methodId: string,
  input: Record<string, unknown>,
) => unknown | Promise<unknown>;

export interface OperatorMcpServerInfo {
  readonly name: string;
  readonly version: string;
}

export interface OperatorMcpServerOptions {
  readonly toolSet: OperatorMcpToolSet;
  readonly invoke: OperatorMcpInvoker;
  readonly serverInfo?: OperatorMcpServerInfo | undefined;
  readonly instructions?: string | undefined;
}

interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id?: string | number | null | undefined;
  readonly method: string;
  readonly params?: Record<string, unknown> | undefined;
}

interface JsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INTERNAL_ERROR = -32603;

const DEFAULT_SERVER_INFO: OperatorMcpServerInfo = {
  name: 'goodvibes-operator',
  version: '1.0.0',
};

function wireTool(tool: McpToolDefinition): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
  };
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : JSON.stringify(error);
}

/**
 * The protocol core: turns a decoded JSON-RPC message into a response (or null
 * for a notification, which gets none). Transport-agnostic — call it from a
 * stdio loop, a socket, or a test.
 */
export class OperatorMcpServer {
  private readonly toolSet: OperatorMcpToolSet;
  private readonly invoke: OperatorMcpInvoker;
  private readonly serverInfo: OperatorMcpServerInfo;
  private readonly instructions: string | undefined;

  constructor(options: OperatorMcpServerOptions) {
    this.toolSet = options.toolSet;
    this.invoke = options.invoke;
    this.serverInfo = options.serverInfo ?? DEFAULT_SERVER_INFO;
    this.instructions = options.instructions;
  }

  /** The MCP tools this server advertises (wire shape). */
  listTools(): Record<string, unknown>[] {
    return this.toolSet.tools.map(wireTool);
  }

  /** Dispatch a tools/call: resolve the tool to its operator method and invoke it. */
  async callTool(name: unknown, args: unknown): Promise<Record<string, unknown>> {
    if (typeof name !== 'string') {
      return this.toolError('tool name must be a string');
    }
    const methodId = this.toolSet.methodIdByToolName.get(name);
    if (!methodId) {
      return this.toolError(`unknown tool: ${name}`);
    }
    const input = args && typeof args === 'object' && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};
    try {
      const result = await this.invoke(methodId, input);
      return {
        content: [{ type: 'text', text: JSON.stringify(result ?? null) }],
      };
    } catch (error) {
      return this.toolError(errorText(error));
    }
  }

  private toolError(message: string): Record<string, unknown> {
    return { content: [{ type: 'text', text: message }], isError: true };
  }

  private initializeResult(params: Record<string, unknown> | undefined): Record<string, unknown> {
    const requestedVersion = params?.protocolVersion;
    const protocolVersion = typeof requestedVersion === 'string' ? requestedVersion : DEFAULT_MCP_PROTOCOL_VERSION;
    return {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: this.serverInfo,
      ...(this.instructions ? { instructions: this.instructions } : {}),
    };
  }

  /** Handle a decoded JSON-RPC request. Returns null for a notification (no id). */
  async handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const isNotification = request.id === undefined || request.id === null;
    const id = request.id ?? null;
    switch (request.method) {
      case 'initialize':
        return isNotification ? null : { jsonrpc: '2.0', id, result: this.initializeResult(request.params) };
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;
      case 'ping':
        return isNotification ? null : { jsonrpc: '2.0', id, result: {} };
      case 'tools/list':
        return isNotification ? null : { jsonrpc: '2.0', id, result: { tools: this.listTools() } };
      case 'tools/call': {
        if (isNotification) return null;
        const params = request.params ?? {};
        const result = await this.callTool(params.name, params.arguments);
        return { jsonrpc: '2.0', id, result };
      }
      default:
        if (isNotification) return null;
        return {
          jsonrpc: '2.0',
          id,
          error: { code: JSON_RPC_METHOD_NOT_FOUND, message: `method not found: ${request.method}` },
        };
    }
  }

  /**
   * Decode one line of newline-delimited JSON-RPC, dispatch it, and return the
   * response line to write (or null for a notification / blank line). A parse
   * failure returns a JSON-RPC parse-error response with a null id.
   */
  async handleLine(line: string): Promise<string | null> {
    const trimmed = line.trim();
    if (trimmed.length === 0) return null;
    let decoded: unknown;
    try {
      decoded = JSON.parse(trimmed);
    } catch {
      return JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: JSON_RPC_PARSE_ERROR, message: 'parse error' },
      } satisfies JsonRpcResponse);
    }
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
      return JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: JSON_RPC_INVALID_REQUEST, message: 'invalid request' },
      } satisfies JsonRpcResponse);
    }
    const request = decoded as JsonRpcRequest;
    if (typeof request.method !== 'string') {
      return JSON.stringify({
        jsonrpc: '2.0',
        id: request.id ?? null,
        error: { code: JSON_RPC_INVALID_REQUEST, message: 'missing method' },
      } satisfies JsonRpcResponse);
    }
    try {
      const response = await this.handleRequest(request);
      return response ? JSON.stringify(response) : null;
    } catch (error) {
      return JSON.stringify({
        jsonrpc: '2.0',
        id: request.id ?? null,
        error: { code: JSON_RPC_INTERNAL_ERROR, message: errorText(error) },
      } satisfies JsonRpcResponse);
    }
  }
}

/** A newline-delimited line transport: a source of inbound lines and a sink for outbound ones. */
export interface McpLineTransport {
  readonly lines: AsyncIterable<string>;
  write(line: string): void | Promise<void>;
}

/**
 * Run the server over a line transport until the inbound stream ends. Each
 * inbound line is dispatched; a non-null response line is written back.
 */
export async function serveOperatorMcp(server: OperatorMcpServer, transport: McpLineTransport): Promise<void> {
  for await (const line of transport.lines) {
    const response = await server.handleLine(line);
    if (response !== null) await transport.write(`${response}\n`);
  }
}

/** A Node-style readable stream that yields string or byte chunks. */
export interface ChunkSource {
  [Symbol.asyncIterator](): AsyncIterator<string | Uint8Array>;
}

/** A Node-style writable stream. */
export interface ChunkSink {
  write(chunk: string): unknown;
}

const textDecoder = new TextDecoder();

/** Turn a byte/string chunk stream into an async iterable of newline-delimited lines. */
export async function* readLines(source: ChunkSource): AsyncIterable<string> {
  let buffer = '';
  for await (const chunk of source) {
    buffer += typeof chunk === 'string' ? chunk : textDecoder.decode(chunk, { stream: true });
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      yield buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf('\n');
    }
  }
  if (buffer.trim().length > 0) yield buffer;
}

/** Build a line transport from a Node-style readable/writable pair (e.g. process.stdin/stdout). */
export function createStreamTransport(input: ChunkSource, output: ChunkSink): McpLineTransport {
  return {
    lines: readLines(input),
    write: (line: string) => { output.write(line); },
  };
}
