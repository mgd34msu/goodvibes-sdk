/**
 * feature-flag-config-apply.test.ts
 *
 * Covers FeatureFlagManager.applyConfigState() and bindFeatureFlagConfigBridge()
 * — the live config -> flag-manager bridge. Before this, a
 * configManager.set('featureFlags.<id>', ...) call after boot persisted to
 * disk but never reached the manager until process restart (services.ts only
 * called loadFromConfig() once, at construction).
 *
 * Unit-level: exercises applyConfigState()/loadFromConfig() directly against
 * a real FeatureFlagManager, plus bindFeatureFlagConfigBridge() against a
 * minimal fake ConfigManager (just the `subscribe` surface it needs) so the
 * subscription wiring itself is proven without constructing a full
 * RuntimeServices. The end-to-end wiring through createRuntimeServices is
 * covered separately in feature-flag-config-bridge-services.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { createFeatureFlagManager } from '../packages/sdk/src/platform/runtime/feature-flags/manager.js';
import { bindFeatureFlagConfigBridge } from '../packages/sdk/src/platform/runtime/feature-flags/config-bridge.js';
import { FEATURE_FLAG_MAP } from '../packages/sdk/src/platform/runtime/feature-flags/flags.js';
import type { FlagState } from '../packages/sdk/src/platform/runtime/feature-flags/types.js';

// A runtime-toggleable flag and a startup-gated (runtimeToggleable: false)
// flag, both defaulting to 'disabled' — picked from the real registry so
// this test tracks the actual flag declarations, not a stand-in.
const TOGGLEABLE_FLAG_ID = 'hitl-ux-modes';
const STARTUP_GATED_FLAG_ID = 'permissions-policy-engine';

function requireKnownFlag(id: string): void {
  if (!FEATURE_FLAG_MAP.has(id)) throw new Error(`test fixture flag "${id}" is no longer in the registry`);
}

requireKnownFlag(TOGGLEABLE_FLAG_ID);
requireKnownFlag(STARTUP_GATED_FLAG_ID);

/** Minimal fake ConfigManager: only the `subscribe` surface the bridge needs. */
function fakeConfigManager() {
  const listeners = new Map<string, Set<(newVal: unknown, oldVal: unknown) => void>>();
  return {
    subscribe(key: string, cb: (newVal: unknown, oldVal: unknown) => void) {
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key)!.add(cb);
      return () => {
        listeners.get(key)?.delete(cb);
      };
    },
    /** Simulates configManager.set('featureFlags.<id>', value) firing subscribers. */
    fireSet(key: string, newVal: unknown, oldVal: unknown) {
      for (const cb of listeners.get(key) ?? []) cb(newVal, oldVal);
    },
    listenerCount(key: string): number {
      return listeners.get(key)?.size ?? 0;
    },
  };
}

