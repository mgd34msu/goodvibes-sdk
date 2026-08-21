/**
 * connector-config-schema.test.ts
 *
 * Gate tests for promoting the mail and calendar connector's `email.*`,
 * `calendar.*` and `google.*` keys from an app-layer cast
 * (`connector-config-sections.ts`) into real CONFIG_SCHEMA rows
 * (`schema-domain-connectors.ts`).
 *
 * The defect this closes: the daemon really stores a Google client id, a
 * Gmail app-password reference and a calendar OAuth refresh token under
 * these paths, but nothing declared them to `CONFIG_SCHEMA`, so the
 * settings surface's authority (`isValidConfigKey` / `configManager.getSchema()`,
 * both reading `CONFIG_SCHEMA`) answered "Unknown setting
 * calendar.google.clientId" for a key the daemon genuinely reads and writes,
 * and a catalog query for `google.oauth.refreshToken` matched 0 of the
 * schema's rows. Modelled on test/inbound-email-config-schema.test.ts (the
 * same migration for `surfaces.email.inbound.*`) and
 * test/platform-secret-daemon-routing.test.ts (the same daemon-ownership
 * double-count regression, for `email.passwordRef` and its siblings).
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'bun:test';
import { CONFIG_SCHEMA, DEFAULT_CONFIG, isValidConfigKey } from '../packages/sdk/src/platform/config/schema.js';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.js';
import { ConfigError } from '../packages/sdk/src/platform/types/errors.js';
import {
  DAEMON_OWNED_NON_SCHEMA_CONFIG_PATHS,
  isDaemonOwnedConfigKey,
  isClientOwnedConfigKey,
  listDaemonOwnedConfigPaths,
} from '../packages/sdk/src/platform/config/config-ownership.js';
import { isDeclaredSecretBearingConfigKey } from '../packages/sdk/src/platform/config/secret-bearing-config-keys.js';

const tmpRoots: string[] = [];
afterEach(() => {
  for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A hermetic ConfigManager over a throwaway temp directory, never ~/.goodvibes. */
function freshManager(): ConfigManager {
  const root = mkdtempSync(join(tmpdir(), 'gv-connector-schema-'));
  tmpRoots.push(root);
  return new ConfigManager({ configDir: join(root, 'config') });
}

/** The 22 promoted rows, with their exact seeded default and whether the value is a secret-store reference. */
const EXPECTED: { key: string; default: unknown; secret: boolean }[] = [
  { key: 'email.enabled', default: false, secret: false },
  { key: 'email.imapHost', default: '', secret: false },
  { key: 'email.imapPort', default: 993, secret: false },
  { key: 'email.imapSecurity', default: 'tls', secret: false },
  { key: 'email.smtpHost', default: '', secret: false },
  { key: 'email.smtpPort', default: 587, secret: false },
  { key: 'email.smtpSecurity', default: 'auto', secret: false },
  { key: 'email.username', default: '', secret: false },
  { key: 'email.passwordRef', default: '', secret: true },
  { key: 'email.smtpPasswordRef', default: '', secret: true },
  { key: 'email.fromAddress', default: '', secret: false },
  { key: 'email.mailbox', default: '', secret: false },
  { key: 'email.draftsMailbox', default: '', secret: false },
  { key: 'calendar.google.clientId', default: '', secret: false },
  { key: 'calendar.google.clientSecretRef', default: '', secret: true },
  { key: 'calendar.google.icsUrl', default: '', secret: true },
  { key: 'calendar.microsoft.clientId', default: '', secret: false },
  { key: 'calendar.microsoft.clientSecretRef', default: '', secret: true },
  { key: 'google.oauth.projectId', default: '', secret: false },
  { key: 'google.oauth.publishingStatus', default: '', secret: false },
  { key: 'google.oauth.refreshToken', default: '', secret: true },
  { key: 'google.credentials.migratedFrom', default: '', secret: false },
];

/** The 19 paths that used to be hand-enumerated because nothing else declared them. */
const FORMERLY_NON_SCHEMA_PATHS = [
  'email.passwordRef',
  'email.smtpPasswordRef',
  'calendar.google.clientSecretRef',
  'calendar.microsoft.clientSecretRef',
  'google.oauth.refreshToken',
  'calendar.google.icsUrl',
  'email.enabled',
  'email.imapHost',
  'email.imapPort',
  'email.smtpHost',
  'email.smtpPort',
  'email.smtpSecurity',
  'email.username',
  'email.fromAddress',
  'calendar.google.clientId',
  'calendar.microsoft.clientId',
  'google.oauth.projectId',
  'google.oauth.publishingStatus',
  'google.credentials.migratedFrom',
];

