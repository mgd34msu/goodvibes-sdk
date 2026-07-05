/**
 * daemon.enabled default-on ruling + deprecated danger.daemon alias precedence.
 *
 * Wave 2 One-Platform ruling: the local session daemon runs BY DEFAULT
 * (`daemon.enabled`, default true, loopback-bound). `danger.daemon` is retained
 * as a deprecated alias (removal scheduled Wave 6): when a user set it explicitly
 * it takes precedence over daemon.enabled; when unset, daemon.enabled governs.
 *
 * See docs/decisions/2026-07-05-daemon-by-default.md.
 */
import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'os';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.js';
import { resolveDaemonEnabled, type DaemonEnabledReader } from '../packages/sdk/src/platform/config/index.js';
import { CONFIG_SCHEMA, DEFAULT_CONFIG } from '../packages/sdk/src/platform/config/schema.js';

// A minimal reader that returns exactly the two keys the resolver consults.
function reader(values: Partial<Record<'daemon.enabled' | 'danger.daemon', boolean>>): DaemonEnabledReader {
  return {
    get: (key) => (key in values ? values[key] : undefined),
  };
}

describe('resolveDaemonEnabled precedence', () => {
  test('default-on: alias unset, daemon.enabled true -> enabled', () => {
    expect(resolveDaemonEnabled(reader({ 'daemon.enabled': true }))).toBe(true);
  });

  test('off-switch: alias unset, daemon.enabled false -> disabled', () => {
    expect(resolveDaemonEnabled(reader({ 'daemon.enabled': false }))).toBe(false);
  });

  test('deprecated alias false WINS over daemon.enabled true (legacy opt-out honored)', () => {
    expect(resolveDaemonEnabled(reader({ 'danger.daemon': false, 'daemon.enabled': true }))).toBe(false);
  });

  test('deprecated alias true WINS over daemon.enabled false', () => {
    expect(resolveDaemonEnabled(reader({ 'danger.daemon': true, 'daemon.enabled': false }))).toBe(true);
  });

  test('alias undefined defers to daemon.enabled (does not force off)', () => {
    expect(resolveDaemonEnabled(reader({ 'danger.daemon': undefined, 'daemon.enabled': true }))).toBe(true);
  });

  test('both unset falls back to enabled (fail-safe default on)', () => {
    expect(resolveDaemonEnabled(reader({}))).toBe(true);
  });
});

describe('schema + DEFAULT_CONFIG: daemon on by default', () => {
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

  test('danger.daemon schema default is undefined (unset sentinel, deprecated)', () => {
    const setting = CONFIG_SCHEMA.find((s) => s.key === 'danger.daemon');
    expect(setting).toBeDefined();
    expect(setting!.default).toBeUndefined();
    expect(setting!.description).toContain('DEPRECATED');
  });

  test('DEFAULT_CONFIG has daemon.enabled = true and no danger.daemon default', () => {
    const cfg = DEFAULT_CONFIG as unknown as Record<string, Record<string, unknown>>;
    expect(cfg['daemon']!['enabled']).toBe(true);
    expect(cfg['danger']!['daemon']).toBeUndefined();
  });

  test('fresh ConfigManager: daemon runs by default (no user config)', () => {
    const manager = makeManager();
    expect(manager.get('daemon.enabled')).toBe(true);
    expect(manager.get('danger.daemon')).toBeUndefined();
    expect(resolveDaemonEnabled(manager)).toBe(true);
  });

  test('legacy user with danger.daemon:false stays off after the flip', () => {
    const manager = makeManager({ danger: { daemon: false } });
    expect(resolveDaemonEnabled(manager)).toBe(false);
  });

  test('new user opting out via daemon.enabled:false', () => {
    const manager = makeManager({ daemon: { enabled: false } });
    expect(resolveDaemonEnabled(manager)).toBe(false);
  });

  test('get(danger.daemon) never throws and resolves as a valid schema key', () => {
    const manager = makeManager();
    expect(() => manager.get('danger.daemon')).not.toThrow();
    expect(() => manager.get('daemon.enabled')).not.toThrow();
  });
});