describe('FeatureFlagManager.applyConfigState — direct unit coverage', () => {
  test('runtime-toggleable flag: applies live and notifies subscribers', () => {
    const manager = createFeatureFlagManager();
    const seen: Array<{ flagId: string; state: FlagState; previous: FlagState }> = [];
    manager.subscribe((flagId, state, previous) => {
      seen.push({ flagId, state, previous });
    });

    expect(manager.getState(TOGGLEABLE_FLAG_ID)).toBe('disabled');
    manager.applyConfigState(TOGGLEABLE_FLAG_ID, 'enabled');

    expect(manager.getState(TOGGLEABLE_FLAG_ID)).toBe('enabled');
    expect(manager.isEnabled(TOGGLEABLE_FLAG_ID)).toBe(true);
    expect(seen).toEqual([{ flagId: TOGGLEABLE_FLAG_ID, state: 'enabled', previous: 'disabled' }]);
    expect(manager.hasPendingRestart(TOGGLEABLE_FLAG_ID)).toBe(false);
  });

  test('startup-gated flag: does not change effective state, records pending-restart', () => {
    const manager = createFeatureFlagManager();
    const seen: unknown[] = [];
    manager.subscribe((flagId, state, previous) => seen.push({ flagId, state, previous }));

    expect(manager.getState(STARTUP_GATED_FLAG_ID)).toBe('disabled');
    manager.applyConfigState(STARTUP_GATED_FLAG_ID, 'enabled');

    // Effective state is untouched — no fake live apply for a startup-only flag.
    expect(manager.getState(STARTUP_GATED_FLAG_ID)).toBe('disabled');
    expect(manager.isEnabled(STARTUP_GATED_FLAG_ID)).toBe(false);
    // No transition fired — nothing actually changed.
    expect(seen).toEqual([]);

    // But the divergence is honestly visible on the snapshot/read surface.
    expect(manager.hasPendingRestart(STARTUP_GATED_FLAG_ID)).toBe(true);
    expect(manager.getPendingRestartState(STARTUP_GATED_FLAG_ID)).toBe('enabled');
    const snapshot = manager.getAll().get(STARTUP_GATED_FLAG_ID);
    expect(snapshot).toMatchObject({ state: 'disabled', persistedState: 'enabled', pendingRestart: true });
  });

  test('startup-gated flag: pending-restart clears once persisted value matches effective state again', () => {
    const manager = createFeatureFlagManager();
    manager.applyConfigState(STARTUP_GATED_FLAG_ID, 'enabled');
    expect(manager.hasPendingRestart(STARTUP_GATED_FLAG_ID)).toBe(true);

    manager.applyConfigState(STARTUP_GATED_FLAG_ID, 'disabled');
    expect(manager.hasPendingRestart(STARTUP_GATED_FLAG_ID)).toBe(false);
    expect(manager.getPendingRestartState(STARTUP_GATED_FLAG_ID)).toBeNull();
  });

  test('killed semantics still follow the manager\'s existing kill-precedence rules via applyConfigState', () => {
    const manager = createFeatureFlagManager();
    manager.applyConfigState(TOGGLEABLE_FLAG_ID, 'killed');
    expect(manager.getState(TOGGLEABLE_FLAG_ID)).toBe('killed');

    // Config trying to re-enable a killed flag is a no-op — kill takes precedence,
    // same as loadFromConfig's existing behavior.
    manager.applyConfigState(TOGGLEABLE_FLAG_ID, 'enabled');
    expect(manager.getState(TOGGLEABLE_FLAG_ID)).toBe('killed');
  });

  test('loadFromConfig (boot path) behavior is unchanged after the applyConfigState refactor', () => {
    const manager = createFeatureFlagManager();
    // Startup-gated flags ARE seeded directly at boot (loadFromConfig runs
    // before the runtime event loop begins) — unlike a live applyConfigState call.
    manager.loadFromConfig({ flags: { [STARTUP_GATED_FLAG_ID]: 'enabled', [TOGGLEABLE_FLAG_ID]: 'enabled' } });
    expect(manager.getState(STARTUP_GATED_FLAG_ID)).toBe('enabled');
    expect(manager.getState(TOGGLEABLE_FLAG_ID)).toBe('enabled');
    expect(manager.hasPendingRestart(STARTUP_GATED_FLAG_ID)).toBe(false);

    // Unknown flag id still throws, same as before.
    expect(() => manager.loadFromConfig({ flags: { 'not-a-real-flag': 'enabled' } })).toThrow();
  });
});

describe('bindFeatureFlagConfigBridge — subscription wiring', () => {
  test('subscribes one listener per registered flag id and applies a live change', () => {
    const configManager = fakeConfigManager();
    const manager = createFeatureFlagManager();
    const unsubscribe = bindFeatureFlagConfigBridge(configManager, manager);

    expect(configManager.listenerCount(`featureFlags.${TOGGLEABLE_FLAG_ID}`)).toBe(1);

    configManager.fireSet(`featureFlags.${TOGGLEABLE_FLAG_ID}`, 'enabled', 'disabled');
    expect(manager.isEnabled(TOGGLEABLE_FLAG_ID)).toBe(true);

    configManager.fireSet(`featureFlags.${STARTUP_GATED_FLAG_ID}`, 'enabled', 'disabled');
    expect(manager.isEnabled(STARTUP_GATED_FLAG_ID)).toBe(false);
    expect(manager.hasPendingRestart(STARTUP_GATED_FLAG_ID)).toBe(true);

    unsubscribe();
    configManager.fireSet(`featureFlags.${TOGGLEABLE_FLAG_ID}`, 'disabled', 'enabled');
    // After unsubscribe, further config changes no longer reach the manager.
    expect(manager.isEnabled(TOGGLEABLE_FLAG_ID)).toBe(true);
  });

  test('ignores a malformed persisted value instead of throwing', () => {
    const configManager = fakeConfigManager();
    const manager = createFeatureFlagManager();
    bindFeatureFlagConfigBridge(configManager, manager);

    expect(() => configManager.fireSet(`featureFlags.${TOGGLEABLE_FLAG_ID}`, 'not-a-real-state', 'disabled'))
      .not.toThrow();
    expect(manager.getState(TOGGLEABLE_FLAG_ID)).toBe('disabled');
  });
});
