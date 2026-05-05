import { PersistentStore } from '../../state/persistent-store.js';
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

  constructor(config: string | AutomationRouteStoreConfig = {}) {
    const path = typeof config === 'string'
      ? config
      : config.path ?? resolveAutomationStorePath('automation-routes.json', config.configManager ?? {});
    this.store = new PersistentStore<AutomationRoutesSnapshot>(path);
  }

  async load(): Promise<AutomationRoutesSnapshot> {
    return validateSnapshot(await this.store.load());
  }

  async save(routes: readonly AutomationRouteBinding[]): Promise<void> {
    await this.store.persist({
      version: 1,
      routes: [...routes],
    });
  }
}
