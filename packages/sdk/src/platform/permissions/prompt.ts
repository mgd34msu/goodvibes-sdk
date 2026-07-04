import type { PermissionCategory, PermissionRequestAnalysis } from './types.js';

export interface PermissionPromptRequest {
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  category: PermissionCategory;
  analysis: PermissionRequestAnalysis;
  workingDirectory?: string | undefined;
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
