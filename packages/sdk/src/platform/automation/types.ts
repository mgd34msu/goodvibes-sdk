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
  readonly providerSelection?: ProviderRoutingSelection | undefined;
  readonly unresolvedModelPolicy?: UnresolvedModelPolicy | undefined;
  readonly providerFailurePolicy?: ProviderFailurePolicy | undefined;
  readonly fallbackModels?: readonly string[] | undefined;
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
  readonly createdBy?: string | undefined;
  readonly updatedBy?: string | undefined;
  readonly notes?: string | undefined;
}

export type AutomationFailureMode = 'continue' | 'retry' | 'disable_job';

export interface AutomationAtSchedule {
  readonly kind: 'at';
  readonly at: number;
}

export interface AutomationEverySchedule {
  readonly kind: 'every';
  readonly intervalMs: number;
  readonly anchorAt?: number | undefined;
}

export interface AutomationCronSchedule {
  readonly kind: 'cron';
  readonly expression: string;
  readonly timezone?: string | undefined;
  readonly staggerMs?: number | undefined;
}

export type AutomationSchedule =
  | AutomationAtSchedule
  | AutomationEverySchedule
  | AutomationCronSchedule;

export interface AutomationExecutionPolicy {
  readonly prompt: string;
  readonly model?: string | undefined;
  readonly template?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly target?: AutomationExecutionKind | undefined;
  readonly toolAllowlist?: readonly string[] | undefined;
}

export interface AutomationDeliveryPolicy {
  readonly kind: AutomationDeliveryKind;
  readonly target?: string | undefined;
  readonly threadId?: string | undefined;
  readonly webhookUrl?: string | undefined;
  readonly onFailure?: 'none' | 'fallback_webhook' | 'surface_alert' | undefined;
}

export interface AutomationFailurePolicy {
  readonly mode: AutomationFailureMode;
  readonly maxConsecutiveFailures: number;
  readonly cooldownMs?: number | undefined;
  readonly disableAfterFailures?: number | undefined;
}

export interface AutomationSourceRef {
  readonly kind: AutomationSourceKind;
  readonly id: string;
}
