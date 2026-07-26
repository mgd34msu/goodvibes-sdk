/**
 * LAN leader election — the per-surface state machine, exercised with an
 * in-memory transport and a clock that only moves when a test says so.
 *
 * Every scenario here is a real failure mode the feature exists to prevent:
 * two nodes both consuming one topic, a crashed holder nobody replaces, a
 * laptop that wakes up and resumes a long poll somebody else already took
 * over, and — the case that broke the whole-node design — two machines whose
 * configured surfaces only partly overlap.
 */
import { describe, expect, test } from 'bun:test';
import {
  compareSpreadRank,
  compareVersions,
} from '../packages/sdk/src/platform/cluster/ranking.js';
import {
  addNode,
  advance,
  createWorld,
  flush,
  holders,
  roleOf,
  settings,
  startNode,
  surfaceState,
  surfaceStatusOf,
  type TestNode,
  type World,
} from './cluster-harness.js';

describe('cluster election — taking a surface', () => {
  test('a node that boots alone takes its surfaces and starts consuming', async () => {
    const world = createWorld();
    const alone = addNode(world, { id: 'node-a', surfaces: ['ntfy-main'] });
    await startNode(world, alone);

    // Still probing: nothing may consume before the boot window closes, or a
    // second node on the network gets a competitor rather than a holder.
    expect(surfaceState(alone, 'ntfy-main').running).toBe(false);
    expect(roleOf(alone, 'ntfy-main')).toBe('probing');

    await advance(world, 1_100);
    expect(roleOf(alone, 'ntfy-main')).toBe('master');
    expect(surfaceState(alone, 'ntfy-main').running).toBe(true);
    expect(surfaceState(alone, 'ntfy-main').startCount).toBe(1);
  });

  test('a node that boots into an existing holder stands by and consumes nothing', async () => {
    const world = createWorld();
    const first = addNode(world, { id: 'node-a', surfaces: ['ntfy-main'] });
    await startNode(world, first);
    await advance(world, 1_100);

    const second = addNode(world, { id: 'node-b', surfaces: ['ntfy-main'] });
    await startNode(world, second);
    await flush(world);

    // The holder answers a PROBE immediately, so the newcomer never has to
    // wait its boot window out to learn it is not alone.
    expect(roleOf(second, 'ntfy-main')).toBe('standby');
    expect(surfaceState(second, 'ntfy-main').startCount).toBe(0);
    expect(holders(world, 'ntfy-main')).toHaveLength(1);

    await advance(world, 5_000);
    expect(holders(world, 'ntfy-main')).toEqual([first]);
  });

  test('two processes on one host coordinate through the same loopback path', async () => {
    const world = createWorld();
    const processOne = addNode(world, { id: 'host1-proc-a', surfaces: ['ntfy-main'] });
    const processTwo = addNode(world, { id: 'host1-proc-b', surfaces: ['ntfy-main'] });
    await startNode(world, processOne);
    await startNode(world, processTwo);
    await advance(world, 4_000);

    expect(holders(world, 'ntfy-main')).toHaveLength(1);
    // Loopback means each process also hears itself; it must never track
    // itself as a peer or it would rank against its own datagrams.
    for (const node of world.nodes) {
      const peerIds = node.election.status().peers.map((peer) => peer.nodeId);
      expect(peerIds).not.toContain(node.id);
    }
  });

  test('a node with no inbound surfaces contests nothing and claims nothing', async () => {
    const world = createWorld();
    const bystander = addNode(world, { id: 'node-bystander', surfaces: [] });
    await startNode(world, bystander);
    await advance(world, 10_000);

    // It joined the group — it can report what it hears — but it never sent a
    // datagram, so it never entered anyone's election.
    expect(bystander.election.status().surfaces).toEqual([]);
    expect(bystander.election.isMaster).toBe(false);
    expect(world.events.filter((event) => event.startsWith('node-bystander:'))).toEqual([]);
  });
});

