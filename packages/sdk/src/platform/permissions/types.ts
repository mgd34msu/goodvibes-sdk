/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

export type PermissionCategory = 'read' | 'write' | 'execute' | 'delegate';

export type PermissionRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type PermissionDecisionSource =
  | 'config_policy'
  | 'managed_policy'
  | 'safety_check'
  | 'runtime_mode'
  | 'session_override'
  | 'user_prompt';

export type PermissionDecisionReasonCode =
  | 'config_allow'
  | 'config_deny'
  | 'managed_policy_allow'
  | 'managed_policy_deny'
  | 'safety_guardrail'
  | 'mode_allow_all'
  | 'mode_denied'
  // Mode — plan mode refused a mutating/exec tool (structured plan-mode denial)
  | 'plan_mode'
  // Mode — accept-edits mode auto-approved a file write/edit tool
  | 'mode_accept_edits'
  | 'session_cached_allow'
  | 'session_cached_deny'
  | 'user_approved'
  | 'user_denied';

export type PermissionAnalysisTargetKind = 'command' | 'path' | 'url' | 'task' | 'generic';
export type PermissionAnalysisSurface = 'filesystem' | 'shell' | 'network' | 'orchestration' | 'platform' | 'generic';
export type PermissionBlastRadius = 'local' | 'project' | 'external' | 'delegated' | 'platform';

export interface PermissionRequestAnalysis {
  readonly classification: string;
  readonly riskLevel: PermissionRiskLevel;
  readonly summary: string;
  readonly reasons: readonly string[];
  readonly target?: string | undefined;
  readonly targetKind?: PermissionAnalysisTargetKind | undefined;
  readonly surface?: PermissionAnalysisSurface | undefined;
  readonly blastRadius?: PermissionBlastRadius | undefined;
  readonly sideEffects?: readonly string[] | undefined;
  readonly host?: string | undefined;
}

export interface PermissionCheckResult {
  readonly approved: boolean;
  readonly persisted: boolean;
  readonly sourceLayer: PermissionDecisionSource;
  readonly reasonCode: PermissionDecisionReasonCode;
  readonly analysis: PermissionRequestAnalysis;
  /**
   * When present, replaces the tool call's original arguments for execution
   * (e.g. a per-hunk-filtered `edits` array for the `edit` tool). Only ever
   * populated via the user-prompt approval path (`sourceLayer: 'user_prompt'`).
   */
  readonly modifiedArgs?: Record<string, unknown> | undefined;
}
