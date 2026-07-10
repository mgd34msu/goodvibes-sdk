/**
 * mcp/server — a local-first Model Context Protocol server that exposes the
 * GoodVibes daemon's operator surface as MCP tools, generated from the operator
 * catalog rather than hand-written, so an external agent tool can drive
 * GoodVibes sessions.
 *
 * - tool-definitions.ts — generate MCP tools from an operator contract manifest.
 * - session-tools.ts     — the first-class session lifecycle tool set.
 * - stdio-server.ts       — the JSON-RPC 2.0 protocol core + a newline-delimited
 *                           (stdio) transport.
 *
 * The transport that reaches the daemon is injected (`OperatorMcpInvoker`), so
 * this module is pure protocol plumbing and carries no transport dependency.
 */
import type { OperatorContractManifest } from '@pellux/goodvibes-contracts';
import {
  buildOperatorMcpTools,
  type BuildOperatorMcpToolsOptions,
} from './tool-definitions.js';
import {
  OperatorMcpServer,
  type OperatorMcpInvoker,
  type OperatorMcpServerInfo,
} from './stdio-server.js';

export {
  buildOperatorMcpTools,
  operatorMethodIdToToolName,
  isFirstClassSessionTool,
  type BuildOperatorMcpToolsOptions,
  type McpToolAnnotations,
  type McpToolDefinition,
  type OperatorMcpToolSet,
} from './tool-definitions.js';
export {
  SESSION_LIFECYCLE_TOOLS,
  SESSION_LIFECYCLE_METHOD_IDS,
  isSessionLifecycleMethodId,
  sessionLifecycleRank,
  sessionLifecycleToolFor,
  type SessionLifecycleTool,
} from './session-tools.js';
export {
  OperatorMcpServer,
  serveOperatorMcp,
  readLines,
  createStreamTransport,
  DEFAULT_MCP_PROTOCOL_VERSION,
  type ChunkSink,
  type ChunkSource,
  type McpLineTransport,
  type OperatorMcpInvoker,
  type OperatorMcpServerInfo,
  type OperatorMcpServerOptions,
} from './stdio-server.js';

/** Options for the one-call server factory. */
export interface CreateOperatorMcpServerOptions {
  /** The operator contract manifest to generate tools from (e.g. getOperatorContract()). */
  readonly contract: OperatorContractManifest;
  /** How to invoke a resolved operator method against the daemon. */
  readonly invoke: OperatorMcpInvoker;
  /** Tool-generation filters (categories, access, dangerous). */
  readonly tools?: BuildOperatorMcpToolsOptions | undefined;
  /** Advertised server identity. */
  readonly serverInfo?: OperatorMcpServerInfo | undefined;
  /** Optional human-readable usage instructions returned from initialize. */
  readonly instructions?: string | undefined;
}

/**
 * Build a ready-to-serve MCP server from an operator contract and an invoker.
 * The contract is passed in (not imported here) so this module never pulls in
 * the large generated contract artifact — a caller supplies `getOperatorContract()`.
 */
export function createOperatorMcpServer(options: CreateOperatorMcpServerOptions): OperatorMcpServer {
  const toolSet = buildOperatorMcpTools(options.contract, options.tools);
  return new OperatorMcpServer({
    toolSet,
    invoke: options.invoke,
    serverInfo: options.serverInfo,
    instructions: options.instructions,
  });
}
