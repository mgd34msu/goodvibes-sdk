/**
 * feature-flag-config-apply.test.ts
 *
 * Covers FeatureFlagManager.applyConfigState() and bindFeatureSettingsBridge()
 * — the live settings -> gate-manager bridge. Every capability derives its
 * state from a per-domain settings key (see feature-settings.ts); a
 * configManager.set on a bound key after boot must reach the manager without
 * a restart for runtime-toggleable gates, and record an honest
 * pending-restart marker for startup-gated ones.
 *
 * Unit-level: exercises applyConfigState()/loadFromConfig() directly against
 * a real FeatureFlagManager, plus bindFeatureSettingsBridge() against a
 * minimal fake ConfigManager (just the `subscribe` surface it needs) so the
 * subscription wiring itself is proven without constructing a full
 * RuntimeServices. The end-to-end wiring through createRuntimeServices is
 * covered separately in feature-flag-config-bridge-services.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { createFeatureFlagManager } from '../packages/sdk/src/platform/runtime/feature-flags/manager.js';
import {
  FEATURE_SETTINGS_BINDINGS,
  bindFeatureSettingsBridge,
  deriveFeatureState,
  deriveFeatureStates,
  getFeatureSettingsBinding,
} from '../packages/sdk/src/platform/runtime/feature-flags/feature-settings.js';
import { FEATURE_FLAG_MAP } from '../packages/sdk/src/platform/runtime/feature-flags/flags.js';
import type { FlagState } from '../packages/sdk/src/platform/runtime/feature-flags/types.js';

// A runtime-toggleable capability defaulting OFF and a startup-gated
// (runtimeToggleable: false) one defaulting OFF — picked from the real
// registry so this test tracks the actual declarations, not a stand-in.
const TOGGLEABLE_FLAG_ID = 'agent-passive-code-injection';
const TOGGLEABLE_KEY = 'agents.passiveInjection.code';
const STARTUP_GATED_FLAG_ID = 'permissions-policy-engine';
const STARTUP_GATED_KEY = 'permissions.engine';

function requireKnownFlag(id: string, expectedDefault: FlagState): void {
  const flag = FEATURE_FLAG_MAP.get(id);
  if (!flag) throw new Error(`test fixture capability "${id}" is no longer in the registry`);
  if (flag.defaultState !== expectedDefault) {
    throw new Error(`test fixture capability "${id}" no longer defaults ${expectedDefault}`);
  }
}

requireKnownFlag(TOGGLEABLE_FLAG_ID, 'disabled');
requireKnownFlag(STARTUP_GATED_FLAG_ID, 'disabled');

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
    /** Simulates configManager.set('<domain key>', value) firing subscribers. */
    fireSet(key: string, newVal: unknown, oldVal: unknown) {
      for (const cb of listeners.get(key) ?? []) cb(newVal, oldVal);
    },
    listenerCount(key: string): number {
      return listeners.get(key)?.size ?? 0;
    },
  };
}

