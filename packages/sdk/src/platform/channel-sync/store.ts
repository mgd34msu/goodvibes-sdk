/**
 * channel-sync/store.ts
 *
 * Durable JSON-snapshot persistence for the two mirrored channel tables,
 * following the same PersistentStore snapshot pattern the channel-profile,
 * automation and principal stores use.
 *
 * One file for both tables because they share a lifetime and a reason to
 * exist: they are what a surface needs to draw the same channel screen on a
 * second device. A malformed snapshot is refused rather than silently reset —
 * `PersistentStore` keeps the file, so a store that cannot be read is a fault
 * an operator can still recover from by hand.
 */
import { PersistentStore } from '../state/persistent-store.js';
import type { ChannelDraft, ChannelRoutingRule } from './types.js';

interface ChannelSyncSnapshot extends Record<string, unknown> {
  version: 1;
  routes: ChannelRoutingRule[];
  drafts: ChannelDraft[];
}

export interface ChannelSyncTables {
  readonly routes: ChannelRoutingRule[];
  readonly drafts: ChannelDraft[];
}

function defaultSnapshot(): ChannelSyncSnapshot {
  return { version: 1, routes: [], drafts: [] };
}

function validateSnapshot(snapshot: ChannelSyncSnapshot | null): ChannelSyncSnapshot {
  if (!snapshot) return defaultSnapshot();
  if (snapshot.version !== 1 || !Array.isArray(snapshot.routes) || !Array.isArray(snapshot.drafts)) {
    throw new Error('Channel sync store snapshot is invalid.');
  }
  return { version: 1, routes: snapshot.routes, drafts: snapshot.drafts };
}

export class ChannelSyncStore {
  private readonly store: PersistentStore<ChannelSyncSnapshot>;

  constructor(path: string) {
    this.store = new PersistentStore<ChannelSyncSnapshot>(path);
  }

  async load(): Promise<ChannelSyncTables> {
    const snapshot = validateSnapshot(await this.store.load());
    return { routes: snapshot.routes, drafts: snapshot.drafts };
  }

  async save(tables: ChannelSyncTables): Promise<void> {
    await this.store.persist({ version: 1, routes: [...tables.routes], drafts: [...tables.drafts] });
  }
}
