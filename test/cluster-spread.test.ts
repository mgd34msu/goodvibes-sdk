/**
 * LAN leader election, spreading surfaces across machines, and staying put.
 *
 * Two properties are under test, and the second is the harder one.
 *
 * SPREAD: three surfaces and two machines must not end up three-and-nothing.
 * The ranking's job is to distribute, and where the ranking alone lands
 * unevenly, because nodes booted at different times, or a machine came back
 * after the others had divided everything, a holder gives one up.
 *
 * STABILITY: having spread, it must STOP. A rebalancer that moves a surface
 * whenever it sees any imbalance trades the same surface back and forth
 * forever, and every trade is an inbound consumer restarting. The tests below
 * run the cluster on for many further rounds after it settles and assert that
 * nothing moves at all.
 */
import { describe, expect, test } from 'bun:test';
import { ClusterHoldingsLedger } from '../packages/sdk/src/platform/cluster/holdings.js';
import { shouldYieldSurface, SURFACE_YIELD_GAP } from '../packages/sdk/src/platform/cluster/ranking.js';
import {
  addNode,
  advance,
  createWorld,
  heldCount,
  holders,
  startNode,
  surfaceState,
  type TestNode,
  type World,
} from './cluster-harness.js';

const THREE = ['ntfy-one', 'ntfy-two', 'ntfy-three'] as const;

/** Total consumer starts across every surface of every node. */
function totalStarts(world: World): number {
  return world.nodes.reduce(
    (sum, node) => sum + [...node.surfaces.values()].reduce((inner, state) => inner + state.startCount, 0),
    0,
  );
}

/** Every surface is consumed by exactly one node, the invariant, always. */
function expectExactlyOneReaderEach(world: World, names: readonly string[]): void {
  for (const name of names) {
    expect(holders(world, name)).toHaveLength(1);
  }
}

describe('cluster spread — the yield rule', () => {
  test('a holder yields only at a gap of two or more', () => {
    // One ahead is already as balanced as an odd split can be. Yielding there
    // would put the other node one ahead instead, and the pair would trade the
    // surface back and forth forever.
    expect(shouldYieldSurface(1, 0)).toBe(false);
    expect(shouldYieldSurface(2, 1)).toBe(false);
    expect(shouldYieldSurface(5, 4)).toBe(false);
    // Two ahead closes to exactly level: the holder loses one, the taker gains
    // one, and the gap goes 2 -> 0. It can never cross into the negative.
    expect(shouldYieldSurface(2, 0)).toBe(true);
    expect(shouldYieldSurface(3, 1)).toBe(true);
    expect(shouldYieldSurface(0, 2)).toBe(false);
    expect(SURFACE_YIELD_GAP).toBe(2);
  });

  test('the gap closes to zero, never past it', () => {
    // The arithmetic behind the threshold, stated as a test so a future change
    // to the constant has to confront it: after a yield at the threshold the
    // resulting gap is not itself yieldable in the other direction.
    const holder = SURFACE_YIELD_GAP;
    const candidate = 0;
    expect(shouldYieldSurface(holder, candidate)).toBe(true);
    const afterHolder = holder - 1;
    const afterCandidate = candidate + 1;
    expect(shouldYieldSurface(afterCandidate, afterHolder)).toBe(false);
  });
});

describe('cluster spread — holdings are observed, never announced', () => {
  test('a node counts what its peers hold from the traffic it hears', () => {
    const ledger = new ClusterHoldingsLedger({ holderTtlMs: 1_000, candidateTtlMs: 3_000 });
    ledger.noteHolder('surface-a', 'node-peer', 0);
    ledger.noteHolder('surface-b', 'node-peer', 0);
    ledger.noteHolder('surface-c', 'node-self', 0);

    // No datagram carries a load figure. Every node derives the same numbers
    // from the same stream, which is why two nodes cannot rank against
    // different self-reports.
    expect(ledger.holdingsOf('node-peer', 0)).toBe(2);
    expect(ledger.holdingsOf('node-self', 0)).toBe(1);

    // A holder that stops heartbeating stops counting: that is what makes a
    // crashed machine's share available to everyone else.
    expect(ledger.holdingsOf('node-peer', 2_000)).toBe(0);
  });

  test('a resigning node stays a candidate — it can still serve what it gave up', () => {
    const ledger = new ClusterHoldingsLedger({ holderTtlMs: 1_000, candidateTtlMs: 3_000 });
    ledger.noteHolder('surface-a', 'node-peer', 0);
    ledger.noteReleased('surface-a', 'node-peer');
    expect(ledger.holderOf('surface-a', 0)).toBeNull();
    expect(ledger.candidatesFor('surface-a', 0)).toEqual(['node-peer']);
  });

  test('a stale farewell does not erase the successor', () => {
    const ledger = new ClusterHoldingsLedger({ holderTtlMs: 1_000, candidateTtlMs: 3_000 });
    ledger.noteHolder('surface-a', 'node-old', 0);
    ledger.noteHolder('surface-a', 'node-new', 10);
    // A RESIGN from the node that already lost the surface arrives late.
    ledger.noteReleased('surface-a', 'node-old');
    expect(ledger.holderOf('surface-a', 10)).toBe('node-new');
  });
});

