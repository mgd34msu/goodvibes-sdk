/**
 * config-shared-voice-tier.test.ts — Fix 1 (Stage-5 cohesion #1).
 *
 * The voice (tts.*) settings resolve from and write to a surface-root-INDEPENDENT
 * shared tier (~/.goodvibes/shared/settings.json), so two surfaces with different
 * surface roots (e.g. 'tui' and 'agent') sharing one home directory resolve the
 * SAME voice. A surface with no shared value falls back to its local setting, so
 * existing setups never break. The resolution order is inspectable via
 * describeConfigKeySource.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.js';

const roots: string[] = [];
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-shared-voice-'));
  roots.push(dir);
  return dir;
}
function sharedFile(h: string): string {
  return join(h, '.goodvibes', 'shared', 'settings.json');
}
function agentSettings(h: string): string {
  return join(h, '.goodvibes', 'agent', 'settings.json');
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('shared voice tier — cross-surface-root resolution (Fix 1)', () => {
  test('a voice set on one surface root is read by another surface root', () => {
    const h = home();
    const tui = new ConfigManager({ homeDir: h, surfaceRoot: 'tui' });
    expect(tui.get('tts.voice')).toBe('');

    tui.set('tts.voice', 'rachel');
    tui.set('tts.speed', 1.75);

    // A fresh agent-surface manager, different surface root, same home → same voice.
    const agent = new ConfigManager({ homeDir: h, surfaceRoot: 'agent' });
    expect(agent.get('tts.voice')).toBe('rachel');
    expect(agent.get('tts.speed')).toBe(1.75);
  });

  test('shared writes land in the shared file, not the surface silo', () => {
    const h = home();
    const tui = new ConfigManager({ homeDir: h, surfaceRoot: 'tui' });
    tui.set('tts.voice', 'daniel');

    expect(existsSync(sharedFile(h))).toBe(true);
    const shared = JSON.parse(readFileSync(sharedFile(h), 'utf-8')) as { tts?: { voice?: string } };
    expect(shared.tts?.voice).toBe('daniel');

    // The surface (tui) settings.json must NOT be the carrier for the shared key.
    const surfacePath = tui.getConfigPath();
    if (existsSync(surfacePath)) {
      const surface = JSON.parse(readFileSync(surfacePath, 'utf-8')) as { tts?: { voice?: string } };
      expect(surface.tts?.voice ?? '').not.toBe('daniel');
    }
  });

  test('a surface with no shared value falls back to its local setting', () => {
    const h = home();
    // Pre-seed a LOCAL agent voice, with no shared tier value present.
    mkdirSync(join(h, '.goodvibes', 'agent'), { recursive: true });
    writeFileSync(agentSettings(h), JSON.stringify({ tts: { voice: 'local-voice' } }), 'utf-8');

    const agent = new ConfigManager({ homeDir: h, surfaceRoot: 'agent' });
    expect(agent.get('tts.voice')).toBe('local-voice');
    expect(agent.describeConfigKeySource('tts.voice').tier).toBe('global');

    // Now a shared value is set elsewhere: it wins over the local fallback.
    const tui = new ConfigManager({ homeDir: h, surfaceRoot: 'tui' });
    tui.set('tts.voice', 'shared-voice');

    const agentReloaded = new ConfigManager({ homeDir: h, surfaceRoot: 'agent' });
    expect(agentReloaded.get('tts.voice')).toBe('shared-voice');
    expect(agentReloaded.describeConfigKeySource('tts.voice').tier).toBe('shared');
  });

  test('describeConfigKeySource reports the resolution tier and shareability', () => {
    const h = home();
    const tui = new ConfigManager({ homeDir: h, surfaceRoot: 'tui' });

    const before = tui.describeConfigKeySource('tts.voice');
    expect(before.tier).toBe('default');
    expect(before.shareable).toBe(true);
    expect(before.sharedTierPath).toBe(sharedFile(h));

    tui.set('tts.voice', 'aria');
    const after = tui.describeConfigKeySource('tts.voice');
    expect(after.tier).toBe('shared');
    expect(after.value).toBe('aria');

    // A non-shared key is not shareable and never resolves from the shared tier.
    const model = tui.describeConfigKeySource('provider.model');
    expect(model.shareable).toBe(false);
  });

  test('a non-shared key stays in the surface silo and does not cross surface roots', () => {
    const h = home();
    const tui = new ConfigManager({ homeDir: h, surfaceRoot: 'tui' });
    tui.set('provider.model', 'openai:gpt-shared-test');

    // The shared file must not carry the non-shared key.
    if (existsSync(sharedFile(h))) {
      const shared = JSON.parse(readFileSync(sharedFile(h), 'utf-8')) as { provider?: unknown };
      expect(shared.provider).toBeUndefined();
    }
    // A different surface root does not see it.
    const agent = new ConfigManager({ homeDir: h, surfaceRoot: 'agent' });
    expect(agent.get('provider.model')).not.toBe('openai:gpt-shared-test');
  });

  test('reset of a shared key propagates across surface roots', () => {
    const h = home();
    const tui = new ConfigManager({ homeDir: h, surfaceRoot: 'tui' });
    tui.set('tts.voice', 'temp-voice');
    tui.reset('tts.voice');

    const agent = new ConfigManager({ homeDir: h, surfaceRoot: 'agent' });
    expect(agent.get('tts.voice')).toBe('');
    expect(agent.describeConfigKeySource('tts.voice').tier).not.toBe('shared');
  });

  test('a configDir-only manager with no home has no shared tier (legacy behavior)', () => {
    const h = home();
    const mgr = new ConfigManager({ configDir: join(h, 'config-only') });
    expect(mgr.getSharedTierPath()).toBeNull();
    // Setting a tts key still works, persisted to the surface silo.
    mgr.set('tts.voice', 'legacy-voice');
    expect(mgr.get('tts.voice')).toBe('legacy-voice');
    const reloaded = new ConfigManager({ configDir: join(h, 'config-only') });
    expect(reloaded.get('tts.voice')).toBe('legacy-voice');
  });
});
