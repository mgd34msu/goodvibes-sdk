import { PersistentStore } from '../../state/persistent-store.js';
import { StoreWriteQueue } from '../../state/store-write-queue.js';
import type { AutomationRun } from '../runs.js';
import { resolveAutomationStorePath, type AutomationStorePathConfig } from './paths.js';

interface AutomationRunsSnapshot extends Record<string, unknown> {
  version: 1;
  runs: AutomationRun[];
}

function defaultSnapshot(): AutomationRunsSnapshot {
  return {
    version: 1,
    runs: [],
  };
}

function validateSnapshot(snapshot: AutomationRunsSnapshot | null): AutomationRunsSnapshot {
  if (!snapshot) return defaultSnapshot();
  if (snapshot.version !== 1 || !Array.isArray(snapshot.runs)) {
    throw new Error('Automation runs store snapshot is invalid.');
  }
  return {
    version: 1,
    runs: snapshot.runs,
  };
}

export interface AutomationRunStoreConfig {
  readonly path?: string | undefined;
  readonly configManager?: AutomationStorePathConfig | undefined;
}

export class AutomationRunStore {
  private readonly store: PersistentStore<AutomationRunsSnapshot>;
  /** Whole-file writes run one at a time, in call order. See StoreWriteQueue. */
  private readonly writes = new StoreWriteQueue();

  constructor(config: string | AutomationRunStoreConfig = {}) {
    const path = typeof config === 'string'
      ? config
      : config.path ?? resolveAutomationStorePath('automation-runs.json', config.configManager ?? {});
    this.store = new PersistentStore<AutomationRunsSnapshot>(path);
  }

  async load(): Promise<AutomationRunsSnapshot> {
    return validateSnapshot(await this.store.load());
  }

  /**
   * Replace the file with `runs` as they are at THIS call, after every write
   * already queued has finished.
   *
   * `PersistentStore.persist` is atomic but unordered, and the run store is
   * written by every concurrent run (`automation.maxConcurrentRuns` defaults to
   * 4) plus the 2-second reconcile timer. Unordered, a write started while a
   * run was still 'running' could land after the write that recorded it
   * 'completed', so the completed run reads back as running; the reconciler
   * then treats it as work that never finished and executes the job again. The
   * snapshot is taken here rather than at write time, because callers mutate
   * their map and then save.
   */
  async save(runs: readonly AutomationRun[]): Promise<void> {
    const snapshot: AutomationRunsSnapshot = { version: 1, runs: [...runs] };
    await this.writes.run(() => this.store.persist(snapshot));
  }
}
