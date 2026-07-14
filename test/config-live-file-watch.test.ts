/**
 * config-live-file-watch.test.ts — external edits apply live.
 *
 * A settings file changed by another process (or by hand) is reloaded and
 * surfaced through the same subscribe() pipeline an in-process set() uses, with
 * no restart. The custom-provider file watcher proves the fs mechanism; this
 * wires the config layer onto it.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.ts';

const dirs: string[] = [];

function tempConfigDir(): string {
  const dir = join(tmpdir(), `gv-cfgwatch-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('config live file watch', () => {
  test('an external edit to a watched file surfaces through a subscription', async () => {
    const configDir = tempConfigDir();
    const manager = new ConfigManager({ configDir });
    // Seed an explicit value so the file exists to be watched.
    manager.set('provider.model', 'openai:start');

    const seen: Array<{ oldValue: unknown; newValue: unknown }> = [];
    manager.subscribe('provider.model', (newValue, oldValue) => {
      seen.push({ oldValue, newValue });
    });

    // Short poll interval keeps the test quick.
    const stop = manager.watchConfigFiles({ intervalMs: 50 });
    try {
      // Another process writes the settings file directly.
      writeFileSync(
        join(configDir, 'settings.json'),
        JSON.stringify({ provider: { model: 'anthropic:edited-externally' } }, null, 2) + '\n',
        'utf-8',
      );

      // Wait for the poll + reload to surface the change.
      const deadline = Date.now() + 4000;
      while (seen.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
    } finally {
      stop();
    }

    // The live config now reflects the external edit...
    expect(manager.get('provider.model')).toBe('anthropic:edited-externally');
    // ...and the subscriber was notified with old + new values.
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[seen.length - 1]?.newValue).toBe('anthropic:edited-externally');
    expect(seen[0]?.oldValue).toBe('openai:start');
  });

  test('stopWatchingConfigFiles halts further notifications', async () => {
    const configDir = tempConfigDir();
    const manager = new ConfigManager({ configDir });
    manager.set('provider.model', 'openai:base');
    let count = 0;
    manager.subscribe('provider.model', () => { count += 1; });

    const stop = manager.watchConfigFiles({ intervalMs: 50 });
    stop();

    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify({ provider: { model: 'openai:after-stop' } }, null, 2) + '\n',
      'utf-8',
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(count).toBe(0);
  });
});
