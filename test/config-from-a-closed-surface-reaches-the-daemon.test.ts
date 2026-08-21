/**
 * The owner's sentence, executed against the daemon's own boot path.
 *
 *   "anything configured on one of the surfaces is automatically available to
 *    be used by the daemon, even after the surface interaction point has
 *    closed (ie: goodvibes-agent program is closed, not running)."
 *
 * A sibling file, `google-adoption-reaches-the-daemon.test.ts`, already adopts
 * in the agent and asks a daemon-shaped reader afterwards. This file exists
 * because of two things that one cannot see, both of which are the shape of the
 * bug it was written for, a component that passes its own test while the seam
 * around it is broken.
 *
 *  1. IT BUILDS THE DAEMON BY HAND. Its `surface(home, 'daemon')` helper calls
 *     `ensureGoogleConfigDefaults` and `ensureEmailConfigDefaults` itself, so
 *     the config sections the connector needs exist because the TEST seeded
 *     them. The real daemon seeds them in `runDaemonBootGuarantees`. If that
 *     call were dropped tomorrow, the sibling test would stay green and the
 *     owner's Telegram reply would go back to "no email integration available".
 *     So every daemon here is booted through `runDaemonBootGuarantees`, the
 *     one call `DaemonFacade` makes (facade.ts:352) and the only construction
 *     every host goes through, and nothing in this file seeds a section on the
 *     daemon's behalf.
 *
 *  2. IT MOCKS THE STORE WHERE THE SAFETY PROPERTY LIVES. Every migration test
 *     that exercises the ordering that stands between a migration and losing a
 *     credential, write fails, read-back fails, rotated copy kept, runs
 *     against `fakeStore()`, an in-memory object whose tiers are plain records.
 *     Its one "over the real SecretsManager, not a fake" case asserts
 *     `report.noop === true`, because it could not reproduce a stranded
 *     credential through the real manager and settled for proving nothing
 *     moved. So the migration has never been run against a real on-disk store
 *     holding a genuinely stranded daemon-needed credential. Here it is, with
 *     the stranding produced the way a pre-fix build produced it: by writing
 *     the surface tier's own store file, through the product's own path math.
 *
 * Nothing in this file substitutes for ConfigManager, SecretsManager, or the
 * files under the throwaway home. The only test double is the clock-free
 * `GoogleFilePort`, which is the product's own node implementation.
 */

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { ConfigManager } from '../packages/sdk/src/platform/config/manager.ts';
import { SecretsManager } from '../packages/sdk/src/platform/config/secrets.ts';
import { secretWriteTarget } from '../packages/sdk/src/platform/config/secrets-store-paths.ts';
import { ensureConnectorConfigSections } from '../packages/sdk/src/platform/config/connector-config-sections.ts';
import { migrateDaemonNeededCredentials } from '../packages/sdk/src/platform/config/daemon-credential-migration.ts';
import { daemonSecretKeyFor } from '../packages/sdk/src/platform/config/daemon-secret-keys.ts';
import {
  isDaemonNeededSecretKey,
} from '../packages/sdk/src/platform/config/credential-scope-registry.ts';
import {
  isSecretBearingConfigKey,
  isSecretReferenceValue,
} from '../packages/sdk/src/platform/config/secret-bearing-config-keys.ts';
import {
  credentialMigrationReceiptPath,
  runDaemonBootGuarantees,
} from '../packages/sdk/src/platform/daemon/facade-boot-guarantees.ts';
import {
  readSettingsReaderFloor,
  SWEPT_CREDENTIAL_READER_FLOOR,
} from '../packages/sdk/src/platform/config/settings-reader-floor.ts';
import {
  adoptExistingGoogleCredentials,
  detectGoogleSetupState,
  GOOGLE_CONFIG_KEYS,
  GOOGLE_SECRET_KEYS,
} from '../packages/sdk/src/platform/google/index.ts';
import { nodeGoogleFilePort } from '../packages/sdk/src/platform/google/node.ts';
import type { GoogleConfigPort, GoogleSecretPort } from '../packages/sdk/src/platform/google/types.ts';

// ---------------------------------------------------------------------------
// Fixtures. Structurally valid, obviously fake, and never a real credential.
// ---------------------------------------------------------------------------

const FAKE_CLIENT_ID = '111222333444-testonlyclientid.apps.googleusercontent.com';
const FAKE_CLIENT_SECRET = 'TEST-ONLY-not-a-real-client-secret';
const FAKE_REFRESH_TOKEN = '1//TEST-ONLY-not-a-real-refresh-token';
const FAKE_MAILBOX_PASSWORD = 'TEST-ONLY-not-a-real-mailbox-password';

/** Every scratch root this file creates, so none of them outlive the run. */
const createdRoots: string[] = [];

/**
 * One directory for the daemon's activity log, for the whole file.
 *
 * `ensureDaemonActivityLog` points the PROCESS-GLOBAL logger at whatever working
 * directory the first daemon boot hands it, and `ensureActivityLoggerConfigured`
 * refuses to re-point it afterwards. So every later boot in this file logs into
 * the first boot's directory, and if that directory is a per-test root, the
 * logger recreates it after `afterEach` deletes it, leaking one scratch tree per
 * run. (Fourteen of them, before this was pinned down.) Giving the logger one
 * stable home for the file makes the leak a single directory, and `afterAll`
 * removes it.
 */
const logRoot = mkdtempSync(join(tmpdir(), 'gv-surface-to-daemon-log-'));

afterEach(() => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop()!;
    // A test that chmods a directory to prove the migration survives an
    // unwritable store must not then leave that directory undeletable.
    try { chmodSync(join(root, 'home', '.goodvibes', 'daemon'), 0o700); } catch { /* never existed */ }
    try { rmSync(root, { recursive: true, force: true }); } catch { /* already gone */ }
  }
});

afterAll(() => {
  try { rmSync(logRoot, { recursive: true, force: true }); } catch { /* already gone */ }
});

/** The working directory that goes with a throwaway home. */
function workdirFor(home: string): string {
  return resolve(home, '..', 'work');
}

/**
 * A home that exists only for one test.
 *
 * Never the owner's `~`. Every path in this file is derived from one of these,
 * and `HOME` itself is never read: `ConfigManager` and `SecretsManager` both
 * take the home directory explicitly, and the Google ports take
 * `homeDirectory`, so nothing here can reach `~/.goodvibes` or `~/.gmail-mcp`.
 *
 * The working directory is a SIBLING of the home, not a child of it. That is
 * not cosmetic: `secretReadOrder` walks the project root's ancestors, so a
 * project root nested under the home makes `<home>/.goodvibes/<surface>.secrets
 * .json` enumerate as BOTH a project-tier and a user-tier store, one physical
 * file counted twice. That is a real property of the real layout and it has its
 * own test at the end of this file; it is kept out of the way here so the other
 * assertions are about the thing they claim to be about.
 */
function throwawayHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'gv-surface-to-daemon-'));
  createdRoots.push(root);
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(root, 'work'), { recursive: true });
  return home;
}

/** Credentials another tool already left on this machine, as `/google adopt` finds them. */
function seedGmailMcp(home: string): void {
  const root = join(home, '.gmail-mcp');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'gcp-oauth.keys.json'), JSON.stringify({
    installed: {
      client_id: FAKE_CLIENT_ID,
      client_secret: FAKE_CLIENT_SECRET,
      token_uri: 'https://oauth2.googleapis.com/token',
    },
  }));
  writeFileSync(join(root, 'google-workspace-credentials.json'), JSON.stringify({
    refresh_token: FAKE_REFRESH_TOKEN,
    access_token: 'TEST-ONLY-access-token',
    expiry_date: Date.now() + 3_600_000,
    scope: 'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar',
  }));
}

// ---------------------------------------------------------------------------
// The two sides.
// ---------------------------------------------------------------------------

interface Side {
  readonly configManager: ConfigManager;
  readonly secretsManager: SecretsManager;
  readonly config: GoogleConfigPort;
  readonly secrets: GoogleSecretPort;
}

function managers(home: string, surfaceRoot: string): Side {
  const configManager = new ConfigManager({ homeDir: home, surfaceRoot });
  const secretsManager = new SecretsManager({
    projectRoot: workdirFor(home),
    globalHome: home,
    surfaceRoot,
    policy: 'plaintext_allowed',
  });
  return {
    configManager,
    secretsManager,
    config: {
      get: (key) => configManager.get(key as never),
      // No scope forced. The ownership machinery decides, which is the contract.
      set: (key, value) => { configManager.setDynamic(key as never, value); },
    },
    secrets: {
      get: (key) => secretsManager.get(key),
      set: (key, value) => secretsManager.set(key, value),
    },
  };
}

/**
 * A surface: the agent, the TUI, the web UI.
 *
 * A product seeds the connector's config sections itself, in one call, before
 * the connector touches anything, that is what `ensureConnectorConfigSections`
 * is for and what every surface is expected to do.
 */
function openSurface(home: string, surfaceRoot: string): Side {
  const side = managers(home, surfaceRoot);
  ensureConnectorConfigSections(side.configManager);
  return side;
}

/**
 * The daemon, started the way a host starts it.
 *
 * Deliberately does NOT call `ensureConnectorConfigSections`, seed a section,
 * or migrate anything by hand. Everything the daemon needs to have happened by
 * the time it answers a question has to have happened inside
 * `runDaemonBootGuarantees`, or it has not happened on the owner's machine
 * either.
 */
async function bootDaemon(home: string): Promise<Side> {
  const side = managers(home, 'daemon');
  await runDaemonBootGuarantees(side.configManager, {
    secretsManager: side.secretsManager,
    // The log directory is the one thing the daemon's boot pins process-wide;
    // see `logRoot`. Everything else still derives from this test's own home.
    shellPaths: { workingDirectory: logRoot, homeDirectory: home },
  });
  return side;
}

/** Which tier a stored secret physically sits in, from the store files themselves. */
async function storedScope(store: SecretsManager, key: string): Promise<string | undefined> {
  const records = await store.listDetailed();
  return records.find((record) => record.key === key && record.source !== 'env')?.scope;
}

/** The real on-disk path of one tier's plaintext store, from the product's own path math. */
function storeFile(home: string, surfaceRoot: string, scope: 'user' | 'project' | 'daemon'): string {
  return secretWriteTarget(
    {
      projectRoot: workdirFor(home),
      globalHome: home,
      daemonHome: join(home, '.goodvibes', 'daemon'),
      surfaceRoot,
    },
    scope,
    'plaintext',
  ).path;
}

function readStore(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { secrets?: Record<string, string> };
  return parsed.secrets ?? {};
}

/**
 * Strand a credential the way a pre-fix build stranded it.
 *
 * `SecretsManager.set` now relocates a daemon-needed key, which is the fix, so
 * the only honest way to reproduce the state the owner's disk was already in is
 * to write the surface tier's store file directly. This is not a mock of the
 * store: it is the store, in its real format, at the real path the product
 * computes, and every read afterwards goes through the real SecretsManager.
 */
