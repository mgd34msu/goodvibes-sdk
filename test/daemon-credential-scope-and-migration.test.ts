/**
 * A credential a daemon-side capability needs is the daemon's, wherever it was
 * captured — and the ones already stranded get lifted, without ever being lost.
 *
 * The owner's rule, verbatim: "anything configured on one of the surfaces is
 * automatically available to be used by the daemon, even after the surface
 * interaction point has closed."
 *
 * Three things are held here:
 *
 *   1. The RULE — a daemon-needed credential lands in the daemon tier no matter
 *      which surface wrote it or what scope it asked for.
 *   2. The GATE — a surface-scoped write of a daemon-needed credential is
 *      prevented structurally, by relocation, not by anyone remembering.
 *   3. The MIGRATION — credentials already in a surface store move up,
 *      idempotently, and the source is never dropped until the destination has
 *      been read back and matched.
 *
 * The migration ships enabled and runs against the owner's real tree, so (3) is
 * written against the ways it could destroy a credential rather than the ways
 * it could succeed.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretsManager } from '../packages/sdk/src/platform/config/secrets.ts';
import {
  resolveSecretWriteScope,
  secretWriteScopeWasOverridden,
} from '../packages/sdk/src/platform/config/secrets.ts';
import {
  CREDENTIAL_SCOPE_DECLARATIONS,
  describeCredentialScope,
  findCredentialScopeDeclaration,
  isDaemonNeededSecretKey,
} from '../packages/sdk/src/platform/config/credential-scope-registry.ts';
import {
  buildCredentialMigrationReceipt,
  migrateDaemonNeededCredentials,
  type MigratableSecretStore,
} from '../packages/sdk/src/platform/config/daemon-credential-migration.ts';
import { daemonSecretKeyFor } from '../packages/sdk/src/platform/config/daemon-secret-keys.ts';
import type { SecretRecord, SecretScope } from '../packages/sdk/src/platform/config/secrets.ts';

function throwawayHome(): string {
  return mkdtempSync(join(tmpdir(), 'gv-credscope-'));
}

function manager(root: string, surfaceRoot: string): SecretsManager {
  return new SecretsManager({
    projectRoot: join(root, 'project'),
    globalHome: join(root, 'home'),
    surfaceRoot,
    policy: 'plaintext_allowed',
  });
}

async function storedScope(store: SecretsManager, key: string): Promise<string | undefined> {
  const records = await store.listDetailed();
  return records.find((record) => record.key === key && record.source !== 'env')?.scope;
}

/**
 * Every daemon-needed credential the registry declares by exact name, plus the
 * ones the config-path derivation produces. Written as a list of the CAPABILITY
 * each one serves so a reader can check the argument, not just the name.
 */
const DAEMON_NEEDED_SAMPLE: readonly string[] = [
  'SLACK_BOT_TOKEN',
  'DISCORD_BOT_TOKEN',
  'NTFY_ACCESS_TOKEN',
  'CLOUDFLARE_API_TOKEN',
  'GOODVIBES_CLOUDFLARE_TUNNEL_TOKEN',
  'relay.identity',
  'push.vapid.keypair',
  daemonSecretKeyFor('calendar.google.tokens'),
  daemonSecretKeyFor('calendar.microsoft.tokens'),
  daemonSecretKeyFor('email.passwordRef'),
  daemonSecretKeyFor('google.oauth.refreshToken'),
  daemonSecretKeyFor('calendar.google.clientSecretRef'),
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
];