describe('cluster spread — three surfaces across two machines', () => {
  async function twoNodesThreeSurfaces(world: World): Promise<[TestNode, TestNode]> {
    const first = addNode(world, { id: 'node-a', surfaces: [...THREE] });
    const second = addNode(world, { id: 'node-b', surfaces: [...THREE] });
    await startNode(world, first);
    await startNode(world, second);
    // Long enough for the boot elections, the reconciliation, and several
    // yield windows (the yield check runs at the master timeout, 3s here).
    await advance(world, 40_000);
    return [first, second];
  }

  test('the work divides — neither machine ends up holding all three', async () => {
    const world = createWorld();
    const [first, second] = await twoNodesThreeSurfaces(world);

    expectExactlyOneReaderEach(world, THREE);
    expect(heldCount(first) + heldCount(second)).toBe(3);
    // Three surfaces over two machines is 2/1 at best, and that is what the
    // yield rule converges to. A 3/0 split is the failure this exists to fix.
    expect(Math.min(heldCount(first), heldCount(second))).toBe(1);
    expect(Math.max(heldCount(first), heldCount(second))).toBe(2);
  });

  test('once divided it STAYS divided — no churn across many further rounds', async () => {
    const world = createWorld();
    const [first, second] = await twoNodesThreeSurfaces(world);

    const before = {
      startsTotal: totalStarts(world),
      firstHeld: heldCount(first),
      secondHeld: heldCount(second),
      holders: THREE.map((name) => holders(world, name)[0]?.id),
    };

    // Many more yield windows and heartbeat rounds than it took to settle.
    await advance(world, 120_000);

    // Not one consumer restarted, and not one surface changed hands. A
    // rebalancer that oscillates fails here and nowhere else.
    expect(totalStarts(world)).toBe(before.startsTotal);
    expect(heldCount(first)).toBe(before.firstHeld);
    expect(heldCount(second)).toBe(before.secondHeld);
    expect(THREE.map((name) => holders(world, name)[0]?.id)).toEqual(before.holders);
    expectExactlyOneReaderEach(world, THREE);
  });

  test('a machine that arrives late is given work rather than left idle', async () => {
    const world = createWorld();
    // The first node is alone long enough to take all three.
    const first = addNode(world, { id: 'node-a', surfaces: [...THREE] });
    await startNode(world, first);
    await advance(world, 2_000);
    expect(heldCount(first)).toBe(3);

    const second = addNode(world, { id: 'node-b', surfaces: [...THREE] });
    await startNode(world, second);
    await advance(world, 60_000);

    // The newcomer cannot preempt a working holder, nothing about being idle
    // entitles it to interrupt one, so the holder must volunteer, and does.
    expect(heldCount(second)).toBeGreaterThanOrEqual(1);
    expect(heldCount(first) + heldCount(second)).toBe(3);
    expectExactlyOneReaderEach(world, THREE);

    // And then it stops, rather than trading the surface back.
    const settled = THREE.map((name) => holders(world, name)[0]?.id);
    await advance(world, 120_000);
    expect(THREE.map((name) => holders(world, name)[0]?.id)).toEqual(settled);
  });

  test('a yield hands over through the ordered path — stop strictly before start', async () => {
    const world = createWorld();
    const first = addNode(world, { id: 'node-a', surfaces: [...THREE] });
    await startNode(world, first);
    await advance(world, 2_000);
    expect(heldCount(first)).toBe(3);

    world.events.length = 0;
    const second = addNode(world, { id: 'node-b', surfaces: [...THREE] });
    await startNode(world, second);
    await advance(world, 60_000);

    // Find the surface that actually moved and check the sequence on it.
    const moved = THREE.find((name) => surfaceState(second, name).running);
    expect(moved).toBeDefined();
    const stopped = world.events.indexOf(`node-a:${moved}:consumers-stop`);
    const resigned = world.events.indexOf(`node-a:${moved}:send:RESIGN`);
    const started = world.events.indexOf(`node-b:${moved}:consumers-start`);
    expect(stopped).toBeGreaterThanOrEqual(0);
    // Rebalancing is not an excuse to skip the ordering. The old holder stops
    // reading, says so, and only then does the new one begin.
    expect(resigned).toBeGreaterThan(stopped);
    expect(started).toBeGreaterThan(resigned);

    // And it is an ORDERED handoff, so nothing is replayed: the predecessor
    // read right up to its stop. Replaying here would answer a message twice
    // as the direct result of a load-balancing decision.
    expect(surfaceState(second, moved!).lastReplayFromMs).toBeNull();
  });

  test('a lone machine never yields, because there is nobody to yield to', async () => {
    const world = createWorld();
    const alone = addNode(world, { id: 'node-a', surfaces: [...THREE] });
    await startNode(world, alone);
    await advance(world, 120_000);

    expect(heldCount(alone)).toBe(3);
    for (const name of THREE) {
      expect(surfaceState(alone, name).startCount).toBe(1);
      expect(surfaceState(alone, name).stopCount).toBe(0);
    }
  });

  test('a machine that is switched off does not drag a surface offline with it', async () => {
    const world = createWorld();
    const staying = addNode(world, { id: 'node-a', surfaces: [...THREE] });
    const leaving = addNode(world, { id: 'node-b', surfaces: [...THREE] });
    await startNode(world, staying);
    await startNode(world, leaving);
    await advance(world, 40_000);
    expect(heldCount(leaving)).toBeGreaterThanOrEqual(1);

    // Pulled off the network with no goodbye.
    world.bus.partition(leaving.transport, 'switched-off');
    await advance(world, 60_000);

    // The survivor picks up everything, and does NOT keep yielding surfaces to
    // a node that has not been heard from, which would take each one offline
    // for a full timeout before the survivor took it back.
    expect(heldCount(staying)).toBe(3);
    const startsAfterTakeover = totalStarts(world);
    await advance(world, 120_000);
    expect(totalStarts(world)).toBe(startsAfterTakeover);
  });

  test('a surface rescued from a dead machine is not handed straight back to it', async () => {
    // The regression this pins down is a TRANSIENT one, which is why the test
    // above could not see it: that test samples only after the dust settles,
    // and by then the survivor has already taken the surface back.
    //
    // Two liveness questions disagreed. A holder is declared gone after
    // masterTimeoutMs of silence; a yield TARGET was believed alive for twice
    // candidacyAnnounceMs, and candidacyAnnounceMs is masterTimeoutMs, so for
    // one further timeout the survivor still counted the dead machine as
    // somebody it could hand work to. It completed the failover, then
    // immediately yielded one of the rescued surfaces back to the corpse, and
    // that surface had no consumer at all until the watchdog re-elected it.
    // Observed live on a two-node LAN before the fix: failover finished 4.6s
    // after the kill, the yield landed 0.8s later, and the surface was dark
    // for a further 5.3s.
    const world = createWorld();
    const staying = addNode(world, { id: 'node-a', surfaces: [...THREE] });
    const leaving = addNode(world, { id: 'node-b', surfaces: [...THREE] });
    await startNode(world, staying);
    await startNode(world, leaving);
    await advance(world, 40_000);
    expect(heldCount(leaving)).toBeGreaterThanOrEqual(1);

    world.bus.partition(leaving.transport, 'switched-off');

    // Step to the exact moment the survivor holds everything, rather than
    // fast-forwarding past the window the defect lives in.
    let guard = 0;
    while (heldCount(staying) < THREE.length && guard < 400) {
      await advance(world, 250);
      guard += 1;
    }
    expect(heldCount(staying)).toBe(THREE.length);

    const stopsAtTakeover = THREE.reduce(
      (sum, name) => sum + surfaceState(staying, name).stopCount,
      0,
    );

    // One further master timeout is precisely the window that used to be open.
    await advance(world, 30_000);

    const stopsAfterwards = THREE.reduce(
      (sum, name) => sum + surfaceState(staying, name).stopCount,
      0,
    );
    expect(stopsAfterwards).toBe(stopsAtTakeover);
    expect(heldCount(staying)).toBe(THREE.length);
    // Deliberately NOT expectExactlyOneReaderEach: the partitioned node still
    // believes it holds what it held when the link dropped, which is ordinary
    // split-brain on the far side of a partition and not what this test is
    // about. The claim here is only about the survivor's own behaviour.
  });
});

