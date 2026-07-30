/**
 * daemon-isolation-guards.test.ts
 *
 * A throwaway daemon must not be able to become the machine's daemon, and must
 * not be able to read the machine's credentials.
 *
 * ── What happened ─────────────────────────────────────────────────────────
 *
 * A daemon was started from a scratchpad directory with `--daemon-home
 * /tmp/.../vhome --port 3499`. That was the whole of its "isolation". Two
 * things then went wrong in sequence:
 *
 *  1. It found the machine's service unit not running and PROMOTED ITSELF:
 *     wrote its own scratchpad `ExecStart` into
 *     `~/.config/systemd/user/goodvibes.service` and exited. systemd
 *     supervised the throwaway as the machine's daemon.
 *
 *  2. `--daemon-home` had moved its identity directory and nothing else, so it
 *     read the real home's config and the real home's credentials — including
 *     the owner's Telegram bot token. It long-polled his real bot, collided
 *     with the production daemon on the same token, and inbound Telegram
 *     stopped.
 *
 * Both halves are guarded here. Neither guard depends on the isolated process
 * reading its own settings file, because that is precisely what failed: a test
 * tree's own `service.enabled: false` opt-out was written and never read, since
 * `service.enabled` is client-owned and resolves against the REAL home.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonLifecycleRuntime } from '../packages/sdk/src/platform/daemon/facade-lifecycle.ts';
import { describeSecretIsolation } from '../packages/sdk/src/platform/runtime/secrets-composition.ts';

const MACHINE_HOME = '/home/owner';

// ---------------------------------------------------------------------------
// Scratch directories — created here, removed here
// ---------------------------------------------------------------------------

/**
 * Every scratch directory this file makes, so the cleanup removes exactly the
 * ones this run created and nothing else.
 *
 * This file used to create a throwaway home per harness and per compiled case
 * and remove only the two directories holding the compiled binaries. Every
 * `gv-promotion-…`, `gv-…-home-…` and `gv-flag-home-…` it made survived the
 * run, and the host this was measured on had accumulated roughly three
 * thousand of them from repeated runs — persisted residue with nothing reaping
 * it, on a tmpfs where each one costs inodes.
 *
 * A registry of the paths we made, rather than a glob sweep of `tmpdir()` for
 * the prefixes: another copy of this suite may be running beside this one, and
 * a prefix sweep would delete the directories it is still using out from under
 * it. `mkdtempSync` already guarantees each name is unique, so removing only
 * what we recorded is both complete for this run and incapable of touching
 * another.
 */
const scratchDirs: string[] = [];

/** `mkdtempSync`, with the result registered for removal. */
function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

afterAll(() => {
  // `force` so an already-removed directory is not an error, and each removal
  // is independent so one failure cannot strand the rest.
  for (const dir of scratchDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A directory we cannot remove must not fail the suite that made it —
      // the assertions have already run and the reason to be here is hygiene.
    }
  }
});

// ---------------------------------------------------------------------------
// Guard 1 — a daemon with an overridden home never seizes the service unit
// ---------------------------------------------------------------------------

function makePromotionHarness(options: { readonly hasOverriddenHome?: boolean | undefined }): {
  readonly runtime: DaemonLifecycleRuntime;
  readonly adopted: () => number;
  readonly exits: readonly number[];
} {
  let adopted = 0;
  const exits: number[] = [];
  const scratch = scratchDir('gv-promotion-');
  const runtime = new DaemonLifecycleRuntime({
    // `service.enabled` is deliberately TRUE here: the guard must not depend on
    // the isolated process having written its own opt-out, because that key is
    // read from the real home and the opt-out never reached it.
    configManager: { get: (key: string) => (key === 'service.enabled' ? true : undefined) } as never,
    platformServiceManager: {
      status: () => ({ installed: false, running: false }),
      install: () => { adopted += 1; },
      uninstall: () => undefined,
      restart: () => undefined,
    } as never,
    isIdle: () => true,
    updateArtifact: { version: '1.0.0', execPath: join(scratch, 'goodvibes-daemon') },
    isCompiledBinary: () => true,
    exitProcess: (code: number) => { exits.push(code); },
    markerIo: {
      read: () => null,
      write: () => undefined,
      remove: () => undefined,
    } as never,
    now: () => 0,
    ...(options.hasOverriddenHome === undefined ? {} : { hasOverriddenHome: options.hasOverriddenHome }),
  } as never);
  return { runtime, adopted: () => adopted, exits };
}

