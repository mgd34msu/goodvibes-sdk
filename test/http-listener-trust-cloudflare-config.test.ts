/**
 * http-listener-trust-cloudflare-config.test.ts
 *
 * `trustCloudflare` decides whether the listener reads the real client IP out
 * of CF-Connecting-IP, the address the rate limiter counts against and the
 * access log records. The listener carried the whole mechanism, including the
 * published-range check that is the only thing stopping any peer from choosing
 * which address it is rate-limited as.
 *
 * It was reachable ONLY as a constructor argument. There was no config key and
 * no config fallback, unlike `trustProxy`, which has both, so no shipped
 * composition could turn it on, and the range check was dead on every daemon
 * anyone runs.
 *
 * These pin the CONFIG PATH: the key exists, it ships off, it reads through the
 * same fallback shape `trustProxy` uses, and an explicit constructor argument
 * still wins. The range semantics themselves are `isCloudflareIp`, exercised
 * here at the boundary that matters, inside a published range versus outside.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.ts';
import { runtimeConfigDefaults, runtimePrimaryConfigSettings } from '../packages/sdk/src/platform/config/schema-domain-runtime.ts';
import { isCloudflareIp } from '../packages/sdk/src/platform/daemon/http-listener.ts';

function configManager(values: Record<string, unknown> = {}): { manager: ConfigManager; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'trust-cloudflare-'));
  const manager = new ConfigManager({
    surfaceRoot: 'goodvibes',
    configDir: join(root, 'cfg'),
    workingDir: root,
    homeDir: root,
  });
  for (const [key, value] of Object.entries(values)) {
    manager.set(key as Parameters<ConfigManager['set']>[0], value as never);
  }
  return { manager, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

describe('the config key exists and mirrors trustProxy', () => {
  test('httpListener.trustCloudflare is a declared boolean setting', () => {
    const definition = runtimePrimaryConfigSettings.find((setting) => setting.key === 'httpListener.trustCloudflare');
    expect(definition).toBeDefined();
    expect(definition?.type).toBe('boolean');
    expect(definition?.default).toBe(false);
    // The description has to say the thing an operator would otherwise get
    // wrong: this key does nothing on its own.
    expect(definition?.description).toContain('httpListener.trustProxy');
  });

  test('it ships off, beside trustProxy, in the same defaults object', () => {
    expect(runtimeConfigDefaults.httpListener.trustCloudflare).toBe(false);
    expect(runtimeConfigDefaults.httpListener.trustProxy).toBe(false);
  });

  test('a fresh config reads the shipped default, and setting it reads back', () => {
    const { manager, dispose } = configManager();
    try {
      expect(manager.get('httpListener.trustCloudflare')).toBe(false);
      manager.set('httpListener.trustCloudflare', true);
      expect(manager.get('httpListener.trustCloudflare')).toBe(true);
    } finally {
      dispose();
    }
  });

  test('it is a SECOND key, not a third value of trustProxy', () => {
    // Turning one on must not turn the other on: CF-Connecting-IP is ignored
    // outright while trustProxy is false, and an operator behind an ordinary
    // reverse proxy must not silently acquire Cloudflare header trust.
    const { manager, dispose } = configManager({ 'httpListener.trustProxy': true });
    try {
      expect(manager.get('httpListener.trustProxy')).toBe(true);
      expect(manager.get('httpListener.trustCloudflare')).toBe(false);
    } finally {
      dispose();
    }
  });
});

describe('the listener resolves it the way it resolves trustProxy', () => {
  /**
   * The constructor line under test is
   * `config.trustCloudflare ?? Boolean(configManager.get('httpListener.trustCloudflare'))`,
   * the same shape as trustProxy's. Read here rather than by booting a
   * listener: constructing one binds two rate limiters and their eviction
   * sweeps, and the property this pins is the resolution, not the socket.
   */
  function resolve(explicit: boolean | undefined, configured: boolean): boolean {
    const { manager, dispose } = configManager({ 'httpListener.trustCloudflare': configured });
    try {
      return explicit ?? Boolean(manager.get('httpListener.trustCloudflare'));
    } finally {
      dispose();
    }
  }

  test('with nothing passed, the config key decides', () => {
    expect(resolve(undefined, true)).toBe(true);
    expect(resolve(undefined, false)).toBe(false);
  });

  test('an explicit constructor argument still wins, in both directions', () => {
    expect(resolve(false, true)).toBe(false);
    expect(resolve(true, false)).toBe(true);
  });
});

describe('the range check the key turns on', () => {
  test('a peer inside a published Cloudflare range is recognized', () => {
    // 173.245.48.0/20 and 2400:cb00::/32 are both on Cloudflare's published list.
    expect(isCloudflareIp('173.245.48.1')).toBe(true);
    expect(isCloudflareIp('2400:cb00::1')).toBe(true);
    // IPv4 arriving IPv6-mapped is the same peer.
    expect(isCloudflareIp('::ffff:173.245.48.1')).toBe(true);
  });

  test('a peer outside every published range is not', () => {
    // This is the header-injection case: without the range check, any of these
    // could send CF-Connecting-IP and choose the address it was counted as.
    expect(isCloudflareIp('8.8.8.8')).toBe(false);
    expect(isCloudflareIp('127.0.0.1')).toBe(false);
    expect(isCloudflareIp('192.168.1.10')).toBe(false);
    expect(isCloudflareIp('2001:db8::1')).toBe(false);
  });

  test('a missing or malformed peer address is never trusted', () => {
    expect(isCloudflareIp('')).toBe(false);
    expect(isCloudflareIp('unknown')).toBe(false);
    expect(isCloudflareIp('not-an-ip')).toBe(false);
  });
});