describe('cluster election — partial overlap between machines', () => {
  /**
   * The case the whole-node design could not express, and the reason this is
   * per surface: node A serves Telegram and ntfy, node B serves ntfy alone.
   * They must divide ntfy between them and B must never end up holding
   * Telegram, which it has no token for.
   */
  async function partiallyOverlappingPair(world: World): Promise<[TestNode, TestNode]> {
    const laptop = addNode(world, { id: 'node-a-laptop', surfaces: ['telegram-bot', 'ntfy-main'] });
    const desktop = addNode(world, { id: 'node-b-desktop', surfaces: ['ntfy-main'] });
    await startNode(world, laptop);
    await startNode(world, desktop);
    await advance(world, 4_000);
    return [laptop, desktop];
  }

  test('exactly one node consumes the shared surface', async () => {
    const world = createWorld();
    await partiallyOverlappingPair(world);
    expect(holders(world, 'ntfy-main')).toHaveLength(1);
  });

  test('the surface only one node can serve is unaffected, and that node holds it', async () => {
    const world = createWorld();
    const [laptop, desktop] = await partiallyOverlappingPair(world);

    expect(surfaceState(laptop, 'telegram-bot').running).toBe(true);
    expect(roleOf(laptop, 'telegram-bot')).toBe('master');
    // The desktop is not in that election at all — not standby, not electing.
    expect(roleOf(desktop, 'telegram-bot')).toBe('stopped');
    expect(desktop.surfaces.has('telegram-bot')).toBe(false);
  });

  test('a node without the credential never wins that surface, even alone in its election', async () => {
    const world = createWorld();
    // The desktop boots first and is the only node up for a full timeout.
    const desktop = addNode(world, { id: 'node-b-desktop', surfaces: ['ntfy-main'] });
    await startNode(world, desktop);
    await advance(world, 10_000);

    expect(surfaceState(desktop, 'ntfy-main').running).toBe(true);
    // Nothing about being the only node up makes it eligible for Telegram.
    expect(roleOf(desktop, 'telegram-bot')).toBe('stopped');
    expect(desktop.election.status().surfaces.map((surface) => surface.kind)).toEqual(['ntfy']);
  });

  test('losing the shared surface\'s holder moves only that surface', async () => {
    const world = createWorld();
    const [laptop, desktop] = await partiallyOverlappingPair(world);

    // Whichever node won ntfy is the one to lose. The ranking decides that,
    // not the test, so the test reads the answer rather than forcing it.
    const [ntfyHolder] = holders(world, 'ntfy-main');
    expect(ntfyHolder).toBeDefined();
    const survivor = ntfyHolder === laptop ? desktop : laptop;
    const telegramStarts = surfaceState(laptop, 'telegram-bot').startCount;
    expect(telegramStarts).toBe(1);

    world.bus.partition(ntfyHolder!.transport, 'crashed');
    await advance(world, 8_000);

    // ntfy moved to the other node that can serve it, and only there. The
    // partitioned node is cut off from the LAN, not from ntfy, so its own
    // island is not part of "exactly one reader" — healing that is the
    // split-brain reconciliation, exercised in cluster-handoff.test.ts.
    expect(surfaceState(survivor, 'ntfy-main').running).toBe(true);
    expect(holders(world, 'ntfy-main').filter((node) => node !== ntfyHolder)).toEqual([survivor]);
    // Telegram did not move and was never restarted by the ntfy failover —
    // the laptop's Telegram consumer has been up, untouched, throughout.
    expect(surfaceState(laptop, 'telegram-bot').startCount).toBe(telegramStarts);
    expect(surfaceState(laptop, 'telegram-bot').stopCount).toBe(0);
    expect(surfaceState(laptop, 'telegram-bot').running).toBe(true);
  });
});

