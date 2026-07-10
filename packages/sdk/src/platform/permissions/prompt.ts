import type { PermissionCategory, PermissionRequestAnalysis } from './types.js';

/**
 * Attribution for a permission ask that did NOT originate from the foreground
 * turn loop. Populated when a background/subagent tool call brokers an ask so a
 * surface can render "which agent is asking" instead of an anonymous prompt.
 * Absent on foreground asks (the common case).
 */
export interface PermissionAttribution {
  /** Marks the asking party. Currently only background agents attribute asks. */
  readonly kind: 'background-agent';
  /** The spawned agent's record id. */
  readonly agentId: string;
  /** The agent's archetype/template, when known (e.g. 'engineer'). */
  readonly template?: string | undefined;
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
