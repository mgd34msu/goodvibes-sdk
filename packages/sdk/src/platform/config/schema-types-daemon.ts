/**
 * Daemon-side service config interfaces: notification fan-out, speech output,
 * the automation scheduler, watchers, the OS service integration, and runtime
 * limits. Split out of schema-types.ts so that file stays under its
 * grandfathered line ceiling; re-exported from schema-types.ts so import sites
 * are unchanged.
 */
export interface NotificationsConfig {
  webhookUrls: string[];
  /**
   * Adaptive suppression of operational churn: quiet/minimal-mode filtering and
   * burst collapse into panel-only groups with reason codes. Default true.
   */
  adaptiveSuppression: boolean;
  /** Burst-detection observation window (ms) for adaptive suppression. */
  burstWindowMs: number;
  /** Event count within the burst window that trips collapse to panel_only. */
  burstThreshold: number;
  /** Cooldown (ms) after a burst before a domain:level group can trip again. */
  burstCooldownMs: number;
  /** Device-push fan-out for pending approvals. ON by default; a toggle to silence, never a working prerequisite. */
  pushApproval: boolean;
  /** Device-push fan-out for fleet nodes blocked on the operator. ON by default. */
  pushNeedsInput: boolean;
  /** Device-push fan-out for finished tracked runs (task/turn completion). ON by default. */
  pushCompletion: boolean;
  /** Grace (ms) a block waits for a human before a device push escalates past an attached surface. */
  blockedEscalationGraceMs: number;
  /** Interval (ms) between bounded follow-up reminders after the first blocked-too-long escalation. */
  blockedEscalationFollowUpMs: number;
  /** Upper bound on follow-up reminders after the first escalation (0 = escalate once). */
  blockedEscalationMaxFollowUps: number;
}

export interface TtsConfig {
  provider: string;
  voice: string;
  llmProvider: string;
  llmModel: string;
  /** Playback speed multiplier (0.25–4.0); 1.0 = normal speed. */
  speed: number;
}

export interface AutomationConfig {
  enabled: boolean;
  maxConcurrentRuns: number;
  runHistoryLimit: number;
  defaultTimeoutMs: number;
  catchUpWindowMinutes: number;
  failureCooldownMs: number;
  deleteAfterRun: boolean;
}

export interface WatchersConfig {
  enabled: boolean;
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  recoveryWindowMinutes: number;
  /** Cadence (ms) for the daemon's recurring CI-watch poll (floor 15s at the poller). */
  ciPollIntervalMs: number;
}

export interface ServiceConfig {
  enabled: boolean;
  autostart: boolean;
  restartOnFailure: boolean;
  platform: 'auto' | 'systemd' | 'launchd' | 'windows' | 'manual';
  serviceName: string;
  logPath: string;
}

export interface RuntimeConfig {
  companionChatLimiter: {
    perSessionLimit: number;
  };
  eventBus: {
    maxListeners: number;
  };
  /** Unified RuntimeTask tracking across subsystems (restart to apply). Default false. */
  unifiedTasks: boolean;
  /** Structured plugin init/teardown lifecycle with health integration (restart to apply). Default false. */
  pluginLifecycle: boolean;
  /** Structured MCP server connect/disconnect lifecycle with health integration (restart to apply). Default false. */
  mcpLifecycle: boolean;
  /**
   * Default per-phase tool-execution budget limits. `enforced` turns hard
   * budget enforcement on; a limit value of 0 means "unlimited" for that
   * dimension; per-call ToolRuntimeContext.budget still overrides.
   */
  toolBudget: {
    enforced: boolean;
    maxMs: number;
    maxTokens: number;
    maxCostUsd: number;
  };
}
