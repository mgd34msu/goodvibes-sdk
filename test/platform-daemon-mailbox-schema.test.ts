/**
 * platform-daemon-mailbox-schema.test.ts
 *
 * The daemon's own mailbox and calendar keys are REACHABLE, from the settings
 * modal, and from the daemon secret tier.
 *
 * Two products tell operators to set these keys by name. goodvibes-webui's
 * CalendarView says "set surfaces.calendar.caldavUrl, surfaces.calendar.caldavUser,
 * and surfaces.calendar.caldavPassword in daemon config, then reload", and
 * goodvibes-tui's email handler says "Email is not configured. Set
 * surfaces.email.host, surfaces.email.user, and the email password secret."
 *
 * The schema-driven settings modal renders from CONFIG_SCHEMA. So while these
 * keys were read by handlers but declared in no schema, both products were
 * naming keys their own settings UI had no row for: the instruction was
 * correct about what to set and gave the operator nowhere to set it.
 *
 * The storage half is the same bug seen from the other side. `config-ownership`
 * derives the daemon-owned SECRET set by WALKING `listDaemonOwnedConfigPaths()`
 *, CONFIG_SCHEMA keys the daemon owns, plus a hand-kept list of non-scalar
 * paths. `surfaces.` has always been a daemon-owned PREFIX, so the predicate
 * `isDaemonOwnedConfigKey` already answered true here; but nothing ENUMERATED
 * these paths, so the walk produced no daemon-owned credential name for them
 * and `GOODVIBES_SURFACES_EMAIL_PASSWORD` was filed in whichever client silo
 * the operator was sitting in. The daemon reads none of those, so a stored mail
 * password looked set and did nothing.
 *
 * The first test below is the one that keeps this fixed going forward: it
 * SCANS the platform sources for `surfaces.email.*` / `surfaces.calendar.*`
 * string literals and requires a schema row for each. A handler that starts
 * reading a new key without declaring it fails here, rather than shipping as
 * another instruction pointing at a row that does not exist.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Glob } from 'bun';
import { CONFIG_SCHEMA, DEFAULT_CONFIG } from '../packages/sdk/src/platform/config/schema.ts';
import type { ConfigKey } from '../packages/sdk/src/platform/config/schema-types.ts';
import { isDaemonOwnedConfigKey } from '../packages/sdk/src/platform/config/config-ownership.ts';
import {
  daemonSecretKeyFor,
  isDaemonOwnedSecretKey,
} from '../packages/sdk/src/platform/config/daemon-secret-keys.ts';
import { daemonMailboxConfigSettings } from '../packages/sdk/src/platform/config/schema-domain-daemon-mailbox.ts';

const PLATFORM_ROOT = join(import.meta.dir, '..', 'packages', 'sdk', 'src', 'platform');

/** Trailing `.` catches `surfaces.email.` used as a prefix rather than a key. */
const KEY_LITERAL = /surfaces\.(?:email|calendar)\.[A-Za-z][A-Za-z0-9.]*/g;

const schemaKeys = new Set(CONFIG_SCHEMA.map((setting) => setting.key));
const declaredKeys = daemonMailboxConfigSettings.map((setting) => setting.key);

/** Every mailbox/calendar key literal that appears in the platform sources. */
function keysReadByPlatformCode(): readonly string[] {
  const found = new Set<string>();
  for (const relative of new Glob('**/*.ts').scanSync({ cwd: PLATFORM_ROOT })) {
    const source = readFileSync(join(PLATFORM_ROOT, relative), 'utf8');
    for (const match of source.matchAll(KEY_LITERAL)) {
      // A literal used as a prefix (`surfaces.email.` + name) ends in a dot
      // once the trailing segment is stripped; those are not keys.
      const key = match[0].replace(/\.$/, '');
      if (key.split('.').length < 3) continue;
      found.add(key);
    }
  }
  // The declaring file itself is the answer sheet, not a reader.
  return [...found];
}

describe('every mailbox key the daemon reads has a settings row', () => {
  const read = keysReadByPlatformCode();

  test('the scan actually found keys, so a silent regex break cannot pass this file', () => {
    expect(read.length).toBeGreaterThan(10);
  });

  test.each([...read])(
    '%s is a CONFIG_SCHEMA key, so the settings modal has a row for it',
    (key: string) => {
      expect(
        schemaKeys.has(key as ConfigKey),
        `${key} is read by platform code but declared in no schema, so the settings modal cannot show it and any instruction naming it sends the operator nowhere`,
      ).toBe(true);
    },
  );
});

describe('the declared keys are daemon-owned', () => {
  test.each(declaredKeys)('%s routes to the daemon tier, not a client silo', (key) => {
    expect(
      isDaemonOwnedConfigKey(key),
      `${key} is not daemon-owned, so a value set from a surface would land in that surface's settings file and the daemon would never read it`,
    ).toBe(true);
  });

  test.each(declaredKeys)('%s is reachable through the typed config defaults', (key) => {
    const value = key.split('.').reduce<unknown>(
      (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
      DEFAULT_CONFIG,
    );
    expect(
      value,
      `${key} has a schema row but no matching entry in DEFAULT_CONFIG, so a read before the operator sets anything returns undefined instead of the declared default`,
    ).toBeDefined();
  });
});

describe('the credentials derive daemon-owned secret names', () => {
  const passwordKeys = declaredKeys.filter((key) => key.toLowerCase().includes('password'));

  test('the mailbox and calendar passwords are all covered', () => {
    expect(passwordKeys.sort()).toEqual([
      'surfaces.calendar.caldavPassword',
      'surfaces.email.imap.password',
      'surfaces.email.imapPassword',
      'surfaces.email.password',
      'surfaces.email.smtp.password',
    ]);
  });

  test.each(passwordKeys)('%s files its secret in the daemon tier', (key) => {
    const secretKey = daemonSecretKeyFor(key);
    expect(
      isDaemonOwnedSecretKey(secretKey),
      `${secretKey} does not derive from a daemon-owned path, so an unqualified write puts the password in a client silo the daemon never reads, the exact failure where a stored password looks set and does nothing`,
    ).toBe(true);
  });

  test('the derivation is the platform one, spelled out for the key that broke', () => {
    expect(daemonSecretKeyFor('surfaces.email.password')).toBe('GOODVIBES_SURFACES_EMAIL_PASSWORD');
    expect(daemonSecretKeyFor('surfaces.calendar.caldavPassword')).toBe(
      'GOODVIBES_SURFACES_CALENDAR_CALDAV_PASSWORD',
    );
  });
});

describe('declaring them as schema keys replaced the non-scalar listing rather than doubling it', () => {
  test('no mailbox key is counted twice in the daemon-owned path walk', async () => {
    const { listDaemonOwnedConfigPaths } = await import(
      '../packages/sdk/src/platform/config/config-ownership.ts'
    );
    const paths = listDaemonOwnedConfigPaths().filter(
      (path) => path.startsWith('surfaces.email.') || path.startsWith('surfaces.calendar.'),
    );
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths.length).toBe(declaredKeys.length);
  });
});
