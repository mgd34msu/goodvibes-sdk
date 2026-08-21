/**
 * manager-streams.ts, the stream watcher kind's lifecycle.
 *
 * Split out of manager.ts so the supervisor file stays inside the 800-line
 * hand-authored cap. The logic is unchanged: spawn the long-lived command
 * through the injected stream host, feed every chunk to a StreamLineProcessor,
 * emit a batch when one is ready, and put a stream command that exits through
 * the same backoff ladder and breaker every other kind uses.
 *
 * These are free functions over a narrow `StreamOwner` view of the manager
 * rather than methods, so the coupling back to the supervisor is written down
 * explicitly instead of being "whatever `this` happens to have".
 */

import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import { renderStreamPrompt, resolveStreamOptions, StreamLineProcessor } from './stream-watchers.js';
import { applyFailure, type SupervisionPolicy } from './supervision.js';
import type { TriggerManagerConfig, TriggerStreamHost } from './manager-types.js';
import type { StreamTriggerSpec, TriggerRecord } from './types.js';

/** Per-trigger stream state: the line processor plus its supervision handles. */
export interface StreamRuntime {
  readonly processor: StreamLineProcessor;
  streamId: string | null;
  timer: ReturnType<typeof setInterval> | null;
}

/** Exactly what the stream lifecycle needs from the supervisor. */
export interface StreamOwner {
  readonly streams: Map<string, StreamRuntime>;
  readonly records: Map<string, TriggerRecord>;
  readonly streamHost: TriggerStreamHost | undefined;
  readonly policy: SupervisionPolicy;
  config(): TriggerManagerConfig;
  now(): number;
  persist(): void;
  fireAction(
    id: string,
    reason: string,
    fingerprint: string,
    kind: 'condition' | 'stream',
    promptOverride?: string,
  ): Promise<void>;
}

export async function startStreamTrigger(
  owner: StreamOwner,
  record: TriggerRecord,
  spec: StreamTriggerSpec,
  now: number,
): Promise<TriggerRecord> {
  const host = owner.streamHost;
  if (!host) {
    throw new Error('A stream trigger needs a stream host; none is wired on this TriggerManager.');
  }
  const id = record.definition.id;
  const config = owner.config();
  const processor = new StreamLineProcessor(resolveStreamOptions(spec, {
    ...(config.streamBatchLines !== undefined ? { batchLines: config.streamBatchLines } : {}),
    ...(config.streamBatchIntervalMs !== undefined ? { batchIntervalMs: config.streamBatchIntervalMs } : {}),
    ...(config.streamQueueLimit !== undefined ? { queueLimit: config.streamQueueLimit } : {}),
  }));
  const runtime: StreamRuntime = { processor, streamId: null, timer: null };
  owner.streams.set(id, runtime);

  const started = await host.start({
    triggerId: id,
    command: spec.command,
    args: spec.args ?? [],
    ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
    onChunk: (chunk: string) => {
      processor.push(chunk, owner.now());
      drainStreamTrigger(owner, id);
    },
    onExit: (exitCode: number | null) => {
      processor.finish(owner.now());
      drainStreamTrigger(owner, id, true);
      handleStreamExit(owner, id, exitCode);
    },
  });
  runtime.streamId = started.streamId;

  const interval = Math.max(50, spec.batchIntervalMs ?? config.streamBatchIntervalMs ?? 1_000);
  runtime.timer = setInterval(() => { drainStreamTrigger(owner, id); }, interval);
  runtime.timer.unref?.();

  return { ...record, state: 'running', nextCheckAt: now, updatedAt: now };
}

/** Emits whatever batches are ready. An agent runs only when one is. */
export function drainStreamTrigger(owner: StreamOwner, id: string, force = false): void {
  const runtime = owner.streams.get(id);
  const record = owner.records.get(id);
  if (!runtime || !record || record.definition.spec.kind !== 'stream') return;
  const spec = record.definition.spec;
  for (;;) {
    const batch = runtime.processor.takeBatch(owner.now(), force);
    if (!batch) break;
    const now = owner.now();
    const current = owner.records.get(id);
    if (current) {
      owner.records.set(id, {
        ...current,
        droppedLines: runtime.processor.droppedTotal,
        runs: [...current.runs, {
          at: now,
          outcome: 'fired',
          detail: `${batch.lines.length} matched line(s)${batch.dropped > 0 ? `, ${batch.dropped} dropped` : ''}`,
        }],
        updatedAt: now,
      });
    }
    const prompt = renderStreamPrompt(batch, record.definition.label, spec.match.pattern);
    void owner.fireAction(
      id,
      `${batch.lines.length} line(s) matched ${spec.match.pattern}`,
      `stream:${batch.lines[0] ?? ''}`,
      'stream',
      prompt,
    ).catch((error: unknown) => {
      logger.warn('Stream trigger action failed', { triggerId: id, error: summarizeError(error) });
    });
    if (force) break;
  }
}

/** A supervised stream command that exits walks the same ladder and breaker. */
export function handleStreamExit(owner: StreamOwner, id: string, exitCode: number | null): void {
  const record = owner.records.get(id);
  if (!record || record.definition.spec.kind !== 'stream') return;
  if (record.state === 'cancelled') return;
  const now = owner.now();
  const spec = record.definition.spec;
  if (spec.restart === false) {
    owner.records.set(id, {
      ...record,
      state: 'idle',
      runs: [...record.runs, { at: now, outcome: 'skipped', detail: `stream command exited (${exitCode}); restart disabled` }],
      updatedAt: now,
    });
    owner.persist();
    return;
  }
  const outcome = applyFailure(record, owner.policy, now);
  owner.records.set(id, {
    ...record,
    state: outcome.state,
    strikes: outcome.strikes,
    backoffRung: outcome.backoffRung,
    nextCheckAt: Number.isFinite(outcome.nextCheckAt) ? outcome.nextCheckAt : undefined,
    lastError: `stream command exited with ${exitCode}`,
    runs: [...record.runs, {
      at: now,
      outcome: 'failed',
      detail: outcome.breakerOpened
        ? `stream command exited (${exitCode}); breaker opened after ${outcome.strikes} consecutive exits`
        : `stream command exited (${exitCode}); restarting in ${outcome.delayMs}ms`,
    }],
    updatedAt: now,
  });
  owner.persist();
}
