/**
 * power-sleep-ownership.test.ts — sleep ownership + the owner keep-awake toggle.
 *
 * The platform had zero power-management integration (bare setTimeout
 * scheduling; no inhibitors; nothing owned the sleep edge). Now:
 * - real work (turns/agents/scheduled runs, off the runtime bus) holds an
 *   idle+sleep inhibitor, hard time-capped, released when work drains;
 * - the owner keep-awake toggle is daemon-held and INDEPENDENT of work state,
 *   with the honest per-class grant/deny split served when the OS refuses a
 *   lid-switch block;
 * - the sleep edge runs checkpoint hooks going down and catch-up hooks
 *   (re-arm + missed-receipt delivery) coming back up;
 * - a live logind proof runs on this host when the environment allows, with
 *   the honest fixture fallback (reason stated) when it does not.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { PowerManager, LID_SWITCH_HONEST_SPLIT } from '../packages/sdk/src/platform/power/manager.ts';
import { bindPowerWorkSignals } from '../packages/sdk/src/platform/power/work-signals.ts';
import { createLinuxLogindSeam, reapOrphanedInhibitors } from '../packages/sdk/src/platform/power/linux-logind.ts';
import type { PowerInhibitClass, PowerPlatformSeam } from '../packages/sdk/src/platform/power/types.ts';

/** A scriptable seam recording every acquire/release, with per-class denials. */
function fixtureSeam(options: { deny?: readonly PowerInhibitClass[] } = {}) {
  const deny = new Set(options.deny ?? []);
  const log: string[] = [];
  let sleepEdge: ((sleeping: boolean) => void) | null = null;
  const seam: PowerPlatformSeam = {
    platform: 'fixture',
    isAvailable: async () => true,
    inhibit: async (input) => {
      const granted = input.classes.filter((cls) => !deny.has(cls));
      const denied = input.classes.filter((cls) => deny.has(cls));
      if (granted.length === 0) return null;
      log.push(`acquire:${granted.join('+')} (${input.why})`);
      return {
        grantedClasses: granted,
        deniedClasses: denied,
        release: async () => {
          log.push(`release:${granted.join('+')}`);
        },
      };
    },
    onPrepareForSleep: (callback) => {
      sleepEdge = callback;
      return () => { sleepEdge = null; };
    },
  };
  return { seam, log, fireSleepEdge: (sleeping: boolean) => sleepEdge?.(sleeping) };
}

