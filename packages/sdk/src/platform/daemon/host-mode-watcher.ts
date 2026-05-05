/**
 * host-mode-watcher.ts
 *
 * Shared helper that creates a config-key watcher for host-mode restart logic.
 * Extracted so the restart guard + dirty-flag loop-back pattern can be tested
 * independently of DaemonServer or HttpListener.
 *
 * Both facade.ts and http-listener.ts delegate to this helper, passing their
 * own `onRestart` closure and `getIsRunning` accessor.
 */

import type { ConfigManager } from '../config/manager.js';
import type { ConfigKey } from '../config/schema.js';

export interface HostModeWatcherOptions {
  /** The ConfigManager to subscribe on. */
  configManager: ConfigManager;
  /** Config keys that should trigger a restart when changed. */
  keys: ConfigKey[];
  /**
   * Called when a key change is detected and the server is running.
   * The implementation is responsible for performing stop + restart.
   * The caller is responsible for re-entrancy / dirty-flag semantics: if a
   * new change arrives while a prior restart is in progress, `onRestart`
   * will be invoked again. The caller must either guard against overlapping
   * cycles or queue the second cycle via its own dirty-flag mechanism.
   */
  onRestart: () => void;
  /** Returns true when the server/listener is currently running. */
  getIsRunning: () => boolean;
}

export interface HostModeWatcherHandle {
  /** Detach all subscriptions — safe to call multiple times. */
  unsubscribe: () => void;
}

/**
 * Create a host-mode restart watcher.
 *
 * Behaviour:
 * - Subscribes to each key in `keys`.
 * - When a key changes and `getIsRunning()` is true, calls `onRestart()`.
 * - The caller's `onRestart` implementation handles re-entrancy / dirty-flag
 *   logic internally (the watcher does NOT duplicate that logic).
 * - `unsubscribe()` removes all subscriptions; subsequent key changes do not
 *   trigger restarts.
 *
 * @param opts - Watcher configuration.
 * @returns A handle with an `unsubscribe` method.
 */
export function createHostModeRestartWatcher(opts: HostModeWatcherOptions): HostModeWatcherHandle {
  const { configManager, keys, onRestart, getIsRunning } = opts;

  const listener = (): void => {
    if (!getIsRunning()) return;
    onRestart();
  };

  const unsubs = keys.map((key) => configManager.subscribe(key, listener));

  return {
    unsubscribe: () => {
      for (const u of unsubs) u();
      // Clear the array so subsequent calls are no-ops.
      unsubs.length = 0;
    },
  };
}
