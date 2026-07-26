/**
 * Deleting `controlPlane.baseUrl` as stored state.
 *
 * The key had zero writers: every site that configured the daemon set
 * hostMode/host/port and left the string alone, so it drifted from the real
 * bind on three axes at once — the port, the scheme, and a host typed in once
 * and passed through verbatim. The owner's own machine ended up with
 * `hostMode: network, host: 0.0.0.0` and a stored loopback URL, which is how one
 * daemon handed out two different click hosts.
 *
 * The URL is derived now, so these tests pin the three things that replace it:
 * the migration that removes the stored key, the reconciliation that reports a
 * derived URL disagreeing with the real bind, and the fact that a declared
 * external address is an override rather than a mirror.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateControlPlaneBaseUrlRemoval } from '../packages/sdk/src/platform/config/migrations.js';
import { applyControlPlaneBaseUrlMigrationPass } from '../packages/sdk/src/platform/config/manager-migration-passes.js';
import {
  deriveControlPlaneBaseUrl,
  describeDerivedBindMismatch,
  readControlPlaneBinding,
} from '../packages/sdk/src/platform/config/control-plane-base-url.js';

describe('migrateControlPlaneBaseUrlRemoval (pure function)', () => {
  test('removes a stored baseUrl and reports the value it dropped', () => {
    const result = migrateControlPlaneBaseUrlRemoval({
      controlPlane: { hostMode: 'network', host: '0.0.0.0', port: 8443, baseUrl: 'http://127.0.0.1:3421' },
    });
    expect(result.migrated).toBe(true);
    expect(result.removedValue).toBe('http://127.0.0.1:3421');
    expect(result.config['controlPlane']).toEqual({ hostMode: 'network', host: '0.0.0.0', port: 8443 });
    expect(result.config['controlPlane'] as Record<string, unknown>).not.toHaveProperty('baseUrl');
  });

  test('does NOT promote the dropped value onto publicBaseUrl', () => {
    // Carrying a stale mirror forward as an explicit external declaration would
    // preserve exactly the drift this removes.
    const result = migrateControlPlaneBaseUrlRemoval({
      controlPlane: { host: '0.0.0.0', baseUrl: 'http://127.0.0.1:3421' },
    });
    expect(result.config['controlPlane'] as Record<string, unknown>).not.toHaveProperty('publicBaseUrl');
  });

  test('drops the controlPlane section entirely when baseUrl was its only key', () => {
    const result = migrateControlPlaneBaseUrlRemoval({ controlPlane: { baseUrl: 'http://x:1' }, display: {} });
    expect(result.config).not.toHaveProperty('controlPlane');
    expect(result.config).toHaveProperty('display');
  });

  test('is idempotent — a file with no legacy key is returned untouched', () => {
    const input = { controlPlane: { hostMode: 'local', port: 3421 } };
    const result = migrateControlPlaneBaseUrlRemoval(input);
    expect(result.migrated).toBe(false);
    expect(result.config).toBe(input);
  });

  test('a non-object controlPlane section is left alone', () => {
    const input = { controlPlane: 'nonsense' };
    expect(migrateControlPlaneBaseUrlRemoval(input).migrated).toBe(false);
  });

  test('a null baseUrl still counts as present and is removed', () => {
    const result = migrateControlPlaneBaseUrlRemoval({ controlPlane: { baseUrl: null, port: 3421 } });
    expect(result.migrated).toBe(true);
    expect(result.removedValue).toBeUndefined();
    expect(result.config['controlPlane']).toEqual({ port: 3421 });
  });
});

describe('applyControlPlaneBaseUrlMigrationPass', () => {
  test('rewrites the settings file on disk and emits one receipt naming publicBaseUrl', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-cp-baseurl-'));
    const file = join(dir, 'settings.json');
    writeFileSync(file, JSON.stringify({ controlPlane: { port: 8443, baseUrl: 'http://127.0.0.1:3421' } }));

    const receipts: Array<{ id: string; text: string }> = [];
    const result = applyControlPlaneBaseUrlMigrationPass(
      JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>,
      file,
      (id, text) => receipts.push({ id, text }),
    );

    expect(result['controlPlane']).toEqual({ port: 8443 });
    const onDisk = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
    expect(onDisk['controlPlane']).toEqual({ port: 8443 });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.text).toContain('http://127.0.0.1:3421');
    expect(receipts[0]!.text).toContain('controlPlane.publicBaseUrl');
  });

  test('a file without the legacy key produces no receipt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-cp-baseurl-'));
    const file = join(dir, 'settings.json');
    const receipts: string[] = [];
    applyControlPlaneBaseUrlMigrationPass({ controlPlane: { port: 3421 } }, file, (id) => receipts.push(id));
    expect(receipts).toEqual([]);
  });
});

describe('describeDerivedBindMismatch', () => {
  const bindingOf = (values: Record<string, unknown>) =>
    readControlPlaneBinding((key) => values[key]);

  test('the owner\'s state: a wildcard network bind derives a usable loopback dial target, not drift', () => {
    const binding = bindingOf({
      'controlPlane.hostMode': 'network',
      'controlPlane.host': '0.0.0.0',
      'controlPlane.port': 8443,
    });
    expect(deriveControlPlaneBaseUrl(binding)).toBe('http://127.0.0.1:8443');
    expect(describeDerivedBindMismatch({ host: '0.0.0.0', port: 8443 }, binding)).toBeNull();
  });

  test('a port disagreement is reported — the 8443-vs-3421 case', () => {
    const binding = bindingOf({
      'controlPlane.hostMode': 'local',
      'controlPlane.host': '127.0.0.1',
      'controlPlane.port': 3421,
    });
    const message = describeDerivedBindMismatch({ host: '127.0.0.1', port: 8443 }, binding);
    expect(message).toContain('http://127.0.0.1:3421');
    expect(message).toContain('127.0.0.1:8443');
  });

  test('a host disagreement is reported', () => {
    const binding = bindingOf({
      'controlPlane.hostMode': 'custom',
      'controlPlane.host': '192.168.1.5',
      'controlPlane.port': 3421,
    });
    expect(describeDerivedBindMismatch({ host: '127.0.0.1', port: 3421 }, binding)).toContain('192.168.1.5');
  });

  test('an agreeing bind is silent', () => {
    const binding = bindingOf({
      'controlPlane.hostMode': 'local',
      'controlPlane.host': '127.0.0.1',
      'controlPlane.port': 3421,
    });
    expect(describeDerivedBindMismatch({ host: '127.0.0.1', port: 3421 }, binding)).toBeNull();
  });

  test('a declared publicBaseUrl is never reported as drift', () => {
    // A tunnel address is SUPPOSED to differ from the bind; flagging it would
    // train people to ignore the warning.
    const binding = bindingOf({
      'controlPlane.hostMode': 'local',
      'controlPlane.host': '127.0.0.1',
      'controlPlane.port': 3421,
      'controlPlane.publicBaseUrl': 'https://tunnel.example.com',
    });
    expect(describeDerivedBindMismatch({ host: '127.0.0.1', port: 3421 }, binding)).toBeNull();
    expect(deriveControlPlaneBaseUrl(binding, 'external')).toBe('https://tunnel.example.com');
    // ...and it does NOT displace the loopback answer for an on-box client.
    expect(deriveControlPlaneBaseUrl(binding, 'loopback')).toBe('http://127.0.0.1:3421');
  });

  test('TLS moves the derived scheme, which a stored string never did', () => {
    const binding = bindingOf({
      'controlPlane.hostMode': 'local',
      'controlPlane.host': '127.0.0.1',
      'controlPlane.port': 8443,
      'controlPlane.tls.mode': 'direct',
    });
    expect(deriveControlPlaneBaseUrl(binding)).toBe('https://127.0.0.1:8443');
  });
});
