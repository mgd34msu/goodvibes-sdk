/**
 * display-tree-glyphs-config.test.ts
 *
 * display.treeGlyphs is a declared enum setting: default 'rounded', three
 * accepted values (rounded, square, ascii), and any other value is refused
 * by the config manager.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_SCHEMA, DEFAULT_CONFIG, isValidConfigKey } from '../packages/sdk/src/platform/config/schema.js';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.js';
import { ConfigError } from '../packages/sdk/src/platform/types/errors.js';

const tmpRoots: string[] = [];
afterEach(() => {
  for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeManager(): ConfigManager {
  const dir = mkdtempSync(join(tmpdir(), 'tree-glyphs-config-'));
  tmpRoots.push(dir);
  return new ConfigManager({ configDir: dir });
}

describe('display.treeGlyphs', () => {
  test('is declared as an enum with default rounded', () => {
    expect(isValidConfigKey('display.treeGlyphs')).toBe(true);
    const row = CONFIG_SCHEMA.find((entry) => entry.key === 'display.treeGlyphs');
    expect(row).toBeDefined();
    expect(row!.type).toBe('enum');
    expect(row!.default).toBe('rounded');
    expect([...(row!.enumValues ?? [])]).toEqual(['rounded', 'square', 'ascii']);
    expect(DEFAULT_CONFIG.display.treeGlyphs).toBe('rounded');
    expect(makeManager().get('display.treeGlyphs')).toBe('rounded');
  });

  test('accepts rounded, square and ascii', () => {
    const manager = makeManager();
    for (const value of ['square', 'ascii', 'rounded'] as const) {
      manager.set('display.treeGlyphs', value);
      expect(manager.get('display.treeGlyphs')).toBe(value);
    }
  });

  test('rejects any other value and keeps the previous one', () => {
    const manager = makeManager();
    manager.set('display.treeGlyphs', 'square');
    expect(() => manager.setDynamic('display.treeGlyphs', 'fancy')).toThrow(ConfigError);
    expect(manager.get('display.treeGlyphs')).toBe('square');
  });
});