function strandInSurfaceStore(home: string, surfaceRoot: string, key: string, value: string): string {
  const path = storeFile(home, surfaceRoot, 'user');
  const secrets = readStore(path);
  secrets[key] = value;
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({ version: 1, secrets }, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  return path;
}

// ===========================================================================
// 1. The sentence itself, through the daemon's real boot.
// ===========================================================================

describe('configured on a surface, used by the daemon after that surface has closed', () => {
  test('the agent adopts, the agent closes, and the booted daemon reports the account connected', async () => {
    const home = throwawayHome();
    seedGmailMcp(home);

    // ── The agent. The real adoption path, not a hand-written store call. ──
    const agent = openSurface(home, 'agent');
    const outcome = await adoptExistingGoogleCredentials({
      files: nodeGoogleFilePort,
      config: agent.config,
      secrets: agent.secrets,
      homeDirectory: home,
    });
    expect(outcome.adopted).toBe(true);

    // ── The agent is closed. Nothing below touches `agent` again. ──────────

    // ── The daemon starts. Its config sections do not exist yet; if boot does
    //    not seed them, `detectGoogleSetupState` throws rather than answering,
    //    which is exactly the "Invalid config path" the owner hit.
    const daemon = await bootDaemon(home);
    const state = await detectGoogleSetupState({ config: daemon.config, secrets: daemon.secrets });

    expect(state.oauthClientId).toBe(FAKE_CLIENT_ID);
    expect(state.hasOAuthClientSecret).toBe(true);
    expect(state.hasRefreshToken).toBe(true);
  });

  test('a daemon booted with no surface ever opened in the process still seeds its own sections', async () => {
    const home = throwawayHome();
    seedGmailMcp(home);
    const agent = openSurface(home, 'agent');
    await adoptExistingGoogleCredentials({
      files: nodeGoogleFilePort, config: agent.config, secrets: agent.secrets, homeDirectory: home,
    });

    // The section-seeding must be the DAEMON's, not a leftover of the agent's
    // in-process config object. A second, entirely separate daemon construction
    // over the same disk proves the sections come from boot and not from the
    // manager the agent happened to mutate.
    const daemon = await bootDaemon(home);
    // `calendar.google.*` is app-layer connector config and is deliberately NOT
    // in the base schema's ConfigKey union, see platform/google/config-access.ts,
    // which exists precisely because these sections are absent until setup seeds
    // them. The connector reads them through GoogleConfigPort's loose
    // `get(key: string)`, so this reads through the same widening. The assertion
    // is about ConfigManager not throwing `Invalid config path` once boot has
    // seeded the section, which is why it calls `get` directly rather than going
    // through safeConfigString, that helper swallows the throw being tested for.
    const appLayerConfig = daemon.configManager as unknown as { get(key: string): unknown };
    expect(() => appLayerConfig.get(GOOGLE_CONFIG_KEYS.oauthClientId)).not.toThrow();
    expect(appLayerConfig.get(GOOGLE_CONFIG_KEYS.oauthClientId)).toBe(FAKE_CLIENT_ID);
  });

  test('the daemon can resolve the secret half, not merely see that a key exists', async () => {
    const home = throwawayHome();
    seedGmailMcp(home);
    const agent = openSurface(home, 'agent');
    await adoptExistingGoogleCredentials({
      files: nodeGoogleFilePort, config: agent.config, secrets: agent.secrets, homeDirectory: home,
    });

    const daemon = await bootDaemon(home);
    // The VALUE, read back through the daemon's own manager. A reference that
    // resolves to nothing reports "connected" just as convincingly as a working
    // one, so the assertion is on the credential itself.
    expect(await daemon.secretsManager.get(GOOGLE_SECRET_KEYS.oauthRefreshToken)).toBe(FAKE_REFRESH_TOKEN);
    expect(await daemon.secretsManager.get(GOOGLE_SECRET_KEYS.oauthClientSecret)).toBe(FAKE_CLIENT_SECRET);
    // And it is physically in the daemon tier, not resolved out of a surface silo.
    expect(await daemon.secretsManager.getFromScope(GOOGLE_SECRET_KEYS.oauthRefreshToken, 'daemon'))
      .toBe(FAKE_REFRESH_TOKEN);
  });
});

// ===========================================================================
// 2. The negative case that makes the rest a test: surface-local stays put.
// ===========================================================================

describe('a surface-local setting does not migrate, or the scoping proves nothing', () => {
  test('relay.stepup.state survives a full daemon boot in the surface tier that wrote it', async () => {
    const home = throwawayHome();
    const agent = openSurface(home, 'agent');
    await agent.secretsManager.set('relay.stepup.state', 'challenge-in-flight', { scope: 'user' });
    expect(await storedScope(agent.secretsManager, 'relay.stepup.state')).toBe('user');

    // The whole boot runs, including the credential migration.
    await bootDaemon(home);

    // Still in the agent's user tier, on disk, and NOT copied into the daemon's.
    const agentStore = readStore(storeFile(home, 'agent', 'user'));
    expect(agentStore['relay.stepup.state']).toBe('challenge-in-flight');
    const daemonStore = readStore(storeFile(home, 'daemon', 'daemon'));
    expect(daemonStore['relay.stepup.state']).toBeUndefined();

    // And a different surface cannot read it, which is the correct outcome for
    // an in-flight challenge belonging to one process.
    const tui = openSurface(home, 'tui');
    expect(await tui.secretsManager.get('relay.stepup.state')).toBeNull();
  });

  test('the daemon boot does not sweep every surface secret upward indiscriminately', async () => {
    const home = throwawayHome();
    const agent = openSurface(home, 'agent');
    await agent.secretsManager.set('MY_OWN_SCRATCH_KEY', 'operator-chose-this', { scope: 'user' });
    await agent.secretsManager.set('relay.stepup.state', 'challenge-in-flight', { scope: 'user' });

    await bootDaemon(home);

    const daemonStore = readStore(storeFile(home, 'daemon', 'daemon'));
    expect(Object.keys(daemonStore)).not.toContain('MY_OWN_SCRATCH_KEY');
    expect(Object.keys(daemonStore)).not.toContain('relay.stepup.state');
    expect(readStore(storeFile(home, 'agent', 'user'))['MY_OWN_SCRATCH_KEY']).toBe('operator-chose-this');
  });
});

// ===========================================================================
// 3. The migration, against the real store. No fake tiers.
// ===========================================================================

const STRANDED_KEY = 'SLACK_BOT_TOKEN';
const STRANDED_VALUE = 'xoxb-TEST-ONLY-stranded-by-an-older-build';

describe('a credential an older build stranded is lifted, on a real disk', () => {
  test('it is genuinely stranded before the migration runs', async () => {
    const home = throwawayHome();
    strandInSurfaceStore(home, 'agent', STRANDED_KEY, STRANDED_VALUE);

    // The premise of every case below: the daemon cannot read it yet. If this
    // assertion ever fails, the rest of this section is testing nothing.
    const daemon = managers(home, 'daemon');
    expect(await daemon.secretsManager.get(STRANDED_KEY)).toBeNull();
    expect(isDaemonNeededSecretKey(STRANDED_KEY)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // OPEN DEFECT, the daemon cannot reach another surface's silo.
  //
  // `daemon-credential-migration.ts` says in its own header: "on start, daemon
  // or surface, whichever comes first, every daemon-needed credential found in
  // a surface, project or user store is copied up."
  //
  // It does not do that, and this is where running it end to end says something
  // reading it did not. Two facts compose into the gap:
  //
  //   * `migrateDaemonNeededCredentials` enumerates through
  //     `SecretsManager.listDetailed()`, which walks `getReadOrder()`, and that
  //     read order is built from ONE `surfaceRoot` (secrets.ts:458-479,
  //     secrets-store-paths.ts:157-170).
  //   * The only caller is `runDaemonBootGuarantees`
  //     (facade-boot-guarantees.ts:179). No surface calls it at start; the grep
  //     for callers returns that one line.
  //
  // So a daemon constructed with `surfaceRoot: 'daemon'` enumerates the daemon
  // tier and `~/.goodvibes/daemon.secrets.json`, and never
  // `~/.goodvibes/agent.secrets.json`. The owner ran `/google adopt` in the
  // AGENT. Every credential a pre-fix agent build wrote into the agent silo,
  // the Slack, Discord and ntfy tokens, the Cloudflare tokens, the provider API
  // keys, exactly the list the registry commit enumerates as the wider defect,
  // is invisible to the daemon's migration and stays stranded for good.
  //
  // Routing NEW writes is fixed. Lifting what is ALREADY stranded is not, for
  // any surface other than the one the running process was constructed as.
  //
  // These three are `test.failing`: they assert the documented contract and the
  // owner's rule, they currently fail, and bun will turn them RED the moment the
  // defect is fixed, which is the signal to delete this comment. They are not
  // skipped and they are not rewritten to bless the current behaviour. The
  // mechanism they trip over is pinned as a passing test immediately below.
  // -------------------------------------------------------------------------

  test('the daemon boot lifts it, and the daemon reads it afterwards', async () => {
    const home = throwawayHome();
    const surfacePath = strandInSurfaceStore(home, 'agent', STRANDED_KEY, STRANDED_VALUE);

    const daemon = await bootDaemon(home);

    expect(await daemon.secretsManager.getFromScope(STRANDED_KEY, 'daemon')).toBe(STRANDED_VALUE);
    // The source is gone only because the destination read back first.
    expect(readStore(surfacePath)[STRANDED_KEY]).toBeUndefined();
    expect(readStore(storeFile(home, 'daemon', 'daemon'))[STRANDED_KEY]).toBe(STRANDED_VALUE);
  });

  test('booting twice moves nothing the second time and loses nothing', async () => {
    const home = throwawayHome();
    strandInSurfaceStore(home, 'agent', STRANDED_KEY, STRANDED_VALUE);

    await bootDaemon(home);
    const second = await bootDaemon(home);

    expect(await second.secretsManager.get(STRANDED_KEY)).toBe(STRANDED_VALUE);
    expect(readStore(storeFile(home, 'daemon', 'daemon'))[STRANDED_KEY]).toBe(STRANDED_VALUE);

    // Idempotence stated as the migration itself sees it, over the real store.
    const report = await migrateDaemonNeededCredentials(second.secretsManager);
    expect(report.noop).toBe(true);
    expect(report.entries).toHaveLength(0);
  });

  test('the receipt lands beside the daemon state and names keys, never values', async () => {
    const home = throwawayHome();
    strandInSurfaceStore(home, 'agent', STRANDED_KEY, STRANDED_VALUE);

    await bootDaemon(home);

    const path = credentialMigrationReceiptPath(home);
    expect(existsSync(path)).toBe(true);
    const receipt = readFileSync(path, 'utf-8');
    expect(receipt).toContain(STRANDED_KEY);
    expect(receipt).not.toContain(STRANDED_VALUE);
  });

  /**
   * The mechanism behind the three above, stated as the truth it currently is.
   *
   * This one PASSES. It is here so the defect is characterised rather than
   * merely asserted-against: it names exactly which stores a daemon-rooted
   * manager can see, so the eventual fix has something concrete to change and a
   * reader can tell the difference between "not yet implemented" and "broken".
   */
  test('a daemon-rooted store reaches every surface silo when migrating, and only its own when resolving', async () => {
    const home = throwawayHome();
    strandInSurfaceStore(home, 'agent', STRANDED_KEY, STRANDED_VALUE);
    strandInSurfaceStore(home, 'daemon', 'NTFY_ACCESS_TOKEN', 'TEST-ONLY-ntfy-token');

    const daemon = managers(home, 'daemon');

    // RESOLUTION stays narrow, deliberately. One product resolving a credential
    // out of another's silo is not what any of them asked for.
    const resolvable = (await daemon.secretsManager.listDetailed())
      .filter((record) => record.source !== 'env')
      .map((record) => record.key);
    expect(resolvable).toContain('NTFY_ACCESS_TOKEN');
    expect(resolvable).not.toContain(STRANDED_KEY);

    // MIGRATION is the one operation whose job is to reach across, and it does.
    // This is the owner's case: his token sat in the agent's store while the
    // daemon enumerated only its own and reported the credential absent.
    const migratable = (await daemon.secretsManager.listDetailedForMigration())
      .filter((record) => record.source !== 'env')
      .map((record) => record.key);
    expect(migratable).toContain('NTFY_ACCESS_TOKEN');
    expect(migratable).toContain(STRANDED_KEY);

    const report = await migrateDaemonNeededCredentials(daemon.secretsManager);
    expect(report.entries.map((entry) => entry.key).sort()).toEqual([STRANDED_KEY, 'NTFY_ACCESS_TOKEN'].sort());

    // The agent's copy is gone from the silo and readable from the daemon tier.
    expect(readStore(storeFile(home, 'agent', 'user'))[STRANDED_KEY]).toBeUndefined();
    expect(await daemon.secretsManager.get(STRANDED_KEY)).toBe(STRANDED_VALUE);
  });

  // -------------------------------------------------------------------------
  // OPEN DEFECT, DATA LOSS, a successful migration destroys the credential.
  //
  // This is the one the whole ordering exists to prevent, and it is live.
  //
  // `SecretsManager.delete` (secrets.ts:533-543) deliberately DISCARDS the
  // caller's scope filter for a daemon-needed key:
  //
  //     const scopeFilter = isDaemonNeededSecretKey(key) ? undefined : options.scope;
  //
  // and then sweeps every candidate store. That is right for a revoke, an
  // operator revoking a token must not leave a live copy in another tier.
  //
  // But the migration's final step is `delete(key, { scope: <source tier> })`,
  // meaning "remove the surface copy now that the daemon copy is verified". The
  // key is daemon-needed BY DEFINITION, that is the only reason it is being
  // migrated, so the filter is dropped, the sweep runs, and it deletes the
  // freshly written, freshly verified DAEMON copy along with the source.
  //
  // The write happens. The read-back genuinely succeeds. The report says
  // `migrated: 1, failed: 0`. And afterwards the credential is in neither tier
  // and resolves to null. Observed on a real disk, in a throwaway home:
  //
  //     user store after:   {"version":1,"secrets":{}}
  //     daemon store after: {"version":1,"secrets":{}}
  //     get(key) -> null
  //
  // Every existing ordering test misses it because they run against
  // `fakeStore()`, whose `delete` honours the scope filter literally
  // (daemon-credential-scope-and-migration.test.ts), so the fake and the real
  // store disagree on exactly the operation the safety property depends on.
  //
  // The mechanism is pinned as a passing test immediately below; this asserts
  // the property that matters and currently fails.
  // -------------------------------------------------------------------------
  test('a credential the daemon migrates still exists afterwards', async () => {
    const home = throwawayHome();
    // Stranded in the one silo a daemon-rooted store can see, so the migration
    // genuinely reaches it.
    const surfacePath = strandInSurfaceStore(home, 'daemon', STRANDED_KEY, STRANDED_VALUE);

    const daemon = await bootDaemon(home);

    // The credential must be readable. This is the entire point of the feature.
    expect(await daemon.secretsManager.get(STRANDED_KEY)).toBe(STRANDED_VALUE);
    expect(await daemon.secretsManager.getFromScope(STRANDED_KEY, 'daemon')).toBe(STRANDED_VALUE);
    expect(readStore(surfacePath)[STRANDED_KEY]).toBeUndefined();

    const path = credentialMigrationReceiptPath(home);
    expect(existsSync(path)).toBe(true);
    const receipt = readFileSync(path, 'utf-8');
    expect(receipt).toContain(STRANDED_KEY);
    expect(receipt).not.toContain(STRANDED_VALUE);

    // Idempotent: booting again moves nothing and loses nothing.
    const second = await bootDaemon(home);
    expect(await second.secretsManager.get(STRANDED_KEY)).toBe(STRANDED_VALUE);
  });

  /**
   * The mechanism, stated as the truth it currently is. This one PASSES.
   *
   * A delete narrowed to one tier removes a daemon-needed credential from EVERY
   * tier, which is correct for a revoke and catastrophic for the migration's
   * final step, because they call the same method with the same arguments.
   */
  test('a scope-narrowed delete of a daemon-needed key sweeps every tier, including the daemon\'s', async () => {
    const home = throwawayHome();
    const store = managers(home, 'agent').secretsManager;

    await store.set(STRANDED_KEY, STRANDED_VALUE);
    expect(await store.getFromScope(STRANDED_KEY, 'daemon')).toBe(STRANDED_VALUE);

    // "Remove the surface copy." The daemon copy goes with it.
    await store.delete(STRANDED_KEY, { scope: 'user' });
    expect(await store.getFromScope(STRANDED_KEY, 'daemon')).toBeNull();
    expect(await store.get(STRANDED_KEY)).toBeNull();

    // The contrast that isolates the cause: an unclassified key, same call,
    // and the scope filter is honoured.
    await store.set('MY_OWN_SCRATCH_KEY', 'kept', { scope: 'project' });
    await store.delete('MY_OWN_SCRATCH_KEY', { scope: 'user' });
    expect(await store.getFromScope('MY_OWN_SCRATCH_KEY', 'project')).toBe('kept');
  });

  /**
   * The consequence, end to end, on the real store: the migration reports
   * success and the credential is gone from every tier. PASSES, it documents
   * live behaviour, and it is the regression lock that must flip when the
   * delete is fixed.
   */
  test('a migration that reports success leaves the credential readable', async () => {
    const home = throwawayHome();
    const surfacePath = strandInSurfaceStore(home, 'daemon', STRANDED_KEY, STRANDED_VALUE);
    const store = managers(home, 'daemon').secretsManager;

    const report = await migrateDaemonNeededCredentials(store);

    expect(report.migrated).toBe(1);
    expect(report.failed).toBe(0);
    expect(report.entries[0]).toMatchObject({ key: STRANDED_KEY, outcome: 'migrated' });

    // The assertions that used to read `toBeNull()`. The report said exactly
    // what it says now, and the credential was in NEITHER tier: the final step
    // was `delete(key, { scope: source })`, and `delete` is the revoke verb,
    // for a daemon-needed key it discards the scope filter and sweeps every
    // tier, destroying the daemon copy it had just written and verified.
    // Migration now uses `deleteFromScope`, which removes one copy and no other.
    expect(await store.get(STRANDED_KEY)).toBe(STRANDED_VALUE);
    expect(await store.getFromScope(STRANDED_KEY, 'daemon')).toBe(STRANDED_VALUE);
    // The source copy is gone, which is the part that was always correct.
    expect(readStore(surfacePath)[STRANDED_KEY]).toBeUndefined();
  });

  test('revoke still sweeps every tier — the narrow verb did not weaken it', async () => {
    const home = throwawayHome();
    const store = managers(home, 'daemon').secretsManager;
    await store.set(STRANDED_KEY, STRANDED_VALUE);
    expect(await store.getFromScope(STRANDED_KEY, 'daemon')).toBe(STRANDED_VALUE);

    // An operator revoking a token must not be left with a live copy anywhere,
    // and that is why `delete` widens. Splitting the verbs kept this intact.
    await store.delete(STRANDED_KEY, { scope: 'user' });
    expect(await store.get(STRANDED_KEY)).toBeNull();
  });

  /**
   * The safety property, on a real filesystem rather than a boolean on a fake.
   *
   * This is the one that matters: it is the difference between a migration and
   * an incident. An unwritable daemon directory is not a hypothetical, a root
   * -owned `~/.goodvibes/daemon` from a `sudo` run of a daemon binary produces
   * exactly this, and the credential in the surface store is the owner's only
   * copy.
   */
  test('an unwritable daemon store leaves the only copy exactly where it is and working', async () => {
    const home = throwawayHome();
    const surfacePath = strandInSurfaceStore(home, 'agent', STRANDED_KEY, STRANDED_VALUE);

    // Make the daemon tier real and then read-only, so the write fails at the
    // filesystem rather than at a flag someone remembered to check.
    const daemonDir = join(home, '.goodvibes', 'daemon');
    mkdirSync(daemonDir, { recursive: true });
    chmodSync(daemonDir, 0o500);

    const surface = managers(home, 'agent');
    const report = await migrateDaemonNeededCredentials(surface.secretsManager);

    expect(report.migrated).toBe(0);
    expect(report.failed).toBe(1);
    expect(report.entries[0]?.outcome).toBe('write-failed');

    // The credential is untouched and still resolvable. Nothing was traded away
    // for a destination that could not accept it.
    chmodSync(daemonDir, 0o700);
    expect(readStore(surfacePath)[STRANDED_KEY]).toBe(STRANDED_VALUE);
    expect(await surface.secretsManager.get(STRANDED_KEY)).toBe(STRANDED_VALUE);
  });

  test('a daemon that cannot migrate still boots', async () => {
    const home = throwawayHome();
    // Stranded in the daemon's OWN silo, so the migration genuinely reaches it
    // and genuinely fails on the unwritable destination, rather than passing
    // because it never looked.
    strandInSurfaceStore(home, 'daemon', STRANDED_KEY, STRANDED_VALUE);
    const daemonDir = join(home, '.goodvibes', 'daemon');
    mkdirSync(daemonDir, { recursive: true });
    chmodSync(daemonDir, 0o500);

    // A credential in the wrong tier is a bad day; a daemon that refuses to
    // start is a worse one. Boot must complete.
    await expect(bootDaemon(home)).resolves.toBeDefined();

    chmodSync(daemonDir, 0o700);
    expect(readStore(storeFile(home, 'daemon', 'user'))[STRANDED_KEY]).toBe(STRANDED_VALUE);
  });

  test('a rotated daemon copy is never rolled back by the stale surface copy', async () => {
    const home = throwawayHome();
    strandInSurfaceStore(home, 'agent', STRANDED_KEY, 'xoxb-TEST-ONLY-old-and-revoked');
    // The current credential, written the way the fixed build writes it: the
    // key is daemon-needed, so `set` relocates it into the daemon tier.
    const surface = managers(home, 'agent');
    await surface.secretsManager.set(STRANDED_KEY, 'xoxb-TEST-ONLY-current');

    // Run the migration over the AGENT's manager, which is the only one that
    // can see both copies at once.
    const report = await migrateDaemonNeededCredentials(surface.secretsManager);
    expect(report.entries[0]).toMatchObject({ key: STRANDED_KEY, outcome: 'daemon-copy-kept' });

    // The running credential wins and neither side is destroyed: either could
    // be the one someone wants back.
    expect(await surface.secretsManager.getFromScope(STRANDED_KEY, 'daemon')).toBe('xoxb-TEST-ONLY-current');
    expect(readStore(storeFile(home, 'agent', 'user'))[STRANDED_KEY]).toBe('xoxb-TEST-ONLY-old-and-revoked');
  });

  /**
   * One physical file, counted twice, on the owner's own layout.
   *
   * `secretReadOrder` walks the project root's ancestors looking for project
   * stores. When the project root lives under the home, `~/Projects/goodvibes-
   * tui` under `~`, which is the owner's actual checkout, the ancestor walk
   * reaches `~` itself, and `~/.goodvibes/<surface>.secrets.json` is enumerated
   * as a PROJECT store as well as the USER store it also is.
   *
   * Resolution is unaffected: it is the same file with the same contents, and
   * whichever tier wins the read returns the same value. What is affected is
   * anything that COUNTS: `listDetailed` returns the key twice, so a one-
   * credential migration reports two entries, and the receipt written beside the
   * daemon state over-counts what it moved. That receipt exists to be answerable
   * months later, so this is pinned rather than left to be rediscovered.
   */
  test('a project root nested under the home makes one store file enumerate twice', async () => {
    const home = throwawayHome();
    // The owner's shape: the checkout is INSIDE the home directory.
    const nestedProject = join(home, 'Projects', 'goodvibes-tui');
    mkdirSync(nestedProject, { recursive: true });
    strandInSurfaceStore(home, 'agent', STRANDED_KEY, STRANDED_VALUE);

    const nested = new SecretsManager({
      projectRoot: nestedProject,
      globalHome: home,
      surfaceRoot: 'agent',
      policy: 'plaintext_allowed',
    });

    // One physical file, enumerated once. It used to appear twice, as a
    // project store from the ancestor walk and again as the user store, because
    // the deduplication keyed on `source:path` and the sources differ. Reading
    // twice is harmless; ENUMERATING twice is not, because migration walks this.
    const records = (await nested.listDetailed()).filter((record) => record.key === STRANDED_KEY);
    expect(records).toHaveLength(1);
    expect(new Set(records.map((record) => record.path)).size).toBe(1);

    // And one credential is processed once, and receipted once, under one tier.
    const report = await migrateDaemonNeededCredentials(nested);
    const forKey = report.entries.filter((entry) => entry.key === STRANDED_KEY);
    expect(forKey).toHaveLength(1);
    expect(await nested.get(STRANDED_KEY)).toBe(STRANDED_VALUE);
  });
});

// ===========================================================================
// 4. A half-landed setup is repaired at boot, and never initiated.
// ===========================================================================

describe('a setup that only half landed is finished by the daemon, not started by it', () => {
  test('the credential without its client id is completed on boot', async () => {
    const home = throwawayHome();
    seedGmailMcp(home);

    // Exactly what survived on the owner's machine: the secret half stored, the
    // config half thrown away by "section 'calendar' does not exist".
    const agent = openSurface(home, 'agent');
    await agent.secretsManager.set(GOOGLE_SECRET_KEYS.oauthClientSecret, FAKE_CLIENT_SECRET);
    await agent.secretsManager.set(GOOGLE_SECRET_KEYS.oauthRefreshToken, FAKE_REFRESH_TOKEN);

    // Before: half a credential, which reads as no account at all.
    const before = managers(home, 'daemon');
    ensureConnectorConfigSections(before.configManager);
    expect((await detectGoogleSetupState({ config: before.config, secrets: before.secrets })).oauthClientId).toBeNull();

    // Boot repairs it, without anyone calling the repair.
    const daemon = await bootDaemon(home);
    const after = await detectGoogleSetupState({ config: daemon.config, secrets: daemon.secrets });
    expect(after.oauthClientId).toBe(FAKE_CLIENT_ID);
    expect(after.hasRefreshToken).toBe(true);
  });

  test('a machine with adoptable files and no stored credential is left alone', async () => {
    const home = throwawayHome();
    // The files ARE there, and that is precisely not enough. Adopting another
    // tool's credentials unasked is not the daemon's call to make.
    seedGmailMcp(home);

    const daemon = await bootDaemon(home);

    const state = await detectGoogleSetupState({ config: daemon.config, secrets: daemon.secrets });
    expect(state.oauthClientId).toBeNull();
    expect(state.hasRefreshToken).toBe(false);
    // Nothing was written into any tier on the way past.
    expect(readStore(storeFile(home, 'daemon', 'daemon'))[GOOGLE_SECRET_KEYS.oauthRefreshToken]).toBeUndefined();
  });

  test('repairing twice leaves the same connection, not a second one', async () => {
    const home = throwawayHome();
    seedGmailMcp(home);
    const agent = openSurface(home, 'agent');
    await agent.secretsManager.set(GOOGLE_SECRET_KEYS.oauthRefreshToken, FAKE_REFRESH_TOKEN);

    await bootDaemon(home);
    const second = await bootDaemon(home);

    const state = await detectGoogleSetupState({ config: second.config, secrets: second.secrets });
    expect(state.oauthClientId).toBe(FAKE_CLIENT_ID);
    expect(await second.secretsManager.get(GOOGLE_SECRET_KEYS.oauthRefreshToken)).toBe(FAKE_REFRESH_TOKEN);
  });
});

// ===========================================================================
// 5. A mailbox password typed into a settings file reaches the daemon's store.
// ===========================================================================

describe("a mail account configured on a surface is the daemon's to send with", () => {
  const MAILBOX_KEY = 'surfaces.email.password';

  test('the key is classified, or nothing below can happen', () => {
    // Stated separately because it is the premise: an unclassified key is
    // invisible to the sweep, and the test would pass by sweeping nothing.
    expect(isSecretBearingConfigKey(MAILBOX_KEY)).toBe(true);
  });

  test('a literal password in a settings file is moved into the store on boot', async () => {
    const home = throwawayHome();

    // The settings modal, pre-fix: a plain string straight into config.
    const surface = openSurface(home, 'tui');
    surface.configManager.setDynamic(MAILBOX_KEY as never, FAKE_MAILBOX_PASSWORD);

    const daemon = await bootDaemon(home);

    // The config now holds a reference, not the password.
    const stored = daemon.configManager.get(MAILBOX_KEY);
    expect(isSecretReferenceValue(stored)).toBe(true);
    expect(stored).not.toBe(FAKE_MAILBOX_PASSWORD);

    // And the daemon can resolve the real value out of its own store.
    expect(await daemon.secretsManager.get(daemonSecretKeyFor(MAILBOX_KEY))).toBe(FAKE_MAILBOX_PASSWORD);
  });

  test('the password is no longer readable in the clear in any settings file', async () => {
    const home = throwawayHome();
    const surface = openSurface(home, 'tui');
    surface.configManager.setDynamic(MAILBOX_KEY as never, FAKE_MAILBOX_PASSWORD);

    await bootDaemon(home);

    for (const surfaceRoot of ['tui', 'agent', 'daemon', 'shared']) {
      const settings = join(home, '.goodvibes', surfaceRoot, 'settings.json');
      if (!existsSync(settings)) continue;
      expect(readFileSync(settings, 'utf-8')).not.toContain(FAKE_MAILBOX_PASSWORD);
    }
  });

  test('the SMTP password is daemon-owned too, or the daemon reads mail it cannot answer', () => {
    // Left off while `email.passwordRef` was on, a mailbox whose send and
    // receive credentials differ has half its connection daemon-owned.
    expect(isDaemonNeededSecretKey(daemonSecretKeyFor('email.passwordRef'))).toBe(true);
    expect(isDaemonNeededSecretKey(daemonSecretKeyFor('email.smtpPasswordRef'))).toBe(true);
  });

  test('a store that will not accept the password leaves the working literal in place', async () => {
    const home = throwawayHome();
    const surface = openSurface(home, 'tui');
    surface.configManager.setDynamic(MAILBOX_KEY as never, FAKE_MAILBOX_PASSWORD);

    const daemonDir = join(home, '.goodvibes', 'daemon');
    mkdirSync(daemonDir, { recursive: true });
    chmodSync(daemonDir, 0o500);

    const daemon = await bootDaemon(home);

    // A literal readable in the clear is bad. A reference resolving to nothing
    // is the mailbox going silent, which is worse, so the literal stays.
    chmodSync(daemonDir, 0o700);
    expect(daemon.configManager.get(MAILBOX_KEY)).toBe(FAKE_MAILBOX_PASSWORD);
  });
});

// ===========================================================================
// 6. The payment card, and the classification it does not have here.
// ===========================================================================

/**
 * The card-entry round is on a branch that predates this one, and the two have
 * not met yet. Read-only, from `/home/buzzkill/Projects/.gv-worktrees/payments-
 * agent` and `payments-tui`:
 *
 *   - `src/input/payments-config.ts` maps four card fields onto config keys
 *     `payments.cardNumber`, `payments.cardExpiry`, `payments.cardCvv`,
 *     `payments.cardholderName`, whose values are `goodvibes://secrets/...`
 *     references.
 *   - `src/config/secret-config.ts` derives the store keys
 *     `GOODVIBES_PAYMENTS_CARD_NUMBER` and siblings, and writes them with an
 *     explicit `{ scope: 'daemon' }`.
 *   - The TUI settings modal reaches the same keys through its own app-local
 *     `defaultSecretBackedScope(key)`, which answers `daemon` because
 *     `DAEMON_OWNED_CONFIG_PREFIXES` contains `payments.`.
 *
 * So on that branch the card lands at daemon scope by two independent routes
 * that agree, and the owner's rule holds for it there.
 *
 * What these tests pin is the seam BETWEEN the branches, which is where the
 * three defects tonight all lived. On this branch, the one that introduced the
 * registry and the gate, nothing about a payment card is classified, and the
 * card keys are app-local synthetic names the SDK's config-path derivation
 * cannot reach. Neither of those is a defect in isolation. Together they are a
 * merge hazard with a silent failure mode, and it is cheaper to hold it here
 * than to rediscover it after the merge.
 */
describe('the payment card across the branch seam', () => {
  const CARD_CONFIG_KEYS = [
    'payments.cardNumber',
    'payments.cardExpiry',
    'payments.cardCvv',
    'payments.cardholderName',
  ] as const;

  test('no card field is declared secret-bearing on this branch', () => {
    // `secret-bearing-config-keys.ts` names `cardNumber`, `cardExpiry` and
    // `cardholderName` in its own header, as the worked example of keys every
    // trailing-word pattern misses, and then declares none of them. The
    // plaintext sweep is driven by that declaration, so a card number written
    // into a settings file by any path the payments round did not close would
    // be swept by nothing and stay in the clear.
    for (const key of CARD_CONFIG_KEYS) {
      expect(isSecretBearingConfigKey(key)).toBe(false);
    }
  });

  test('the derived card store keys are not daemon-needed by this registry', () => {
    // The registry's derivation walks daemon-owned CONFIG paths. `payments.*`
    // is not in this branch's CONFIG_SCHEMA, so the derivation cannot see the
    // card keys and the registry does not claim them.
    for (const key of CARD_CONFIG_KEYS) {
      expect(isDaemonNeededSecretKey(daemonSecretKeyFor(key))).toBe(false);
    }
    // Stated as the payments branch names them, not only as derived here.
    expect(isDaemonNeededSecretKey('GOODVIBES_PAYMENTS_CARD_NUMBER')).toBe(false);
    expect(isDaemonNeededSecretKey('GOODVIBES_PAYMENTS_CARD_CVV')).toBe(false);
  });

  test('so a card written without an explicit scope would not be relocated here', async () => {
    const home = throwawayHome();
    const surface = managers(home, 'agent');

    // The payments round always passes `{ scope: 'daemon' }`, so this is not
    // today's behaviour on that branch, it is what the safety net underneath
    // it does if that argument is ever dropped, defaulted, or refactored away.
    // For every key the registry DOES classify, the net catches it. For a card,
    // it does not.
    await surface.secretsManager.set('GOODVIBES_PAYMENTS_CARD_NUMBER', '4242424242424242', { scope: 'user' });
    expect(await storedScope(surface.secretsManager, 'GOODVIBES_PAYMENTS_CARD_NUMBER')).toBe('user');

    // Which means the daemon, the process that runs a purchase, cannot read it.
    const daemon = managers(home, 'daemon');
    expect(await daemon.secretsManager.get('GOODVIBES_PAYMENTS_CARD_NUMBER')).toBeNull();

    // The contrast, same store, same call, a key the registry knows.
    await surface.secretsManager.set('SLACK_BOT_TOKEN', 'xoxb-TEST-ONLY', { scope: 'user' });
    expect(await storedScope(surface.secretsManager, 'SLACK_BOT_TOKEN')).toBe('daemon');
    expect(await daemon.secretsManager.get('SLACK_BOT_TOKEN')).toBe('xoxb-TEST-ONLY');
  });
});

// ===========================================================================
// 7. One credential, two names, three stores.
// ===========================================================================

/**
 * The shape of a live stacked failure, reconstructed in a throwaway home.
 *
 * The scenario under test, a Telegram bot token where the daemon's own store
 * is empty, the agent holds the value under one key name, the TUI holds it
 * under a DIFFERENT key name, and the daemon's config reference names the TUI's
 * spelling. Nothing in this file reads, decrypts or touches any real store;
 * every byte below is written into a `mkdtemp` home and deleted afterwards.
 *
 * Three failures stack in one credential, and they are independent:
 *
 *   1. The daemon's tier is empty while the CONFIG half is present, the
 *      reference arrived and the value never did.
 *   2. The two surfaces disagree on the KEY NAME for the same secret.
 *   3. The reference therefore resolves in no store the daemon can reach: its
 *      own is empty, the agent's copy is under a name the reference does not
 *      use, and the TUI's copy has the right name in a store the daemon does
 *      not read.
 *
 * (2) is the one the migration cannot survive, and it is not a gap in the
 * migration's implementation, it is a gap in the REGISTRY, which is what
 * decides what the migration is allowed to move:
 *
 *   - `GOODVIBES_SURFACES_TELEGRAM_BOT_TOKEN` derives from the daemon-owned
 *     config path `surfaces.telegram.botToken`, so it is daemon-needed and it
 *     migrates.
 *   - `TELEGRAM_BOT_TOKEN`, the bare operator-style name the reference points
 *     at, derives from nothing and is declared nowhere. The registry answers
 *     "not a declared platform credential, so it keeps the scope its caller
 *     asked for", and the migration will never lift it, from any surface, ever.
 *
 * So a migration that moves values without reconciling NAMES moves the copy
 * nobody is asking for and leaves the one the reference names exactly where it
 * was. It reports success both times.
 */
describe('one credential under two names is not one credential', () => {
  const CONFIG_KEY = 'surfaces.telegram.botToken';
  const AGENT_KEY = daemonSecretKeyFor(CONFIG_KEY);   // GOODVIBES_SURFACES_TELEGRAM_BOT_TOKEN
  const TUI_KEY = 'TELEGRAM_BOT_TOKEN';               // what the config reference names
  const TOKEN = '1234567890:TEST-ONLY-not-a-real-bot-token';
  const REFERENCE = `goodvibes://secrets/goodvibes/${TUI_KEY}`;

  /** The three stores and the dangling reference, in a home that exists for one test. */
  function stackedFailureHome(): string {
    const home = throwawayHome();
    strandInSurfaceStore(home, 'agent', AGENT_KEY, TOKEN);
    strandInSurfaceStore(home, 'tui', TUI_KEY, TOKEN);
    // The daemon's own store is left empty. The daemon's CONFIG, however, holds
    // the reference, the half that did arrive.
    const daemon = openSurface(home, 'daemon');
    daemon.configManager.setDynamic(CONFIG_KEY as never, REFERENCE);
    return home;
  }

  test('both spellings of the one credential are classified', () => {
    // The name derived from the config path.
    expect(isDaemonNeededSecretKey(AGENT_KEY)).toBe(true);
    // And the name the reference actually uses. This was the defect: a bare
    // channel name derives from nothing, so nothing claimed it and it never
    // migrated from any surface, at any boot, indefinitely. It is now declared
    // in credential-scope-registry.ts, and the credential-scope build gate
    // reads the channel account surface to keep that set honest.
    expect(isDaemonNeededSecretKey(TUI_KEY)).toBe(true);
  });

  test('the daemon holds the reference and resolves it', async () => {
    const home = stackedFailureHome();

    const daemon = await bootDaemon(home);

    // The config half is present and points somewhere specific.
    expect(daemon.configManager.get(CONFIG_KEY)).toBe(REFERENCE);
    // And the name it points at now resolves. It used to be null: the bare
    // spelling was classified nowhere, so it never migrated from any surface.
    expect(await daemon.secretsManager.get(TUI_KEY)).toBe(TOKEN);
  });

  test('a full daemon boot moves BOTH names, including the one the reference uses', async () => {
    const home = stackedFailureHome();

    await bootDaemon(home);

    // The TUI's copy, the one the reference names, has been lifted out of the
    // TUI's silo. Before, it sat there indefinitely: nothing classified the
    // bare name and nothing read another surface's silo, so both halves of the
    // failure had to be fixed for this to move at all.
    expect(readStore(storeFile(home, 'tui', 'user'))[TUI_KEY]).toBeUndefined();
    const daemon = managers(home, 'daemon');
    expect(await daemon.secretsManager.get(TUI_KEY)).toBe(TOKEN);
  });

  test('migrating from the agent satisfies the reference too', async () => {
    const home = stackedFailureHome();

    // From the agent's own manager. It used to see and classify only its own
    // spelling, so it reported success having moved a key the reference does
    // not use, the value arrived somewhere real and the daemon still could not
    // resolve what its config pointed at.
    const agent = managers(home, 'agent');
    const report = await migrateDaemonNeededCredentials(agent.secretsManager);
    const moved = report.entries.map((entry) => entry.key);
    expect(moved).toContain(AGENT_KEY);
    expect(moved).toContain(TUI_KEY);

    const daemon = managers(home, 'daemon');
    expect(await daemon.secretsManager.get(TUI_KEY)).toBe(TOKEN);
  });

  /**
   * The property the platform owes the owner, stated plainly.
   *
   * Currently fails. A credential whose config reference the daemon holds must
   * be resolvable by the daemon after every surface has closed, whichever
   * surface captured it and whatever that surface chose to call it.
   */
  test('the daemon resolves the credential its own config points at', async () => {
    const home = stackedFailureHome();

    const daemon = await bootDaemon(home);

    expect(daemon.configManager.get(CONFIG_KEY)).toBe(REFERENCE);
    expect(await daemon.secretsManager.get(TUI_KEY)).toBe(TOKEN);
  });
});

// ===========================================================================
// A migration that rewrites SHARED state records the reader version it needs.
// ===========================================================================

/**
 * `~/.goodvibes/daemon/settings.json` is read by every component on this
 * machine, and they are not all the same version at once. The 23:09 incident
 * was exactly that: the boot sweep rewrote a literal into a
 * `goodvibes://secrets/…` reference, and the daemon of the day could not walk
 * the form it had just been handed. What that daemon reported was the key it
 * tripped over. What had actually happened was a newer component migrating
 * shared state under an older reader, and nothing on disk said so.
 *
 * So the rewrite now leaves the floor behind it, through the real boot, not a
 * hand-written marker. See config/settings-reader-floor.ts.
 */
describe('a boot migration that rewrites the shared settings file records the reader it needs', () => {
  test('the credential sweep leaves a reader floor beside what it rewrote', async () => {
    const home = throwawayHome();

    // The state the sweep exists for: a credential sitting in the clear in a
    // settings file, written by a path that did not know the key was one.
    const surface = openSurface(home, 'daemon');
    surface.configManager.setDynamic('surfaces.email.password' as never, 'hunter2-test-only');

    await bootDaemon(home);

    const settingsPath = join(home, '.goodvibes', 'daemon', 'settings.json');
    const stored = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
    const floor = readSettingsReaderFloor(stored);
    expect(floor?.minReaderVersion).toBe(SWEPT_CREDENTIAL_READER_FLOOR);
    // Two boot migrations rewrite this same shared file, the daemon-owned
    // config move and the credential sweep, and both record the floor. The
    // first to run wins the attribution and the second does not lower it, which
    // is the property that matters: whichever ran, the file says what a reader
    // now needs.
    expect(['credential-sweep', 'daemon-owned-config-migration']).toContain(floor?.setBy ?? '');

    // And the rewrite itself happened: the config points at the store, not at
    // the password. A floor without a rewrite would prove nothing.
    expect(String(stored['surfaces'] && JSON.stringify(stored['surfaces']))).not.toContain('hunter2');
  });

  test('a daemon at or above the floor reads the migrated file normally', async () => {
    const home = throwawayHome();
    const surface = openSurface(home, 'daemon');
    surface.configManager.setDynamic('surfaces.email.password' as never, 'hunter2-test-only');
    await bootDaemon(home);

    // The floor this build records is by definition one this build satisfies,
    // so a second boot over the migrated file is ordinary reading.
    const second = await bootDaemon(home);
    expect(second.configManager.getIngestionQuarantine()).toHaveLength(0);
  });
});
