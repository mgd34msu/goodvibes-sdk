/**
 * cost-origin.ts
 *
 * AsyncLocalStorage-scoped "cost attribution origin" — the tool call, hook, or
 * MCP server on whose behalf the engine is executing right now. It is a sibling
 * of runtime/correlation.ts (session/turn IDs) but carries CAUSE rather than
 * identity: when the engine runs a tool call, fires a hook, or drives an MCP
 * server, it opens an origin scope; any LLM usage event emitted inside that
 * scope inherits the origin so downstream cost attribution can break spend down
 * by the tool/hook/MCP server that caused it.
 *
 * HONESTY IDIOM: the origin is only ever what the engine genuinely set for the
 * current async scope. A top-level agent-reasoning LLM call (no tool/hook/MCP
 * cause) runs with an empty origin and is attributed to the session/agent, never
 * mis-tagged to a tool it merely called afterwards. `getCostOrigin()` returns an
 * empty object when no scope is active, so reading it is always safe.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** The tool/hook/MCP-server cause for LLM usage emitted within a scope. */
export interface CostOrigin {
  /** The tool name whose execution caused this spend (e.g. 'read', 'agent'). */
  readonly tool?: string | undefined;
  /** The tool-call id (correlates to the ToolEvent callId) when a tool caused it. */
  readonly callId?: string | undefined;
  /** The hook path (e.g. 'Post:tool:edit') whose dispatch caused this spend. */
  readonly hook?: string | undefined;
  /** The MCP server id whose tool/interaction caused this spend. */
  readonly mcpServer?: string | undefined;
}

/** The singleton AsyncLocalStorage instance for the cost-attribution origin. */
export const costOriginCtx = new AsyncLocalStorage<CostOrigin>();

/**
 * The current cost-attribution origin, or an empty object when no scope is
 * active. Safe to call from anywhere.
 */
export function getCostOrigin(): Readonly<CostOrigin> {
  return costOriginCtx.getStore() ?? {};
}

/**
 * Run an async function within a cost-origin scope that REPLACES the current
 * origin with the provided fields (undefined fields are dropped). Replace, not
 * merge: a nested tool call executed by a tool should be attributed to the
 * inner tool, not carry the outer one's fields.
 */
export function withCostOriginAsync<T>(origin: CostOrigin, fn: () => Promise<T>): Promise<T> {
  return costOriginCtx.run(pruneUndefined(origin), fn);
}

/**
 * A qualified MCP tool name is `mcp:<server>:<tool>` (see the MCP registry's
 * tool namespacing). Return the `<server>` segment for a qualified name, or
 * undefined for an ordinary (non-MCP) tool name.
 */
export function mcpServerOfToolName(toolName: string): string | undefined {
  if (!toolName.startsWith('mcp:')) return undefined;
  const rest = toolName.slice('mcp:'.length);
  const sep = rest.indexOf(':');
  const server = sep === -1 ? rest : rest.slice(0, sep);
  return server.length > 0 ? server : undefined;
}

function pruneUndefined(origin: CostOrigin): CostOrigin {
  const pruned: { -readonly [K in keyof CostOrigin]: CostOrigin[K] } = {};
  if (origin.tool !== undefined) pruned.tool = origin.tool;
  if (origin.callId !== undefined) pruned.callId = origin.callId;
  if (origin.hook !== undefined) pruned.hook = origin.hook;
  if (origin.mcpServer !== undefined) pruned.mcpServer = origin.mcpServer;
  return pruned;
}
