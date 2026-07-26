/**
 * daemon-config-migration.test.ts
 *
 * Daemon-owned values must MOVE into the daemon's own store, never be copied
 * and never be abandoned. The migration is re-runnable, survives a torn marker,
 * and discloses exactly what moved and what it discarded.
 *
 * The last block runs against a copy of the shape a real machine had when this
 * change was written — a `tui` store with a live Telegram configuration and an
 * `agent` store with a DIFFERENT bot-token reference and an empty chat id — so
 * the conflict rule is exercised on real data, not only synthetic fixtures.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.js';
import {
  migrateDaemonOwnedConfig,
  describeDaemonConfigMigration,
} from '../packages/sdk/src/platform/config/daemon-config-migration.js';
import {
  daemonConfigMovedPath,
  readDaemonConfigMovedMarker,
} from '../packages/sdk/src/platform/config/daemon-config-migration-io.js';

const roots: string[] = [];
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-daemon-migrate-'));
  roots.push(dir);
  return dir;
}
function writeSurface(h: string, surface: string, value: unknown): string {
  const path = join(h, '.goodvibes', surface, 'settings.json');
  mkdirSync(join(h, '.goodvibes', surface), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  return path;
}
function daemonStore(h: string): string {
  return join(h, '.goodvibes', 'daemon', 'settings.json');
}
function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('daemon-owned config migration', () => {
  test('moves daemon-owned values out of the surface silos and leaves client keys alone', () => {
    const h = home();
    writeSurface(h, 'tui', {
      display: { theme: 'vaporwave' },
      surfaces: { telegram: { enabled: true, botUsername: 'goodvibes_agent_bot' } },
      watchers: { enabled: true },
    });

    const result = migrateDaemonOwnedConfig({ homeDir: h });
    expect(result.migrated).toBe(true);

    const store = readJson(daemonStore(h));
    expect(store['surfaces']).toEqual({ telegram: { enabled: true, botUsername: 'goodvibes_agent_bot' } });
    expect(store['watchers']).toEqual({ enabled: true });

    // MOVED, not copied — the surface file no longer carries them.
    const tui = readJson(join(h, '.goodvibes', 'tui', 'settings.json'));
    expect(tui['surfaces']).toBeUndefined();
    expect(tui['watchers']).toBeUndefined();
    expect(tui['display']).toEqual({ theme: 'vaporwave' });
  });

  test('discloses every key it moved, and where from', () => {
    const h = home();
    const tuiPath = writeSurface(h, 'tui', {
      surfaces: { telegram: { botUsername: 'goodvibes_agent_bot' } },
    });

    const { marker, markerPath } = migrateDaemonOwnedConfig({ homeDir: h });
    expect(markerPath).toBe(daemonConfigMovedPath(daemonStore(h)));
    expect(marker.status).toBe('complete');
    expect(marker.movedTo).toBe(daemonStore(h));
    expect(marker.moved).toContainEqual({ key: 'surfaces.telegram.botUsername', from: tuiPath });

    // And the marker on disk parses back to the same ledger.
    const reread = readDaemonConfigMovedMarker(markerPath);
    expect(reread?.moved).toEqual(marker.moved);
  });

  test('is idempotent — a second run moves nothing and changes nothing', () => {
    const h = home();
    writeSurface(h, 'tui', { surfaces: { telegram: { botUsername: 'goodvibes_agent_bot' } } });

    const first = migrateDaemonOwnedConfig({ homeDir: h });
    const storeAfterFirst = readFileSync(daemonStore(h), 'utf-8');

    const second = migrateDaemonOwnedConfig({ homeDir: h });
    expect(second.migrated).toBe(false);
    expect(second.marker.moved).toEqual(first.marker.moved);
    expect(readFileSync(daemonStore(h), 'utf-8')).toBe(storeAfterFirst);
  });

  test('a TORN marker re-runs the migration instead of stranding the data', () => {
    const h = home();
    writeSurface(h, 'tui', { surfaces: { telegram: { botUsername: 'goodvibes_agent_bot' } } });
    const { markerPath } = migrateDaemonOwnedConfig({ homeDir: h });

    // Truncate the marker mid-JSON, exactly the shape that stranded user data
    // once before. `existsSync` would call this migrated; parsing does not.
    const torn = readFileSync(markerPath, 'utf-8').slice(0, 40);
    writeFileSync(markerPath, torn, 'utf-8');
    expect(readDaemonConfigMovedMarker(markerPath)).toBeNull();

    const rerun = migrateDaemonOwnedConfig({ homeDir: h });
    expect(rerun.migrated).toBe(true);
    // The value survived: it is still in the daemon store, not lost to the
    // re-run, and the marker is valid again.
    const store = readJson(daemonStore(h));
    expect((store['surfaces'] as Record<string, Record<string, unknown>>)['telegram']!['botUsername'])
      .toBe('goodvibes_agent_bot');
    expect(readDaemonConfigMovedMarker(markerPath)?.status).toBe('complete');
  });

  test('an in-progress marker is not believed, and its ledger is carried forward', () => {
    const h = home();
    const tuiPath = writeSurface(h, 'tui', { surfaces: { telegram: { botUsername: 'bot_a' } } });
    const markerPath = daemonConfigMovedPath(daemonStore(h));
    mkdirSync(join(h, '.goodvibes', 'daemon'), { recursive: true });
    writeFileSync(markerPath, JSON.stringify({
      version: 1,
      status: 'in-progress',
      movedTo: daemonStore(h),
      primarySurface: 'tui',
      date: '2026-07-25T00:00:00.000Z',
      sources: [tuiPath],
      moved: [{ key: 'surfaces.telegram.defaultChatId', from: tuiPath }],
      discarded: [],
    }, null, 2), 'utf-8');

    expect(readDaemonConfigMovedMarker(markerPath)).toBeNull();
    const rerun = migrateDaemonOwnedConfig({ homeDir: h });
    expect(rerun.migrated).toBe(true);
    // The interrupted run's disclosure is preserved alongside this run's.
    expect(rerun.marker.moved).toContainEqual({ key: 'surfaces.telegram.defaultChatId', from: tuiPath });
    expect(rerun.marker.moved).toContainEqual({ key: 'surfaces.telegram.botUsername', from: tuiPath });
  });

  test('a conflict resolves to the primary surface and discloses the discarded value', () => {
    const h = home();
    const tuiPath = writeSurface(h, 'tui', { surfaces: { telegram: { defaultChatId: '8546431428' } } });
    const agentPath = writeSurface(h, 'agent', { surfaces: { telegram: { defaultChatId: '' } } });

    const { marker } = migrateDaemonOwnedConfig({ homeDir: h, primarySurface: 'tui' });

    // The daemon has been reading the tui store, so its value is what the
    // machine is doing today; keeping it means behavior does not change.
    const store = readJson(daemonStore(h));
    expect((store['surfaces'] as Record<string, Record<string, unknown>>)['telegram']!['defaultChatId'])
      .toBe('8546431428');
    expect(marker.moved).toContainEqual({ key: 'surfaces.telegram.defaultChatId', from: tuiPath });
    expect(marker.discarded).toContainEqual({
      key: 'surfaces.telegram.defaultChatId',
      from: agentPath,
      value: '',
      reason: 'conflict',
      supersededBy: tuiPath,
    });
    expect(describeDaemonConfigMigration(marker)).toContain('discarded');
  });

  test('an identical value in a second store is disclosed as a duplicate, not a conflict', () => {
    const h = home();
    writeSurface(h, 'tui', { surfaces: { telegram: { botUsername: 'same_bot' } } });
    const agentPath = writeSurface(h, 'agent', { surfaces: { telegram: { botUsername: 'same_bot' } } });

    const { marker } = migrateDaemonOwnedConfig({ homeDir: h });
    const entry = marker.discarded.find((d) => d.from === agentPath);
    expect(entry?.reason).toBe('duplicate');
  });

  test('a credential value is redacted in the disclosure, but a secret REFERENCE is shown', () => {
    const h = home();
    writeSurface(h, 'tui', { surfaces: { telegram: { botToken: 'goodvibes://secrets/goodvibes/TELEGRAM_BOT_TOKEN' } } });
    const agentPath = writeSurface(h, 'agent', { surfaces: { telegram: { botToken: '123456:REAL-SECRET-VALUE' } } });

    const { marker } = migrateDaemonOwnedConfig({ homeDir: h });
    const entry = marker.discarded.find((d) => d.from === agentPath);
    // The raw token never reaches the ledger...
    expect(entry?.value).toBe('[redacted]');
    expect(JSON.stringify(marker)).not.toContain('REAL-SECRET-VALUE');
    // ...but the surviving reference is legible, which is the detail that
    // explains why two stores disagreed in the first place.
    expect(readJson(daemonStore(h))).toEqual({
      surfaces: { telegram: { botToken: 'goodvibes://secrets/goodvibes/TELEGRAM_BOT_TOKEN' } },
    });
  });

  test('an existing daemon-store value wins over any surface value', () => {
    const h = home();
    mkdirSync(join(h, '.goodvibes', 'daemon'), { recursive: true });
    writeFileSync(daemonStore(h), JSON.stringify({ surfaces: { telegram: { botUsername: 'already_here' } } }), 'utf-8');
    const tuiPath = writeSurface(h, 'tui', { surfaces: { telegram: { botUsername: 'from_tui' } } });

    const { marker } = migrateDaemonOwnedConfig({ homeDir: h });
    const store = readJson(daemonStore(h));
    expect((store['surfaces'] as Record<string, Record<string, unknown>>)['telegram']!['botUsername'])
      .toBe('already_here');
    expect(marker.discarded).toContainEqual({
      key: 'surfaces.telegram.botUsername',
      from: tuiPath,
      value: 'from_tui',
      reason: 'conflict',
      supersededBy: daemonStore(h),
    });
  });

  test('after migrating, a config manager on any surface resolves the daemon value', () => {
    const h = home();
    writeSurface(h, 'tui', { surfaces: { telegram: { enabled: true, botUsername: 'goodvibes_agent_bot' } } });
    writeSurface(h, 'agent', { surfaces: { telegram: { enabled: false } } });

    migrateDaemonOwnedConfig({ homeDir: h });

    for (const surfaceRoot of ['tui', 'agent']) {
      const config = new ConfigManager({ homeDir: h, surfaceRoot });
      expect(config.get('surfaces.telegram.botUsername')).toBe('goodvibes_agent_bot');
      expect(config.get('surfaces.telegram.enabled')).toBe(true);
      expect(config.describeConfigKeySource('surfaces.telegram.enabled').tier).toBe('daemon');
    }
  });
});

describe('migration against the live machine layout that motivated this change', () => {
  /**
   * A faithful reduction of the real `~/.goodvibes/tui/settings.json` and
   * `~/.goodvibes/agent/settings.json` as they stood when the split was found:
   * both carry daemon-owned domains, and they DISAGREE on the Telegram token
   * reference, the chat id, the control-plane binding and the watcher switch.
   */
  const liveTui = {
    display: { theme: 'vaporwave', themeMode: 'dark' },
    provider: { model: 'openai-subscriber:gpt-5.6-sol', reasoningEffort: 'high' },
    controlPlane: { enabled: true, hostMode: 'network', host: '0.0.0.0', port: 3421, allowRemote: true },
    surfaces: {
      ntfy: { enabled: true, baseUrl: 'https://ntfy.example.dev', topic: 'goodvibes-agent' },
      telegram: {
        enabled: true,
        botToken: 'goodvibes://secrets/goodvibes/TELEGRAM_BOT_TOKEN',
        defaultChatId: '8546431428',
        botUsername: 'goodvibes_agent_bot',
        mode: 'polling',
      },
    },
    watchers: { enabled: true, pollIntervalMs: 60000 },
    daemon: { enabled: true, embedInProcess: false },
    service: { enabled: true, autostart: true },
    voice: { local: { ttsEngine: 'piper', ttsBinary: '/opt/piper/piper' } },
  };
  const liveAgent = {
    display: { theme: 'vaporwave' },
    provider: { model: 'openai:gpt-5.6-sol', reasoningEffort: 'high' },
    controlPlane: { enabled: false, hostMode: 'local', host: '127.0.0.1', port: 3421, allowRemote: false },
    surfaces: {
      ntfy: { enabled: true, baseUrl: 'https://ntfy.example.dev', topic: 'goodvibes-agent' },
      telegram: {
        enabled: true,
        botToken: 'goodvibes://secrets/goodvibes/GOODVIBES_SURFACES_TELEGRAM_BOT_TOKEN',
        defaultChatId: '',
        botUsername: 'goodvibes_agent_bot',
        mode: 'polling',
      },
    },
    watchers: { enabled: false, pollIntervalMs: 60000 },
    daemon: { enabled: false },
    service: { enabled: false, autostart: false },
  };

  function liveHome(): string {
    const h = home();
    writeSurface(h, 'tui', liveTui);
    writeSurface(h, 'agent', liveAgent);
    writeSurface(h, 'app', { app: { stopDaemonOnQuit: false } });
    return h;
  }

  test('the working Telegram configuration survives intact', () => {
    const h = liveHome();
    migrateDaemonOwnedConfig({ homeDir: h });
    const telegram = (readJson(daemonStore(h))['surfaces'] as Record<string, Record<string, unknown>>)['telegram']!;
    expect(telegram).toEqual({
      enabled: true,
      botToken: 'goodvibes://secrets/goodvibes/TELEGRAM_BOT_TOKEN',
      defaultChatId: '8546431428',
      botUsername: 'goodvibes_agent_bot',
      mode: 'polling',
    });
  });

  test('the daemon keeps the binding it is actually running with', () => {
    const h = liveHome();
    migrateDaemonOwnedConfig({ homeDir: h });
    expect(readJson(daemonStore(h))['controlPlane']).toEqual({
      enabled: true, hostMode: 'network', host: '0.0.0.0', port: 3421, allowRemote: true,
    });
  });

  test('per-installation switches are NOT collected into the daemon store', () => {
    const h = liveHome();
    migrateDaemonOwnedConfig({ homeDir: h });
    const store = readJson(daemonStore(h));
    expect(store['daemon']).toBeUndefined();
    expect(store['service']).toBeUndefined();
    // They stay exactly where each installation put them.
    expect(readJson(join(h, '.goodvibes', 'agent', 'settings.json'))['daemon']).toEqual({ enabled: false });
    expect(readJson(join(h, '.goodvibes', 'tui', 'settings.json'))['daemon']).toEqual({ enabled: true, embedInProcess: false });
  });

  test('each surface keeps its own model and theme', () => {
    const h = liveHome();
    migrateDaemonOwnedConfig({ homeDir: h });
    expect(new ConfigManager({ homeDir: h, surfaceRoot: 'tui' }).get('provider.model'))
      .toBe('openai-subscriber:gpt-5.6-sol');
    expect(new ConfigManager({ homeDir: h, surfaceRoot: 'agent' }).get('provider.model'))
      .toBe('openai:gpt-5.6-sol');
  });

  test('every conflicting agent value is disclosed rather than dropped', () => {
    const h = liveHome();
    const { marker } = migrateDaemonOwnedConfig({ homeDir: h });
    const agentPath = join(h, '.goodvibes', 'agent', 'settings.json');
    const conflicts = marker.discarded
      .filter((entry) => entry.from === agentPath && entry.reason === 'conflict')
      .map((entry) => entry.key)
      .sort();
    expect(conflicts).toEqual([
      'controlPlane.allowRemote',
      'controlPlane.enabled',
      'controlPlane.host',
      'controlPlane.hostMode',
      'surfaces.telegram.botToken',
      'surfaces.telegram.defaultChatId',
      'watchers.enabled',
    ]);
    // The discarded token reference is legible in the record — a user has to be
    // able to see that the agent was pointing at a different secret name.
    const token = marker.discarded.find(
      (entry) => entry.from === agentPath && entry.key === 'surfaces.telegram.botToken',
    );
    expect(token?.value).toBe('goodvibes://secrets/goodvibes/GOODVIBES_SURFACES_TELEGRAM_BOT_TOKEN');
  });

  test('re-running against the live layout is a no-op', () => {
    const h = liveHome();
    migrateDaemonOwnedConfig({ homeDir: h });
    const snapshot = [
      readFileSync(daemonStore(h), 'utf-8'),
      readFileSync(join(h, '.goodvibes', 'tui', 'settings.json'), 'utf-8'),
      readFileSync(join(h, '.goodvibes', 'agent', 'settings.json'), 'utf-8'),
    ];
    migrateDaemonOwnedConfig({ homeDir: h });
    expect([
      readFileSync(daemonStore(h), 'utf-8'),
      readFileSync(join(h, '.goodvibes', 'tui', 'settings.json'), 'utf-8'),
      readFileSync(join(h, '.goodvibes', 'agent', 'settings.json'), 'utf-8'),
    ]).toEqual(snapshot);
  });

  test('no daemon-owned key remains in any surface file afterwards', () => {
    const h = liveHome();
    migrateDaemonOwnedConfig({ homeDir: h });
    for (const surface of ['tui', 'agent', 'app']) {
      const raw = readJson(join(h, '.goodvibes', surface, 'settings.json'));
      for (const domain of ['surfaces', 'controlPlane', 'watchers', 'atRest', 'device']) {
        expect(raw[domain]).toBeUndefined();
      }
    }
    expect(existsSync(daemonStore(h))).toBe(true);
  });
});
