/**
 * platform-google-daemon-ownership.test.ts
 *
 * The mail and calendar connection is DAEMON state, written through whichever
 * surface the operator happened to use.
 *
 * This is the property that decides whether the daemon can do anything once a
 * surface closes. Setup is a thing a person does in a UI, the agent, the TUI,
 * the web UI, but the runtime that has to act on the result at 3am is the
 * daemon. If any part of the connection lands in the surface's own silo, then
 * the moment that surface exits the daemon holds a partial credential and
 * reports "no Google account connected", and the failure looks like a
 * configuration mistake rather than a storage one.
 *
 * The half-credential case is the one worth naming, because it is the one that
 * looks fine right up until it doesn't: the refresh token was daemon-owned
 * before the client id was, and a refresh token with no client id cannot be
 * exchanged for anything. Setup would report success, the surface would keep
 * working from its own copy, and the daemon would be exactly as unable to send
 * mail as before.
 *
 * So this file asserts, for every config path and every secret name the
 * connector actually uses:
 *   - the config path is daemon-owned, so writes route to the daemon tier;
 *   - the secret name derives from a daemon-owned path, so an unqualified
 *     write files it in the daemon secret tier rather than a client silo;
 *   - the operator's mailbox and calendar replicate to the other nodes, so a
 *     node that wins a handover can actually serve them, while the
 *     "this machine already migrated its legacy files" marker does not.
 *
 * These are derived from `GOOGLE_CONFIG_KEYS`/`GOOGLE_SECRET_KEYS` rather than
 * from a hand-written list, so a path added to the connector and forgotten in
 * the ownership tables fails here instead of in production a week later.
 */

import { describe, expect, test } from 'bun:test';
import {
  GOOGLE_CONFIG_KEYS,
  GOOGLE_SECRET_KEYS,
} from '../packages/sdk/src/platform/google/setup-plan.ts';
import { isDaemonOwnedConfigKey } from '../packages/sdk/src/platform/config/config-ownership.ts';
import {
  daemonSecretKeyFor,
  isDaemonOwnedSecretKey,
} from '../packages/sdk/src/platform/config/daemon-secret-keys.ts';
import {
  classifyDaemonConfigPath,
  replicatedSecretKeys,
} from '../packages/sdk/src/platform/cluster/config-replication-policy.ts';

const CONFIG_PATHS = Object.entries(GOOGLE_CONFIG_KEYS);
const SECRET_NAMES = Object.entries(GOOGLE_SECRET_KEYS);

/**
 * The one connector path that is a statement about a single filesystem rather
 * than about the operator's accounts. Everything else must replicate.
 */
const NODE_LOCAL_CONNECTOR_PATH = 'google.credentials.migratedFrom';

describe('the mail and calendar connection is daemon-owned, not surface-owned', () => {
  test.each(CONFIG_PATHS)(
    'GOOGLE_CONFIG_KEYS.%s is daemon-owned, so setup in any surface writes the daemon tier',
    (_name, path) => {
      expect(
        isDaemonOwnedConfigKey(path),
        `${path} is not daemon-owned: setup would strand it in whichever surface ran it, and the daemon would come up unable to use the account once that surface closed`,
      ).toBe(true);
    },
  );

  test('the legacy-migration marker is daemon-owned too, so it is not re-run per surface', () => {
    expect(isDaemonOwnedConfigKey(NODE_LOCAL_CONNECTOR_PATH)).toBe(true);
  });
});

describe('the credentials land in the daemon secret tier', () => {
  test.each(SECRET_NAMES)(
    'GOOGLE_SECRET_KEYS.%s is a daemon-owned secret name',
    (_name, secretKey) => {
      expect(
        isDaemonOwnedSecretKey(secretKey),
        `${secretKey} does not derive from a daemon-owned config path, so an unqualified write files it in a client silo and a handover loses it`,
      ).toBe(true);
    },
  );

  test('every secret name is the platform derivation of its config path, not a hand-written string', () => {
    expect(GOOGLE_SECRET_KEYS.appPassword).toBe(daemonSecretKeyFor(GOOGLE_CONFIG_KEYS.emailPasswordRef));
    expect(GOOGLE_SECRET_KEYS.oauthClientSecret).toBe(daemonSecretKeyFor(GOOGLE_CONFIG_KEYS.oauthClientSecretRef));
    expect(GOOGLE_SECRET_KEYS.oauthRefreshToken).toBe(daemonSecretKeyFor(GOOGLE_CONFIG_KEYS.oauthRefreshToken));
    expect(GOOGLE_SECRET_KEYS.calendarIcsUrl).toBe(daemonSecretKeyFor(GOOGLE_CONFIG_KEYS.calendarIcsUrl));
  });
});

describe('a node that wins a handover can actually serve the account', () => {
  test.each(CONFIG_PATHS.filter(([, path]) => (path as string) !== NODE_LOCAL_CONNECTOR_PATH))(
    'GOOGLE_CONFIG_KEYS.%s replicates to the other nodes',
    (_name, path) => {
      expect(
        classifyDaemonConfigPath(path).replication,
        `${path} does not replicate, so a node taking over would be handed the responsibility without the means to meet it`,
      ).toBe('replicated');
    },
  );

  test('"this machine already migrated its legacy files" stays on that machine', () => {
    expect(classifyDaemonConfigPath(NODE_LOCAL_CONNECTOR_PATH).replication).toBe('node-local');
  });

  test.each(SECRET_NAMES)('GOOGLE_SECRET_KEYS.%s is selected for replication', (_name, secretKey) => {
    expect(
      replicatedSecretKeys().has(secretKey),
      `${secretKey} is not selected for replication, so the receiving node comes up with no way to read or send`,
    ).toBe(true);
  });
});
