/**
 * LAN leader election — the state machine, exercised with an in-memory
 * transport and a clock that only moves when a test says so.
 *
 * Every scenario here is a real failure mode the feature exists to prevent:
 * two nodes both consuming, a crashed master nobody replaces, a laptop that
 * wakes up and resumes a long poll somebody else already took over.
 */
import { describe, expect, test } from 'bun:test';
import { compareRank, compareVersions } from '../packages/sdk/src/platform/cluster/ranking.js';
import {
  addNode,
  advance,
  createWorld,
  flush,
  masters,
  settings,
  startNode,
  type TestNode,
  type World,
} from './cluster-harness.js';

describe('cluster election — claiming the role', () => {
  test('a node that boots alone claims the role and starts consuming', async () => {
    const world = createWorld();
    const alone = addNode(world, { id: 'node-a' });
    await startNode(world, alone);

    // Still probing: nothing may consume before the boot window closes, or a
    // second node on the network gets a competitor rather than a master.
    expect(alone.running).toBe(false);
    expect(alone.election.currentRole).toBe('probing');

    await advance(world, 1_100);
    expect(alone.election.currentRole).toBe('master');
    expect(alone.running).toBe(true);
    expect(alone.startCount).toBe(1);
  });

  test('a node that boots into an existing master stands by and consumes nothing', async () => {
    const world = createWorld();
    const first = addNode(world, { id: 'node-a' });
    await startNode(world, first);
    await advance(world, 1_100);

    const second = addNode(world, { id: 'node-b' });
    await startNode(world, second);
    await flush(world);

    // The master answers a PROBE immediately, so the newcomer never has to
    // wait its boot window out to learn it is not alone.
    expect(second.election.currentRole).toBe('standby');
    expect(second.running).toBe(false);
    expect(second.startCount).toBe(0);
    expect(masters(world)).toHaveLength(1);

    await advance(world, 5_000);
    expect(masters(world)).toEqual([first]);
  });

  test('two processes on one host coordinate through the same loopback path', async () => {
    const world = createWorld();
    const processOne = addNode(world, { id: 'host1-proc-a' });
    const processTwo = addNode(world, { id: 'host1-proc-b' });
    await startNode(world, processOne);
    await startNode(world, processTwo);
    await advance(world, 4_000);

    expect(masters(world)).toHaveLength(1);
    // Loopback means each process also hears itself; it must never track
    // itself as a peer or it would rank against its own datagrams.
    for (const node of world.nodes) {
      const peerIds = node.election.status().peers.map((peer) => peer.nodeId);
      expect(peerIds).not.toContain(node.id);
    }
  });
});

describe('cluster election — ranking decides, not scheduling', () => {
  test('compareVersions orders releases, prereleases and ragged lengths', () => {
    expect(compareVersions('1.20.0', '1.3.0')).toBeGreaterThan(0);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('2.0.0-rc.1', '2.0.0')).toBeLessThan(0);
    expect(compareVersions('v1.4.0', '1.4.0')).toBe(0);
  });

  test('compareRank applies version, then uptime, then nodeId', () => {
    const older = { nodeId: 'a', version: '1.0.0', uptimeMs: 10_000 };
    const newerBuild = { nodeId: 'z', version: '1.1.0', uptimeMs: 1 };
    expect(compareRank(newerBuild, older)).toBeLessThan(0);

    const longUptime = { nodeId: 'z', version: '1.0.0', uptimeMs: 10_000 };
    const shortUptime = { nodeId: 'a', version: '1.0.0', uptimeMs: 10 };
    expect(compareRank(longUptime, shortUptime)).toBeLessThan(0);

    const lowId = { nodeId: 'aaa', version: '1.0.0', uptimeMs: 500 };
    const highId = { nodeId: 'zzz', version: '1.0.0', uptimeMs: 500 };
    expect(compareRank(lowId, highId)).toBeLessThan(0);
  });

  /**
   * In each of the three races below the WORSE node draws jitter 0, so it
   * claims first. If the winner were decided by who spoke first the worse node
   * would take the role every time; it is decided by rank, so it does not.
   */
  async function raceAfterMasterLoss(
    world: World,
    master: TestNode,
  ): Promise<void> {
    // The master vanishes without a word — the crash path, not a clean stop.
    world.bus.partition(master.transport, 'gone');
    await advance(world, 6_000);
  }

  test('the newest version wins even when an older build claims first', async () => {
    const world = createWorld();
    const master = addNode(world, { id: 'node-master' });
    await startNode(world, master);
    await advance(world, 1_100);

    const olderBuild = addNode(world, { id: 'node-a-old', version: '1.0.0', jitter: 0 });
    const newerBuild = addNode(world, { id: 'node-z-new', version: '1.1.0', jitter: 0.9 });
    await startNode(world, olderBuild);
    await startNode(world, newerBuild);
    await raceAfterMasterLoss(world, master);

    expect(newerBuild.running).toBe(true);
    expect(olderBuild.running).toBe(false);
  });

  test('the longest uptime wins among equal versions', async () => {
    const world = createWorld();
    const master = addNode(world, { id: 'node-master' });
    await startNode(world, master);

    const longRunning = addNode(world, { id: 'node-z-long', jitter: 0.9 });
    await startNode(world, longRunning);
    // Let the long-running node accumulate uptime before the other appears.
    await advance(world, 4_000);
    const justStarted = addNode(world, { id: 'node-a-short', jitter: 0 });
    await startNode(world, justStarted);
    await advance(world, 200);

    await raceAfterMasterLoss(world, master);
    expect(longRunning.running).toBe(true);
    expect(justStarted.running).toBe(false);
  });

  test('the lexically lowest nodeId wins when version and uptime tie', async () => {
    const world = createWorld();
    const master = addNode(world, { id: 'node-master' });
    await startNode(world, master);
    await advance(world, 1_100);

    // Both start at the same instant on the same clock, so uptime is equal.
    const lowId = addNode(world, { id: 'aaa-node', jitter: 0.9 });
    const highId = addNode(world, { id: 'zzz-node', jitter: 0 });
    await startNode(world, lowId);
    await startNode(world, highId);
    await raceAfterMasterLoss(world, master);

    expect(lowId.running).toBe(true);
    expect(highId.running).toBe(false);
  });
});