function makeManager(seam: PowerPlatformSeam, config: Record<string, unknown> = {}) {
  const stateChanges: unknown[] = [];
  const manager = new PowerManager({
    seam,
    readConfig: (key) => config[key],
    writeConfig: (key, value) => { config[key] = value; },
    onStateChanged: (state) => stateChanges.push(state),
  });
  return { manager, config, stateChanges };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('automatic work inhibition', () => {
  test('a simulated running turn holds the inhibitor with its reason; drain releases it', async () => {
    const { seam, log } = fixtureSeam();
    const { manager } = makeManager(seam);

    // A fake runtime bus delivering the real event shapes bindPowerWorkSignals reads.
    const handlers = new Map<string, (env: { event: Record<string, unknown> }) => void>();
    bindPowerWorkSignals({ on: (type, cb) => { handlers.set(type, cb); return () => {}; } }, manager);

    handlers.get('TURN_SUBMITTED')!({ event: { turnId: 't-1' } });
    await settle();
    let state = manager.getState();
    expect(state.work.held).toBe(true);
    expect(state.work.reasons).toEqual(['a turn is running']);
    expect(state.work.grantedClasses).toEqual(['idle', 'sleep']);
    expect(state.work.capExpiresAt).not.toBeNull();

    // A second piece of work overlaps; the inhibitor survives the first drain.
    handlers.get('AGENT_RUNNING')!({ event: { agentId: 'a-9' } });
    handlers.get('TURN_COMPLETED')!({ event: { turnId: 't-1' } });
    await settle();
    state = manager.getState();
    expect(state.work.held).toBe(true);
    expect(state.work.reasons).toEqual(['agent a-9 is active']);

    // Last work drains: released.
    handlers.get('AGENT_COMPLETED')!({ event: { agentId: 'a-9' } });
    await settle();
    expect(manager.getState().work.held).toBe(false);
    expect(log).toEqual([
      'acquire:idle+sleep (a turn is running)',
      'release:idle+sleep',
    ]);
  });

  test('the hard cap force-releases a wedged hold and reports it honestly', async () => {
    const { seam } = fixtureSeam();
    // A tiny cap (0.0005 min = 30ms) so the test observes the expiry live.
    const { manager } = makeManager(seam, { 'power.workInhibitMaxMinutes': 0.0005 });
    manager.holdWork('wedged', 'a hold that never drains');
    await settle();
    expect(manager.getState().work.held).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const state = manager.getState();
    expect(state.work.held).toBe(false);
    expect(state.work.capExpired).toBe(true);
    // The un-drained reason is still listed honestly.
    expect(state.work.reasons).toEqual(['a hold that never drains']);
  });

  test('power.inhibitWhileWorking=false disables automatic holds', async () => {
    const { seam, log } = fixtureSeam();
    const { manager } = makeManager(seam, { 'power.inhibitWhileWorking': false });
    manager.holdWork('t', 'work');
    await settle();
    expect(manager.getState().work.held).toBe(false);
    expect(log).toEqual([]);
  });
});

describe('the owner keep-awake toggle', () => {
  test('holds independent of work state and persists the setting', async () => {
    const { seam, log } = fixtureSeam();
    const { manager, config } = makeManager(seam);

    await manager.setKeepAwake(true);
    expect(config['power.keepAwake']).toBe(true);
    let state = manager.getState();
    expect(state.keepAwake.enabled).toBe(true);
    expect(state.keepAwake.held).toBe(true);
    expect(state.keepAwake.grantedClasses).toEqual(['idle', 'sleep', 'handle-lid-switch']);

    // Work comes and goes; the toggle's inhibitor is untouched — that's the
    // point: stay reachable after work finishes.
    manager.holdWork('t1', 'turn');
    await settle();
    manager.releaseWork('t1');
    await settle();
    state = manager.getState();
    expect(state.work.held).toBe(false);
    expect(state.keepAwake.held).toBe(true);

    await manager.setKeepAwake(false);
    expect(manager.getState().keepAwake.held).toBe(false);
    expect(log.filter((entry) => entry.startsWith('release:idle+sleep+handle-lid-switch')).length).toBe(1);
  });

  test('a persisted toggle re-applies at start()', async () => {
    const { seam } = fixtureSeam();
    const { manager } = makeManager(seam, { 'power.keepAwake': true });
    await manager.start();
    await settle();
    expect(manager.getState().keepAwake.held).toBe(true);
    await manager.stop();
  });

  test('the honest split serves when the lid-switch block is not grantable', async () => {
    const { seam } = fixtureSeam({ deny: ['handle-lid-switch'] });
    const { manager } = makeManager(seam);
    const state = await manager.setKeepAwake(true);
    expect(state.keepAwake.held).toBe(true);
    expect(state.keepAwake.grantedClasses).toEqual(['idle', 'sleep']);
    expect(state.keepAwake.deniedClasses).toEqual(['handle-lid-switch']);
    expect(state.keepAwake.note).toBe(LID_SWITCH_HONEST_SPLIT);
    expect(state.keepAwake.note).toBe('idle sleep blocked; lid-close suspend is controlled by your OS here');
  });
});

describe('sleep-edge honesty', () => {
  test('sleep runs checkpoint hooks; wake runs catch-up (re-arm + receipts)', async () => {
    const { seam, fireSleepEdge } = fixtureSeam();
    const { manager } = makeManager(seam);
    const calls: string[] = [];
    manager.onSleepEdge({
      onSleep: () => { calls.push('checkpoint'); },
      onWake: async () => {
        calls.push('re-arm:consolidation');
        calls.push('re-arm:snapshots');
        calls.push('receipts:missed-run-heartbeat');
      },
    });
    await manager.start();

    fireSleepEdge(true);
    await settle();
    expect(calls).toEqual(['checkpoint']);

    fireSleepEdge(false);
    await settle();
    expect(calls).toEqual(['checkpoint', 're-arm:consolidation', 're-arm:snapshots', 'receipts:missed-run-heartbeat']);
    await manager.stop();
  });
});

describe('process-exit hygiene (holds never outlive the process)', () => {
  test('the registered exit cleanup releases every held inhibitor', async () => {
    const { seam, log } = fixtureSeam();
    let exitCleanup: (() => void) | null = null;
    let unregistered = false;
    const manager = new PowerManager({
      seam,
      readConfig: () => true, // inhibitWhileWorking on
      registerProcessExitHooks: (cleanup) => {
        exitCleanup = cleanup;
        return () => { unregistered = true; };
      },
    });
    await manager.start();
    expect(exitCleanup).not.toBeNull();
    manager.holdWork('turn-1', 'a running turn');
    await manager.setKeepAwake(true, { persist: false });
    await settle();
    expect(log.filter((line) => line.startsWith('acquire:'))).toHaveLength(2);
    // Simulate process exit: the cleanup must release BOTH holds (the seam
    // handles signal their inhibit children synchronously).
    exitCleanup!();
    await settle();
    expect(log.filter((line) => line.startsWith('release:'))).toHaveLength(2);
    // stop() deregisters the hooks.
    await manager.stop();
    expect(unregistered).toBe(true);
  });

  test('start() reaps a crashed process\'s stamped orphan inhibitors — never a live owner\'s', async () => {
    const killed: number[] = [];
    const reaped = await reapOrphanedInhibitors('goodvibes', {
      listProcesses: () => [
        // Dead owner (pid 99991): must be reaped.
        { pid: 501, args: 'systemd-inhibit --what=sleep --who=goodvibes [owner-pid 99991] --why=work --mode=block sleep infinity' },
        // Live owner (pid 42): must be left alone.
        { pid: 502, args: 'systemd-inhibit --what=idle --who=goodvibes [owner-pid 42] --why=work --mode=block sleep infinity' },
        // Someone else\'s inhibitor without our stamp: never touched.
        { pid: 503, args: 'systemd-inhibit --what=sleep --who=other-tool --why=backup --mode=block sleep infinity' },
        // Not an inhibitor at all.
        { pid: 504, args: 'sleep infinity' },
      ],
      isAlive: (pid) => pid === 42,
      kill: (pid) => { killed.push(pid); },
      selfPid: 1000,
    });
    expect(reaped).toBe(1);
    expect(killed).toEqual([501]);
  });

  test('the manager start() invokes the seam orphan reaper', async () => {
    const { seam } = fixtureSeam();
    let reapCalled = 0;
    const reapingSeam: PowerPlatformSeam = { ...seam, reapOrphans: async () => { reapCalled += 1; return 0; } };
    const manager = new PowerManager({ seam: reapingSeam, registerProcessExitHooks: () => () => undefined });
    await manager.start();
    expect(reapCalled).toBe(1);
    await manager.stop();
  });

  test('a power.keepAwake config change applies LIVE through the subscription', async () => {
    const { seam, log } = fixtureSeam();
    const config: Record<string, unknown> = { 'power.keepAwake': false };
    const subscribers = new Map<string, (value: unknown) => void>();
    const manager = new PowerManager({
      seam,
      readConfig: (key) => config[key],
      subscribeConfig: (key, cb) => { subscribers.set(key, cb); return () => subscribers.delete(key); },
      registerProcessExitHooks: () => () => undefined,
    });
    await manager.start();
    expect(manager.getState().keepAwake.enabled).toBe(false);
    // A persist-only settings write lands: the subscription flips the real inhibitor.
    config['power.keepAwake'] = true;
    subscribers.get('power.keepAwake')!(true);
    await settle();
    expect(manager.getState().keepAwake.enabled).toBe(true);
    expect(log.some((line) => line.startsWith('acquire:'))).toBe(true);
    // And flipping back releases it live.
    subscribers.get('power.keepAwake')!(false);
    await settle();
    expect(manager.getState().keepAwake.enabled).toBe(false);
    expect(log.some((line) => line.startsWith('release:'))).toBe(true);
    await manager.stop();
    expect(subscribers.size).toBe(0);
  });
});

describe('live logind proof on this host', () => {
  test('an unprivileged idle inhibitor is genuinely held and released via logind', async () => {
    const seam = createLinuxLogindSeam({ who: 'goodvibes-test-proof' });
    if (!(await seam.isAvailable())) {
      // Honest fallback: this environment has no logind session bus access;
      // the fixture-backed policy tests above still prove the full contract.
      console.warn('[power test] logind unavailable in this environment — live proof skipped honestly');
      return;
    }
    const handle = await seam.inhibit({ classes: ['idle'], who: 'goodvibes-test-proof', why: 'live test proof' });
    expect(handle).not.toBeNull();
    expect(handle!.grantedClasses).toContain('idle');
    // The OS actually lists our inhibitor (never sudo — plain user).
    const listed = execFileSync('systemd-inhibit', ['--list', '--no-legend'], { encoding: 'utf-8' });
    expect(listed).toContain('goodvibes-test-proof');
    await handle!.release();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const after = execFileSync('systemd-inhibit', ['--list', '--no-legend'], { encoding: 'utf-8' });
    expect(after).not.toContain('goodvibes-test-proof');
  }, 15_000);
});
