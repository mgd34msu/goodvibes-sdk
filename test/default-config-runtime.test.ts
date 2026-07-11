/**
 * DEFAULT_CONFIG must include a `runtime` section so that
 * ConfigManager.resolvePath('runtime.*') never throws "section 'runtime' does not exist".
 */
import { describe, expect, test } from 'bun:test';
import { CONFIG_SCHEMA, DEFAULT_CONFIG } from '../packages/sdk/src/platform/config/schema.js';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.js';
import { DEFAULT_MEMORY_CONSOLIDATION_CONFIG } from '../packages/sdk/src/platform/state/memory-consolidation-config.js';
import { resolveMemoryConsolidationConfig } from '../packages/sdk/src/platform/state/memory-consolidation-config.js';
import { tmpdir } from 'os';
import { mkdirSync } from 'fs';
import { join } from 'path';

// ---------------------------------------------------------------------------
// DEFAULT_CONFIG structure
// ---------------------------------------------------------------------------

describe('DEFAULT_CONFIG runtime section', () => {
  test('DEFAULT_CONFIG has a runtime key', () => {
    expect('runtime' in DEFAULT_CONFIG).toBe(true);
  });

  test('DEFAULT_CONFIG.runtime.companionChatLimiter.perSessionLimit uses the documented default', () => {
    const config = DEFAULT_CONFIG as Record<string, unknown>;
    const runtime = config['runtime'] as Record<string, unknown>;
    const limiter = runtime['companionChatLimiter'] as Record<string, unknown>;
    expect(typeof limiter['perSessionLimit']).toBe('number');
    expect(limiter['perSessionLimit']).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Recently-added domains must each carry a DEFAULT_CONFIG entry, or every
// resolvePath() through them throws "section '<domain>' does not exist".
// Regression guard for the worktree gap (worktree.setup.* was read via
// configManager.get but the domain was never registered) — and for the
// already-registered checkin.* / atRest.* neighbors.
// ---------------------------------------------------------------------------

describe('DEFAULT_CONFIG registers every recently-added domain', () => {
  for (const domain of ['worktree', 'checkin', 'atRest', 'learning'] as const) {
    test(`DEFAULT_CONFIG has a '${domain}' section`, () => {
      expect(domain in DEFAULT_CONFIG).toBe(true);
    });
  }

  test('worktree.setup carries empty-array defaults', () => {
    const worktree = (DEFAULT_CONFIG as Record<string, unknown>)['worktree'] as Record<string, unknown>;
    const setup = worktree['setup'] as Record<string, unknown>;
    expect(Array.isArray(setup['commands'])).toBe(true);
    expect(setup['commands']).toEqual([]);
    expect(Array.isArray(setup['carryOverGlobs'])).toBe(true);
    expect(setup['carryOverGlobs']).toEqual([]);
  });

  test("config.get('worktree.setup.commands') resolves the default instead of throwing", () => {
    const configDir = join(tmpdir(), `gv-test-worktree-${Date.now()}-${crypto.randomUUID()}`);
    mkdirSync(configDir, { recursive: true });
    const manager = new ConfigManager({ configDir });
    // worktree.setup.* is an array key (not a scalar ConfigKey), so it is read
    // through the same object-path resolution the daemon uses via a cast.
    const get = manager.get.bind(manager) as unknown as (k: string) => unknown;
    expect(() => get('worktree.setup.commands')).not.toThrow();
    expect(get('worktree.setup.commands')).toEqual([]);
    expect(() => get('worktree.setup.carryOverGlobs')).not.toThrow();
    expect(get('worktree.setup.carryOverGlobs')).toEqual([]);
  });

  test('learning.consolidation schema defaults exactly equal DEFAULT_MEMORY_CONSOLIDATION_CONFIG (no drift)', () => {
    const learning = (DEFAULT_CONFIG as Record<string, unknown>)['learning'] as Record<string, unknown>;
    const consolidation = learning['consolidation'] as Record<string, unknown>;
    // The config-surface mirror must never drift from the behavioral contract's
    // fallback, or a user who sets nothing would resolve a different policy than
    // one whose settings.json carries no learning block.
    expect(consolidation).toEqual({ ...DEFAULT_MEMORY_CONSOLIDATION_CONFIG });
  });

  test("config.get/set('learning.consolidation.*') is safe and the resolver still returns the defaults", () => {
    const configDir = join(tmpdir(), `gv-test-learning-${Date.now()}-${crypto.randomUUID()}`);
    mkdirSync(configDir, { recursive: true });
    const manager = new ConfigManager({ configDir });
    const get = manager.get.bind(manager) as unknown as (k: string) => unknown;
    // Before the domain was registered these threw "section 'learning' does not exist".
    expect(() => get('learning.consolidation.enabled')).not.toThrow();
    expect(get('learning.consolidation.enabled')).toBe(false);
    expect(get('learning.consolidation.decayAgeDays')).toBe(45);
    expect(() => manager.setDynamic('learning.consolidation.enabled' as Parameters<typeof manager.setDynamic>[0], true)).not.toThrow();
    // Resolver behavior is unchanged: with a schema default present it reads the
    // same values it previously fell back to.
    expect(resolveMemoryConsolidationConfig(manager)).toEqual({ ...DEFAULT_MEMORY_CONSOLIDATION_CONFIG, enabled: true });
  });
});

// ---------------------------------------------------------------------------
// ConfigManager: every runtime.* schema key resolves without throwing
// ---------------------------------------------------------------------------

describe('ConfigManager resolves all runtime.* schema keys', () => {
  function makeConfigManager(): ConfigManager {
    const configDir = join(tmpdir(), `gv-test-runtime-${Date.now()}-${crypto.randomUUID()}`);
    mkdirSync(configDir, { recursive: true });
    return new ConfigManager({ configDir });
  }

  const runtimeKeys = CONFIG_SCHEMA
    .map((setting) => setting.key)
    .filter((key) => key.startsWith('runtime.'));

  test('at least one runtime.* key exists in CONFIG_SCHEMA', () => {
    expect(runtimeKeys).toEqual([
      'runtime.companionChatLimiter.perSessionLimit',
      'runtime.eventBus.maxListeners',
      'runtime.toolBudget.maxMs',
      'runtime.toolBudget.maxTokens',
      'runtime.toolBudget.maxCostUsd',
    ]);
  });

  for (const key of runtimeKeys) {
    test(`config.get('${key}') does not throw`, () => {
      const manager = makeConfigManager();
      expect(() => manager.get(key as Parameters<typeof manager.get>[0])).not.toThrow();
    });

    test(`config.get('${key}') returns the schema default value`, () => {
      const manager = makeConfigManager();
      const setting = CONFIG_SCHEMA.find((s) => s.key === key)!;
      const value = manager.get(key as Parameters<typeof manager.get>[0]);
      expect(value).toBe(setting.default);
    });
  }
});

// ---------------------------------------------------------------------------
// buildResolvedEntries equivalent: iterate all schema keys via get()
// ---------------------------------------------------------------------------

describe('ConfigManager resolves all CONFIG_SCHEMA keys without throwing', () => {
  test('iterating all schema keys via get() never throws', () => {
    const configDir = join(tmpdir(), `gv-test-allkeys-${Date.now()}-${crypto.randomUUID()}`);
    mkdirSync(configDir, { recursive: true });
    const manager = new ConfigManager({ configDir });

    // This replicates what buildResolvedEntries() does — if runtime section is missing,
    // this loop throws at the runtime.* entry and test fails.
    const errors: string[] = [];
    for (const setting of CONFIG_SCHEMA) {
      try {
        manager.get(setting.key as Parameters<typeof manager.get>[0]);
      } catch (e) {
        errors.push(`${setting.key}: ${String(e)}`);
      }
    }
    expect(errors).toHaveLength(0);
  });

  test('every schema key is set-safe: setting its own default value never throws', () => {
    const configDir = join(tmpdir(), `gv-test-setallkeys-${Date.now()}-${crypto.randomUUID()}`);
    mkdirSync(configDir, { recursive: true });
    const manager = new ConfigManager({ configDir });

    // A schema key whose top-level domain is absent from DEFAULT_CONFIG resolves
    // fine on read of the default snapshot but throws at set() (resolvePath walks
    // the live config). Writing each key's own default exercises the set path —
    // validation, enum, and object-path resolution — without changing any value.
    const errors: string[] = [];
    for (const setting of CONFIG_SCHEMA) {
      try {
        manager.setDynamic(setting.key as Parameters<typeof manager.setDynamic>[0], setting.default);
      } catch (e) {
        errors.push(`${setting.key}: ${String(e)}`);
      }
    }
    expect(errors).toHaveLength(0);
  });
});