describe('boot promotion', () => {
  test('a daemon running from an overridden home does NOT adopt the machine service unit', () => {
    const h = makePromotionHarness({ hasOverriddenHome: true });
    h.runtime.onStarted();
    // This is the regression: it used to write its own scratchpad ExecStart
    // into the machine's unit and hand over.
    expect(h.adopted()).toBe(0);
    expect(h.exits).toEqual([]);
    h.runtime.onStopping(false);
  });

  test('a daemon on the machine default home still promotes, so the feature is intact', () => {
    const h = makePromotionHarness({ hasOverriddenHome: false });
    h.runtime.onStarted();
    expect(h.adopted()).toBe(1);
    h.runtime.onStopping(false);
  });

  test('an unstated home is treated as the machine default, preserving existing behaviour', () => {
    const h = makePromotionHarness({ hasOverriddenHome: undefined });
    h.runtime.onStarted();
    expect(h.adopted()).toBe(1);
    h.runtime.onStopping(false);
  });
});

// ---------------------------------------------------------------------------
// Guard 2 — isolation reports which tier still reaches the real home
// ---------------------------------------------------------------------------

describe('credential isolation is reported per tier, not as one boolean', () => {
  test('the exact configuration that leaked: daemon home moved, project root left under the real home', () => {
    const report = describeSecretIsolation({
      projectRoot: `${MACHINE_HOME}/Projects/goodvibes-tui`,
      globalHome: MACHINE_HOME,
      daemonHome: '/tmp/scratchpad/vhome',
      machineHome: MACHINE_HOME,
    });
    // The one thing the operator moved is genuinely moved...
    expect(report.daemonTierIsolated).toBe(true);
    // ...and the two they did not are exactly how the real token was reached.
    expect(report.projectTierIsolated).toBe(false);
    expect(report.userTierIsolated).toBe(false);
    expect(report.fullyIsolated).toBe(false);
    // The report has to name WHICH tier, or "not isolated" tells nobody why.
    expect(report.detail).toContain('the project tier');
    expect(report.detail).toContain('ancestors reach the real home');
    expect(report.detail).toContain('the user tier');
  });

  test('a project root anywhere beneath the machine home leaks, because the read order walks ancestors', () => {
    const report = describeSecretIsolation({
      projectRoot: `${MACHINE_HOME}/a/b/c/d/e`,
      globalHome: '/tmp/iso/home',
      daemonHome: '/tmp/iso/daemon',
      machineHome: MACHINE_HOME,
    });
    expect(report.projectTierIsolated).toBe(false);
    expect(report.fullyIsolated).toBe(false);
  });

  test('moving all three roots outside the machine home is what actually isolates', () => {
    const report = describeSecretIsolation({
      projectRoot: '/tmp/iso/project',
      globalHome: '/tmp/iso/home',
      daemonHome: '/tmp/iso/daemon',
      machineHome: MACHINE_HOME,
    });
    expect(report.fullyIsolated).toBe(true);
    expect(report.detail).toContain('no credential store resolves inside the machine home');
  });

  test('with no daemonHome override the daemon tier follows globalHome', () => {
    const leaky = describeSecretIsolation({
      projectRoot: '/tmp/iso/project',
      globalHome: MACHINE_HOME,
      machineHome: MACHINE_HOME,
    });
    expect(leaky.daemonTierIsolated).toBe(false);

    const clean = describeSecretIsolation({
      projectRoot: '/tmp/iso/project',
      globalHome: '/tmp/iso/home',
      machineHome: MACHINE_HOME,
    });
    expect(clean.daemonTierIsolated).toBe(true);
  });

  test('a sibling directory that merely shares a prefix is not "under" the machine home', () => {
    const report = describeSecretIsolation({
      projectRoot: `${MACHINE_HOME}-backup/project`,
      globalHome: `${MACHINE_HOME}-backup`,
      daemonHome: `${MACHINE_HOME}-backup/daemon`,
      machineHome: MACHINE_HOME,
    });
    expect(report.fullyIsolated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Guard 3 — `--daemon-home` governs the daemon tier, proven in a real binary
// ---------------------------------------------------------------------------

/**
 * Everything below runs a COMPILED binary, because both facts it pins were
 * invisible to every source-level test in this repository.
 *
 *  - The released daemon died mute. Measured against the shipped 1.27.0 binary
 *    in an isolated home with an unparseable `daemon/settings.json`: exit 1,
 *    zero bytes on stdout, zero bytes on stderr, and no activity log at all.
 *    The cause was not buffering and not a bypassed handler — the shipped
 *    entrypoint reports a fatal boot failure to the activity LOGGER and exits,
 *    and at that point the logger has no destination, so nothing is written
 *    anywhere and no file descriptor is ever touched.
 *
 *  - `--daemon-home` moved the identity directory and nothing else. The
 *    ConfigManager derived its daemon tier from `homedir()` regardless, so a
 *    daemon told to keep its state elsewhere still read the real home's daemon
 *    settings — the second half of the incident this file's header describes.
 *
 * Compiling is what makes these honest: it is the artifact that ships.
 */

const COMPILE_TIMEOUT_MS = 120_000;

interface CompiledEntry {
  readonly binary: string;
  readonly dir: string;
}

/** Compile one entry the way the release lane does (see toolchain buildCompileArgs). */
function compileEntry(entry: string, name: string): CompiledEntry {
  const dir = scratchDir(`gv-compiled-${name}-`);
  const binary = join(dir, name);
  const built = spawnSync(
    process.execPath,
    ['build', join(import.meta.dir, '..', entry), '--compile', '--target=bun-linux-x64', '--outfile', binary],
    { cwd: join(import.meta.dir, '..'), encoding: 'utf-8', timeout: COMPILE_TIMEOUT_MS },
  );
  if (built.status !== 0) {
    throw new Error(`compiling ${entry} failed (${built.status}): ${built.stderr ?? ''}`);
  }
  return { binary, dir };
}

interface DaemonRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run a compiled daemon entry against a throwaway home.
 *
 * `env -i`-style: the environment is built from nothing but what is passed, so
 * no ambient `GOODVIBES_*` from the developer's shell can decide the outcome.
 */
function runDaemon(binary: string, home: string, args: readonly string[] = []): DaemonRun {
  const result = spawnSync(binary, [...args], {
    encoding: 'utf-8',
    timeout: 30_000,
    env: {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      HOME: home,
      GOODVIBES_WORKING_DIR: join(home, 'work'),
    },
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** A home whose daemon tier holds exactly `settings`. */
function homeWithDaemonSettings(settings: unknown, label: string): string {
  const home = scratchDir(`gv-${label}-`);
  mkdirSync(join(home, '.goodvibes', 'daemon'), { recursive: true });
  mkdirSync(join(home, 'work'), { recursive: true });
  writeFileSync(join(home, '.goodvibes', 'daemon', 'settings.json'), JSON.stringify(settings), 'utf-8');
  return home;
}

describe('the compiled daemon says why it will not start', () => {
  let fixed: CompiledEntry;
  let legacy: CompiledEntry;

  beforeAll(() => {
    fixed = compileEntry('test/fixtures/daemon-fatal-boot-entry.ts', 'gvd');
    legacy = compileEntry('test/fixtures/daemon-fatal-boot-legacy-entry.ts', 'gvd-legacy');
  });
  // No local afterAll: both compile directories come from `scratchDir`, so the
  // file-level cleanup removes them along with every throwaway home. One
  // registry rather than two removal paths is what stopped the homes leaking.

  test('the shape that shipped writes NOTHING to either stream — the baseline', () => {
    // Not an assumption about how a compiled binary flushes: a fatal handler
    // that only calls logger.error has no descriptor to flush. This is what an
    // operator saw for 77 crash-loops, held still so nobody restores it.
    const home = homeWithDaemonSettings({}, 'legacy-home');
    const run = runDaemon(legacy.binary, home);
    expect(run.status).toBe(1);
    expect(run.stdout).toHaveLength(0);
    expect(run.stderr).toHaveLength(0);
  });

  test('an unparseable settings file names the file and the parse error on stderr', () => {
    const home = scratchDir('gv-corrupt-home-');
    mkdirSync(join(home, '.goodvibes', 'daemon'), { recursive: true });
    mkdirSync(join(home, 'work'), { recursive: true });
    const settingsPath = join(home, '.goodvibes', 'daemon', 'settings.json');
    writeFileSync(settingsPath, '{ "controlPlane": { "port": 39153 }', 'utf-8');

    const run = runDaemon(fixed.binary, home);
    expect(run.status).toBe(1);
    expect(run.stderr.length).toBeGreaterThan(0);
    expect(run.stderr).toContain(settingsPath);
    expect(run.stderr).toContain('could not be read as JSON');
  });

  test('a safety-gate refusal names the key and the reason on stderr', () => {
    const home = homeWithDaemonSettings({ permissions: { tools: { exec: 'sometimes' } } }, 'gate-home');
    const run = runDaemon(fixed.binary, home);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('permissions.tools.exec');
    expect(run.stderr).toContain('expects one of allow, prompt, deny');
  });

  test('a reader-floor refusal names both versions and the one action that fixes it', () => {
    const home = homeWithDaemonSettings({
      $goodvibes: { minReaderVersion: '99.0.0', setBy: 'credential-sweep', at: '2026-07-29T23:09:00.000Z' },
    }, 'floor-home');
    const run = runDaemon(fixed.binary, home);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('was migrated by a newer component');
    expect(run.stderr).toContain('older than the floor (99.0.0) — update it');
  });

  test('a settings file it CAN read still boots — the disclosure is not a new failure', () => {
    const home = homeWithDaemonSettings({ controlPlane: { port: 31111 } }, 'ok-home');
    const run = runDaemon(fixed.binary, home);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('RESOLVED controlPlane.port=31111');
    expect(run.stdout).toContain('QUARANTINE=[]');
  });

  test('--daemon-home moves the daemon tier: the real home\'s value does not surface', () => {
    // The sentinel lives in the REAL home, reached through HOME with no env
    // override of the daemon home — so the only thing that can redirect the
    // read is the flag itself.
    const realHome = homeWithDaemonSettings({ controlPlane: { port: 31111 } }, 'real-home');
    const flagHome = scratchDir('gv-flag-home-');
    writeFileSync(join(flagHome, 'settings.json'), JSON.stringify({ controlPlane: { port: 32222 } }), 'utf-8');

    // Without the flag, the real home answers — otherwise the sentinel proves nothing.
    const unflagged = runDaemon(fixed.binary, realHome);
    expect(unflagged.stdout).toContain('RESOLVED controlPlane.port=31111');

    const flagged = runDaemon(fixed.binary, realHome, ['--daemon-home', flagHome]);
    expect(flagged.status).toBe(0);
    expect(flagged.stdout).toContain(`BOOTED daemonTierPath=${join(flagHome, 'settings.json')}`);
    expect(flagged.stdout).toContain('RESOLVED controlPlane.port=32222');
    // The whole point: the real home's value is NOT what the daemon is running on.
    expect(flagged.stdout).not.toContain('controlPlane.port=31111');
  });
});
