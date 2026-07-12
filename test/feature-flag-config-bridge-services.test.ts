/**
 * feature-flag-config-bridge-services.test.ts
 *
 * End-to-end coverage for the live settings -> gate-manager bridge wired in
 * createRuntimeServices() (platform/runtime/services.ts): a real
 * ConfigManager.set on a capability's domain settings key (behavior.hitlMode,
 * permissions.engine, ...), after RuntimeServices is already constructed,
 * must reach the internally-created FeatureFlagManager without a restart —
 * for runtime-toggleable gates only. A startup-gated capability must show up
 * as pending-restart on the manager's snapshot instead of silently doing
 * nothing or faking a live apply.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.js';
import type { ConfigKey } from '../packages/sdk/src/platform/config/schema-types.js';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.js';
import { createRuntimeServices } from '../packages/sdk/src/platform/runtime/services.js';
import { createRuntimeStore } from '../packages/sdk/src/platform/runtime/store/index.js';
import { createFeatureFlagManager } from '../packages/sdk/src/platform/runtime/feature-flags/manager.js';

const TOGGLEABLE_FLAG_ID = 'hitl-ux-modes';
const TOGGLEABLE_KEY = 'behavior.hitlMode' as ConfigKey;
const STARTUP_GATED_FLAG_ID = 'permissions-policy-engine';
const STARTUP_GATED_KEY = 'permissions.engine' as ConfigKey;

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function buildServices() {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-flag-config-bridge-'));
  tmpRoots.push(root);
  const workingDir = join(root, 'workspace');
  const homeDirectory = join(root, 'home');
  mkdirSync(workingDir, { recursive: true });
  mkdirSync(homeDirectory, { recursive: true });
  const configManager = new ConfigManager({
    homeDir: homeDirectory,
    workingDir,
    surfaceRoot: 'goodvibes-test',
  });
  const runtimeServices = createRuntimeServices({
    configManager,
    runtimeBus: new RuntimeEventBus(),
    runtimeStore: createRuntimeStore(),
    surfaceRoot: 'goodvibes',
    workingDir,
    homeDirectory,
  });
  return { configManager, runtimeServices };
}

describe('createRuntimeServices — live feature-settings bridge', () => {
  test('config.set on a runtime-toggleable flag applies live and notifies subscribers', () => {
    const { configManager, runtimeServices } = buildServices();
    const seen: Array<{ flagId: string; state: string }> = [];
    runtimeServices.featureFlags.subscribe((flagId, state) => seen.push({ flagId, state }));

    // behavior.hitlMode defaults 'balanced', so the notification-mode system is on.
    expect(runtimeServices.featureFlags.isEnabled(TOGGLEABLE_FLAG_ID)).toBe(true);
    configManager.setDynamic(TOGGLEABLE_KEY, 'off');

    expect(runtimeServices.featureFlags.isEnabled(TOGGLEABLE_FLAG_ID)).toBe(false);
    expect(seen).toEqual([{ flagId: TOGGLEABLE_FLAG_ID, state: 'disabled' }]);
  });

  test('config.set on a startup-gated flag does not change effective state but is visible as pending-restart', () => {
    const { configManager, runtimeServices } = buildServices();
    const seen: unknown[] = [];
    runtimeServices.featureFlags.subscribe((flagId, state) => seen.push({ flagId, state }));

    expect(runtimeServices.featureFlags.isEnabled(STARTUP_GATED_FLAG_ID)).toBe(false);
    configManager.setDynamic(STARTUP_GATED_KEY, 'policy-engine');

    // No live apply — the runtime must not fake a startup-only flag as active.
    expect(runtimeServices.featureFlags.isEnabled(STARTUP_GATED_FLAG_ID)).toBe(false);
    expect(seen).toEqual([]);

    // But it is honestly surfaced as "persisted, restart required" on the manager's snapshot.
    expect(runtimeServices.featureFlags.hasPendingRestart(STARTUP_GATED_FLAG_ID)).toBe(true);
    expect(runtimeServices.featureFlags.getPendingRestartState(STARTUP_GATED_FLAG_ID)).toBe('enabled');
    const snapshot = runtimeServices.featureFlags.getAll().get(STARTUP_GATED_FLAG_ID);
    expect(snapshot).toMatchObject({ state: 'disabled', persistedState: 'enabled', pendingRestart: true });
  });

  test('an externally-injected featureFlags manager is NOT bridged (caller owns it)', () => {
    const root = mkdtempSync(join(tmpdir(), 'goodvibes-flag-config-bridge-injected-'));
    tmpRoots.push(root);
    const workingDir = join(root, 'workspace');
    const homeDirectory = join(root, 'home');
    mkdirSync(workingDir, { recursive: true });
    mkdirSync(homeDirectory, { recursive: true });
    const configManager = new ConfigManager({
      homeDir: homeDirectory,
      workingDir,
      surfaceRoot: 'goodvibes-test',
    });
    const injectedFeatureFlags = createFeatureFlagManager();
    const runtimeServices = createRuntimeServices({
      configManager,
      runtimeBus: new RuntimeEventBus(),
      runtimeStore: createRuntimeStore(),
      surfaceRoot: 'goodvibes',
      workingDir,
      homeDirectory,
      featureFlags: injectedFeatureFlags,
    });
    expect(runtimeServices.featureFlags).toBe(injectedFeatureFlags);

    configManager.setDynamic(TOGGLEABLE_KEY, 'off');
    // The composition root only bridges the manager it created itself
    // (mirrors the options.featureFlags === undefined guard around the boot
    // loadFromConfig call) — an injected manager is the caller's to bridge.
    // The injected manager keeps its registry default (enabled) untouched.
    expect(injectedFeatureFlags.isEnabled(TOGGLEABLE_FLAG_ID)).toBe(true);
  });

  test('boot load still seeds effective state from persisted config at construction (unchanged)', () => {
    const root = mkdtempSync(join(tmpdir(), 'goodvibes-flag-config-bridge-boot-'));
    tmpRoots.push(root);
    const workingDir = join(root, 'workspace');
    const homeDirectory = join(root, 'home');
    mkdirSync(workingDir, { recursive: true });
    mkdirSync(homeDirectory, { recursive: true });
    const configManager = new ConfigManager({
      homeDir: homeDirectory,
      workingDir,
      surfaceRoot: 'goodvibes-test',
    });
    // Persist a settings choice BEFORE RuntimeServices is constructed — the
    // boot path derives gate states from the domain keys at construction.
    configManager.setDynamic(TOGGLEABLE_KEY, 'off');

    const runtimeServices = createRuntimeServices({
      configManager,
      runtimeBus: new RuntimeEventBus(),
      runtimeStore: createRuntimeStore(),
      surfaceRoot: 'goodvibes',
      workingDir,
      homeDirectory,
    });
    expect(runtimeServices.featureFlags.isEnabled(TOGGLEABLE_FLAG_ID)).toBe(false);
  });
});
