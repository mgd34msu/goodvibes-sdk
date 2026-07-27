/**
 * platform-secret-daemon-routing.test.ts
 *
 * A credential the daemon executes with has exactly ONE home, and neither an
 * undeclared config path nor an explicit scope argument may move it.
 *
 * Two defects sat behind this file, and they compose into the same symptom —
 * a password that reports success and does nothing:
 *
 *  1. The daemon-owned SECRET set is derived by walking the ENUMERATED
 *     daemon-owned config paths, not by prefix. `surfaces.` has always been a
 *     daemon-owned prefix, so `isDaemonOwnedConfigKey('surfaces.email.password')`
 *     answered true — but nothing enumerated that path, so no daemon-owned
 *     credential was derived from it and `GOODVIBES_SURFACES_EMAIL_PASSWORD`
 *     was filed in whichever client store the operator happened to be sitting
 *     in. The daemon reads none of those.
 *
 *  2. Even for keys that WERE correctly daemon-owned, an explicit `scope`
 *     argument won. `/secrets set` passes one on every call, so the ordinary
 *     path a person takes to store a credential defeated the routing outright.
 *
 * The tests below are written against the declared paths rather than a
 * hand-copied list of secret names, so a connector path added and forgotten in
 * the ownership table fails here rather than at 3am on a machine with no
 * surface attached.
 */

import { describe, expect, test } from 'bun:test';
import {
  daemonSecretKeyFor,
  isDaemonOwnedSecretKey,
} from '../packages/sdk/src/platform/config/daemon-secret-keys.ts';
import {
  resolveSecretWriteScope,
  secretWriteScopeWasOverridden,
} from '../packages/sdk/src/platform/config/secrets.ts';
import { classifyDaemonConfigPath } from '../packages/sdk/src/platform/cluster/config-replication-policy.ts';

/**
 * Every credential the daemon's own mail and calendar handlers read.
 *
 * `surfaces.email.password` and `surfaces.calendar.caldavPassword` are the two
 * the dogfood round caught; the rest are the same class and were declared with
 * them, because a password whose host and user are stranded elsewhere is not a
 * usable credential either.
 */
const DAEMON_MAIL_AND_CALENDAR_CREDENTIAL_PATHS: readonly string[] = [
  'surfaces.email.password',
  'surfaces.email.imap.password',
  'surfaces.email.imapPassword',
  'surfaces.email.smtp.password',
  'surfaces.calendar.caldavPassword',
];

/** Correctly-routed from the start. Kept here so a regression shows up as a diff, not a silence. */
const ALREADY_CORRECT_PATHS: readonly string[] = [
  'surfaces.slack.botToken',
  'email.passwordRef',
  'calendar.google.clientSecretRef',
  'google.oauth.refreshToken',
];

describe('the daemon reads the credentials a surface stores', () => {
  test.each(DAEMON_MAIL_AND_CALENDAR_CREDENTIAL_PATHS)(
    '%s names a daemon-owned credential',
    (path) => {
      const key = daemonSecretKeyFor(path);
      expect(
        isDaemonOwnedSecretKey(key),
        `${key} is not daemon-owned, so a /secrets set from any surface files it where the daemon never looks and mail silently stops working`,
      ).toBe(true);
    },
  );

  test.each(ALREADY_CORRECT_PATHS)('%s stays daemon-owned', (path) => {
    expect(isDaemonOwnedSecretKey(daemonSecretKeyFor(path))).toBe(true);
  });

  test.each([...DAEMON_MAIL_AND_CALENDAR_CREDENTIAL_PATHS, ...ALREADY_CORRECT_PATHS])(
    '%s replicates, so a node that wins a handover can actually use the account',
    (path) => {
      expect(classifyDaemonConfigPath(path).replication).toBe('replicated');
    },
  );
});

describe('an explicit scope cannot move a daemon-owned credential', () => {
  const everyDaemonPath = [...DAEMON_MAIL_AND_CALENDAR_CREDENTIAL_PATHS, ...ALREADY_CORRECT_PATHS];

  test.each(everyDaemonPath)('%s lands in the daemon tier even when "user" is asked for', (path) => {
    const key = daemonSecretKeyFor(path);
    expect(resolveSecretWriteScope(key, 'user')).toBe('daemon');
    expect(resolveSecretWriteScope(key, 'project')).toBe('daemon');
    expect(resolveSecretWriteScope(key, 'daemon')).toBe('daemon');
    expect(resolveSecretWriteScope(key, undefined)).toBe('daemon');
  });

  test('the relocation is reported, so it is disclosed rather than silent', () => {
    const key = daemonSecretKeyFor('surfaces.email.password');
    expect(secretWriteScopeWasOverridden(key, 'user')).toBe(true);
    expect(secretWriteScopeWasOverridden(key, 'project')).toBe(true);
    // Asking for the home it was going to anyway is not an override.
    expect(secretWriteScopeWasOverridden(key, 'daemon')).toBe(false);
    expect(secretWriteScopeWasOverridden(key, undefined)).toBe(false);
  });

  test('a key nobody declared still honours the scope its caller asked for', () => {
    // The rule is narrow on purpose: it applies to credentials a daemon-owned
    // config path NAMES, and to nothing else. A bare name an operator invented
    // keeps whatever scope they chose.
    expect(isDaemonOwnedSecretKey('MY_OWN_TOKEN')).toBe(false);
    expect(resolveSecretWriteScope('MY_OWN_TOKEN', 'user')).toBe('user');
    expect(resolveSecretWriteScope('MY_OWN_TOKEN', 'project')).toBe('project');
    expect(secretWriteScopeWasOverridden('MY_OWN_TOKEN', 'user')).toBe(false);
  });

  test('an undeclared path derives no daemon-owned credential, which is what defect 1 was', () => {
    // The guard against "fix the symptom by special-casing the name": routing
    // follows the DECLARATION, so a path nobody declares still routes nowhere
    // special. That is the mechanism, and it is why declaring the paths — not
    // patching the key list — was the fix.
    const undeclared = daemonSecretKeyFor('surfaces.email.notARealSetting');
    expect(isDaemonOwnedSecretKey(undeclared)).toBe(false);
    expect(resolveSecretWriteScope(undeclared, 'user')).toBe('user');
  });
});
