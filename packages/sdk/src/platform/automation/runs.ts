/**
 * First-class automation run records.
 */

import type { AutomationDeliveryAttempt } from './delivery.js';
import type { AutomationExecutionPolicy, AutomationSessionTarget } from './session-targets.js';
import type {
  AutomationEntityBase,
  AutomationExecutionIntent,
  AutomationExecutionMode,
  AutomationRunStatus,
} from './types.js';
import type { AutomationRouteBinding } from './routes.js';
import type { AutomationSourceRecord } from './sources.js';

export type AutomationRunContinuationMode = AutomationExecutionMode;

export interface AutomationRunUsageSummary {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens?: number | undefined;
}

export interface AutomationRunTelemetry {
  readonly usage: AutomationRunUsageSummary;
  readonly llmCallCount?: number | undefined;
  readonly toolCallCount?: number | undefined;
  readonly turnCount?: number | undefined;
  readonly modelId?: string | undefined;
  readonly providerId?: string | undefined;
  readonly reasoningSummaryPresent?: boolean | undefined;
  readonly source?: 'local-agent' | 'shared-session' | 'remote-node' | 'remote-device' | undefined;
}

export interface AutomationRun extends AutomationEntityBase {
  readonly jobId: string;
  readonly status: AutomationRunStatus;
  readonly agentId?: string | undefined;
  readonly triggeredBy: AutomationSourceRecord;
  readonly target: AutomationSessionTarget;
  readonly execution: AutomationExecutionPolicy;
  readonly scheduleKind?: 'at' | 'every' | 'cron' | undefined;
  readonly queuedAt: number;
  readonly startedAt?: number | undefined;
  readonly endedAt?: number | undefined;
  readonly durationMs?: number | undefined;
  readonly forceRun: boolean;
  readonly dueRun: boolean;
  readonly attempt: number;
  readonly sessionId?: string | undefined;
  readonly routeId?: string | undefined;
  readonly route?: AutomationRouteBinding | undefined;
  readonly continuationMode?: AutomationRunContinuationMode | undefined;
  readonly executionIntent?: AutomationExecutionIntent | undefined;
  readonly deliveryIds: readonly string[];
  readonly deliveryAttempts?: readonly AutomationDeliveryAttempt[] | undefined;
  readonly modelId?: string | undefined;
  readonly providerId?: string | undefined;
  readonly telemetry?: AutomationRunTelemetry | undefined;
  readonly result?: unknown | undefined;
  readonly error?: string | undefined;
  readonly cancelledReason?: string | undefined;
}

export interface AutomationRunSummary {
  readonly runId: string;
  readonly jobId: string;
  readonly status: AutomationRunStatus;
  readonly startedAt?: number | undefined;
  readonly endedAt?: number | undefined;
}
