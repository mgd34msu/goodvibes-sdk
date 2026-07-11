import type { PermissionCategory, PermissionRequestAnalysis } from './types.js';

/**
 * Attribution for a permission ask that did NOT originate from the foreground
 * turn loop. Populated when a background/subagent tool call — or an MCP server's
 * elicitation request — brokers an ask so a surface can render "who is asking"
 * instead of an anonymous prompt. Absent on foreground asks (the common case).
 *
 * A discriminated union: every non-foreground origin that reaches the approval
 * broker names itself here so the same prompt UI can attribute it. Adding an
 * origin means adding a member, never widening `kind` to `string`.
 */
export type PermissionAttribution =
  | BackgroundAgentAttribution
  | McpServerAttribution
  | SandboxEscalationAttribution;

/** A background/subagent tool call brokered an ask on behalf of a spawned agent. */
export interface BackgroundAgentAttribution {
  readonly kind: 'background-agent';
  /** The spawned agent's record id. */
  readonly agentId: string;
  /** The agent's archetype/template, when known (e.g. 'engineer'). */
  readonly template?: string | undefined;
}

/**
 * An MCP server asked the client for user input (spec `elicitation/create`), and
 * that request is routed through the SAME approval broker as a permission ask so
 * every surface's existing approval UI renders it and background-agent bubbling
 * applies. Carries which server is asking so the prompt can attribute it.
 */
export interface McpServerAttribution {
  readonly kind: 'mcp-server';
  /** The MCP server that issued the elicitation request. */
  readonly serverName: string;
}

/**
 * The active per-command exec sandbox needs host access a boundary-safe command
 * would not — network, a host-privilege escalation, a package install that
 * reaches the network — so it brokers an ASK through the SAME approval broker as
 * a permission ask (one learned pattern, not five). Every surface's approval UI
 * renders it and background bubbling applies. Names the sandbox and the specific
 * escalation so the prompt can attribute it ("wants-network").
 */
export interface SandboxEscalationAttribution {
  readonly kind: 'sandbox-escalation';
  /** The sandbox that raised the escalation (e.g. 'exec-sandbox'). */
  readonly sandbox: string;
  /** The specific host-access escalations named on this ask (e.g. 'wants-network'). */
  readonly escalations: readonly string[];
}

export interface PermissionPromptRequest {
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  category: PermissionCategory;
  analysis: PermissionRequestAnalysis;
  workingDirectory?: string | undefined;
  /**
   * Set when the ask was brokered on behalf of a background/subagent tool call.
   * Undefined for foreground asks.
   */
  attribution?: PermissionAttribution | undefined;
}

export interface PermissionPromptDecision {
  approved: boolean;
  remember?: boolean | undefined;
  /**
   * When present, replaces the tool call's original arguments for execution
   * (e.g. a per-hunk-filtered `edits` array for the `edit` tool). Never
   * populated by non-prompt approval paths (auto-approve, policy, session
   * cache) — only the user-prompt path can set this.
   */
  modifiedArgs?: Record<string, unknown> | undefined;
}

export type PermissionRequestHandler = (
  request: PermissionPromptRequest,
) => Promise<PermissionPromptDecision>;

export interface PermissionRequest extends PermissionPromptRequest {
  resolve: (approved: boolean, remember?: boolean, modifiedArgs?: Record<string, unknown>) => void;
}
