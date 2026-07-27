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

import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonLifecycleRuntime } from '../packages/sdk/src/platform/daemon/facade-lifecycle.ts';
import { describeSecretIsolation } from '../packages/sdk/src/platform/runtime/secrets-composition.ts';

const MACHINE_HOME = '/home/owner';

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
  const scratch = mkdtempSync(join(tmpdir(), 'gv-promotion-'));
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