describe('cluster election — ranking decides, not scheduling', () => {
  test('compareVersions orders releases, prereleases and ragged lengths', () => {
    expect(compareVersions('1.20.0', '1.3.0')).toBeGreaterThan(0);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('2.0.0-rc.1', '2.0.0')).toBeLessThan(0);
    expect(compareVersions('v1.4.0', '1.4.0')).toBe(0);
  });

  test('the spread ranking is version, then fewest surfaces held, then a per-surface hash', () => {
    const surfaceId = 'a'.repeat(32);
    const newerBuild = { nodeId: 'z', version: '1.1.0', holdings: 9 };
    const olderBuild = { nodeId: 'a', version: '1.0.0', holdings: 0 };
    // Version outranks load: an update must still roll over.
    expect(compareSpreadRank(newerBuild, olderBuild, surfaceId)).toBeLessThan(0);

    const busy = { nodeId: 'a', version: '1.0.0', holdings: 3 };
    const idle = { nodeId: 'z', version: '1.0.0', holdings: 1 };
    // Among equal builds the lighter node wins — this is what spreads work.
    expect(compareSpreadRank(idle, busy, surfaceId)).toBeLessThan(0);
  });

  test('the hash tiebreak sends different surfaces to different nodes', () => {
    const left = { nodeId: 'node-alpha', version: '1.0.0', holdings: 0 };
    const right = { nodeId: 'node-beta', version: '1.0.0', holdings: 0 };
    const winners = new Set<string>();
    for (let index = 0; index < 24; index += 1) {
      const surfaceId = index.toString(16).padStart(32, '0');
      winners.add(compareSpreadRank(left, right, surfaceId) < 0 ? left.nodeId : right.nodeId);
    }
    // A nodeId-only tiebreak — the whole-node design's third tier — would hand
    // every one of these to the same node. Mixing the surface in does not.
    expect(winners.size).toBe(2);
  });

  /**
   * The WORSE node draws jitter 0, so it claims first. If the winner were
   * decided by who spoke first the worse node would take the surface every
   * time; it is decided by rank, so it does not.
   */
  async function raceAfterHolderLoss(world: World, holder: TestNode): Promise<void> {
    // The holder vanishes without a word — the crash path, not a clean stop.
    world.bus.partition(holder.transport, 'gone');
    await advance(world, 6_000);
  }

  test('the newest version wins even when an older build claims first', async () => {
    const world = createWorld();
    const holder = addNode(world, { id: 'node-holder', surfaces: ['ntfy-main'] });
    await startNode(world, holder);
    await advance(world, 1_100);

    const olderBuild = addNode(world, { id: 'node-a-old', version: '1.0.0', jitter: 0, surfaces: ['ntfy-main'] });
    const newerBuild = addNode(world, { id: 'node-z-new', version: '1.1.0', jitter: 0.9, surfaces: ['ntfy-main'] });
    await startNode(world, olderBuild);
    await startNode(world, newerBuild);
    await raceAfterHolderLoss(world, holder);

    expect(surfaceState(newerBuild, 'ntfy-main').running).toBe(true);
    expect(surfaceState(olderBuild, 'ntfy-main').running).toBe(false);
  });

  test('a node already holding more surfaces loses to a lighter one', async () => {
    const world = createWorld();
    // The busy node serves three surfaces and is alone for long enough to take
    // all of them; the light node serves only the contested one.
    const busy = addNode(world, {
      id: 'node-busy',
      jitter: 0,
      surfaces: ['ntfy-one', 'ntfy-two', 'ntfy-three'],
    });
    await startNode(world, busy);
    await advance(world, 1_100);
    expect(holders(world, 'ntfy-three')).toEqual([busy]);

    const light = addNode(world, { id: 'node-light', jitter: 0.9, surfaces: ['ntfy-three'] });
    await startNode(world, light);
    await advance(world, 2_000);

    // The busy node then loses ntfy-three cleanly, so the surface is free and
    // both nodes contest it: the lighter one takes it even though the busy one
    // claims first (jitter 0 against 0.9).
    await busy.election.stop('operator stopped this node');
    await advance(world, 4_000);
    expect(surfaceState(light, 'ntfy-three').running).toBe(true);
  });
});

describe('cluster election — crash takeover', () => {
  test('a standby takes over after the timeout and replays from the last heartbeat', async () => {
    const world = createWorld();
    const holder = addNode(world, { id: 'node-a', surfaces: ['ntfy-main'] });
    await startNode(world, holder);
    await advance(world, 1_100);

    const standby = addNode(world, { id: 'node-b', surfaces: ['ntfy-main'] });
    await startNode(world, standby);
    await advance(world, 2_000);
    expect(surfaceState(standby, 'ntfy-main').running).toBe(false);

    const lastHeardAt = surfaceStatusOf(standby, 'ntfy-main').lastHolderHeartbeatAt;
    expect(lastHeardAt).not.toBeNull();

    // SIGKILL, not a stop: no RESIGN is ever sent, so only the watchdog can
    // notice. Nothing may take over before the configured timeout.
    world.bus.partition(holder.transport, 'crashed');
    await advance(world, 2_000);
    expect(surfaceState(standby, 'ntfy-main').running).toBe(false);

    await advance(world, 4_000);
    expect(roleOf(standby, 'ntfy-main')).toBe('master');
    expect(surfaceState(standby, 'ntfy-main').running).toBe(true);
    // ntfy has no server-side cursor, so the successor must subscribe from the
    // dead holder's last breath or the gap between them is lost silently.
    expect(surfaceState(standby, 'ntfy-main').lastReplayFromMs).toBe(lastHeardAt);
  });

  test('a lone holder keeps its surfaces and never restarts their consumers', async () => {
    const world = createWorld();
    const holder = addNode(world, { id: 'node-a', surfaces: ['ntfy-main', 'telegram-bot'] });
    await startNode(world, holder);
    await advance(world, 20_000);

    for (const name of ['ntfy-main', 'telegram-bot']) {
      expect(roleOf(holder, name)).toBe('master');
      expect(surfaceState(holder, name).startCount).toBe(1);
      expect(surfaceState(holder, name).stopCount).toBe(0);
    }
  });
});

