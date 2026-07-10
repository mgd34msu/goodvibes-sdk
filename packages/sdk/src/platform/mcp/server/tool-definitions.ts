/**
 * mcp/server/tool-definitions.ts
 *
 * Generates Model Context Protocol tool definitions from the GoodVibes operator
 * catalog, rather than hand-writing them, so the MCP surface an external agent
 * tool sees is exactly the daemon's operator contract and can never drift from
 * it. Every cataloged, invokable operator method becomes one MCP tool: its
 * dotted method id maps to an MCP-safe tool name, its description carries over,
 * and its operator inputSchema becomes the tool's JSON Schema input.
 *
 * The session lifecycle methods (create / attach / send message / read
 * transcript / steer, see session-tools.ts) are lifted to the front of the list
 * and tagged, so they read as first-class tools.
 */
import type {
  JsonSchema,
  OperatorContractManifest,
  OperatorMethodContract,
} from '@pellux/goodvibes-contracts';
import {
  isSessionLifecycleMethodId,
  sessionLifecycleRank,
  sessionLifecycleToolFor,
} from './session-tools.js';

/** Advisory hints an MCP client may use to present or gate a tool. */
export interface McpToolAnnotations {
  /** True when the tool only reads state (declares read: scopes, no write). */
  readonly readOnlyHint?: boolean | undefined;
  /** True when the operator method is flagged dangerous. */
  readonly destructiveHint?: boolean | undefined;
  /** True when the method is idempotent (safe to retry). */
  readonly idempotentHint?: boolean | undefined;
}

/** A single MCP tool definition, as returned by tools/list. */
export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly annotations?: McpToolAnnotations | undefined;
  /** GoodVibes-specific: the operator method id this tool dispatches to. */
  readonly operatorMethodId: string;
}

/** The generated tool set plus the name<->method-id mapping the server dispatches with. */
export interface OperatorMcpToolSet {
  readonly tools: readonly McpToolDefinition[];
  /** Resolve an MCP tool name back to the operator method id it invokes. */
  readonly methodIdByToolName: ReadonlyMap<string, string>;
}

/** Options controlling which operator methods are exposed as MCP tools. */
export interface BuildOperatorMcpToolsOptions {
  /** Only include methods in these categories (default: all). */
  readonly includeCategories?: readonly string[] | undefined;
  /** Exclude methods in these categories (applied after includeCategories). */
  readonly excludeCategories?: readonly string[] | undefined;
  /** Only include methods with these access levels (default: all). */
  readonly includeAccess?: readonly OperatorMethodContract['access'][] | undefined;
  /** Include methods marked dangerous (default: true). */
  readonly includeDangerous?: boolean | undefined;
  /** Keep the session lifecycle tools at the front of the list (default: true). */
  readonly prioritizeSessionLifecycle?: boolean | undefined;
}

const EMPTY_OBJECT_INPUT_SCHEMA: JsonSchema = { type: 'object', properties: {} };

/** MCP tool names are restricted to a safe slug; the dotted method id maps by replacing dots. */
export function operatorMethodIdToToolName(methodId: string): string {
  return methodId.replace(/\./g, '_');
}

function isReadOnly(method: OperatorMethodContract): boolean {
  if (method.scopes.length === 0) return false;
  return method.scopes.every((scope) => scope.startsWith('read:'));
}

/** Normalize an operator inputSchema to a valid MCP object input schema. */
function toInputSchema(schema: JsonSchema | undefined): JsonSchema {
  if (!schema || typeof schema !== 'object') return { ...EMPTY_OBJECT_INPUT_SCHEMA };
  if (schema.type === 'object') return schema;
  // A non-object operator input is wrapped so the MCP contract always presents
  // an object at the tool boundary, as MCP clients expect.
  return { type: 'object', properties: {} };
}

function buildAnnotations(method: OperatorMethodContract): McpToolAnnotations | undefined {
  const annotations: McpToolAnnotations = {
    readOnlyHint: isReadOnly(method),
    ...(method.dangerous ? { destructiveHint: true } : {}),
    ...(method.idempotent ? { idempotentHint: true } : {}),
  };
  return annotations;
}

function buildDescription(method: OperatorMethodContract): string {
  const lifecycle = sessionLifecycleToolFor(method.id);
  const base = method.description || method.title || method.id;
  return lifecycle ? `${lifecycle.hint} ${base}` : base;
}

function includeMethod(method: OperatorMethodContract, options: BuildOperatorMcpToolsOptions): boolean {
  if (method.invokable === false) return false;
  if (options.includeDangerous === false && method.dangerous) return false;
  if (options.includeCategories && !options.includeCategories.includes(method.category)) return false;
  if (options.excludeCategories?.includes(method.category)) return false;
  if (options.includeAccess && !options.includeAccess.includes(method.access)) return false;
  return true;
}

function compareTools(a: McpToolDefinition, b: McpToolDefinition, prioritizeLifecycle: boolean): number {
  if (prioritizeLifecycle) {
    const rankA = sessionLifecycleRank(a.operatorMethodId);
    const rankB = sessionLifecycleRank(b.operatorMethodId);
    if (rankA !== rankB) return rankA - rankB;
  }
  return a.name.localeCompare(b.name);
}

/**
 * Build the MCP tool set from an operator contract manifest. Pure over its
 * input — pass `getOperatorContract()` (or any manifest) to generate the tools.
 * Throws when two method ids collapse to the same MCP tool name, so a catalog
 * change that would silently shadow a tool fails loudly instead.
 */
export function buildOperatorMcpTools(
  contract: OperatorContractManifest,
  options: BuildOperatorMcpToolsOptions = {},
): OperatorMcpToolSet {
  const prioritizeLifecycle = options.prioritizeSessionLifecycle ?? true;
  const methodIdByToolName = new Map<string, string>();
  const tools: McpToolDefinition[] = [];

  for (const method of contract.operator.methods) {
    if (!includeMethod(method, options)) continue;
    const name = operatorMethodIdToToolName(method.id);
    const existing = methodIdByToolName.get(name);
    if (existing && existing !== method.id) {
      throw new Error(
        `MCP tool name collision: "${name}" maps to both "${existing}" and "${method.id}"`,
      );
    }
    methodIdByToolName.set(name, method.id);
    tools.push({
      name,
      description: buildDescription(method),
      inputSchema: toInputSchema(method.inputSchema),
      annotations: buildAnnotations(method),
      operatorMethodId: method.id,
    });
  }

  tools.sort((a, b) => compareTools(a, b, prioritizeLifecycle));
  return { tools, methodIdByToolName };
}

/** Whether the given method id would be surfaced as a first-class session lifecycle tool. */
export function isFirstClassSessionTool(methodId: string): boolean {
  return isSessionLifecycleMethodId(methodId);
}
