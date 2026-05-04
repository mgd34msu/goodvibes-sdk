import type { ChatRequest, ChatResponse, ProviderBatchStatus, ProviderMessage } from '../providers/interface.js';
import type { ToolDefinition } from '../types/tools.js';

export type DaemonBatchMode = 'off' | 'explicit' | 'eligible-by-default';
export type DaemonBatchFallback = 'live' | 'fail';
export type DaemonBatchQueueBackend = 'local' | 'cloudflare';

export type DaemonBatchJobStatus =
  | 'queued'
  | 'submitted'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired'
  | 'dead_lettered';

export interface DaemonBatchChatRequest {
  readonly messages: readonly ProviderMessage[];
  readonly tools?: readonly ToolDefinition[] | undefined;
  readonly systemPrompt?: string | undefined;
  readonly maxTokens?: number | undefined;
  readonly reasoningEffort?: ChatRequest['reasoningEffort'] | undefined;
  readonly reasoningSummary?: boolean | undefined;
}

export interface CreateDaemonBatchJobInput {
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly request: DaemonBatchChatRequest;
  readonly executionMode?: 'batch' | 'live' | undefined;
  readonly source?: {
    readonly kind: 'daemon-api' | 'cloudflare-worker' | 'cloudflare-queue' | 'automation' | 'client';
    readonly id?: string | undefined;
  };
  readonly metadata?: Record<string, string> | undefined;
  readonly flush?: boolean | undefined;
}

export interface DaemonBatchJob {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly status: DaemonBatchJobStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly request: DaemonBatchChatRequest;
  readonly source?: CreateDaemonBatchJobInput['source'] | undefined;
  readonly metadata?: Record<string, string> | undefined;
  readonly attempts: number;
  readonly providerBatchId?: string | undefined;
  readonly providerBatchStatus?: ProviderBatchStatus | undefined;
  readonly submittedAt?: number | undefined;
  readonly completedAt?: number | undefined;
  readonly result?: ChatResponse | undefined;
  readonly error?: {
    readonly message: string;
    readonly code?: string | undefined;
    readonly raw?: unknown | undefined;
  };
}

export interface DaemonBatchTickResult {
  submittedProviderBatches: number;
  submittedJobs: number;
  polledProviderBatches: number;
  completedJobs: number;
  failedJobs: number;
}

export interface DaemonBatchRuntimeSnapshot {
  readonly mode: DaemonBatchMode;
  readonly fallback: DaemonBatchFallback;
  readonly queueBackend: DaemonBatchQueueBackend;
  readonly cloudflare: {
    readonly enabled: boolean;
    readonly freeTierMode: boolean;
    readonly accountId: string;
    readonly workerName: string;
    readonly workerBaseUrl: string;
    readonly daemonBaseUrl: string;
    readonly queueName: string;
    readonly deadLetterQueueName: string;
    readonly maxQueueOpsPerDay: number;
  };
  readonly limits: {
    readonly tickIntervalMs: number;
    readonly maxDelayMs: number;
    readonly maxJobsPerProviderBatch: number;
    readonly maxQueuePayloadBytes: number;
    readonly maxQueueMessagesPerDay: number;
  };
  readonly supportedProviders: readonly string[];
}

export interface DaemonBatchStoreData extends Record<string, unknown> {
  version: 1;
  jobs: Record<string, DaemonBatchJob>;
}

export class DaemonBatchError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, code: string, status = 400) {
    super(message);
    this.name = 'DaemonBatchError';
    this.code = code;
    this.status = status;
  }
}
