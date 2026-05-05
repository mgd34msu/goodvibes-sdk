import { join } from 'node:path';
import { PersistentStore } from '../state/persistent-store.js';
import type { ConfigManager } from '../config/manager.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { LLMProvider, ProviderBatchResult } from '../providers/interface.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import type {
  CreateDaemonBatchJobInput,
  DaemonBatchJob,
  DaemonBatchRuntimeSnapshot,
  DaemonBatchStoreData,
  DaemonBatchTickResult,
} from './types.js';
import { DaemonBatchError } from './types.js';

const TERMINAL_JOB_STATUSES = new Set<DaemonBatchJob['status']>([
  'completed',
  'failed',
  'cancelled',
  'expired',
  'dead_lettered',
]);
const BATCH_JOB_STATUSES = new Set<DaemonBatchJob['status']>([
  'queued',
  'submitted',
  'running',
  ...TERMINAL_JOB_STATUSES,
]);

function now(): number {
  return Date.now();
}

function makeEmptyStore(): DaemonBatchStoreData {
  return { version: 1, jobs: {} };
}

function estimateJsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function throwInvalidBatchStore(): never {
  throw new DaemonBatchError('Daemon batch store snapshot is invalid.', 'BATCH_STORE_INVALID', 500);
}

function validateBatchJob(jobId: string, value: unknown): void {
  if (!isRecord(value)) throwInvalidBatchStore();
  const job = value as Partial<DaemonBatchJob>;
  if (
    typeof job.id !== 'string'
    || job.id !== jobId
    || typeof job.provider !== 'string'
    || typeof job.model !== 'string'
    || typeof job.status !== 'string'
    || !BATCH_JOB_STATUSES.has(job.status as DaemonBatchJob['status'])
    || !isFiniteNumber(job.createdAt)
    || !isFiniteNumber(job.updatedAt)
    || !isFiniteNumber(job.attempts)
    || !isRecord(job.request)
    || !Array.isArray(job.request.messages)
    || job.request.messages.length === 0
  ) {
    throwInvalidBatchStore();
  }
  for (const message of job.request.messages) {
    if (!isRecord(message) || typeof message['role'] !== 'string') throwInvalidBatchStore();
  }
  if (job.request.tools !== undefined && !Array.isArray(job.request.tools)) throwInvalidBatchStore();
  if (job.metadata !== undefined && !isRecord(job.metadata)) throwInvalidBatchStore();
  if (job.source !== undefined && !isRecord(job.source)) throwInvalidBatchStore();
  if (job.error !== undefined && (!isRecord(job.error) || typeof job.error.message !== 'string')) {
    throwInvalidBatchStore();
  }
}

function validateBatchStoreData(snapshot: DaemonBatchStoreData | null): DaemonBatchStoreData {
  if (!snapshot) return makeEmptyStore();
  if (!isRecord(snapshot) || snapshot.version !== 1 || !isRecord(snapshot.jobs)) {
    throwInvalidBatchStore();
  }
  for (const [jobId, job] of Object.entries(snapshot.jobs)) {
    validateBatchJob(jobId, job);
  }
  return snapshot;
}

export class DaemonBatchManager {
  private readonly store: PersistentStore<DaemonBatchStoreData>;
  private data: DaemonBatchStoreData | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private ticking: Promise<DaemonBatchTickResult> | null = null;

  constructor(
    private readonly options: {
      readonly configManager: Pick<ConfigManager, 'get' | 'getControlPlaneConfigDir'>;
      readonly providerRegistry: Pick<ProviderRegistry, 'getCurrentModel' | 'getForModel' | 'getRegistered' | 'listProviders'>;
      readonly storePath?: string | undefined;
    },
  ) {
    this.store = new PersistentStore(
      options.storePath ?? join(options.configManager.getControlPlaneConfigDir(), 'batch-jobs.json'),
    );
  }

  start(): void {
    if (this.interval !== null) return;
    this.interval = setInterval(() => {
      void this.tick().catch((error) => {
        logger.warn('Batch manager tick failed', { error: summarizeError(error) });
      });
    }, this.getNumberConfig('batch.tickIntervalMs', 60_000));
    this.interval.unref?.();
  }

