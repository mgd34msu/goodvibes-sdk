/**
 * config-persists-user-keys-only.test.ts — the config file carries only
 * user-set keys, never frozen defaults.
 *
 * Defect class: ConfigManager.save() serialized the whole merged config, so
 * every default was baked onto disk (freezing it against later default
 * changes) and a set() rewrote the entire file (clobbering hand edits made
 * between load and set). Now a set() is a per-key read-merge-write, and an
 * invisible migration strips previously-frozen defaults from existing files.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.ts';
import { DEFAULT_CONFIG } from '../packages/sdk/src/platform/config/schema.ts';

function tempConfigDir(): string {
  const dir = join(tmpdir(), `gv-cfg-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function readSettings(configDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf-8')) as Record<string, unknown>;
}

describe('config persists only user-set keys', () => {
  test('a set() writes only that key to disk — defaults never land', () => {
    const configDir = tempConfigDir();
    const manager = new ConfigManager({ configDir });
    manager.set('provider.model', 'openai:gpt-test');

    const onDisk = readSettings(configDir);
    // Only the touched section is present — no frozen defaults for every other
    // domain.
    expect(Object.keys(onDisk)).toEqual(['provider']);
    expect(onDisk.provider).toEqual({ model: 'openai:gpt-test' });
  });

  test('a hand-edited file survives a concurrent set() of a different key', () => {
    const configDir = tempConfigDir();
    // Two managers over the same dir stand in for two live processes.
    const a = new ConfigManager({ configDir });
    const b = new ConfigManager({ configDir });

    // Process A sets one key.
    a.set('provider.model', 'openai:gpt-a');
    // A hand edit (or process B) writes an UNRELATED key directly to disk.
    const raw = readSettings(configDir);
    (raw as { behavior?: Record<string, unknown> }).behavior = { autoApprove: true };
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify(raw, null, 2) + '\n', 'utf-8');

    // Process B (loaded before the edit) now sets a THIRD, different key.
    b.set('behavior.notifyOnComplete', false);

    // The hand-edited key must still be on disk — B's per-key write did not
    // clobber it by rewriting the whole file from its stale in-memory view.
    const after = readSettings(configDir);
    expect((after.behavior as Record<string, unknown>).autoApprove).toBe(true);
    expect((after.provider as Record<string, unknown>).model).toBe('openai:gpt-a');
  });

  test('migration strips frozen defaults but keeps genuine user values', () => {
    const configDir = tempConfigDir();
    // Seed a file the OLD whole-config writer would have produced: every
    // default frozen on disk, plus one genuine user change.
    const frozen = structuredClone(DEFAULT_CONFIG) as Record<string, Record<string, unknown>>;
    frozen.provider = { ...frozen.provider, model: 'anthropic:my-model' };
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify(frozen, null, 2) + '\n', 'utf-8');

    // Constructing the manager runs the invisible strip migration.
    const manager = new ConfigManager({ configDir });

    const onDisk = readSettings(configDir);
    // The genuine user value survives...
    expect((onDisk.provider as Record<string, unknown>).model).toBe('anthropic:my-model');
    // ...and resolves live.
    expect(manager.get('provider.model')).toBe('anthropic:my-model');
    // ...but the frozen defaults are gone: the file is far smaller than the
    // full default set, and a default-valued domain is no longer present.
    expect(Object.keys(onDisk).length).toBeLessThan(Object.keys(DEFAULT_CONFIG).length);
    // A representative default-equal key was stripped (its value still resolves
    // from defaults).
    for (const [domain, value] of Object.entries(onDisk)) {
      if (domain === 'provider') continue;
      // No surviving domain is byte-identical to its full default (that would
      // be a frozen default left behind).
      expect(value).not.toEqual((DEFAULT_CONFIG as Record<string, unknown>)[domain]);
    }
  });

  test('a fresh minimal file is left untouched by the strip migration', () => {
    const configDir = tempConfigDir();
    const first = new ConfigManager({ configDir });
    first.set('provider.model', 'openai:only-key');
    const before = readFileSync(join(configDir, 'settings.json'), 'utf-8');

    // Re-loading must not rewrite an already-minimal file.
    const second = new ConfigManager({ configDir });
    expect(second.get('provider.model')).toBe('openai:only-key');
    const after = readFileSync(join(configDir, 'settings.json'), 'utf-8');
    expect(after).toBe(before);
  });

  test('reset(key) removes the explicit value rather than freezing the default', () => {
    const configDir = tempConfigDir();
    const manager = new ConfigManager({ configDir });
    manager.set('provider.model', 'openai:temp');
    expect(existsSync(join(configDir, 'settings.json'))).toBe(true);

    manager.reset('provider.model');
    const onDisk = readSettings(configDir);
    // The key is gone from disk; it resolves back to its default.
    expect(onDisk.provider).toBeUndefined();
    expect(manager.get('provider.model')).toBe(DEFAULT_CONFIG.provider.model);
  });
});
