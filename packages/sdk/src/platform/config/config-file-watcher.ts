/**
 * config-file-watcher.ts — poll-based watch over a set of settings files.
 *
 * ConfigManager uses this to apply EXTERNAL edits live: a settings file changed
 * by another process or by hand fires `onChange`, which reloads and diffs. Uses
 * watchFile polling (not fs.watch) so it is robust to both in-place writes and
 * atomic save-via-rename — the failure mode the custom-provider fs.watch note
 * calls out. Kept out of manager.ts so that file stays under the line cap.
 */
import { unwatchFile, watchFile, type Stats } from 'node:fs';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

/** A running watch over one or more config files; call stop() to release it. */
export interface ConfigFileWatchHandle {
  stop(): void;
}

/**
 * Watch each path for content changes (mtime or size), invoking `onChange` on a
 * real change. A deleted file (size 0, mtime 0) still fires so the reader can
 * fall back to defaults. Duplicate paths are watched once.
 */
export function watchConfigFiles(
  paths: readonly string[],
  onChange: () => void,
  intervalMs = 250,
): ConfigFileWatchHandle {
  const listeners = new Map<string, (curr: Stats, prev: Stats) => void>();
  for (const path of paths) {
    if (!path || listeners.has(path)) continue;
    const listener = (curr: Stats, prev: Stats): void => {
      if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return;
      onChange();
    };
    const watcher = watchFile(path, { interval: intervalMs }, listener);
    // Never pin the event loop: an idle process must be able to exit even
    // when the composition root left the watch running (same posture as the
    // fleet registry's unref'd tick).
    (watcher as { unref?: () => void }).unref?.();
    listeners.set(path, listener);
  }
  return {
    stop(): void {
      for (const [path, listener] of listeners) {
        try {
          unwatchFile(path, listener);
        } catch (error) {
          logger.warn('Config file unwatch failed', { path, error: summarizeError(error) });
        }
      }
      listeners.clear();
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
 * key whose value actually changed — so an in-process set() that already
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
