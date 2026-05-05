/**
 * DEFAULT_CONFIG must include a `runtime` section so that
 * ConfigManager.resolvePath('runtime.*') never throws "section 'runtime' does not exist".
 */
import { describe, expect, test } from 'bun:test';
import { CONFIG_SCHEMA, DEFAULT_CONFIG } from '../packages/sdk/src/platform/config/schema.js';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.js';
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
});
