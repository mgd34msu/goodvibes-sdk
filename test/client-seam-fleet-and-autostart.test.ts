/**
 * client-seam-fleet-and-autostart.test.ts — the two policies that were written
 * twice, once per surface product.
 *
 * FLEET UNION. The failure guarded here is not a crash. It is a view that shows
 * half the fleet and looks complete: this surface's own agents present, the
 * daemon's scheduled work and observed agents silently absent, with nothing
 * saying so. That is strictly worse than showing nothing, because a person reads
 * a short row list as "nothing else is running". So the merge and its precedence
 * are pinned — local wins on a shared id, because the local copy is live and
 * actionable while the daemon's arrives over a poll — plus the degrade path that
 * must not lose rows.
 *
 * DAEMON AUTOSTART. Both surface products grew this independently, arrived at
 * the same policy, and each carried one thing the other lacked. What is pinned
 * is the union: the boundaries neither may cross (a reachable daemon is never
 * restarted, a held port is left alone, an active unit is waited on rather than
 * started underneath), and the attempt-counted wait that terminates even when
 * the injected sleep does nothing.
 */
import { describe, expect, test } from 'bun:test';
import {
  createDaemonFleetRowsPoller,
  daemonOnlyFleetActRefusal,
  mergeFleetNodes,
  readDaemonFleetRows,
} from '../packages/sdk/src/platform/runtime/client/fleet-union.ts';
import {
  autostartInstalledDaemon,
  describeDaemonAutostart,
  type DaemonServiceControl,
  type DaemonServiceSnapshot,
} from '../packages/sdk/src/platform/runtime/client/daemon-autostart.ts';
import type { DaemonVerbCaller } from '../packages/sdk/src/platform/runtime/client/daemon-verbs.ts';
import type { ProcessNode } from '../packages/sdk/src/platform/runtime/fleet/index.ts';

function node(id: string, label: string): ProcessNode {
  return {
    id, kind: 'agent', label, state: 'thinking',
    elapsedMs: 0, costState: 'unpriced',
    capabilities: { interruptible: false, resumable: false, killable: false, steerable: false },
  } as unknown as ProcessNode;
}

const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 10); });

describe('the fleet is local rows union the daemon\'s', () => {
  test('the daemon\'s rows are folded in alongside this surface\'s', () => {
    const merged = mergeFleetNodes([node('a1', 'local agent')], [node('d1', 'scheduled job'), node('d2', 'observed agent')]);
    expect(merged.map((entry) => entry.id)).toEqual(['a1', 'd1', 'd2']);
  });

  test('a row both halves carry appears once, from the LOCAL copy', () => {
    const merged = mergeFleetNodes([node('shared', 'live local label')], [node('shared', 'stale daemon label')]);
    // One row, not two — and from the half that is live and can be interrupted,
    // steered and killed from here.
    expect(merged).toHaveLength(1);
    expect(merged[0]?.label).toBe('live local label');
  });

  test('an answer that is not a fleet payload is null, never an empty fleet', () => {
    // "nobody answered" and "nothing is running" must stay distinguishable all
    // the way to the view; collapsing them is how half a fleet disappears.
    expect(readDaemonFleetRows(null)).toBeNull();
    expect(readDaemonFleetRows({ capturedAt: 1 })).toBeNull();
    expect(readDaemonFleetRows({ nodes: [] })).toMatchObject({ nodes: [] });
  });

  test('acting on a daemon row refuses with a reason, never a bare false', () => {
    const refusal = daemonOnlyFleetActRefusal('d1', 'this terminal');
    // A bare `queued:false` with no reason reads as "the agent ignored you".
    expect(refusal).toContain('d1');
    expect(refusal).toContain('daemon');
  });

  test('with no daemon configured the poller never invokes and holds no rows', async () => {
    let invoked = 0;
    const verbs: DaemonVerbCaller = {
      probe: () => ({ available: false, reason: 'the daemon is disabled' }),
      invoke: async <T,>(): Promise<T> => { invoked += 1; return {} as T; },
    };
    const poller = createDaemonFleetRowsPoller({ verbs, refreshIntervalMs: 5 });
    await settle();
    expect(invoked).toBe(0);
    expect(poller.rows()).toBeNull();
    poller.stop();
  });

  test('a failed refresh keeps the last known daemon rows rather than dropping them', async () => {
    let fail = false;
    const verbs: DaemonVerbCaller = {
      probe: () => ({ available: true }),
      invoke: async <T,>(): Promise<T> => {
        if (fail) throw new Error('connection reset');
        return { capturedAt: 2_000, nodes: [node('d1', 'scheduled job')] } as T;
      },
    };
    const poller = createDaemonFleetRowsPoller({ verbs, refreshIntervalMs: 10_000 });
    await poller.refresh();
    expect(poller.rows()?.nodes).toHaveLength(1);
    fail = true;
    await poller.refresh();
    // Half the fleet must not blink out on one bad request. The capturedAt on
    // the rows is what discloses that this half is stale.
    expect(poller.rows()?.nodes).toHaveLength(1);
    poller.stop();
  });

  test('stop() ends the refresh timer', async () => {
    let invoked = 0;
    const verbs: DaemonVerbCaller = {
      probe: () => ({ available: true }),
      invoke: async <T,>(): Promise<T> => { invoked += 1; return { capturedAt: 1, nodes: [] } as T; },
    };
    const poller = createDaemonFleetRowsPoller({ verbs, refreshIntervalMs: 5 });
    await settle();
    poller.stop();
    const after = invoked;
    await settle();
    expect(invoked).toBe(after);
  });
});