  dispose(): void {
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  async describeRuntime(): Promise<DaemonBatchRuntimeSnapshot> {
    return {
      mode: this.getMode(),
      fallback: this.getFallback(),
      queueBackend: this.getQueueBackend(),
      cloudflare: {
        enabled: this.getBooleanConfig('cloudflare.enabled', false),
        freeTierMode: this.getBooleanConfig('cloudflare.freeTierMode', true),
        accountId: this.getStringConfig('cloudflare.accountId', ''),
        workerName: this.getStringConfig('cloudflare.workerName', 'goodvibes-batch-worker'),
        workerBaseUrl: this.getStringConfig('cloudflare.workerBaseUrl', ''),
        daemonBaseUrl: this.getStringConfig('cloudflare.daemonBaseUrl', ''),
        queueName: this.getStringConfig('cloudflare.queueName', 'goodvibes-batch'),
        deadLetterQueueName: this.getStringConfig('cloudflare.deadLetterQueueName', 'goodvibes-batch-dlq'),
        maxQueueOpsPerDay: this.getNumberConfig('cloudflare.maxQueueOpsPerDay', 10_000),
      },
      limits: {
        tickIntervalMs: this.getNumberConfig('batch.tickIntervalMs', 60_000),
        maxDelayMs: this.getNumberConfig('batch.maxDelayMs', 5 * 60 * 1000),
        maxJobsPerProviderBatch: this.getNumberConfig('batch.maxJobsPerProviderBatch', 100),
        maxQueuePayloadBytes: this.getNumberConfig('batch.maxQueuePayloadBytes', 16 * 1024),
        maxQueueMessagesPerDay: this.getNumberConfig('batch.maxQueueMessagesPerDay', 1_000),
      },
      supportedProviders: this.options.providerRegistry
        .listProviders()
        .filter((provider) => Boolean(
          provider.batch?.endpoints.includes('/v1/chat/completions') ||
          provider.batch?.endpoints.includes('/v1/messages/batches'),
        ))
        .map((provider) => provider.name)
        .sort(),
    };
  }

  async createJob(input: CreateDaemonBatchJobInput): Promise<DaemonBatchJob> {
    if (this.getMode() === 'off') {
      throw new DaemonBatchError('Daemon batch mode is off.', 'BATCH_DISABLED', 409);
    }
    if (input.executionMode === 'live') {
      throw new DaemonBatchError('This endpoint only accepts batch jobs. Use the live daemon route for immediate execution.', 'LIVE_REQUEST_NOT_ACCEPTED', 400);
    }
    if (!input.request || !Array.isArray(input.request.messages) || input.request.messages.length === 0) {
      throw new DaemonBatchError('Batch jobs require request.messages.', 'INVALID_BATCH_REQUEST', 400);
    }
    const defaults = this.options.providerRegistry.getCurrentModel();
    const provider = input.provider?.trim() || defaults.provider;
    const model = input.model?.trim() || defaults.id;
    const providerInstance = this.getBatchProvider(model, provider);
    this.requireProviderBatchSupport(providerInstance, provider);
    const payloadBytes = estimateJsonBytes(input);
    if (input.source?.kind === 'cloudflare-queue') {
      const maxPayload = this.getNumberConfig('batch.maxQueuePayloadBytes', 16 * 1024);
      if (payloadBytes > maxPayload) {
        throw new DaemonBatchError(
          `Cloudflare queue batch signal is ${payloadBytes} bytes, above configured limit ${maxPayload}. Store the payload in the daemon and queue only a signal.`,
          'QUEUE_PAYLOAD_TOO_LARGE',
          413,
        );
      }
    }

    const loaded = await this.load();
    const timestamp = now();
    const job: DaemonBatchJob = {
      id: `batch-job-${crypto.randomUUID()}`,
      provider,
      model,
      status: 'queued',
      createdAt: timestamp,
      updatedAt: timestamp,
      request: {
        messages: [...input.request.messages],
        ...(input.request.tools ? { tools: [...input.request.tools] } : {}),
        ...(input.request.systemPrompt ? { systemPrompt: input.request.systemPrompt } : {}),
        ...(input.request.maxTokens !== undefined ? { maxTokens: input.request.maxTokens } : {}),
        ...(input.request.reasoningEffort ? { reasoningEffort: input.request.reasoningEffort } : {}),
        ...(input.request.reasoningSummary !== undefined ? { reasoningSummary: input.request.reasoningSummary } : {}),
      },
      ...(input.source ? { source: input.source } : {}),
      ...(input.metadata ? { metadata: { ...input.metadata } } : {}),
      attempts: 0,
    };
    loaded.jobs[job.id] = job;
    await this.persist();
    if (input.flush) {
      await this.tick({ forceSubmit: true });
      return (await this.getJob(job.id)) ?? job;
    }
    return job;
  }

  async getJob(jobId: string): Promise<DaemonBatchJob | null> {
    const loaded = await this.load();
    return loaded.jobs[jobId] ?? null;
  }

  async listJobs(limit = 100): Promise<readonly DaemonBatchJob[]> {
    const loaded = await this.load();
    return Object.values(loaded.jobs)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, Math.max(1, Math.min(limit, 1000)));
  }

