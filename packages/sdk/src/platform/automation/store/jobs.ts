import { PersistentStore } from '../../state/persistent-store.js';
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

  constructor(config: string | AutomationJobStoreConfig = {}) {
    const path = typeof config === 'string'
      ? config
      : config.path ?? resolveAutomationStorePath('automation-jobs.json', config.configManager ?? {});
    this.store = new PersistentStore<AutomationJobsSnapshot>(path);
  }

  async load(): Promise<AutomationJobsSnapshot> {
    return validateSnapshot(await this.store.load());
  }

  async save(jobs: readonly AutomationJob[]): Promise<void> {
    await this.store.persist({
      version: 1,
      jobs: [...jobs],
    });
  }
}