describe('every promoted key is a real, valid CONFIG_SCHEMA row', () => {
  test.each(EXPECTED)('$key is a valid config key with a CONFIG_SCHEMA row', ({ key }) => {
    expect(isValidConfigKey(key), `${key} is not a valid ConfigKey`).toBe(true);
    const row = CONFIG_SCHEMA.find((s) => s.key === key);
    expect(row, `${key} has no CONFIG_SCHEMA row at all`).toBeDefined();
  });

  test.each(EXPECTED)('$key defaults to $default', ({ key, default: expected }) => {
    const row = CONFIG_SCHEMA.find((s) => s.key === key)!;
    expect(row.default).toBe(expected);
  });

  test('there are exactly twenty-two connector keys — not more, not fewer', () => {
    const connectorKeys = CONFIG_SCHEMA
      .map((s) => s.key)
      .filter((key) => key.startsWith('email.') || key.startsWith('calendar.') || key.startsWith('google.'));
    expect(new Set(connectorKeys).size).toBe(22);
    expect(connectorKeys.map(String).sort()).toEqual(EXPECTED.map((e) => e.key).sort());
  });

  test.each(EXPECTED)('$key is reachable through DEFAULT_CONFIG with the same default', ({ key, default: expected }) => {
    const value = key.split('.').reduce<unknown>(
      (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
      DEFAULT_CONFIG,
    );
    expect(value).toBe(expected);
  });
});

describe('every row describes itself', () => {
  test.each(EXPECTED)('$key has a real, non-empty, user-facing description', ({ key }) => {
    const row = CONFIG_SCHEMA.find((s) => s.key === key)!;
    expect(row.description.length).toBeGreaterThan(20);
    expect(row.description.toLowerCase()).not.toBe(key.toLowerCase());
  });

  test.each(EXPECTED.filter((e) => e.secret))(
    '$key is declared secret-bearing, and its description names the secret store',
    ({ key }) => {
      expect(
        isDeclaredSecretBearingConfigKey(key),
        `${key} is not in SECRET_BEARING_CONFIG_PATHS`,
      ).toBe(true);
      const row = CONFIG_SCHEMA.find((s) => s.key === key)!;
      const description = row.description.toLowerCase();
      expect(
        description.includes('secret store') || description.includes('secret tier'),
        `${key}'s description does not name the secret store: "${row.description}"`,
      ).toBe(true);
      expect(
        description.includes('never in config') || description.includes('never held in config'),
        `${key}'s description does not say the secret is never held in config: "${row.description}"`,
      ).toBe(true);
    },
  );

  test.each(EXPECTED.filter((e) => !e.secret))(
    '$key is NOT declared secret-bearing',
    ({ key }) => {
      expect(isDeclaredSecretBearingConfigKey(key)).toBe(false);
    },
  );
});

describe('every registered key resolves through a real ConfigManager without throwing', () => {
  test.each(EXPECTED)('$key reads its default rather than throwing', ({ key, default: expected }) => {
    const mgr = freshManager();
    expect(() => mgr.get(key as never)).not.toThrow();
    expect(mgr.get(key as never) as unknown).toBe(expected);
  });

  test('a write to one connector key survives a read back, and siblings keep their own defaults', () => {
    const mgr = freshManager();
    mgr.set('calendar.google.clientId' as never, 'a-client-id' as never);
    expect(mgr.get('calendar.google.clientId' as never) as unknown).toBe('a-client-id');
    expect(mgr.get('calendar.google.clientSecretRef' as never) as unknown).toBe('');
    expect(mgr.get('calendar.microsoft.clientId' as never) as unknown).toBe('');
  });

  test('imapSecurity and smtpSecurity reject a value outside their enum', () => {
    const mgr = freshManager();
    expect(() => mgr.set('email.imapSecurity' as never, 'starttls' as never)).toThrow(ConfigError);
    expect(() => mgr.set('email.imapSecurity' as never, 'tls' as never)).not.toThrow();
    expect(() => mgr.set('email.imapSecurity' as never, 'plaintext' as never)).not.toThrow();

    expect(() => mgr.set('email.smtpSecurity' as never, 'ssl' as never)).toThrow(ConfigError);
    expect(() => mgr.set('email.smtpSecurity' as never, 'auto' as never)).not.toThrow();
    expect(() => mgr.set('email.smtpSecurity' as never, 'tls' as never)).not.toThrow();
    expect(() => mgr.set('email.smtpSecurity' as never, 'starttls' as never)).not.toThrow();
  });
});

describe('every promoted key is daemon-owned, exactly once, in the owned-path walk', () => {
  test.each(EXPECTED)('$key is daemon-owned', ({ key }) => {
    expect(isDaemonOwnedConfigKey(key), `${key} is not daemon-owned`).toBe(true);
    expect(isClientOwnedConfigKey(key)).toBe(false);
  });

  test.each(EXPECTED)('$key appears exactly once in listDaemonOwnedConfigPaths()', ({ key }) => {
    const paths = listDaemonOwnedConfigPaths().map(String);
    const occurrences = paths.filter((path) => path === key).length;
    expect(occurrences, `${key} appears ${occurrences} times in listDaemonOwnedConfigPaths()`).toBe(1);
  });

  // The double-count regression this migration was explicitly required to
  // avoid: a path left on BOTH the schema and the hand-kept non-schema list
  // would appear twice in every owned-set walk.
  test.each(FORMERLY_NON_SCHEMA_PATHS)(
    '%s no longer appears in DAEMON_OWNED_NON_SCHEMA_CONFIG_PATHS',
    (path) => {
      expect(
        (DAEMON_OWNED_NON_SCHEMA_CONFIG_PATHS as readonly string[]).includes(path),
        `${path} is still on the non-schema list, so it would double-count in every owned-set walk`,
      ).toBe(false);
    },
  );

  test('conversationGate.gatedSurfaces, cluster.peers and cluster.groupMaterial are kept — they are genuinely non-scalar', () => {
    for (const kept of ['conversationGate.gatedSurfaces', 'cluster.peers', 'cluster.groupMaterial']) {
      expect((DAEMON_OWNED_NON_SCHEMA_CONFIG_PATHS as readonly string[])).toContain(kept);
    }
  });

  test('the schema definitions of the 19 formerly-non-schema paths still exist and are daemon-owned', () => {
    for (const path of FORMERLY_NON_SCHEMA_PATHS) {
      expect(isValidConfigKey(path), `${path} should now be a real schema key`).toBe(true);
      expect(isDaemonOwnedConfigKey(path)).toBe(true);
    }
  });
});