  async cancelJob(jobId: string): Promise<DaemonBatchJob> {
    const loaded = await this.load();
    const job = loaded.jobs[jobId]!;
    if (!job) throw new DaemonBatchError(`Batch job '${jobId}' was not found.`, 'BATCH_JOB_NOT_FOUND', 404);
    if (TERMINAL_JOB_STATUSES.has(job.status)) return job;
    if (job.status !== 'queued') {
      throw new DaemonBatchError(
        'Submitted provider batches are cancelled at provider-batch granularity; wait for the result or cancel the provider batch outside this per-job route.',
        'BATCH_JOB_ALREADY_SUBMITTED',
        409,
      );
    }
    const updated = { ...job, status: 'cancelled' as const, updatedAt: now(), completedAt: now() };
    loaded.jobs[jobId] = updated;
    await this.persist();
    return updated;
  }

  async tick(options: { readonly forceSubmit?: boolean } = {}): Promise<DaemonBatchTickResult> {
    if (this.ticking) return this.ticking;
    this.ticking = this.runTick(options).finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  private async runTick(options: { readonly forceSubmit?: boolean }): Promise<DaemonBatchTickResult> {
    const result: DaemonBatchTickResult = {
      submittedProviderBatches: 0,
      submittedJobs: 0,
      polledProviderBatches: 0,
      completedJobs: 0,
      failedJobs: 0,
    };
    if (this.getMode() === 'off') return result;
    const loaded = await this.load();
    await this.submitQueuedJobs(loaded, result, options.forceSubmit === true);
    await this.pollProviderBatches(loaded, result);
    await this.persist();
    return result;
  }

  private async submitQueuedJobs(
    data: DaemonBatchStoreData,
    result: DaemonBatchTickResult,
    forceSubmit: boolean,
  ): Promise<void> {
    const queued = Object.values(data.jobs).filter((job) => job.status === 'queued');
    if (queued.length === 0) return;
    const maxDelayMs = this.getNumberConfig('batch.maxDelayMs', 5 * 60 * 1000);
    const maxJobs = this.getNumberConfig('batch.maxJobsPerProviderBatch', 100);
    const grouped = new Map<string, DaemonBatchJob[]>();
    for (const job of queued) {
      const ageMs = now() - job.createdAt;
      if (!forceSubmit && maxDelayMs > 0 && ageMs < maxDelayMs) continue;
      const key = `${job.provider}\u0000${job.model}`;
      const bucket = grouped.get(key) ?? [];
      bucket.push(job);
      grouped.set(key, bucket);
    }
    for (const jobs of grouped.values()) {
      for (let i = 0; i < jobs.length; i += maxJobs) {
        const slice = jobs.slice(i, i + maxJobs);
        if (slice.length === 0) continue;
        await this.submitProviderBatch(data, slice, result);
      }
    }
  }

  private async submitProviderBatch(
    data: DaemonBatchStoreData,
    jobs: readonly DaemonBatchJob[],
    result: DaemonBatchTickResult,
  ): Promise<void> {
    const first = jobs[0]!;
    if (!first) return;
    try {
      const provider = this.getBatchProvider(first.model, first.provider);
      this.requireProviderBatchSupport(provider, first.provider);
      const created = await provider.batch!.createChatBatch({
        requests: jobs.map((job) => ({
          customId: job.id,
          params: {
            model: job.model,
            messages: [...job.request.messages],
            ...(job.request.tools ? { tools: [...job.request.tools] } : {}),
            ...(job.request.systemPrompt ? { systemPrompt: job.request.systemPrompt } : {}),
            ...(job.request.maxTokens !== undefined ? { maxTokens: job.request.maxTokens } : {}),
            ...(job.request.reasoningEffort ? { reasoningEffort: job.request.reasoningEffort } : {}),
            ...(job.request.reasoningSummary !== undefined ? { reasoningSummary: job.request.reasoningSummary } : {}),
          },
        })),
        metadata: {
          source: 'goodvibes-sdk',
          provider: first.provider,
          model: first.model,
        },
        completionWindow: '24h',
      });
      const timestamp = now();
      for (const job of jobs) {
        data.jobs[job.id] = {
          ...job,
          status: created.status === 'completed' ? 'running' : created.status === 'failed' ? 'failed' : 'submitted',
          updatedAt: timestamp,
          attempts: job.attempts + 1,
          providerBatchId: created.providerBatchId,
          providerBatchStatus: created.status,
          submittedAt: timestamp,
          ...(created.status === 'failed'
            ? { completedAt: timestamp, error: { message: 'Provider failed to create batch.', raw: created.raw } }
            : {}),
        };
      }
      result.submittedProviderBatches += 1;
      result.submittedJobs += jobs.length;
    } catch (error: unknown) {
      const timestamp = now();
      for (const job of jobs) {
        data.jobs[job.id] = {
          ...job,
          status: 'dead_lettered',
          updatedAt: timestamp,
          completedAt: timestamp,
          attempts: job.attempts + 1,
          error: { message: summarizeError(error) },
        };
      }
      result.failedJobs += jobs.length;
    }
  }

  private async pollProviderBatches(
    data: DaemonBatchStoreData,
    result: DaemonBatchTickResult,
  ): Promise<void> {
    const pendingByProviderBatch = new Map<string, DaemonBatchJob[]>();
    for (const job of Object.values(data.jobs)) {
      if (!job.providerBatchId || TERMINAL_JOB_STATUSES.has(job.status)) continue;
      const key = `${job.provider}\u0000${job.model}\u0000${job.providerBatchId}`;
      const bucket = pendingByProviderBatch.get(key) ?? [];
      bucket.push(job);
      pendingByProviderBatch.set(key, bucket);
    }
    for (const jobs of pendingByProviderBatch.values()) {
      const first = jobs[0]!;
      if (!first?.providerBatchId) continue;
      try {
        const provider = this.getBatchProvider(first.model, first.provider);
        this.requireProviderBatchSupport(provider, first.provider);
        const polled = await provider.batch?.retrieveBatch(first.providerBatchId);
        if (!polled) continue;
        result.polledProviderBatches += 1;
        const timestamp = now();
        for (const job of jobs) {
          data.jobs[job.id] = {
            ...job,
            status: polled.status === 'running' || polled.status === 'submitted' ? 'running' : job.status,
            updatedAt: timestamp,
            providerBatchStatus: polled.status,
          };
        }
        if (polled.resultAvailable || polled.status === 'completed') {
          const providerResults = await provider.batch?.getResults(first.providerBatchId);
          if (!providerResults) continue;
          this.applyProviderResults(data, providerResults, result);
        } else if (polled.status === 'failed' || polled.status === 'cancelled' || polled.status === 'expired') {
          for (const job of jobs) {
            const status = polled.status === 'cancelled' ? 'cancelled' : polled.status === 'expired' ? 'expired' : 'failed';
            data.jobs[job.id] = {
              ...(data.jobs[job.id] ?? {}),
              status,
              updatedAt: timestamp,
              completedAt: timestamp,
              error: status === 'failed' ? { message: 'Provider batch failed.', raw: polled.raw } : data.jobs[job.id]?.error,
            } as DaemonBatchJob;
            if (status === 'failed') result.failedJobs += 1;
          }
        }
      } catch (error: unknown) {
        const timestamp = now();
        for (const job of jobs) {
          data.jobs[job.id] = {
            ...job,
            status: 'dead_lettered',
            updatedAt: timestamp,
            completedAt: timestamp,
            error: { message: summarizeError(error) },
          };
          result.failedJobs += 1;
        }
      }
    }
  }

  private applyProviderResults(
    data: DaemonBatchStoreData,
    providerResults: readonly ProviderBatchResult[],
    tickResult: DaemonBatchTickResult,
  ): void {
    const timestamp = now();
    for (const providerResult of providerResults) {
      const job = data.jobs[providerResult.customId];
      if (!job || TERMINAL_JOB_STATUSES.has(job.status)) continue;
      if (providerResult.status === 'succeeded' && providerResult.response) {
        data.jobs[job.id] = {
          ...job,
          status: 'completed',
          updatedAt: timestamp,
          completedAt: timestamp,
          result: providerResult.response,
        };
        tickResult.completedJobs += 1;
        continue;
      }
      const status = providerResult.status === 'cancelled'
        ? 'cancelled'
        : providerResult.status === 'expired'
          ? 'expired'
          : 'failed';
      data.jobs[job.id] = {
        ...job,
        status,
        updatedAt: timestamp,
        completedAt: timestamp,
        error: providerResult.error ?? { message: `Provider batch request ${status}.`, raw: providerResult.raw },
      };
      if (status === 'failed') tickResult.failedJobs += 1;
    }
  }

  private getBatchProvider(model: string, providerId: string): LLMProvider {
    if (providerId === 'openai') return this.options.providerRegistry.getRegistered('openai');
    return this.options.providerRegistry.getForModel(model, providerId);
  }

  private requireProviderBatchSupport(provider: LLMProvider, providerId: string): void {
    if (!provider.batch) {
      throw new DaemonBatchError(`Provider '${providerId}' does not expose a provider Batch API adapter.`, 'BATCH_PROVIDER_UNSUPPORTED', 409);
    }
    if (typeof provider.isConfigured === 'function' && !provider.isConfigured()) {
      throw new DaemonBatchError(`Provider '${providerId}' is not configured for Batch API use. Batch API routes require provider API-key credentials.`, 'BATCH_PROVIDER_NOT_CONFIGURED', 409);
    }
  }

  private async load(): Promise<DaemonBatchStoreData> {
    if (this.data) return this.data;
    this.data = validateBatchStoreData(await this.store.load());
    return this.data;
  }

  private async persist(): Promise<void> {
    if (this.data) await this.store.persist(this.data);
  }

  private getMode(): DaemonBatchRuntimeSnapshot['mode'] {
    const value = this.options.configManager.get('batch.mode');
    return value === 'explicit' || value === 'eligible-by-default' ? value : 'off';
  }

  private getFallback(): DaemonBatchRuntimeSnapshot['fallback'] {
    const value = this.options.configManager.get('batch.fallback');
    return value === 'fail' ? 'fail' : 'live';
  }

  private getQueueBackend(): DaemonBatchRuntimeSnapshot['queueBackend'] {
    const value = this.options.configManager.get('batch.queueBackend');
    return value === 'cloudflare' ? 'cloudflare' : 'local';
  }

  private getNumberConfig(key: Parameters<ConfigManager['get']>[0], fallback: number): number {
    const value = this.options.configManager.get(key);
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }

  private getBooleanConfig(key: Parameters<ConfigManager['get']>[0], fallback: boolean): boolean {
    const value = this.options.configManager.get(key);
    return typeof value === 'boolean' ? value : fallback;
  }

  private getStringConfig(key: Parameters<ConfigManager['get']>[0], fallback: string): string {
    const value = this.options.configManager.get(key);
    return typeof value === 'string' ? value : fallback;
  }
}
