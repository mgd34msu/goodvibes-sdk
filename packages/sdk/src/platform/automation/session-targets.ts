/**
 * Execution-target types for automation jobs and runs.
 */

import type {
  AutomationExecutionKind,
  AutomationExecutionTargetKind,
  AutomationSurfaceKind,
  ProviderModelRoutingPolicy,
} from './types.js';
import type { ExecutionIntent } from '../runtime/execution-intents.js';

export type AutomationSessionTargetKind = AutomationExecutionTargetKind;

export interface AutomationSessionTarget {
  readonly kind: AutomationSessionTargetKind;
  readonly sessionId?: string | undefined;
  readonly routeId?: string | undefined;
  readonly threadId?: string | undefined;
  readonly channelId?: string | undefined;
  readonly surfaceKind?: AutomationSurfaceKind | undefined;
  readonly pinnedSessionId?: string | undefined;
  readonly preserveThread?: boolean | undefined;
  readonly createIfMissing?: boolean | undefined;
}

export type AutomationSandboxMode = 'inherit' | 'isolate' | 'off';
export type AutomationWakeMode = 'next-heartbeat' | 'now';
export type AutomationExternalContentSourceKind =
  | 'gmail'
  | 'email'
  | 'webhook'
  | 'api'
  | 'browser'
  | 'channel_metadata'
  | 'web_search'
  | 'web_fetch'
  | 'slack'
  | 'discord'
  | 'ntfy'
  | 'unknown';

export type AutomationExternalContentSource =
  | AutomationExternalContentSourceKind
  | {
      readonly kind: AutomationExternalContentSourceKind | string;
      readonly id?: string | undefined;
      readonly url?: string | undefined;
      readonly routeId?: string | undefined;
      readonly surfaceKind?: AutomationSurfaceKind | undefined;
      readonly metadata?: Record<string, unknown> | undefined;
    };

export interface AutomationExecutionPolicy {
  readonly prompt?: string | undefined;
  readonly template?: string | undefined;
  readonly target: AutomationSessionTarget;
  readonly modelProvider?: string | undefined;
  readonly modelId?: string | undefined;
  readonly fallbackModels?: readonly string[] | undefined;
  readonly routing?: ProviderModelRoutingPolicy | undefined;
  readonly executionIntent?: ExecutionIntent | undefined;
  readonly reasoningEffort?: 'instant' | 'low' | 'medium' | 'high' | undefined;
  readonly thinking?: string | undefined;
  readonly wakeMode?: AutomationWakeMode | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxAttempts?: number | undefined;
  readonly toolAllowlist?: readonly string[] | undefined;
  readonly autoApprove?: boolean | undefined;
  readonly sandboxMode?: AutomationSandboxMode | undefined;
  readonly allowUnsafeExternalContent?: boolean | undefined;
  readonly externalContentSource?: AutomationExternalContentSource | undefined;
  readonly lightContext?: boolean | undefined;
}
