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
