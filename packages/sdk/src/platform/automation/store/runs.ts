import { PersistentStore } from '../../state/persistent-store.js';
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

  constructor(config: string | AutomationRunStoreConfig = {}) {
    const path = typeof config === 'string'
      ? config
      : config.path ?? resolveAutomationStorePath('automation-runs.json', config.configManager ?? {});
    this.store = new PersistentStore<AutomationRunsSnapshot>(path);
  }

  async load(): Promise<AutomationRunsSnapshot> {
    return validateSnapshot(await this.store.load());
  }

  async save(runs: readonly AutomationRun[]): Promise<void> {
    await this.store.persist({
      version: 1,
      runs: [...runs],
    });
  }
}