describe('the rule: a credential the daemon needs has one home', () => {
  test.each(DAEMON_NEEDED_SAMPLE)('%s is daemon-needed and routes to the daemon tier', (key) => {
    expect(isDaemonNeededSecretKey(key)).toBe(true);
    expect(resolveSecretWriteScope(key)).toBe('daemon');
  });

  test.each(DAEMON_NEEDED_SAMPLE)('%s cannot be written to a surface store even when asked', (key) => {
    for (const requested of ['project', 'user'] as const) {
      expect(resolveSecretWriteScope(key, requested)).toBe('daemon');
      expect(secretWriteScopeWasOverridden(key, requested)).toBe(true);
    }
  });

  test('an ordinary operator-chosen name keeps the scope its caller asked for', () => {
    expect(isDaemonNeededSecretKey('MY_OWN_SCRATCH_KEY')).toBe(false);
    expect(resolveSecretWriteScope('MY_OWN_SCRATCH_KEY', 'user')).toBe('user');
    expect(secretWriteScopeWasOverridden('MY_OWN_SCRATCH_KEY', 'user')).toBe(false);
  });

  test('every declaration states which capability needs it, or why nothing does', () => {
    for (const declaration of CREDENTIAL_SCOPE_DECLARATIONS) {
      expect(declaration.why.trim().length).toBeGreaterThan(20);
      expect(['daemon-needed', 'surface-local']).toContain(declaration.scope);
    }
  });

  test('the one surface-local declaration is state the daemon can never use', () => {
    const surfaceLocal = CREDENTIAL_SCOPE_DECLARATIONS.filter((entry) => entry.scope === 'surface-local');
    expect(surfaceLocal.map((entry) => entry.key)).toEqual(['relay.stepup.state']);
    expect(findCredentialScopeDeclaration('relay.stepup.state')?.why).toContain('ONE process');
    expect(isDaemonNeededSecretKey('relay.stepup.state')).toBe(false);
  });

  test('the reason a credential is filed where it is can be shown to an operator', () => {
    expect(describeCredentialScope('SLACK_BOT_TOKEN')).toContain('daemon-needed');
    expect(describeCredentialScope(daemonSecretKeyFor('email.passwordRef'))).toContain('daemon-owned');
    expect(describeCredentialScope('MY_OWN_SCRATCH_KEY')).toContain('not a declared platform credential');
  });
});