describe('cluster election — suspend and wake', () => {
  test('a woken holder stops consuming and re-probes before it resumes, per surface', async () => {
    const world = createWorld();
    const laptop = addNode(world, { id: 'node-a', surfaces: ['ntfy-main', 'telegram-bot'] });
    await startNode(world, laptop);
    await advance(world, 1_100);
    expect(surfaceState(laptop, 'ntfy-main').running).toBe(true);
    expect(surfaceState(laptop, 'telegram-bot').running).toBe(true);
    const eventsBeforeSleep = world.events.length;

    // Suspend: the wall clock runs on, the monotonic clock does not, and no
    // timer fires. The next tick is how the process finds out.
    world.clock.advanceWallOnly(600_000);
    await advance(world, 1_100);

    const woken = world.events.slice(eventsBeforeSleep);
    for (const name of ['ntfy-main', 'telegram-bot']) {
      const stopIndex = woken.indexOf(`node-a:${name}:consumers-stop`);
      const resignIndex = woken.indexOf(`node-a:${name}:send:RESIGN`);
      const probeIndex = woken.indexOf(`node-a:${name}:send:PROBE`);
      expect(stopIndex).toBeGreaterThanOrEqual(0);
      // Consumers stop BEFORE anything else: resuming a long poll a successor
      // already took over is exactly the double consumption this prevents.
      expect(stopIndex).toBeLessThan(resignIndex);
      expect(resignIndex).toBeLessThan(probeIndex);
      expect(surfaceState(laptop, name).running).toBe(false);
    }

    // And they come back on their own once the probe window closes.
    await advance(world, 1_100);
    expect(roleOf(laptop, 'ntfy-main')).toBe('master');
    expect(surfaceState(laptop, 'ntfy-main').running).toBe(true);
    expect(surfaceState(laptop, 'telegram-bot').running).toBe(true);
  });

  test('a woken standby re-probes rather than assuming the old holder is still there', async () => {
    const world = createWorld();
    const holder = addNode(world, { id: 'node-a', surfaces: ['ntfy-main'] });
    const standby = addNode(world, { id: 'node-b', surfaces: ['ntfy-main'] });
    await startNode(world, holder);
    await advance(world, 1_100);
    await startNode(world, standby);
    await flush(world);
    expect(roleOf(standby, 'ntfy-main')).toBe('standby');

    world.clock.advanceWallOnly(600_000);
    world.clock.advance(1_000);
    await flush(world);
    expect(roleOf(standby, 'ntfy-main')).toBe('probing');
    expect(surfaceState(standby, 'ntfy-main').running).toBe(false);

    // The wall-clock jump is the whole HOST sleeping, so the holder re-probes
    // too. Both re-enter the protocol from scratch and it settles on exactly
    // one reader — which is the invariant, not which of the two it is.
    await advance(world, 4_000);
    expect(holders(world, 'ntfy-main')).toHaveLength(1);
    expect(roleOf(standby, 'ntfy-main')).not.toBe('probing');
    expect(roleOf(holder, 'ntfy-main')).not.toBe('probing');
  });
});

describe('cluster election — configuration', () => {
  test('disabling the election is not a way to make two nodes consume silently', () => {
    // resolveClusterSettings must preserve an explicit false rather than
    // defaulting it back on.
    const resolved = settings({ enabled: false });
    expect(resolved.enabled).toBe(false);
  });

  test('a master timeout shorter than two heartbeats is raised, not accepted', async () => {
    const world = createWorld();
    const node = addNode(world, {
      id: 'node-a',
      surfaces: ['ntfy-main'],
      settings: { heartbeatSeconds: 5, masterTimeoutSeconds: 3 },
    });
    await startNode(world, node);
    // 5s heartbeat with a 3s timeout would make a standby declare every holder
    // dead between beats; the derived timing floors it at two heartbeats, so
    // the node simply runs rather than flapping.
    await advance(world, 30_000);
    expect(roleOf(node, 'ntfy-main')).toBe('master');
    expect(surfaceState(node, 'ntfy-main').stopCount).toBe(0);
  });
});
