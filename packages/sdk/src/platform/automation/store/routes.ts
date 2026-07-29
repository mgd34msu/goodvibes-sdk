import { PersistentStore } from '../../state/persistent-store.js';
import { StoreWriteQueue } from '../../state/store-write-queue.js';
import type { AutomationRouteBinding } from '../routes.js';
import { resolveAutomationStorePath, type AutomationStorePathConfig } from './paths.js';

interface AutomationRoutesSnapshot extends Record<string, unknown> {
  version: 1;
  routes: AutomationRouteBinding[];
}

function defaultSnapshot(): AutomationRoutesSnapshot {
  return {
    version: 1,
    routes: [],
  };
}

function validateSnapshot(snapshot: AutomationRoutesSnapshot | null): AutomationRoutesSnapshot {
  if (!snapshot) return defaultSnapshot();
  if (snapshot.version !== 1 || !Array.isArray(snapshot.routes)) {
    throw new Error('Automation routes store snapshot is invalid.');
  }
  return {
    version: 1,
    routes: snapshot.routes,
  };
}

export interface AutomationRouteStoreConfig {
  readonly path?: string | undefined;
  readonly configManager?: AutomationStorePathConfig | undefined;
}

export class AutomationRouteStore {
  private readonly store: PersistentStore<AutomationRoutesSnapshot>;
  /** Whole-file writes run one at a time, in call order. See StoreWriteQueue. */
  private readonly writes = new StoreWriteQueue();

  constructor(config: string | AutomationRouteStoreConfig = {}) {
    const path = typeof config === 'string'
      ? config
      : config.path ?? resolveAutomationStorePath('automation-routes.json', config.configManager ?? {});
    this.store = new PersistentStore<AutomationRoutesSnapshot>(path);
  }

  async load(): Promise<AutomationRoutesSnapshot> {
    return validateSnapshot(await this.store.load());
  }

  /**
   * Replace the file with `routes` as they are at THIS call, after every write
   * already queued has finished. Ordering, not the snapshot point, is what was
   * missing: `PersistentStore.persist` is atomic but says nothing about which
   * of two in-flight writes lands last, and `AutomationService.upsertRun`,
   * `upsertRoute` and `removeJob` all rewrite this whole file.
   */
  async save(routes: readonly AutomationRouteBinding[]): Promise<void> {
    const snapshot: AutomationRoutesSnapshot = { version: 1, routes: [...routes] };
    await this.writes.run(() => this.store.persist(snapshot));
  }
}