function control(entries: readonly Partial<DaemonServiceSnapshot>[], started: string[] = []): DaemonServiceControl {
  return {
    snapshot: () => entries.map((entry) => ({
      serviceName: entry.serviceName ?? 'goodvibes',
      platform: entry.platform ?? 'systemd',
      unitPath: entry.unitPath ?? '/dev/null',
      installed: entry.installed ?? false,
      running: entry.running ?? false,
      startSupported: entry.startSupported ?? true,
    })),
    start: (serviceName) => { started.push(serviceName); return { ok: true }; },
  };
}

const noSleep = async (): Promise<void> => { /* attempt-counted, so this terminates */ };

describe('one bounded boot-time start of an installed-but-stopped daemon', () => {
  test.each([
    ['embedded', 'daemon-active'],
    ['external', 'daemon-active'],
    ['blocked', 'port-held'],
    ['incompatible', 'port-held'],
    ['disabled', 'daemon-disabled'],
    ['something-new', 'unrecognized-mode'],
  ])('mode %s does nothing at all (%s)', async (mode, reason) => {
    const started: string[] = [];
    const outcome = await autostartInstalledDaemon({
      daemonMode: mode,
      control: control([{ installed: true }], started),
      isReachable: async () => false,
      sleep: noSleep,
    });
    // A reachable daemon is never restarted, and a held port belongs to whoever
    // is holding it — stepping on either turns a transient state into an outage.
    expect(outcome).toEqual({ action: 'none', reason: reason as never });
    expect(started).toEqual([]);
  });

  test('nothing installed is guidance, never a spawn', async () => {
    const started: string[] = [];
    const outcome = await autostartInstalledDaemon({
      daemonMode: 'unavailable',
      control: control([{ installed: false }], started),
      isReachable: async () => false,
      sleep: noSleep,
    });
    expect(outcome).toEqual({ action: 'not-installed' });
    expect(started).toEqual([]);
    expect(describeDaemonAutostart(outcome, false)).toBeNull();
  });

  test('an installed-but-stopped unit is started once and waited for', async () => {
    const started: string[] = [];
    let answers = false;
    const outcome = await autostartInstalledDaemon({
      daemonMode: 'unavailable',
      control: control([{ serviceName: 'goodvibes', installed: true }], started),
      isReachable: async () => { const was = answers; answers = true; return was; },
      pollIntervalMs: 1,
      waitTimeoutMs: 10,
      sleep: noSleep,
    });
    expect(outcome).toEqual({ action: 'started', serviceName: 'goodvibes' });
    expect(started).toEqual(['goodvibes']);
    expect(describeDaemonAutostart(outcome, true)?.level).toBe('low');
  });

  test('a unit the service manager already reports active is waited on, never started again', async () => {
    const started: string[] = [];
    const outcome = await autostartInstalledDaemon({
      daemonMode: 'unavailable',
      control: control([{ serviceName: 'goodvibes', installed: true, running: true }], started),
      isReachable: async () => true,
      sleep: noSleep,
    });
    expect(outcome).toEqual({ action: 'came-online', serviceName: 'goodvibes' });
    // A second start underneath a unit that is mid-start is how a boot loop begins.
    expect(started).toEqual([]);
  });

  test('a start that never answers reports the failure with the wait it gave up after', async () => {
    const outcome = await autostartInstalledDaemon({
      daemonMode: 'unavailable',
      control: control([{ serviceName: 'goodvibes', installed: true }]),
      isReachable: async () => false,
      pollIntervalMs: 1,
      waitTimeoutMs: 5,
      // A no-op sleep terminates because the wait is attempt-counted rather than
      // wall-clock — the drift one of the two originals had and the other did not.
      sleep: noSleep,
    });
    expect(outcome.action).toBe('start-failed');
    expect(describeDaemonAutostart(outcome, false)?.level).toBe('high');
  });

  test('a startable unit is preferred over an installed one nothing here can start', async () => {
    const started: string[] = [];
    const outcome = await autostartInstalledDaemon({
      daemonMode: 'unavailable',
      control: control([
        { serviceName: 'goodvibes', installed: true, startSupported: false, platform: 'manual' },
        { serviceName: 'goodvibes-daemon', installed: true },
      ], started),
      isReachable: async () => true,
      sleep: noSleep,
    });
    // A machine carrying both must not be refused because of the one nobody here
    // can start; the older unit name is still found.
    expect(outcome).toEqual({ action: 'started', serviceName: 'goodvibes-daemon' });
    expect(started).toEqual(['goodvibes-daemon']);
  });

  test('the only installed entry being unstartable is said out loud, not reported as absent', async () => {
    const outcome = await autostartInstalledDaemon({
      daemonMode: 'unavailable',
      control: control([{ serviceName: 'goodvibes', installed: true, startSupported: false, platform: 'manual' }]),
      isReachable: async () => false,
      sleep: noSleep,
    });
    expect(outcome.action).toBe('start-failed');
    if (outcome.action === 'start-failed') expect(outcome.reason).toContain('without a service-manager entry');
  });

  test('a probe that throws mid-wait is a failed attempt, not a failed boot', async () => {
    let attempts = 0;
    const outcome = await autostartInstalledDaemon({
      daemonMode: 'unavailable',
      control: control([{ serviceName: 'goodvibes', installed: true }]),
      isReachable: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('ECONNREFUSED');
        return true;
      },
      pollIntervalMs: 1,
      waitTimeoutMs: 10,
      sleep: noSleep,
    });
    expect(outcome).toEqual({ action: 'started', serviceName: 'goodvibes' });
  });
});