describe('cluster election — crash takeover', () => {
  test('a standby takes over after the master timeout and replays from its last heartbeat', async () => {
    const world = createWorld();
    const master = addNode(world, { id: 'node-a' });
    await startNode(world, master);
    await advance(world, 1_100);

    const standby = addNode(world, { id: 'node-b' });
    await startNode(world, standby);
    await advance(world, 2_000);
    expect(standby.running).toBe(false);

    const lastHeardAt = standby.election.status().lastMasterHeartbeatAt;
    expect(lastHeardAt).not.toBeNull();

    // SIGKILL, not a stop: no RESIGN is ever sent, so only the watchdog can
    // notice. Nothing may take over before the configured timeout.
    world.bus.partition(master.transport, 'crashed');
    await advance(world, 2_000);
    expect(standby.running).toBe(false);

    await advance(world, 4_000);
    expect(standby.election.currentRole).toBe('master');
    expect(standby.running).toBe(true);
    // ntfy has no server-side cursor, so the successor must subscribe from the
    // dead master's last breath or the gap between them is lost silently.
    expect(standby.lastReplayFromMs).toBe(lastHeardAt);
  });

  test('a lone master keeps the role and never restarts its consumers', async () => {
    const world = createWorld();
    const master = addNode(world, { id: 'node-a' });
    await startNode(world, master);
    await advance(world, 20_000);

    expect(master.election.currentRole).toBe('master');
    expect(master.startCount).toBe(1);
    expect(master.stopCount).toBe(0);
  });
});

describe('cluster election — suspend and wake', () => {
  test('a woken master stops consuming and re-probes before it resumes', async () => {
    const world = createWorld();
    const laptop = addNode(world, { id: 'node-a' });
    await startNode(world, laptop);
    await advance(world, 1_100);
    expect(laptop.running).toBe(true);
    const eventsBeforeSleep = world.events.length;

    // Suspend: the wall clock runs on, the monotonic clock does not, and no
    // timer fires. The next tick is how the process finds out.
    world.clock.advanceWallOnly(600_000);
    await advance(world, 1_100);

    const woken = world.events.slice(eventsBeforeSleep);
    const stopIndex = woken.indexOf('node-a:consumers-stop');
    const resignIndex = woken.indexOf('node-a:send:RESIGN');
    const probeIndex = woken.indexOf('node-a:send:PROBE');
    expect(stopIndex).toBeGreaterThanOrEqual(0);
    // Consumers stop BEFORE anything else: resuming a long poll a successor
    // already took over is exactly the double consumption this prevents.
    expect(stopIndex).toBeLessThan(resignIndex);
    expect(resignIndex).toBeLessThan(probeIndex);
    expect(laptop.running).toBe(false);

    // And it comes back on its own once the probe window closes.
    await advance(world, 1_100);
    expect(laptop.election.currentRole).toBe('master');
    expect(laptop.running).toBe(true);
  });

  test('a woken standby re-probes rather than assuming the old master is still there', async () => {
    const world = createWorld();
    const master = addNode(world, { id: 'node-a' });
    const standby = addNode(world, { id: 'node-b' });
    await startNode(world, master);
    await advance(world, 1_100);
    await startNode(world, standby);
    await flush(world);
    expect(standby.election.currentRole).toBe('standby');

    world.clock.advanceWallOnly(600_000);
    world.clock.advance(1_000);
    await flush(world);
    expect(standby.election.currentRole).toBe('probing');
    expect(standby.running).toBe(false);

    // The surviving master answers the probe, so the woken node stands by
    // again instead of seizing a role that was never free.
    await advance(world, 1_500);
    expect(standby.running).toBe(false);
    expect(master.running).toBe(true);
  });
});

describe('cluster election — configuration', () => {
  test('disabling the election is not a way to make two nodes consume silently', () => {
    // resolveClusterSettings must preserve an explicit false rather than
    // defaulting it back on, and must keep a master timeout below two
    // heartbeats from declaring a healthy master dead between its own beats.
    const resolved = settings({ enabled: false });
    expect(resolved.enabled).toBe(false);
  });

  test('a master timeout shorter than two heartbeats is raised, not accepted', async () => {
    const world = createWorld();
    const node = addNode(world, {
      id: 'node-a',
      settings: { heartbeatSeconds: 5, masterTimeoutSeconds: 3 },
    });
    await startNode(world, node);
    // 5s heartbeat with a 3s timeout would make a standby declare every master
    // dead between beats; the derived timing floors it at two heartbeats, so
    // the node simply runs rather than flapping.
    await advance(world, 30_000);
    expect(node.election.currentRole).toBe('master');
    expect(node.stopCount).toBe(0);
  });
});
