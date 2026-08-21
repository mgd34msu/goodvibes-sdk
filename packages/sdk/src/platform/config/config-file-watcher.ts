/**
 * config-file-watcher.ts, poll-based watch over a set of settings files.
 *
 * ConfigManager uses this to apply EXTERNAL edits live: a settings file changed
 * by another process or by hand fires `onChange`, which reloads and diffs. Polls
 * with statSync (not fs.watch) so it is robust to both in-place writes and
 * atomic save-via-rename, the failure mode the custom-provider fs.watch note
 * calls out. Kept out of manager.ts so that file stays under the line cap.
 *
 * Why this does NOT use fs.watchFile
 * ----------------------------------
 * watchFile establishes its own "previous stat" baseline ASYNCHRONOUSLY, after
 * the call returns, and only invokes the listener when a later poll differs
 * from that baseline. A write that lands between the watchFile() call and the
 * baseline stat therefore BECOMES the baseline: watchFile sees no subsequent
 * change and never fires, so the edit is silently lost for the lifetime of the
 * watch. That is not a slow-machine flake, the watcher stays silent forever.
 *
 * This module removes the race by construction: it takes each file's baseline
 * SYNCHRONOUSLY, before the watch is armed, and every poll compares against
 * that self-owned baseline instead of a baseline the runtime captured at an
 * unknown later moment. A write landing at any point after the synchronous
 * baseline, including during watcher startup, differs from it and fires.
 */
import { statSync } from 'node:fs';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

/** A running watch over one or more config files; call stop() to release it. */
export interface ConfigFileWatchHandle {
  stop(): void;
}

/** The stat fields the watcher treats as content identity for one path. */
interface FileSnapshot {
  readonly mtimeMs: number;
  readonly size: number;
  readonly exists: boolean;
}

/**
 * Snapshot one path. A missing file is a real state (zeros, exists=false), not
 * an error: creating or deleting a settings file is a change the reader must
 * see so it can fall back to, or move off, defaults.
 */
function readSnapshot(path: string): FileSnapshot {
  try {
    const stats = statSync(path);
    return { mtimeMs: stats.mtimeMs, size: stats.size, exists: true };
  } catch {
    return { mtimeMs: 0, size: 0, exists: false };
  }
}

function sameSnapshot(a: FileSnapshot, b: FileSnapshot): boolean {
  return a.mtimeMs === b.mtimeMs && a.size === b.size && a.exists === b.exists;
}

/**
 * Watch each path for content changes (mtime, size, or existence), invoking
 * `onChange` once per poll in which at least one watched path changed.
 * Duplicate paths are watched once.
 */
export function watchConfigFiles(
  paths: readonly string[],
  onChange: () => void,
  intervalMs = 250,
): ConfigFileWatchHandle {
  // Baselines are captured synchronously HERE, before any polling is armed, so
  // no write can slip in behind an asynchronously-established baseline.
  const baselines = new Map<string, FileSnapshot>();
  for (const path of paths) {
    if (!path || baselines.has(path)) continue;
    baselines.set(path, readSnapshot(path));
  }
  if (baselines.size === 0) return { stop(): void { /* nothing watched */ } };

  let stopped = false;
  const poll = (): void => {
    if (stopped) return;
    let changed = false;
    for (const [path, previous] of baselines) {
      const current = readSnapshot(path);
      if (sameSnapshot(previous, current)) continue;
      baselines.set(path, current);
      changed = true;
    }
    // One notification per tick even when several files moved together: the
    // reload is a whole-config diff, so per-path fan-out would only re-do it.
    if (changed) onChange();
  };

  const timer = setInterval(poll, Math.max(1, intervalMs));
  // Never pin the event loop: an idle process must be able to exit even
  // when the composition root left the watch running (same posture as the
  // fleet registry's unref'd tick).
  (timer as unknown as { unref?: () => void }).unref?.();

  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
      baselines.clear();
    },
  };
}

/** Injectable dependencies for reloadAndNotifyChanges (ConfigManager provides these). */
export interface ReloadDeps {
  readonly listenerKeys: Iterable<string>;
  readonly get: (key: string) => unknown;
  readonly load: () => void;
  readonly notify: (key: string, oldValue: unknown, newValue: unknown) => void;
}

/**
 * Snapshot every subscribed key, reload from disk, then fire `notify` for each
 * key whose value actually changed, so an in-process set() that already
 * notified does not double-fire (its value is unchanged on reload), and an
 * external edit reaches subscribers exactly once. A failed reload keeps the
 * in-memory config and notifies nobody.
 */
export function reloadAndNotifyChanges(deps: ReloadDeps): void {
  const before = new Map<string, unknown>();
  for (const key of deps.listenerKeys) {
    try {
      before.set(key, structuredClone(deps.get(key)));
    } catch {
      before.set(key, undefined);
    }
  }
  try {
    deps.load();
  } catch (error) {
    logger.warn('Config live reload failed; keeping in-memory config', { error: summarizeError(error) });
    return;
  }
  for (const [key, oldValue] of before) {
    let newValue: unknown;
    try {
      newValue = deps.get(key);
    } catch {
      continue;
    }
    if (JSON.stringify(oldValue) === JSON.stringify(newValue)) continue;
    deps.notify(key, oldValue, newValue);
  }
}
