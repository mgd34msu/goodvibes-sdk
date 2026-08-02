import { resolveSharedDirectory } from '../runtime/surface-root.js';
import { readJsonFileOrQuarantine, writeJsonFileAtomic } from '../utils/atomic-json-store.js';
import type { WatcherRecord } from '../runtime/store/domains/watchers.js';

export interface WatcherStoreSnapshot {
  readonly version: 1;
  readonly watchers: readonly WatcherRecord[];
}

/**
 * What the `.why` receipt tells a human who finds a quarantined watcher
 * snapshot: nothing needs doing, the state comes back on its own.
 */
const WATCHER_STORE_RECOVERY =
  'Watcher state rebuilds from live registrations on the next load (daemon boot, daemon tick, or a client reconnect) — nothing further is required.';

function sortWatchers(watchers: readonly WatcherRecord[]): WatcherRecord[] {
  return [...watchers].sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

export function getWatcherStorePath(rootPath: string): string {
  return resolveSharedDirectory(rootPath, 'watchers.json');
}

export function resolveWatcherStorePath(storePath?: string): string {
  if (!storePath) {
    throw new Error('Watcher store requires an explicit storePath');
  }
  return storePath;
}

export function loadWatcherSnapshot(storePath: string): WatcherStoreSnapshot | null {
  return loadWatcherSnapshotFromPath(storePath);
}

/**
 * Load a watcher store snapshot, never throwing on a corrupt file.
 *
 * A file this reader cannot trust — unparseable JSON, a torn/zero-tailed
 * write, or the wrong shape — is moved aside by the shared quarantine helper
 * with a `.why` receipt, and this returns null exactly as it does for "no
 * snapshot yet". Callers (daemon boot, daemon tick, TUI, agent) all rebuild
 * watcher state from live registrations on a null return, so a corrupt
 * snapshot degrades to an empty one instead of crash-looping the reader.
 */
export function loadWatcherSnapshotFromPath(storePath: string): WatcherStoreSnapshot | null {
  return readJsonFileOrQuarantine<WatcherStoreSnapshot>(storePath, {
    label: 'watchers/store',
    recovery: WATCHER_STORE_RECOVERY,
    validate: (parsed) => {
      const snapshot = parsed as Partial<WatcherStoreSnapshot> | null;
      if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.watchers)) {
        throw new Error('snapshot is missing the expected version 1 shape or a watchers array');
      }
      const watchers = snapshot.watchers.filter((record): record is WatcherRecord => Boolean(record && typeof record.id === 'string'));
      if (watchers.length !== snapshot.watchers.length) {
        throw new Error('snapshot contains one or more malformed watcher records');
      }
      return { version: 1, watchers };
    },
  });
}

export function saveWatcherSnapshot(watchers: readonly WatcherRecord[], storePath: string): void {
  saveWatcherSnapshotToPath(watchers, storePath);
}

/**
 * Save a watcher store snapshot atomically via the shared helper: temp file
 * beside the target, fsync, rename over it, stale-temp sweep first. A reader —
 * or a process that dies mid-write — only ever sees a complete snapshot.
 */
export function saveWatcherSnapshotToPath(watchers: readonly WatcherRecord[], storePath: string): void {
  const snapshot: WatcherStoreSnapshot = {
    version: 1,
    watchers: sortWatchers(watchers),
  };
  writeJsonFileAtomic(storePath, snapshot);
}
