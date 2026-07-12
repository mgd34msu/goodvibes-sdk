/**
 * Public option and observation types for McpClient.
 */
import type { JsonRpcId } from './jsonrpc.js';

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

/**
 * A resolver for the MCP `elicitation/create` server→client request. When
 * wired, the client advertises the `elicitation` capability at handshake and
 * routes incoming elicitation requests here instead of hard-rejecting them with
 * `-32601`; the resolved outcome is written back as the JSON-RPC result.
 * Modern-era servers deliver elicitation as Multi Round-Trip Request input
 * requests on tool calls; those route through the same resolver.
 */
export type McpElicitationResolver = (input: {
  serverName: string;
  id: JsonRpcId;
  params?: unknown | undefined;
}) => Promise<{ action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> | undefined }>;

export interface McpClientOptions {
  timeout?: number | undefined;
  processSpec?: McpProcessSpec | undefined;
  onNotification?: ((notification: McpClientNotification) => void) | undefined;
  onServerRequest?: ((request: McpClientServerRequest) => void) | undefined;
  onUnhandledResponse?: ((response: McpClientUnhandledResponse) => void) | undefined;
  /**
   * When set, `elicitation/create` server requests are resolved through this
   * handler (which brokers them to the approval channel) rather than dropped.
   */
  onElicitation?: McpElicitationResolver | undefined;
  /** Injectable fetch for the Streamable HTTP transport (tests). */
  fetchImpl?: typeof fetch | undefined;
}
