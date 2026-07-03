/**
 * W0.3 — wrfc.commitScope config surface + readWrfcConfig/getWrfcCommitScope resolution.
 *
 * The behavioral (auto-commit staging) tests live in wrfc-controller.test.ts and
 * agent-worktree.test.ts. This file covers just the config schema/plumbing:
 * - wrfc.commitScope is present in CONFIG_SCHEMA as an enum defaulting to 'scoped'.
 * - ConfigManager resolves it and rejects out-of-set values.
 * - readWrfcConfig()/getWrfcCommitScope() default to 'scoped' and reject invalid values.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_SCHEMA } from '../packages/sdk/src/platform/config/schema.js';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.js';
import { readWrfcConfig, getWrfcCommitScope, type WrfcConfigReader } from '../packages/sdk/src/platform/agents/wrfc-config.js';

function makeConfigManager(): ConfigManager {
  const configDir = join(tmpdir(), `gv-test-commitscope-${Date.now()}-${crypto.randomUUID()}`);
  mkdirSync(configDir, { recursive: true });
  return new ConfigManager({ configDir });
}

describe('CONFIG_SCHEMA: wrfc.commitScope', () => {
  test('is present as an enum key defaulting to "scoped" with the three documented values', () => {
    const setting = CONFIG_SCHEMA.find((s) => s.key === 'wrfc.commitScope');
    expect(setting).toBeDefined();
    expect(setting!.type).toBe('enum');
    expect(setting!.default).toBe('scoped');
    expect(setting!.enumValues).toEqual(['off', 'scoped', 'all']);
  });

  test('ConfigManager.get resolves the schema default without throwing', () => {
    const manager = makeConfigManager();
    expect(() => manager.get('wrfc.commitScope')).not.toThrow();
    expect(manager.get('wrfc.commitScope')).toBe('scoped');
  });

  test('ConfigManager.set accepts the three documented values', () => {
    const manager = makeConfigManager();
    for (const value of ['off', 'scoped', 'all'] as const) {
      expect(() => manager.set('wrfc.commitScope', value)).not.toThrow();
      expect(manager.get('wrfc.commitScope')).toBe(value);
    }
  });

  test('ConfigManager.set rejects a value outside the enum', () => {
    const manager = makeConfigManager();
    expect(() => manager.set('wrfc.commitScope', 'everything' as never)).toThrow();
  });
});

describe('readWrfcConfig / getWrfcCommitScope', () => {
  function reader(commitScope: unknown): WrfcConfigReader {
    return {
      get: (key: string): unknown => (key === 'wrfc.commitScope' ? commitScope : undefined),
      getCategory: (category: string): unknown => (category === 'wrfc' ? { commitScope } : undefined),
    } as unknown as WrfcConfigReader;
  }

  test('defaults to "scoped" when nothing is configured', () => {
    const config = reader(undefined);
    expect(readWrfcConfig(config).commitScope).toBe('scoped');
    expect(getWrfcCommitScope(config)).toBe('scoped');
  });

  test('accepts "off" and "all" from config.get', () => {
    expect(getWrfcCommitScope(reader('off'))).toBe('off');
    expect(getWrfcCommitScope(reader('all'))).toBe('all');
  });

  test('rejects an invalid value and falls back to "scoped" rather than poisoning the commit path', () => {
    expect(getWrfcCommitScope(reader('everything'))).toBe('scoped');
    expect(getWrfcCommitScope(reader(42))).toBe('scoped');
  });
});