describe('FeatureFlagManager.applyConfigState — direct unit coverage', () => {
  test('runtime-toggleable gate: applies live and notifies subscribers', () => {
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

  test('startup-gated gate: does not change effective state, records pending-restart', () => {
    const manager = createFeatureFlagManager();
    const seen: unknown[] = [];
    manager.subscribe((flagId, state, previous) => seen.push({ flagId, state, previous }));

    expect(manager.getState(STARTUP_GATED_FLAG_ID)).toBe('disabled');
    manager.applyConfigState(STARTUP_GATED_FLAG_ID, 'enabled');

    // Effective state is untouched — no fake live apply for a startup-only gate.
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

  test('startup-gated gate: pending-restart clears once persisted value matches effective state again', () => {
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

    // A derived enable can never silently resurrect a killed gate.
    manager.applyConfigState(TOGGLEABLE_FLAG_ID, 'enabled');
    expect(manager.getState(TOGGLEABLE_FLAG_ID)).toBe('killed');
  });

  test('loadFromConfig (boot path) seeds startup-gated gates directly', () => {
    const manager = createFeatureFlagManager();
    manager.loadFromConfig({ flags: { [STARTUP_GATED_FLAG_ID]: 'enabled', [TOGGLEABLE_FLAG_ID]: 'enabled' } });
    expect(manager.getState(STARTUP_GATED_FLAG_ID)).toBe('enabled');
    expect(manager.getState(TOGGLEABLE_FLAG_ID)).toBe('enabled');
    expect(manager.hasPendingRestart(STARTUP_GATED_FLAG_ID)).toBe(false);

    // Unknown id still throws, same as before.
    expect(() => manager.loadFromConfig({ flags: { 'not-a-real-flag': 'enabled' } })).toThrow();
  });
});

describe('feature-settings bindings — derivation', () => {
  test('every registry capability has exactly one binding', () => {
    expect(FEATURE_SETTINGS_BINDINGS.length).toBe(FEATURE_FLAG_MAP.size);
    for (const id of FEATURE_FLAG_MAP.keys()) {
      expect(getFeatureSettingsBinding(id)).not.toBeNull();
    }
  });

  test('boolean, enum, and constant bindings derive honestly', () => {
    const bool = getFeatureSettingsBinding(TOGGLEABLE_FLAG_ID)!;
    expect(deriveFeatureState(bool, true)).toBe('enabled');
    expect(deriveFeatureState(bool, false)).toBe('disabled');
    expect(deriveFeatureState(bool, 'junk')).toBe('disabled');

    const engine = getFeatureSettingsBinding(STARTUP_GATED_FLAG_ID)!;
    expect(deriveFeatureState(engine, 'policy-engine')).toBe('enabled');
    expect(deriveFeatureState(engine, 'baseline')).toBe('disabled');
    expect(deriveFeatureState(engine, 42)).toBe('disabled');

    const fetch = getFeatureSettingsBinding('fetch-sanitization')!;
    expect(fetch.kind).toBe('constant');
    expect(deriveFeatureState(fetch, 'none')).toBe('enabled');
  });

  test('deriveFeatureStates on registry defaults reproduces every defaultState', () => {
    // A fake config manager returning each binding key's schema default is the
    // stock-config boot; deriving from it must be a no-op against the registry.
    const { DEFAULT_CONFIG } = require('../packages/sdk/src/platform/config/schema.js') as
      typeof import('../packages/sdk/src/platform/config/schema.js');
    const fake = {
      get: (key: string) => key.split('.').reduce<unknown>(
        (cursor, segment) => (cursor as Record<string, unknown>)?.[segment],
        DEFAULT_CONFIG as unknown,
      ),
    };
    const states = deriveFeatureStates(fake as never);
    for (const [id, flag] of FEATURE_FLAG_MAP) {
      expect(`${id}:${states[id]}`).toBe(`${id}:${flag.defaultState}`);
    }
  });
});

describe('bindFeatureSettingsBridge — subscription wiring', () => {
  test('subscribes each bound settings key once and applies a live change', () => {
    const configManager = fakeConfigManager();
    const manager = createFeatureFlagManager();
    const unsubscribe = bindFeatureSettingsBridge(configManager, manager);

    expect(configManager.listenerCount(TOGGLEABLE_KEY)).toBe(1);

    configManager.fireSet(TOGGLEABLE_KEY, true, false);
    expect(manager.isEnabled(TOGGLEABLE_FLAG_ID)).toBe(true);

    configManager.fireSet(STARTUP_GATED_KEY, 'policy-engine', 'baseline');
    expect(manager.isEnabled(STARTUP_GATED_FLAG_ID)).toBe(false);
    expect(manager.hasPendingRestart(STARTUP_GATED_FLAG_ID)).toBe(true);

    unsubscribe();
    configManager.fireSet(TOGGLEABLE_KEY, false, true);
    // After unsubscribe, further settings changes no longer reach the manager.
    expect(manager.isEnabled(TOGGLEABLE_FLAG_ID)).toBe(true);
  });

  test('one settings key drives every capability bound to it', () => {
    const configManager = fakeConfigManager();
    const manager = createFeatureFlagManager();
    bindFeatureSettingsBridge(configManager, manager);

    // behavior.compactionStrategy carries both the compaction gate and the
    // distiller-strategy gate — one listener, two derived states.
    expect(configManager.listenerCount('behavior.compactionStrategy')).toBe(1);
    expect(manager.isEnabled('session-compaction')).toBe(true);
    expect(manager.isEnabled('compaction-distiller-strategy')).toBe(false);

    configManager.fireSet('behavior.compactionStrategy', 'distiller', 'structured');
    expect(manager.isEnabled('session-compaction')).toBe(true);
    expect(manager.isEnabled('compaction-distiller-strategy')).toBe(true);

    configManager.fireSet('behavior.compactionStrategy', 'off', 'distiller');
    expect(manager.isEnabled('session-compaction')).toBe(false);
    expect(manager.isEnabled('compaction-distiller-strategy')).toBe(false);
  });

  test('constant bindings are not subscribed — their domain keys act directly', () => {
    const configManager = fakeConfigManager();
    const manager = createFeatureFlagManager();
    bindFeatureSettingsBridge(configManager, manager);

    expect(configManager.listenerCount('surfaces.slack.enabled')).toBe(0);
    expect(manager.isEnabled('slack-surface')).toBe(true);
  });

  test('a malformed persisted value derives to disabled instead of throwing', () => {
    const configManager = fakeConfigManager();
    const manager = createFeatureFlagManager();
    manager.applyConfigState(TOGGLEABLE_FLAG_ID, 'enabled');
    bindFeatureSettingsBridge(configManager, manager);

    expect(() => configManager.fireSet(TOGGLEABLE_KEY, 'not-a-boolean', true)).not.toThrow();
    expect(manager.getState(TOGGLEABLE_FLAG_ID)).toBe('disabled');
  });
});
