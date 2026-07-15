/**
 * wiring.ts — daemon composition seam for the memory governance layer.
 *
 * Builds the CacheRegistry, PauseController, and MemoryGovernor as one unit,
 * registers the known caches and the deferrable background jobs, wires ops
 * emission onto the runtime bus and the tripwire receipt onto disk, and (by
 * default — it is a safety feature the owner confirmed ON) starts the governor.
 * Interactive/test compositions call this too but inject fake clocks/samplers.
 */
import { writeFileSync } from 'node:fs';
import type { RuntimeEventBus } from '../events/index.js';
import { emitOpsMemoryPressure } from '../emitters/ops.js';
import { logger } from '../../utils/logger.js';
import { CacheRegistry, type MemoryCacheId, type RegisteredCache } from './cache-registry.js';
import { PauseController } from './pause-controller.js';
import {
  MemoryGovernor,
  type MemoryGovernorConfig,
  type MemoryGovernorDeps,
} from './memory-governor.js';

export interface MemoryGovernanceHandles {
  readonly cacheRegistry: CacheRegistry;
  readonly pauseController: PauseController;
  readonly memoryGovernor: MemoryGovernor;
}

export interface MemoryGovernanceWiringOptions {
  readonly config: MemoryGovernorConfig;
  /** The runtime bus the OPS_MEMORY_PRESSURE attention event is emitted onto. */
  readonly runtimeBus?: RuntimeEventBus | undefined;
  /** Caches to register at construction (all KNOWN_MEMORY_CACHES for a full daemon). */
  readonly caches: ReadonlyArray<{ readonly id: MemoryCacheId; readonly cache: RegisteredCache }>;
  /** Deferrable background jobs the governor pauses under pressure. */
  readonly jobIds: readonly string[];
  /** Where the tripwire receipt is written so a supervisor sees the exit reason. */
  readonly receiptPath?: string | undefined;
  /** Default true — the governor is a safety feature and starts ON. */
  readonly start?: boolean | undefined;
  /** Test injection for the governor's I/O (sampler, clock, gc, exit). */
  readonly deps?: Partial<Pick<MemoryGovernorDeps, 'sampler' | 'now' | 'gc' | 'exit' | 'resolveSystemRamMb'>> | undefined;
  /**
   * A pre-built PauseController to reuse. The daemon composition builds this
   * EARLY so scheduler gates (isIdle/isEnabled/isBackgroundPaused) can consult
   * it before the governor exists; the jobs listed in `jobIds` are registered
   * onto it here (idempotent).
   */
  readonly pauseController?: PauseController | undefined;
  /** A pre-built CacheRegistry to reuse; the `caches` are registered onto it. */
  readonly cacheRegistry?: CacheRegistry | undefined;
}

/** Construct and (by default) start the memory governance layer. */
export function createMemoryGovernance(options: MemoryGovernanceWiringOptions): MemoryGovernanceHandles {
  const cacheRegistry = options.cacheRegistry ?? new CacheRegistry();
  for (const { id, cache } of options.caches) cacheRegistry.register(id, cache);

  const pauseController = options.pauseController ?? new PauseController();
  for (const id of options.jobIds) {
    if (!pauseController.states().some((s) => s.id === id)) pauseController.register({ id });
  }

  const runtimeBus = options.runtimeBus;
  const receiptPath = options.receiptPath;

  const memoryGovernor = new MemoryGovernor(options.config, {
    caches: cacheRegistry,
    pauses: pauseController,
    ...(options.deps ?? {}),
    emitOps: runtimeBus
      ? (event): void => emitOpsMemoryPressure(runtimeBus, { sessionId: 'memory-governor', source: 'memory-governor', traceId: 'memory-governor' }, event)
      : undefined,
    writeReceipt: receiptPath
      ? (receipt): void => {
          try {
            writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), 'utf-8');
          } catch (error) {
            logger.warn('[memory] tripwire receipt write failed', { receiptPath, error: String(error) });
          }
        }
      : undefined,
  });

  if (options.start !== false) memoryGovernor.start();
  return { cacheRegistry, pauseController, memoryGovernor };
}

/** Config + count getters the daemon composition supplies to {@link wireDaemonMemoryGovernance}. */
export interface DaemonMemoryGovernanceOptions {
  readonly config: MemoryGovernorConfig;
  readonly runtimeBus?: RuntimeEventBus | undefined;
  readonly cacheRegistry: CacheRegistry;
  readonly pauseController: PauseController;
  readonly jobIds: readonly string[];
  readonly receiptPath: string;
  /** Retained-entry count across the daemon's knowledge stores. */
  readonly knowledgeEntryCount: () => number;
  /** Busy shared-session count (session union visibility). */
  readonly busySessionCount: () => number;
}

/**
 * Build and start the daemon's memory governance with the standard KNOWN cache
 * adapters. Kept here (not in services.ts) so the composition root stays lean:
 * adapters expose a real retained-entry count where the subsystem offers one
 * cheaply; authoritative/bounded stores register for VISIBILITY with a safe
 * no-op trim.
 */
export function wireDaemonMemoryGovernance(options: DaemonMemoryGovernanceOptions): MemoryGovernanceHandles {
  const caches: Array<{ id: MemoryCacheId; cache: RegisteredCache }> = [
    { id: 'knowledge-store', cache: { name: 'knowledge stores (regular + agent + home-graph)', entryCount: options.knowledgeEntryCount, trim: () => { /* authoritative; per-run materialization is paged */ } } },
    { id: 'session-union', cache: { name: 'shared session broker (busy sessions)', entryCount: options.busySessionCount, trim: () => {} } },
    { id: 'discovery-scan-ttl', cache: { name: 'discovery/scan TTL caches', entryCount: () => 0, trim: () => {} } },
    { id: 'provider-model-catalog', cache: { name: 'provider + model catalogs', entryCount: () => 0, trim: () => {} } },
    { id: 'event-replay-ring', cache: { name: 'control-plane event replay ring', entryCount: () => 0, trim: () => {} } },
  ];
  return createMemoryGovernance({
    config: options.config,
    runtimeBus: options.runtimeBus,
    cacheRegistry: options.cacheRegistry,
    pauseController: options.pauseController,
    jobIds: options.jobIds,
    caches,
    receiptPath: options.receiptPath,
  });
}
