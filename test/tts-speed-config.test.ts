import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { ConfigError } from '../packages/sdk/src/platform/types/errors.js';

/**
 * Item 5b — tts.speed config key
 *
 * Verifies that:
 * 1. TtsConfig interface has a `speed` field typed as number.
 * 2. DEFAULT_CONFIG / coreConfigDefaults includes tts.speed = 1.0.
 * 3. The schema definition list contains the 'tts.speed' key with correct defaults.
 * 4. ConfigManager round-trips tts.speed through get/set.
 * 5. Validation rejects values outside [0.25, 4.0] (validate fn enforces range; ConfigError is thrown).
 */

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('tts.speed config key (Item 5b)', () => {
  test('coreConfigDefaults.tts.speed is 1.0', async () => {
    const { coreConfigDefaults } = await import('../packages/sdk/src/platform/config/schema-domain-core.js');
    expect(coreConfigDefaults.tts.speed).toBe(1.0);
  });

  test('schema definition list contains tts.speed key with correct type and default', async () => {
    const { CONFIG_SCHEMA } = await import('../packages/sdk/src/platform/config/schema.js');
    const entry = CONFIG_SCHEMA.find((s) => s.key === 'tts.speed');
    expect(entry).toBeDefined();
    expect(entry!.type).toBe('number');
    expect(entry!.default).toBe(1.0);
    expect(typeof entry!.description).toBe('string');
    expect(entry!.description.length).toBeGreaterThan(0);
  });

  test('TtsConfig type has speed field typed as number', async () => {
    // Runtime check: ConfigManager returns tts as TtsConfig-shaped object with speed
    const { ConfigManager } = await import('../packages/sdk/src/platform/config/manager.js');
    const root = mkdtempSync(join(tmpdir(), 'goodvibes-tts-speed-'));
    tmpRoots.push(root);
    const mgr = new ConfigManager({ configDir: join(root, 'config') });
    const tts = mgr.getCategory('tts');
    expect(typeof tts.speed).toBe('number');
    expect(tts.speed).toBe(1.0);
  });

  test('ConfigManager get tts.speed returns default 1.0', async () => {
    const { ConfigManager } = await import('../packages/sdk/src/platform/config/manager.js');
    const root = mkdtempSync(join(tmpdir(), 'goodvibes-tts-speed-get-'));
    tmpRoots.push(root);
    const mgr = new ConfigManager({ configDir: join(root, 'config') });
    expect(mgr.get('tts.speed')).toBe(1.0);
  });

  test('ConfigManager set/get round-trips tts.speed', async () => {
    const { ConfigManager } = await import('../packages/sdk/src/platform/config/manager.js');
    const root = mkdtempSync(join(tmpdir(), 'goodvibes-tts-speed-set-'));
    tmpRoots.push(root);
    const mgr = new ConfigManager({ configDir: join(root, 'config') });
    await mgr.set('tts.speed', 1.5);
    expect(mgr.get('tts.speed')).toBe(1.5);
  });

  test('ConfigManager set/get round-trips extreme valid values', async () => {
    const { ConfigManager } = await import('../packages/sdk/src/platform/config/manager.js');
    const root = mkdtempSync(join(tmpdir(), 'goodvibes-tts-speed-extreme-'));
    tmpRoots.push(root);
    const mgr = new ConfigManager({ configDir: join(root, 'config') });
    await mgr.set('tts.speed', 0.25);
    expect(mgr.get('tts.speed')).toBe(0.25);
    await mgr.set('tts.speed', 4.0);
    expect(mgr.get('tts.speed')).toBe(4.0);
  });

  test('tts.speed appears in ConfigKey union (TypeScript type coverage)', async () => {
    // Ensures the key is usable with mgr.get without a type error at the call site.
    // This test imports the schema definition list and verifies the key is present
    // (the actual TypeScript union is compile-time-only; we verify data consistency).
    const { CONFIG_SCHEMA } = await import('../packages/sdk/src/platform/config/schema.js');
    const keys = CONFIG_SCHEMA.map((s) => s.key);
    expect(keys).toContain('tts.speed');
    // Confirm it sits in the tts.* group alongside its siblings
    expect(keys).toContain('tts.provider');
    expect(keys).toContain('tts.voice');
    expect(keys).toContain('tts.llmProvider');
    expect(keys).toContain('tts.llmModel');
  });

  test('ConfigManager set rejects tts.speed > 4.0 (too fast)', async () => {
    const { ConfigManager } = await import('../packages/sdk/src/platform/config/manager.js');
    const root = mkdtempSync(join(tmpdir(), 'goodvibes-tts-speed-hi-'));
    tmpRoots.push(root);
    const mgr = new ConfigManager({ configDir: join(root, 'config') });
    expect(() => mgr.set('tts.speed', 10)).toThrow(ConfigError);
    try { mgr.set('tts.speed', 10); } catch (e) {
      expect(String(e)).toContain('0.25');
      expect(String(e)).toContain('4.0');
    }
  });

  test('ConfigManager set rejects tts.speed < 0.25 (too slow)', async () => {
    const { ConfigManager } = await import('../packages/sdk/src/platform/config/manager.js');
    const root = mkdtempSync(join(tmpdir(), 'goodvibes-tts-speed-lo-'));
    tmpRoots.push(root);
    const mgr = new ConfigManager({ configDir: join(root, 'config') });
    expect(() => mgr.set('tts.speed', -1)).toThrow(ConfigError);
    try { mgr.set('tts.speed', -1); } catch (e) {
      expect(String(e)).toContain('0.25');
      expect(String(e)).toContain('4.0');
    }
  });

  test('ConfigManager set rejects tts.speed = NaN', async () => {
    const { ConfigManager } = await import('../packages/sdk/src/platform/config/manager.js');
    const root = mkdtempSync(join(tmpdir(), 'goodvibes-tts-speed-nan-'));
    tmpRoots.push(root);
    const mgr = new ConfigManager({ configDir: join(root, 'config') });
    expect(() => mgr.set('tts.speed', Number.NaN)).toThrow(ConfigError);
    try { mgr.set('tts.speed', Number.NaN); } catch (e) {
      expect(String(e)).toContain('0.25');
      expect(String(e)).toContain('4.0');
    }
  });
});
