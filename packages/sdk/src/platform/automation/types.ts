/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * Shared automation type vocabulary used across jobs, runs, routes, delivery,
 * watchers, and control-plane domains.
 */

export type AutomationJobStatus = 'enabled' | 'paused' | 'error' | 'archived';
export type AutomationRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type AutomationRunTrigger =
  | 'scheduled'
  | 'manual'
  | 'catch_up'
  | 'webhook'
  | 'surface'
  | 'watcher';

export type AutomationSurfaceKind =
  | 'tui'
  | 'web'
  | 'slack'
  | 'discord'
  | 'ntfy'
  | 'webhook'
  | 'homeassistant'
  | 'telegram'
  | 'google-chat'
  | 'signal'
  | 'whatsapp'
  | 'imessage'
  | 'msteams'
  | 'bluebubbles'
  | 'mattermost'
  | 'matrix'
  | 'service';

export type AutomationRouteKind = 'session' | 'thread' | 'channel' | 'message';
export type AutomationSourceKind =
  | 'schedule'
  | 'manual'
  | 'hook'
  | 'webhook'
  | 'surface'
  | 'watcher';
export type AutomationExecutionKind = 'isolated' | 'current' | 'pinned' | 'background' | 'main';
export type AutomationExecutionTargetKind = AutomationExecutionKind | 'session' | 'route';
export type AutomationDeliveryKind = 'none' | 'webhook' | 'surface' | 'integration' | 'link';
export type ProviderRoutingSelection = 'inherit-current' | 'concrete' | 'synthetic';
export type UnresolvedModelPolicy = 'fallback-to-current' | 'fail';
export type ProviderFailurePolicy = 'ordered-fallbacks' | 'fail';
export type AutomationExecutionMode = 'spawn' | 'shared-session' | 'continued-live' | 'background';
export type AutomationSessionPolicy = 'create-or-bind' | 'continue-existing' | 'require-existing';
export type AutomationThreadPolicy = 'preserve' | 'replace' | 'detached';
export type AutomationDeliveryGuarantee = 'best-effort' | 'at-least-once';

export interface ProviderModelRoutingPolicy {
  readonly providerSelection?: ProviderRoutingSelection;
  readonly unresolvedModelPolicy?: UnresolvedModelPolicy;
  readonly providerFailurePolicy?: ProviderFailurePolicy;
  readonly fallbackModels?: readonly string[];
}

export interface AutomationExecutionIntent {
  readonly mode: AutomationExecutionMode;
  readonly targetKind: AutomationExecutionTargetKind;
}

export interface AutomationEntityBase {
  readonly id: string;
  readonly labels: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly createdBy?: string;
  readonly updatedBy?: string;
  readonly notes?: string;
}

export type AutomationFailureMode = 'continue' | 'retry' | 'disable_job';

export interface AutomationAtSchedule {
  readonly kind: 'at';
  readonly at: number;
}

export interface AutomationEverySchedule {
  readonly kind: 'every';
  readonly intervalMs: number;
  readonly anchorAt?: number;
}

export interface AutomationCronSchedule {
  readonly kind: 'cron';
  readonly expression: string;
  readonly timezone?: string;
  readonly staggerMs?: number;
}

export type AutomationSchedule =
  | AutomationAtSchedule
  | AutomationEverySchedule
  | AutomationCronSchedule;

export interface AutomationExecutionPolicy {
  readonly prompt: string;
  readonly model?: string;
  readonly template?: string;
  readonly timeoutMs?: number;
  readonly target?: AutomationExecutionKind;
  readonly toolAllowlist?: readonly string[];
}

export interface AutomationDeliveryPolicy {
  readonly kind: AutomationDeliveryKind;
  readonly target?: string;
  readonly threadId?: string;
  readonly webhookUrl?: string;
  readonly onFailure?: 'none' | 'fallback_webhook' | 'surface_alert';
}

export interface AutomationFailurePolicy {
  readonly mode: AutomationFailureMode;
  readonly maxConsecutiveFailures: number;
  readonly cooldownMs?: number;
  readonly disableAfterFailures?: number;
}

export interface AutomationSourceRef {
  readonly kind: AutomationSourceKind;
  readonly id: string;
}
