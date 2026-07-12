/**
 * daemon.enabled default-on ruling.
 *
 * One-Platform ruling: the local session daemon runs BY DEFAULT
 * (`daemon.enabled`, default true, loopback-bound). The deprecated
 * `danger.daemon` alias was removed from the schema (a config migration in
 * ConfigManager.load honors any existing explicit `danger.daemon = false`
 * by rewriting it onto `daemon.enabled = false` — see
 * config-migrations.test.ts for that contract).
 *
 * See docs/decisions/2026-07-05-daemon-by-default.md.
 */
import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'os';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.js';
import { resolveDaemonEnabled, type DaemonEnabledReader } from '../packages/sdk/src/platform/config/index.js';
import { CONFIG_SCHEMA, DEFAULT_CONFIG, CONFIG_KEYS } from '../packages/sdk/src/platform/config/schema.js';

// A minimal reader that returns exactly the key the resolver consults.
function reader(values: Partial<Record<'daemon.enabled', boolean>>): DaemonEnabledReader {
  return {
    get: (key) => (key in values ? values[key] : undefined),
  };
}

describe('resolveDaemonEnabled', () => {
  test('default-on: daemon.enabled true -> enabled', () => {
    expect(resolveDaemonEnabled(reader({ 'daemon.enabled': true }))).toBe(true);
  });

  test('off-switch: daemon.enabled false -> disabled', () => {
    expect(resolveDaemonEnabled(reader({ 'daemon.enabled': false }))).toBe(false);
  });

  test('unset falls back to enabled (fail-safe default on)', () => {
    expect(resolveDaemonEnabled(reader({}))).toBe(true);
  });
});

describe('schema + DEFAULT_CONFIG: daemon on by default, danger.daemon alias removed', () => {
  function makeManager(diskConfig?: Record<string, unknown>): ConfigManager {
    const configDir = join(tmpdir(), `gv-daemon-default-${Date.now()}-${crypto.randomUUID()}`);
    mkdirSync(configDir, { recursive: true });
    if (diskConfig) {
      writeFileSync(join(configDir, 'settings.json'), JSON.stringify(diskConfig), 'utf-8');
    }
    return new ConfigManager({ configDir });
  }

  test('daemon.enabled schema default is true', () => {
    const setting = CONFIG_SCHEMA.find((s) => s.key === 'daemon.enabled');
    expect(setting).toBeDefined();
    expect(setting!.default).toBe(true);
  });

  test('danger.daemon is no longer a valid schema key (removed)', () => {
    expect(CONFIG_SCHEMA.find((s) => s.key === 'danger.daemon')).toBeUndefined();
    expect(CONFIG_KEYS.has('danger.daemon')).toBe(false);
  });

  test('DEFAULT_CONFIG has daemon.enabled = true and no danger.daemon field', () => {
    const cfg = DEFAULT_CONFIG as unknown as Record<string, Record<string, unknown>>;
    expect(cfg['daemon']!['enabled']).toBe(true);
    expect(cfg['danger']).not.toHaveProperty('daemon');
  });

  test('fresh ConfigManager: daemon runs by default (no user config)', () => {
    const manager = makeManager();
    expect(manager.get('daemon.enabled')).toBe(true);
    expect(resolveDaemonEnabled(manager)).toBe(true);
  });

  test('new user opting out via daemon.enabled:false', () => {
    const manager = makeManager({ daemon: { enabled: false } });
    expect(resolveDaemonEnabled(manager)).toBe(false);
  });

  test('legacy user with a stray danger.daemon:false on disk stays off (migrated at load)', () => {
    const manager = makeManager({ danger: { daemon: false } });
    expect(resolveDaemonEnabled(manager)).toBe(false);
    expect(manager.get('daemon.enabled')).toBe(false);
  });

  test('legacy user with a stray danger.daemon:true on disk is unaffected (already the default)', () => {
    const manager = makeManager({ danger: { daemon: true } });
    expect(resolveDaemonEnabled(manager)).toBe(true);
    expect(manager.get('daemon.enabled')).toBe(true);
  });

});
