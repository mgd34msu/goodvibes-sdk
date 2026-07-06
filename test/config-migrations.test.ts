/**
 * The danger.daemon removal migration.
 *
 * Removing `danger.daemon` from the schema means an existing settings.json
 * with an explicit `danger.daemon = false` (the two-year off-switch) would
 * otherwise be silently ignored by the deep-merge (the default `danger`
 * object no longer declares a `daemon` field to merge onto), flipping the
 * daemon back ON the moment a user upgrades. migrateDangerDaemonAlias closes
 * that hazard; see manager.ts load() for where it is wired in.
 */
import { describe, expect, test } from 'bun:test';
import { migrateDangerDaemonAlias } from '../packages/sdk/src/platform/config/migrations.js';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.js';
import { resolveDaemonEnabled } from '../packages/sdk/src/platform/config/index.js';
import { mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('migrateDangerDaemonAlias (pure function)', () => {
  test('explicit danger.daemon:false rewrites onto daemon.enabled:false and removes the alias', () => {
    const result = migrateDangerDaemonAlias({ danger: { daemon: false, httpListener: true } });
    expect(result.migrated).toBe(true);
    expect(result.rewroteDaemonEnabledFalse).toBe(true);
    expect(result.config['daemon']).toMatchObject({ enabled: false });
    expect(result.config['danger']).toEqual({ httpListener: true });
    expect((result.config['danger'] as Record<string, unknown>)).not.toHaveProperty('daemon');
  });

  test('explicit danger.daemon:false preserves other existing daemon.* fields', () => {
    const result = migrateDangerDaemonAlias({
      danger: { daemon: false },
      daemon: { embedInProcess: true },
    });
    expect(result.config['daemon']).toEqual({ embedInProcess: true, enabled: false });
  });

  test('explicit danger.daemon:true removes the alias without rewriting daemon.enabled (already default true)', () => {
    const result = migrateDangerDaemonAlias({ danger: { daemon: true }, daemon: { enabled: false } });
    expect(result.migrated).toBe(true);
    expect(result.rewroteDaemonEnabledFalse).toBe(false);
    // daemon.enabled is left exactly as the user set it independently of the alias.
    expect(result.config['daemon']).toEqual({ enabled: false });
    expect(result.config['danger']).toEqual({});
  });

  test('unset (no danger.daemon key) is a no-op — config returned unchanged', () => {
    const input = { danger: { httpListener: true } };
    const result = migrateDangerDaemonAlias(input);
    expect(result.migrated).toBe(false);
    expect(result.rewroteDaemonEnabledFalse).toBe(false);
    expect(result.config).toBe(input);
  });

  test('no danger section at all is a no-op', () => {
    const input = { display: { theme: 'x' } };
    const result = migrateDangerDaemonAlias(input);
    expect(result.migrated).toBe(false);
    expect(result.config).toBe(input);
  });

  test('idempotent: migrating an already-migrated config is a no-op', () => {
    const once = migrateDangerDaemonAlias({ danger: { daemon: false, httpListener: true } });
    expect(once.migrated).toBe(true);
    const twice = migrateDangerDaemonAlias(once.config);
    expect(twice.migrated).toBe(false);
    expect(twice.rewroteDaemonEnabledFalse).toBe(false);
    expect(twice.config).toEqual(once.config);
  });

  test('idempotent: migrating twice in a row converges to a fixed point', () => {
    const input = { danger: { daemon: false } };
    const first = migrateDangerDaemonAlias(input);
    const second = migrateDangerDaemonAlias(first.config);
    const third = migrateDangerDaemonAlias(second.config);
    expect(second.config).toEqual(first.config);
    expect(third.config).toEqual(first.config);
  });
});

describe('migration wired into ConfigManager.load', () => {
  function managerWithDisk(diskConfig: Record<string, unknown>): ConfigManager {
    const configDir = join(tmpdir(), `gv-migration-${Date.now()}-${crypto.randomUUID()}`);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify(diskConfig), 'utf-8');
    return new ConfigManager({ configDir });
  }

  test('an explicit legacy danger.daemon:false stays off after load (the silent-flip hazard is prevented)', () => {
    const manager = managerWithDisk({ danger: { daemon: false } });
    expect(manager.get('daemon.enabled')).toBe(false);
    expect(resolveDaemonEnabled(manager)).toBe(false);
  });

  test('unset alias (no danger.daemon on disk) stays default-on', () => {
    const manager = managerWithDisk({ display: { theme: 'vaporwave' } });
    expect(manager.get('daemon.enabled')).toBe(true);
    expect(resolveDaemonEnabled(manager)).toBe(true);
  });

  test('a legacy danger.daemon:true on disk stays default-on (no-op rewrite)', () => {
    const manager = managerWithDisk({ danger: { daemon: true } });
    expect(manager.get('daemon.enabled')).toBe(true);
    expect(resolveDaemonEnabled(manager)).toBe(true);
  });

  test('reloading the same manager instance re-applies the migration idempotently', () => {
    const manager = managerWithDisk({ danger: { daemon: false } });
    expect(resolveDaemonEnabled(manager)).toBe(false);
    manager.load();
    expect(resolveDaemonEnabled(manager)).toBe(false);
    manager.load();
    expect(resolveDaemonEnabled(manager)).toBe(false);
  });

  test('a user who explicitly sets daemon.enabled:false directly (no legacy alias) is unaffected by the migration', () => {
    const manager = managerWithDisk({ daemon: { enabled: false } });
    expect(resolveDaemonEnabled(manager)).toBe(false);
  });
});