describe('cluster spread — partial overlap still spreads', () => {
  test('a shared surface goes to the machine carrying less, not to the busier one', async () => {
    const world = createWorld();
    // The laptop already reads Telegram and one topic; the desktop reads
    // nothing yet and can serve the shared topic.
    const laptop = addNode(world, {
      id: 'node-a-laptop',
      surfaces: ['telegram-bot', 'ntfy-one', 'ntfy-shared'],
    });
    await startNode(world, laptop);
    await advance(world, 2_000);
    expect(heldCount(laptop)).toBe(3);

    const desktop = addNode(world, { id: 'node-b-desktop', surfaces: ['ntfy-shared'] });
    await startNode(world, desktop);
    await advance(world, 60_000);

    // Only one surface is contestable, so that is the one that moves, and it
    // moves, because the laptop is three ahead of a machine holding nothing.
    expect(surfaceState(desktop, 'ntfy-shared').running).toBe(true);
    expect(surfaceState(laptop, 'ntfy-shared').running).toBe(false);
    // The surfaces the desktop cannot serve stayed exactly where they were.
    expect(surfaceState(laptop, 'telegram-bot').running).toBe(true);
    expect(surfaceState(laptop, 'telegram-bot').stopCount).toBe(0);
    expect(surfaceState(laptop, 'ntfy-one').running).toBe(true);
    expect(surfaceState(laptop, 'ntfy-one').stopCount).toBe(0);

    // Balanced at 2/1 now; nothing further moves.
    const starts = totalStarts(world);
    await advance(world, 120_000);
    expect(totalStarts(world)).toBe(starts);
  });
});
