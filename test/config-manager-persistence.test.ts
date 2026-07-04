import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.ts';
import { getConfiguredSystemPrompt } from '../packages/sdk/src/platform/config/index.ts';

function tempDir(label: string): string {
  return join(tmpdir(), `gv-${label}-${randomUUID()}`);
}

describe('ConfigManager persistence', () => {
  test('rejects invalid persisted global config instead of using defaults', () => {
    const configDir = tempDir('bad-config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'settings.json'), '{not json', 'utf-8');

    expect(() => new ConfigManager({ configDir })).toThrow('Global config load failed');
  });

  test('rolls back in-memory config when persistence fails', () => {
    const configDir = tempDir('readonly-config');
    mkdirSync(configDir, { recursive: true });
    const manager = new ConfigManager({ configDir });
    chmodSync(configDir, 0o500);

    try {
      expect(() => manager.set('provider.model', 'openai:gpt-test')).toThrow();
      expect(manager.get('provider.model')).not.toBe('openai:gpt-test');
    } finally {
      chmodSync(configDir, 0o700);
    }
  });

  test('removeCategoryKey deletes an override and persists the removal across reload', () => {
    const configDir = tempDir('remove-category-key');
    mkdirSync(configDir, { recursive: true });
    const manager = new ConfigManager({ configDir });

    manager.mergeCategory('featureFlags', { 'test-flag': 'disabled' } as never);
    expect((manager.getCategory('featureFlags') as Record<string, string>)['test-flag']).toBe('disabled');

    manager.removeCategoryKey('featureFlags', 'test-flag');
    expect('test-flag' in (manager.getCategory('featureFlags') as Record<string, string>)).toBe(false);

    // The removal must survive a reload from disk — this is the exact path
    // that silently kept stale flag overrides alive across restarts.
    const reloaded = new ConfigManager({ configDir });
    expect('test-flag' in (reloaded.getCategory('featureFlags') as Record<string, string>)).toBe(false);
  });

  test('removeCategoryKey on an absent key is a no-op and does not throw', () => {
    const configDir = tempDir('remove-absent-key');
    mkdirSync(configDir, { recursive: true });
    const manager = new ConfigManager({ configDir });

    expect(() => manager.removeCategoryKey('featureFlags', 'never-set')).not.toThrow();
  });

  test('configured system prompt file read failures are surfaced', () => {
    const configDir = tempDir('missing-system-prompt');
    mkdirSync(configDir, { recursive: true });
    const manager = new ConfigManager({
      configDir,
      systemPromptFile: join(configDir, 'missing-prompt.md'),
    });

    expect(() => getConfiguredSystemPrompt(manager)).toThrow();
  });
});
