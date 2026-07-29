import { PersistentStore } from '../../state/persistent-store.js';
import { StoreWriteQueue } from '../../state/store-write-queue.js';
import type { AutomationJob } from '../jobs.js';
import { resolveAutomationStorePath, type AutomationStorePathConfig } from './paths.js';

interface AutomationJobsSnapshot extends Record<string, unknown> {
  version: 1;
  jobs: AutomationJob[];
}

function defaultSnapshot(): AutomationJobsSnapshot {
  return {
    version: 1,
    jobs: [],
  };
}

function validateSnapshot(snapshot: AutomationJobsSnapshot | null): AutomationJobsSnapshot {
  if (!snapshot) return defaultSnapshot();
  if (snapshot.version !== 1 || !Array.isArray(snapshot.jobs)) {
    throw new Error('Automation jobs store snapshot is invalid.');
  }
  return {
    version: 1,
    jobs: snapshot.jobs,
  };
}

export interface AutomationJobStoreConfig {
  readonly path?: string | undefined;
  readonly configManager?: AutomationStorePathConfig | undefined;
}

export class AutomationJobStore {
  private readonly store: PersistentStore<AutomationJobsSnapshot>;
  /** Whole-file writes run one at a time, in call order. See StoreWriteQueue. */
  private readonly writes = new StoreWriteQueue();

  constructor(config: string | AutomationJobStoreConfig = {}) {
    const path = typeof config === 'string'
      ? config
      : config.path ?? resolveAutomationStorePath('automation-jobs.json', config.configManager ?? {});
    this.store = new PersistentStore<AutomationJobsSnapshot>(path);
  }

  async load(): Promise<AutomationJobsSnapshot> {
    return validateSnapshot(await this.store.load());
  }

  /**
   * Replace the file with `jobs` as they are at THIS call, after every write
   * already queued has finished.
   *
   * `PersistentStore.persist` is atomic but unordered, and this file has four
   * concurrent writers by design: `automation.maxConcurrentRuns` defaults to 4,
   * and every run's start, finish, failure-count update and schedule advance
   * saves the whole job map. Unordered, a long write started by one run could
   * land after a shorter one started later and put its older view of the jobs
   * back on disk. The snapshot is taken here rather than deferred to write
   * time, because callers mutate their map and then save, so each snapshot is
   * at least as new as the one queued before it.
   */
  async save(jobs: readonly AutomationJob[]): Promise<void> {
    const snapshot: AutomationJobsSnapshot = { version: 1, jobs: [...jobs] };
    await this.writes.run(() => this.store.persist(snapshot));
  }
}
