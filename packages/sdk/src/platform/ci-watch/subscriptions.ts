/**
 * ci-watch/subscriptions.ts
 *
 * Durable storage for standing CI watches, over the same PersistentStore
 * snapshot pattern the other registries use.
 */
import { PersistentStore } from '../state/persistent-store.js';
import type { CiWatchSubscription } from './types.js';

interface CiWatchSnapshot extends Record<string, unknown> {
  version: 1;
  subscriptions: CiWatchSubscription[];
}

function validateSnapshot(snapshot: CiWatchSnapshot | null): CiWatchSnapshot {
  if (!snapshot) return { version: 1, subscriptions: [] };
  if (snapshot.version !== 1 || !Array.isArray(snapshot.subscriptions)) {
    throw new Error('CI watch store snapshot is invalid.');
  }
  return { version: 1, subscriptions: snapshot.subscriptions };
}

export class CiWatchStore {
  private readonly store: PersistentStore<CiWatchSnapshot>;

  constructor(path: string) {
    this.store = new PersistentStore<CiWatchSnapshot>(path);
  }

  async load(): Promise<CiWatchSubscription[]> {
    return validateSnapshot(await this.store.load()).subscriptions;
  }

  async save(subscriptions: readonly CiWatchSubscription[]): Promise<void> {
    await this.store.persist({ version: 1, subscriptions: [...subscriptions] });
  }
}
