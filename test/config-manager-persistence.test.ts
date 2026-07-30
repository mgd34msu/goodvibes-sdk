import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.ts';
import { getConfiguredSystemPrompt } from '../packages/sdk/src/platform/config/index.ts';
import {
  announceIngestionNotice,
  unreadableSettingsFileNotice,
} from '../packages/sdk/src/platform/config/settings-ingestion.ts';

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

  test('a settings file that will not parse says the file and the reason, and why it is not skipped', () => {
    // The one place the skip-by-default rule does not apply: the reader cannot
    // tell whether the unreadable bytes held a permission gate, so it cannot
    // know that carrying on without them is safe. Unlike a single bad key, this
    // stops the process — so the line has to name the file and the parse error,
    // which is what turns "the daemon will not start" into a two-minute fix.
    const entry = unreadableSettingsFileNotice('/tmp/daemon/settings.json', "JSON Parse error: Expected '}'");
    expect(entry.action).toBe('refused');
    expect(entry.file).toBe('/tmp/daemon/settings.json');
    expect(entry.reason).toContain("JSON Parse error: Expected '}'");
    expect(entry.remedy).toContain('may hold permission or safety settings');

    const lines: string[] = [];
    announceIngestionNotice(entry, (line) => { lines.push(line); });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('/tmp/daemon/settings.json');
    expect(lines[0]).toContain('REFUSED');
  });

  test('a clean load quarantines nothing', () => {
    const configDir = tempDir('clean-config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ display: { theme: 'dark' } }), 'utf-8');

    expect(new ConfigManager({ configDir }).getIngestionQuarantine()).toHaveLength(0);
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

    manager.mergeCategory('helper', { testEntry: 'disabled' } as never);
    expect((manager.getCategory('helper') as unknown as Record<string, string>)['testEntry']).toBe('disabled');

    manager.removeCategoryKey('helper', 'testEntry');
    expect('testEntry' in (manager.getCategory('helper') as unknown as Record<string, string>)).toBe(false);

    // The removal must survive a reload from disk — this is the exact path
    // that silently kept stale overrides alive across restarts.
    const reloaded = new ConfigManager({ configDir });
    expect('testEntry' in (reloaded.getCategory('helper') as unknown as Record<string, string>)).toBe(false);
  });

  test('removeCategoryKey on an absent key is a no-op and does not throw', () => {
    const configDir = tempDir('remove-absent-key');
    mkdirSync(configDir, { recursive: true });
    const manager = new ConfigManager({ configDir });

    expect(() => manager.removeCategoryKey('helper', 'never-set')).not.toThrow();
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