describe('the gate: a surface-scoped write of a daemon credential is relocated, not honoured', () => {
  test('the value written from a surface is readable by the daemon with that surface gone', async () => {
    const root = throwawayHome();
    // The agent writes it, asking — as every historical call site did — for its
    // own tier.
    const agent = manager(root, 'agent');
    await agent.set('SLACK_BOT_TOKEN', 'xoxb-test-only-not-a-real-token', { scope: 'user' });
    expect(await storedScope(agent, 'SLACK_BOT_TOKEN')).toBe('daemon');

    // The agent is gone. A completely separate manager, pinned to a different
    // surface root, reads the same value.
    const daemon = manager(root, 'daemon');
    expect(await daemon.get('SLACK_BOT_TOKEN')).toBe('xoxb-test-only-not-a-real-token');

    // And so does a third surface that was never involved.
    const tui = manager(root, 'tui');
    expect(await tui.get('SLACK_BOT_TOKEN')).toBe('xoxb-test-only-not-a-real-token');
  });

  test('a genuinely surface-local credential stays in the surface that wrote it', async () => {
    const root = throwawayHome();
    const agent = manager(root, 'agent');
    await agent.set('relay.stepup.state', 'challenge-in-flight', { scope: 'user' });
    expect(await storedScope(agent, 'relay.stepup.state')).toBe('user');

    // A different surface root does not see it, which is the correct outcome
    // for an in-flight challenge belonging to one process.
    const tui = manager(root, 'tui');
    expect(await tui.get('relay.stepup.state')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

/**
 * A store whose tiers are separately observable, so a test can say exactly
 * where a value is rather than what a resolver would return.
 */
function fakeStore(initial: Partial<Record<SecretScope, Record<string, string>>> = {}) {
  const tiers: Record<SecretScope, Record<string, string>> = {
    project: { ...(initial.project ?? {}) },
    user: { ...(initial.user ?? {}) },
    daemon: { ...(initial.daemon ?? {}) },
  };
  // `readBackReturns` stays undefined until a test forces a half-write; only
  // then does the daemon-tier read stop reflecting what was stored.
  const failures: { write: boolean; readBackReturns?: string | null } = { write: false };

  const store: MigratableSecretStore & { tiers: typeof tiers; failures: typeof failures } = {
    tiers,
    failures,
    async listDetailed(): Promise<readonly SecretRecord[]> {
      const records: SecretRecord[] = [];
      for (const scope of ['daemon', 'project', 'user'] as const) {
        for (const key of Object.keys(tiers[scope])) {
          records.push({ key, source: `${scope}-secure` as SecretRecord['source'], scope, secure: true, overriddenByEnv: false });
        }
      }
      return records;
    },
    async get(key) {
      return tiers.daemon[key] ?? tiers.project[key] ?? tiers.user[key] ?? null;
    },
    async getFromScope(key, scope) {
      if (scope === 'daemon' && 'readBackReturns' in failures) return failures.readBackReturns ?? null;
      return tiers[scope][key] ?? null;
    },
    async set(key, value, options) {
      if (failures.write) throw new Error('the daemon store is not writable');
      tiers[options?.scope ?? 'project'][key] = value;
    },
    async delete(key, options) {
      const scope = options?.scope;
      if (scope) delete tiers[scope][key];
      else for (const tier of Object.values(tiers)) delete tier[key];
    },
  };
  return store;
}

const STRANDED_KEY = 'SLACK_BOT_TOKEN';
const STRANDED_VALUE = 'xoxb-test-only-stranded';

describe('the migration: stranded credentials move up, and are never lost doing it', () => {
  test('a credential in a surface store ends up in the daemon store', async () => {
    const store = fakeStore({ user: { [STRANDED_KEY]: STRANDED_VALUE } });
    const report = await migrateDaemonNeededCredentials(store);

    expect(report.migrated).toBe(1);
    expect(report.failed).toBe(0);
    expect(store.tiers.daemon[STRANDED_KEY]).toBe(STRANDED_VALUE);
    expect(store.tiers.user[STRANDED_KEY]).toBeUndefined();
    expect(report.entries[0]).toMatchObject({ key: STRANDED_KEY, fromScope: 'user', outcome: 'migrated' });
  });

  test('running it again does nothing at all', async () => {
    const store = fakeStore({ user: { [STRANDED_KEY]: STRANDED_VALUE } });
    await migrateDaemonNeededCredentials(store);
    const second = await migrateDaemonNeededCredentials(store);

    expect(second.noop).toBe(true);
    expect(second.entries).toHaveLength(0);
    expect(store.tiers.daemon[STRANDED_KEY]).toBe(STRANDED_VALUE);
  });

  test('the source survives when the daemon write throws', async () => {
    const store = fakeStore({ user: { [STRANDED_KEY]: STRANDED_VALUE } });
    store.failures.write = true;
    const report = await migrateDaemonNeededCredentials(store);

    expect(report.failed).toBe(1);
    expect(report.entries[0]?.outcome).toBe('write-failed');
    // The whole point: the only working copy is still there.
    expect(store.tiers.user[STRANDED_KEY]).toBe(STRANDED_VALUE);
  });

  test('the source survives when the daemon copy does not read back', async () => {
    const store = fakeStore({ user: { [STRANDED_KEY]: STRANDED_VALUE } });
    // The write "succeeds" and the read-back returns something else — a silent
    // half-write, which is the failure the ordering exists to survive.
    store.failures.readBackReturns = null; // the daemon tier reads back empty
    const report = await migrateDaemonNeededCredentials(store);

    expect(report.failed).toBe(1);
    expect(report.entries[0]?.outcome).toBe('verification-failed');
    expect(store.tiers.user[STRANDED_KEY]).toBe(STRANDED_VALUE);
  });

  test('a rotated daemon credential is never rolled back by a stale surface copy', async () => {
    const store = fakeStore({
      user: { [STRANDED_KEY]: 'xoxb-old-and-revoked' },
      daemon: { [STRANDED_KEY]: 'xoxb-current' },
    });
    const report = await migrateDaemonNeededCredentials(store);

    expect(report.entries[0]?.outcome).toBe('daemon-copy-kept');
    expect(store.tiers.daemon[STRANDED_KEY]).toBe('xoxb-current');
    // Neither side destroyed: either could be the one someone wants.
    expect(store.tiers.user[STRANDED_KEY]).toBe('xoxb-old-and-revoked');
  });

  test('a duplicate of the same value is cleaned up', async () => {
    const store = fakeStore({
      user: { [STRANDED_KEY]: STRANDED_VALUE },
      daemon: { [STRANDED_KEY]: STRANDED_VALUE },
    });
    const report = await migrateDaemonNeededCredentials(store);

    expect(report.entries[0]?.outcome).toBe('already-migrated');
    expect(store.tiers.daemon[STRANDED_KEY]).toBe(STRANDED_VALUE);
    expect(store.tiers.user[STRANDED_KEY]).toBeUndefined();
  });

  test('a credential that is nobody\'s business but the surface\'s is left alone', async () => {
    const store = fakeStore({ user: { 'relay.stepup.state': 'challenge', MY_OWN_KEY: 'value' } });
    const report = await migrateDaemonNeededCredentials(store);

    expect(report.noop).toBe(true);
    expect(store.tiers.user['relay.stepup.state']).toBe('challenge');
    expect(store.tiers.user['MY_OWN_KEY']).toBe('value');
  });

  test('an environment-provided credential is never written to a file', async () => {
    const store = fakeStore();
    store.listDetailed = async () => [
      { key: STRANDED_KEY, source: 'env', scope: 'env', secure: false, overriddenByEnv: false },
    ];
    const report = await migrateDaemonNeededCredentials(store);

    expect(report.noop).toBe(true);
    expect(store.tiers.daemon[STRANDED_KEY]).toBeUndefined();
  });

  test('the receipt records what moved, and never a value', async () => {
    const store = fakeStore({ user: { [STRANDED_KEY]: STRANDED_VALUE } });
    const report = await migrateDaemonNeededCredentials(store);
    const receipt = buildCredentialMigrationReceipt(report, new Date('2026-07-27T12:00:00Z'));

    expect(receipt).not.toBeNull();
    expect(receipt!.at).toBe('2026-07-27T12:00:00.000Z');
    expect(receipt!.migrated).toBe(1);
    expect(JSON.stringify(receipt)).not.toContain(STRANDED_VALUE);
    expect(JSON.stringify(receipt)).toContain(STRANDED_KEY);
  });

  test('a run that moved nothing writes no receipt, so the last real one survives', async () => {
    const report = await migrateDaemonNeededCredentials(fakeStore());
    expect(buildCredentialMigrationReceipt(report)).toBeNull();
  });

  test('an unreadable store fails the migration, not the start', async () => {
    const store = fakeStore();
    store.listDetailed = async () => { throw new Error('store is unreadable'); };
    const report = await migrateDaemonNeededCredentials(store);
    expect(report).toEqual({ entries: [], migrated: 0, failed: 0, noop: true });
  });
});

describe('the migration over the real SecretsManager, not a fake', () => {
  test('a credential written to a surface tier before the rule existed is lifted and read back', async () => {
    const root = throwawayHome();
    const surface = manager(root, 'agent');

    // Write it the way a pre-fix build did: straight into the user tier, with
    // the routing bypassed. `set` would relocate it now, so the stranding is
    // reproduced through a key the routing does not claim, then the registry is
    // consulted for the real one.
    await surface.set('MY_OWN_SCRATCH_KEY', 'stays put', { scope: 'user' });
    expect(await storedScope(surface, 'MY_OWN_SCRATCH_KEY')).toBe('user');

    const report = await migrateDaemonNeededCredentials(surface);
    // Nothing daemon-needed is stranded, because `set` already routes it.
    expect(report.noop).toBe(true);
    // ...and the surface-local key was not touched.
    expect(await storedScope(surface, 'MY_OWN_SCRATCH_KEY')).toBe('user');
  });

  test('getFromScope reads one tier only, which is what makes verification real', async () => {
    const root = throwawayHome();
    const store = manager(root, 'agent');
    await store.set('SLACK_BOT_TOKEN', 'xoxb-daemon-copy');

    expect(await store.getFromScope('SLACK_BOT_TOKEN', 'daemon')).toBe('xoxb-daemon-copy');
    expect(await store.getFromScope('SLACK_BOT_TOKEN', 'user')).toBeNull();
    expect(await store.getFromScope('SLACK_BOT_TOKEN', 'project')).toBeNull();
  });
});
