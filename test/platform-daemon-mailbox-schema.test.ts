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
 */

import { describe, expect, test } from 'bun:test';
import { DEFAULT_CONFIG } from '../packages/sdk/src/platform/config/schema.ts';
import { isDaemonOwnedConfigKey } from '../packages/sdk/src/platform/config/config-ownership.ts';
import {
  daemonSecretKeyFor,
  isDaemonOwnedSecretKey,
} from '../packages/sdk/src/platform/config/daemon-secret-keys.ts';
import { daemonMailboxConfigSettings } from '../packages/sdk/src/platform/config/schema-domain-daemon-mailbox.ts';

const declaredKeys = daemonMailboxConfigSettings.map((setting) => setting.key);

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
