/**
 * wiring.ts — daemon composition seam for the memory governance layer.
 *
 * Builds the CacheRegistry, PauseController, and MemoryGovernor as one unit,
 * registers the known caches and the deferrable background jobs, wires ops
 * emission onto the runtime bus and the tripwire receipt onto disk, and (by
 * default — it is a safety feature the owner confirmed ON) starts the governor.
 * Interactive/test compositions call this too but inject fake clocks/samplers.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RuntimeEventBus } from '../events/index.js';
import { emitOpsMemoryPressure } from '../emitters/ops.js';
import { logger } from '../../utils/logger.js';
import { CacheRegistry, type MemoryCacheId, type RegisteredCache } from './cache-registry.js';
import { PauseController } from './pause-controller.js';
import {
  MemoryGovernor,
  type MemoryGovernorConfig,
  type MemoryGovernorDeps,
  type MemoryTripwireReceipt,
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
  /**
   * Graceful shutdown work run before a tripwire exit — the same session/store
   * snapshot + inhibitor-release path the daemon's signal handlers use.
   */
  readonly onTripwireShutdown?: ((receipt: MemoryTripwireReceipt) => Promise<void> | void) | undefined;
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
            // A fresh install has no receipt directory yet — a bare write would
            // ENOENT and the tripwire's one forensic artifact would be lost.
            mkdirSync(dirname(receiptPath), { recursive: true });
            writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), 'utf-8');
          } catch (error) {
            logger.warn('[memory] tripwire receipt write failed', { receiptPath, error: String(error) });
          }
        }
      : undefined,
    shutdown: options.onTripwireShutdown,
  });

  if (options.start !== false) memoryGovernor.start();
  return { cacheRegistry, pauseController, memoryGovernor };
}

/** The live collaborators the daemon composition hands the standard cache adapters. */
export interface DaemonMemoryGovernanceOptions {
  readonly config: MemoryGovernorConfig;
  readonly runtimeBus?: RuntimeEventBus | undefined;
  readonly cacheRegistry: CacheRegistry;
  readonly pauseController: PauseController;
  readonly jobIds: readonly string[];
  readonly receiptPath: string;
  /** Graceful shutdown work run before a tripwire exit. */
  readonly onTripwireShutdown?: ((receipt: MemoryTripwireReceipt) => Promise<void> | void) | undefined;
  /** The daemon's knowledge stores (regular + agent + home-graph): real counts + a real jobRuns trim. */
  readonly knowledgeStores: ReadonlyArray<{ retainedEntryCount(): number; pruneJobRuns(keep: number): number }>;
  /** The shared session broker: real retained-record count + a real GC/truncate trim. */
  readonly sessionBroker: { retainedRecordCount(): number; trimRetained(level: 'floor' | 'flush'): void };
}

/**
 * Build and start the daemon's memory governance with REAL cache adapters:
 * every registered cache exposes a genuine retained-entry count and a trim that
 * actually reclaims (knowledge job-run history pruning, session broker GC +
 * bucket truncation). Caches with no reachable real adapter are NOT registered
 * — a no-op registration would make the governor's shed tiers theater and the
 * tripwire's "flush didn't help" note vacuous.
 */
export function wireDaemonMemoryGovernance(options: DaemonMemoryGovernanceOptions): MemoryGovernanceHandles {
  const caches: Array<{ id: MemoryCacheId; cache: RegisteredCache }> = [
    {
      id: 'knowledge-store',
      cache: {
        name: 'knowledge stores (regular + agent + home-graph)',
        entryCount: () => options.knowledgeStores.reduce((sum, store) => sum + store.retainedEntryCount(), 0),
        trim: (level) => {
          // Real reclaim: prune the retained job-run history (Map + sqlite
          // rows). Floor keeps a short recent history; flush keeps only
          // active runs. Authoritative source/node mirrors are never dropped.
          const keep = level === 'flush' ? 0 : 50;
          for (const store of options.knowledgeStores) store.pruneJobRuns(keep);
        },
      },
    },
    {
      id: 'session-union',
      cache: {
        name: 'shared session broker (sessions + message/input buckets)',
        entryCount: () => options.sessionBroker.retainedRecordCount(),
        trim: (level) => options.sessionBroker.trimRetained(level),
      },
    },
  ];
  return createMemoryGovernance({
    config: options.config,
    runtimeBus: options.runtimeBus,
    cacheRegistry: options.cacheRegistry,
    pauseController: options.pauseController,
    jobIds: options.jobIds,
    caches,
    receiptPath: options.receiptPath,
    onTripwireShutdown: options.onTripwireShutdown,
  });
}
