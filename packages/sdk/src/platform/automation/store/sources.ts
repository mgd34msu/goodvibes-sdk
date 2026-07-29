import { PersistentStore } from '../../state/persistent-store.js';
import { StoreWriteQueue } from '../../state/store-write-queue.js';
import type { AutomationSourceRecord } from '../sources.js';
import { resolveAutomationStorePath, type AutomationStorePathConfig } from './paths.js';

interface AutomationSourcesSnapshot extends Record<string, unknown> {
  version: 1;
  sources: AutomationSourceRecord[];
}

function defaultSnapshot(): AutomationSourcesSnapshot {
  return {
    version: 1,
    sources: [],
  };
}

function validateSnapshot(snapshot: AutomationSourcesSnapshot | null): AutomationSourcesSnapshot {
  if (!snapshot) return defaultSnapshot();
  if (snapshot.version !== 1 || !Array.isArray(snapshot.sources)) {
    throw new Error('Automation sources store snapshot is invalid.');
  }
  return {
    version: 1,
    sources: snapshot.sources,
  };
}

export interface AutomationSourceStoreConfig {
  readonly path?: string | undefined;
  readonly configManager?: AutomationStorePathConfig | undefined;
}

export class AutomationSourceStore {
  private readonly store: PersistentStore<AutomationSourcesSnapshot>;
  /** Whole-file writes run one at a time, in call order. See StoreWriteQueue. */
  private readonly writes = new StoreWriteQueue();

  constructor(config: string | AutomationSourceStoreConfig = {}) {
    const path = typeof config === 'string'
      ? config
      : config.path ?? resolveAutomationStorePath('automation-sources.json', config.configManager ?? {});
    this.store = new PersistentStore<AutomationSourcesSnapshot>(path);
  }

  async load(): Promise<AutomationSourcesSnapshot> {
    return validateSnapshot(await this.store.load());
  }

  /**
   * Replace the file with `sources` as they are at THIS call, after every write
   * already queued has finished. Ordering, not the snapshot point, is what was
   * missing: `AutomationService.upsertJob`, `upsertRun` and `upsertSource` all
   * rewrite this whole file, and `PersistentStore.persist` is atomic but
   * unordered.
   */
  async save(sources: readonly AutomationSourceRecord[]): Promise<void> {
    const snapshot: AutomationSourcesSnapshot = { version: 1, sources: [...sources] };
    await this.writes.run(() => this.store.persist(snapshot));
  }
}
