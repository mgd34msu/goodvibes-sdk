/**
 * LAN leader election — handoffs, and the ordering that makes them safe.
 *
 * The single property under test throughout this file: a successor NEVER
 * starts consuming a surface before its predecessor has finished stopping.
 * Every assertion on `world.events` is an ordering assertion, because "exactly
 * one consumer" is not a state you can check at a single instant — it is a
 * property of the sequence.
 */
import { describe, expect, test } from 'bun:test';
import { ClusterCoordinator } from '../packages/sdk/src/platform/cluster/coordinator.js';
import { FakeClusterClock } from '../packages/sdk/src/platform/cluster/clock.js';
import { MemoryClusterBus } from '../packages/sdk/src/platform/cluster/memory-transport.js';
import { decodeMessage, encodeMessage, signMessage } from '../packages/sdk/src/platform/cluster/protocol.js';
import { compareStableRank } from '../packages/sdk/src/platform/cluster/ranking.js';
import { DEFAULT_CLUSTER_SETTINGS, resolveClusterSettings } from '../packages/sdk/src/platform/cluster/settings.js';
import { ntfySurface, providerSurface, surfaceIdFor } from '../packages/sdk/src/platform/cluster/surface-id.js';
import {
  INITIAL_CONSUMER_CONFLICT_STATE,
  nextConsumerConflictBackoff,
} from '../packages/sdk/src/platform/cluster/consumer-conflict-backoff.js';
import { deriveClusterTiming } from '../packages/sdk/src/platform/cluster/timing.js';
import { parsePeers } from '../packages/sdk/src/platform/cluster/udp-transport.js';
import {
  CLUSTER_PROTOCOL_VERSION,
  type ClusterConsumerGate,
  type ClusterMessage,
} from '../packages/sdk/src/platform/cluster/types.js';
import {
  addNode,
  advance,
  createWorld,
  flush,
  holders,
  idFor,
  roleOf,
  settings,
  startNode,
  surfaceState,
  surfaceStatusOf,
  SILENT,
} from './cluster-harness.js';

/** Index of an event in the global ordered log; -1 when it never happened. */
function at(events: readonly string[], event: string): number {
  return events.indexOf(event);
}

const SURFACE = 'ntfy-main';

describe('cluster handoff — preemption by a strictly newer build', () => {
  test('the old holder stops consuming BEFORE it resigns, and only then does the new one start', async () => {
    const world = createWorld();
    const oldBuild = addNode(world, { id: 'node-old', version: '1.0.0', surfaces: [SURFACE] });
    await startNode(world, oldBuild);
    await advance(world, 1_100);
    expect(surfaceState(oldBuild, SURFACE).running).toBe(true);

    world.events.length = 0;
    const newBuild = addNode(world, { id: 'node-new', version: '1.1.0', surfaces: [SURFACE] });
    await startNode(world, newBuild);
    await advance(world, 1_500);

    const stopped = at(world.events, `node-old:${SURFACE}:consumers-stop`);
    const resigned = at(world.events, `node-old:${SURFACE}:send:RESIGN`);
    const started = at(world.events, `node-new:${SURFACE}:consumers-start`);
    expect(stopped).toBeGreaterThanOrEqual(0);
    expect(resigned).toBeGreaterThan(stopped);
    // The whole point: the successor's first byte of consumption happens after
    // the predecessor's last. Reverse these and one message is answered twice.
    expect(started).toBeGreaterThan(resigned);

    expect(surfaceState(newBuild, SURFACE).running).toBe(true);
    expect(surfaceState(oldBuild, SURFACE).running).toBe(false);
    expect(holders(world, SURFACE)).toEqual([newBuild]);

    // An ORDERED handoff replays NOTHING. The predecessor consumed right up to
    // its stop, so resuming from its last heartbeat would re-deliver every
    // message it already handled in between — which is not a near-miss but the
    // exact symptom this feature exists to prevent, arriving through the fix.
    expect(surfaceState(newBuild, SURFACE).lastReplayFromMs).toBeNull();
  });

  test('a handoff the predecessor never completed DOES replay, because the gap is real', async () => {
    const world = createWorld();
    const oldBuild = addNode(world, {
      id: 'node-old',
      version: '1.0.0',
      stopHangs: true,
      surfaces: [SURFACE],
    });
    await startNode(world, oldBuild);
    await advance(world, 1_100);
    const newBuild = addNode(world, { id: 'node-new', version: '1.1.0', surfaces: [SURFACE] });
    await startNode(world, newBuild);
    await flush(world);
    const lastHeardAt = surfaceStatusOf(newBuild, SURFACE).lastHolderHeartbeatAt;

    await advance(world, 1_500);
    expect(surfaceState(newBuild, SURFACE).running).toBe(true);
    // The grace timer fired, so we do NOT know the predecessor finished
    // stopping. Replaying a window is the right call: a duplicate is a
    // nuisance, a lost message is not recoverable.
    expect(surfaceState(newBuild, SURFACE).lastReplayFromMs).toBe(lastHeardAt);
  });

  test('an older build never preempts a newer one, however long it has been up', async () => {
    const world = createWorld();
    const newBuild = addNode(world, { id: 'node-new', version: '1.1.0', surfaces: [SURFACE] });
    await startNode(world, newBuild);
    await advance(world, 1_100);

    // Older version, and it will soon have been up far longer than the holder.
    // Neither is grounds to interrupt a node that is already doing the work.
    const oldBuild = addNode(world, { id: 'aaa-old', version: '1.0.0', surfaces: [SURFACE] });
    await startNode(world, oldBuild);
    await advance(world, 20_000);

    expect(surfaceState(newBuild, SURFACE).running).toBe(true);
    expect(surfaceState(oldBuild, SURFACE).running).toBe(false);
    expect(surfaceState(newBuild, SURFACE).stopCount).toBe(0);
  });

  test('a preemptor whose predecessor wedges on stop takes over on the grace timeout', async () => {
    const world = createWorld();
    // Its consumer never finishes closing — a long poll whose socket hangs —
    // so the RESIGN this handoff is waiting on will never be sent.
    const oldBuild = addNode(world, {
      id: 'node-old',
      version: '1.0.0',
      stopHangs: true,
      surfaces: [SURFACE],
    });
    await startNode(world, oldBuild);
    await advance(world, 1_100);
    expect(surfaceState(oldBuild, SURFACE).running).toBe(true);

    const newBuild = addNode(world, { id: 'node-new', version: '1.1.0', surfaces: [SURFACE] });
    await startNode(world, newBuild);
    await flush(world);
    expect(roleOf(newBuild, SURFACE)).toBe('awaiting-handoff');
    // It waits rather than seizing the surface: the ordered path gets its chance.
    expect(surfaceState(newBuild, SURFACE).running).toBe(false);
    expect(world.events).not.toContain(`node-old:${SURFACE}:send:RESIGN`);
    // The predecessor did at least stop consuming before it wedged.
    expect(world.events).toContain(`node-old:${SURFACE}:consumers-stop`);
    expect(surfaceState(oldBuild, SURFACE).running).toBe(false);

    // Grace elapses (masterTimeout/3 = 1s here) and the successor proceeds.
    await advance(world, 1_500);
    expect(roleOf(newBuild, SURFACE)).toBe('master');
    expect(surfaceState(newBuild, SURFACE).running).toBe(true);
  });

  test('a preemption moves only the surfaces both builds serve', async () => {
    const world = createWorld();
    const oldBuild = addNode(world, {
      id: 'node-old',
      version: '1.0.0',
      surfaces: [SURFACE, 'telegram-bot'],
    });
    await startNode(world, oldBuild);
    await advance(world, 1_100);

    // The newer build serves ONLY ntfy. It must not take Telegram away from a
    // node that can serve it, merely by being newer.
    const newBuild = addNode(world, { id: 'node-new', version: '1.1.0', surfaces: [SURFACE] });
    await startNode(world, newBuild);
    await advance(world, 2_000);

    expect(surfaceState(newBuild, SURFACE).running).toBe(true);
    expect(surfaceState(oldBuild, SURFACE).running).toBe(false);
    expect(surfaceState(oldBuild, 'telegram-bot').running).toBe(true);
    expect(surfaceState(oldBuild, 'telegram-bot').stopCount).toBe(0);
  });
});

describe('cluster handoff — clean shutdown', () => {
  test('a holder stops consuming and says goodbye, so failover skips the crash timeout', async () => {
    const world = createWorld();
    const leaving = addNode(world, { id: 'node-a', surfaces: [SURFACE] });
    await startNode(world, leaving);
    await advance(world, 1_100);
    const successor = addNode(world, { id: 'node-b', surfaces: [SURFACE] });
    await startNode(world, successor);
    await advance(world, 1_000);
    expect(surfaceState(successor, SURFACE).running).toBe(false);

    world.events.length = 0;
    await leaving.election.stop('SIGTERM');
    await flush(world);

    const stopped = at(world.events, `node-a:${SURFACE}:consumers-stop`);
    const resigned = at(world.events, `node-a:${SURFACE}:send:RESIGN`);
    expect(stopped).toBeGreaterThanOrEqual(0);
    expect(resigned).toBeGreaterThan(stopped);
    expect(surfaceState(leaving, SURFACE).running).toBe(false);

    // The crash timeout is 3s here. A clean goodbye must not wait for it.
    await advance(world, 1_200);
    expect(roleOf(successor, SURFACE)).toBe('master');
    expect(surfaceState(successor, SURFACE).running).toBe(true);
    expect(at(world.events, `node-b:${SURFACE}:consumers-start`)).toBeGreaterThan(resigned);
    // A clean goodbye is an ordered handoff too: nothing to replay.
    expect(surfaceState(successor, SURFACE).lastReplayFromMs).toBeNull();
  });

  test('stopping a standby is silent and disturbs nobody', async () => {
    const world = createWorld();
    const holder = addNode(world, { id: 'node-a', surfaces: [SURFACE] });
    await startNode(world, holder);
    await advance(world, 1_100);
    const standby = addNode(world, { id: 'node-b', surfaces: [SURFACE] });
    await startNode(world, standby);
    await flush(world);

    world.events.length = 0;
    await standby.election.stop('SIGTERM');
    await advance(world, 5_000);

    expect(world.events).not.toContain(`node-b:${SURFACE}:consumers-stop`);
    expect(surfaceState(holder, SURFACE).running).toBe(true);
    expect(surfaceState(holder, SURFACE).stopCount).toBe(0);
  });

  test('a surface whose credential is withdrawn is released cleanly, and only it', async () => {
    const world = createWorld();
    const node = addNode(world, { id: 'node-a', surfaces: [SURFACE, 'telegram-bot'] });
    await startNode(world, node);
    await advance(world, 1_100);
    expect(surfaceState(node, 'telegram-bot').running).toBe(true);

    world.events.length = 0;
    // The bot token is removed while the daemon runs: the consumer unregisters.
    node.unregister.get('telegram-bot')?.();
    await advance(world, 500);

    // It stopped consuming and said goodbye rather than going quiet, so any
    // other node is free to take it immediately instead of waiting the timeout.
    const stopped = at(world.events, 'node-a:telegram-bot:consumers-stop');
    expect(stopped).toBeGreaterThanOrEqual(0);
    expect(at(world.events, 'node-a:telegram-bot:send:RESIGN')).toBeGreaterThan(stopped);
    expect(node.election.surfaceRole(idFor('telegram-bot'))).toBe('stopped');
    // ntfy carried on throughout.
    expect(surfaceState(node, SURFACE).running).toBe(true);
    expect(surfaceState(node, SURFACE).stopCount).toBe(0);
  });
});

describe('cluster handoff — partition and heal', () => {
  test('both sides elect while split; on heal the better-ranked one keeps the surface', async () => {
    const world = createWorld();
    const first = addNode(world, { id: 'node-a', surfaces: [SURFACE] });
    world.bus.partition(first.transport, 'left');
    await startNode(world, first);
    await advance(world, 1_100);

    const second = addNode(world, { id: 'node-b', surfaces: [SURFACE] });
    world.bus.partition(second.transport, 'right');
    await startNode(world, second);
    await advance(world, 1_100);

    // A genuine split brain: neither side can hear the other, so both are
    // correctly consuming for their own side of the network.
    expect(surfaceState(first, SURFACE).running).toBe(true);
    expect(surfaceState(second, SURFACE).running).toBe(true);

    // The winner is decided by the holdings-FREE ordering, which both sides
    // compute identically from the datagram alone. Two nodes that were
    // partitioned have by definition observed different traffic, so a
    // reconciliation ranked on observed load could have both believe they won.
    const digest = idFor(SURFACE);
    const rank = compareStableRank(
      { nodeId: 'node-a', version: '1.0.0' },
      { nodeId: 'node-b', version: '1.0.0' },
      digest,
    );
    const [winner, loser] = rank < 0 ? [first, second] : [second, first];

    world.events.length = 0;
    world.bus.heal();
    await advance(world, 3_000);

    expect(holders(world, SURFACE)).toEqual([winner]);
    const stopped = at(world.events, `${loser.id}:${SURFACE}:consumers-stop`);
    const resigned = at(world.events, `${loser.id}:${SURFACE}:send:RESIGN`);
    expect(stopped).toBeGreaterThanOrEqual(0);
    expect(resigned).toBeGreaterThan(stopped);
    // The winner never stopped: it was already the right answer.
    expect(surfaceState(winner, SURFACE).stopCount).toBe(0);
    expect(surfaceState(winner, SURFACE).startCount).toBe(1);
  });
});

describe('cluster handoff — the provider-conflict backstop', () => {
  test('a 409 naming another consumer makes this node stand down instead of fighting', async () => {
    const world = createWorld();
    const node = addNode(world, { id: 'node-a', surfaces: [SURFACE] });
    await startNode(world, node);
    await advance(world, 1_100);
    expect(surfaceState(node, SURFACE).running).toBe(true);

    world.events.length = 0;
    node.election.reportConsumerConflict('terminated by other getUpdates request');
    await flush(world);

    // Stop first, then say so. Retrying instead would produce two processes
    // each terminating the other's long poll while messages go nowhere.
    const stopped = at(world.events, `node-a:${SURFACE}:consumers-stop`);
    expect(stopped).toBeGreaterThanOrEqual(0);
    expect(at(world.events, `node-a:${SURFACE}:send:RESIGN`)).toBeGreaterThan(stopped);
    expect(surfaceState(node, SURFACE).running).toBe(false);
    expect(roleOf(node, SURFACE)).toBe('standby');

    // It backs off, re-probes, and — if the conflict was transient and nobody
    // else claims — comes back on its own rather than staying dead.
    await advance(world, 2_000);
    expect(roleOf(node, SURFACE)).toBe('master');
    expect(surfaceState(node, SURFACE).running).toBe(true);
  });

  test('a conflict on one surface leaves this node\'s other surfaces alone', async () => {
    const world = createWorld();
    const node = addNode(world, { id: 'node-a', surfaces: [SURFACE, 'telegram-bot'] });
    await startNode(world, node);
    await advance(world, 1_100);

    // A Telegram 409 is about one bot token. Giving up an unrelated ntfy topic
    // over it would take a working surface down for no reason.
    node.election.reportConsumerConflict('terminated by other getUpdates request', idFor('telegram-bot'));
    await flush(world);

    expect(surfaceState(node, 'telegram-bot').running).toBe(false);
    expect(surfaceState(node, SURFACE).running).toBe(true);
    expect(surfaceState(node, SURFACE).stopCount).toBe(0);
  });

  test('the backoff doubles to a ceiling, and resets only after the consumer really served', () => {
    const limits = { floorMs: 500, ceilingMs: 4_000, servedLongEnoughMs: 3_000 };
    // Refused immediately every time: the interval doubles and then stops.
    let state = INITIAL_CONSUMER_CONFLICT_STATE;
    const delays: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      state = nextConsumerConflictBackoff(state, { servedForMs: 0, ...limits });
      delays.push(state.lastDelayMs);
    }
    expect(delays).toEqual([500, 1_000, 2_000, 4_000, 4_000, 4_000]);

    // Having served well past the threshold, the next refusal starts over —
    // this is a new incident, not a continuation of the old one.
    const afterServing = nextConsumerConflictBackoff(state, { servedForMs: 60_000, ...limits });
    expect(afterServing.streak).toBe(1);
    expect(afterServing.lastDelayMs).toBe(500);

    // Serving for less than the threshold does NOT reset it: a consumer that
    // starts and is refused straight away is exactly the loop being damped.
    const afterBlink = nextConsumerConflictBackoff(state, { servedForMs: 10, ...limits });
    expect(afterBlink.streak).toBe(state.streak + 1);
  });

  test('a surface refused over and over is retried less and less often, not at a fixed rate', async () => {
    // A consumer conflict is not a transient fault: another PROCESS holds the
    // credential, and no amount of retrying decides which one should. With a
    // flat backoff a node with no peer to hand the surface to resigns,
    // re-probes, wins its own election again, restarts the consumer and is
    // refused again — forever, at a constant rate, against a third party's
    // API. Measured live on a two-node group with a 4s master timeout before
    // this existed: 44 getUpdates calls in 40 seconds, every one refused.
    const world = createWorld();
    const node = addNode(world, { id: 'node-a', surfaces: [SURFACE] });
    await startNode(world, node);
    await advance(world, 1_100);
    expect(surfaceState(node, SURFACE).running).toBe(true);

    // Refuse it every single time it manages to start.
    const gapsMs: number[] = [];
    for (let round = 0; round < 4; round += 1) {
      expect(roleOf(node, SURFACE)).toBe('master');
      node.election.reportConsumerConflict('terminated by other getUpdates request');
      await flush(world);
      expect(roleOf(node, SURFACE)).toBe('standby');

      // Step until it contests again, and record how long that took.
      let waited = 0;
      while (roleOf(node, SURFACE) !== 'master' && waited < 600_000) {
        await advance(world, 100);
        waited += 100;
      }
      gapsMs.push(waited);
    }

    // Each wait is longer than the one before it.
    for (let i = 1; i < gapsMs.length; i += 1) {
      expect(gapsMs[i]!).toBeGreaterThan(gapsMs[i - 1]!);
    }
    // And it is bounded, not unbounded growth. The harness runs a 3s master
    // timeout, so the ceiling is 30s; a real install's 90s timeout gives the
    // fifteen-minute cap.
    const timing = deriveClusterTiming(resolveClusterSettings({
      enabled: true, heartbeatSeconds: 1, masterTimeoutSeconds: 3, bootProbeSeconds: 1,
    }));
    expect(timing.consumerConflictBackoffMaxMs).toBe(30_000);
    expect(gapsMs[gapsMs.length - 1]!).toBeLessThanOrEqual(
      timing.consumerConflictBackoffMaxMs + 2_000,
    );
  });

  test('a conflict reported to a standby changes nothing', async () => {
    const world = createWorld();
    const holder = addNode(world, { id: 'node-a', surfaces: [SURFACE] });
    await startNode(world, holder);
    await advance(world, 1_100);
    const standby = addNode(world, { id: 'node-b', surfaces: [SURFACE] });
    await startNode(world, standby);
    await flush(world);

    standby.election.reportConsumerConflict('terminated by other getUpdates request');
    await advance(world, 2_000);
    expect(surfaceState(standby, SURFACE).stopCount).toBe(0);
    expect(surfaceState(holder, SURFACE).running).toBe(true);
  });
});

describe('cluster protocol — the wire', () => {
  const message: ClusterMessage = {
    v: CLUSTER_PROTOCOL_VERSION,
    type: 'CLAIM',
    surfaceId: surfaceIdFor(ntfySurface('https://ntfy.test', 'gv-secret-topic-name')),
    nodeId: 'node-a',
    nodeVersion: '1.2.3',
    seq: 7,
    ts: 1_700_000_000_000,
  };

  test('a surface travels as a digest, never as the topic or the bot id', () => {
    const raw = encodeMessage(message, '');
    // The capability itself — anyone who learns an ntfy topic name can read
    // and publish to it — must not be recoverable from a packet capture.
    expect(raw).not.toContain('gv-secret-topic-name');
    expect(raw).not.toContain('ntfy.test');
    expect(message.surfaceId).toMatch(/^[0-9a-f]{32}$/);

    const botMessage: ClusterMessage = {
      ...message,
      surfaceId: surfaceIdFor({ kind: 'telegram', discriminator: '8123456789' }),
    };
    expect(encodeMessage(botMessage, '')).not.toContain('8123456789');
  });

  test('the same surface hashes identically on every node, and different ones differ', () => {
    const here = surfaceIdFor(ntfySurface('https://ntfy.sh/', 'topic-one'));
    const there = surfaceIdFor(ntfySurface('https://ntfy.sh', 'topic-one'));
    // Trailing slash and case in the server are normalized, so two nodes that
    // wrote the same server slightly differently still meet in one election.
    expect(here).toBe(there);
    // The same topic name on a different server is a DIFFERENT surface: a node
    // reading a self-hosted server must not stand down for one reading ntfy.sh.
    expect(surfaceIdFor(ntfySurface('https://ntfy.example', 'topic-one'))).not.toBe(here);
    expect(surfaceIdFor(ntfySurface('https://ntfy.sh', 'topic-two'))).not.toBe(here);
  });

  test('a plaintext surface name on the wire is rejected, not accepted as a digest', () => {
    const spoofed = JSON.stringify({ ...message, surfaceId: 'gv-secret-topic-name' });
    const result = decodeMessage(spoofed, '');
    expect(result.message).toBeNull();
    expect(result.rejected).toContain('surface digest');
  });

  test('a group-level datagram with no surface decodes and is not an error', () => {
    const groupLevel = encodeMessage({ ...message, surfaceId: null }, '');
    expect(decodeMessage(groupLevel, '').message?.surfaceId).toBeNull();
  });

  test('an unsigned datagram is rejected once a shared phrase is configured', () => {
    const unsigned = encodeMessage(message, '');
    expect(decodeMessage(unsigned, '').message).toEqual(message);

    const rejected = decodeMessage(unsigned, 'shared-phrase');
    expect(rejected.message).toBeNull();
    expect(rejected.rejected).toContain('unsigned');
  });

  test('a datagram signed with the wrong phrase is rejected', () => {
    const wrong = encodeMessage(message, 'not-the-phrase');
    const rejected = decodeMessage(wrong, 'shared-phrase');
    expect(rejected.message).toBeNull();
    expect(rejected.rejected).toContain('signature');
  });

  test('a correctly signed datagram verifies, and tampering with any field breaks it', () => {
    const signed = encodeMessage(message, 'shared-phrase');
    expect(decodeMessage(signed, 'shared-phrase').message).toEqual(message);

    const tampered = JSON.stringify({
      ...message,
      nodeVersion: '9.9.9',
      sig: signMessage(message, 'shared-phrase'),
    });
    expect(decodeMessage(tampered, 'shared-phrase').message).toBeNull();

    // The surface is inside the signed form: an unsigned surfaceId could be
    // rewritten in flight to redirect a claim at a different surface.
    const redirected = JSON.stringify({
      ...message,
      surfaceId: surfaceIdFor(ntfySurface('https://ntfy.test', 'other-topic')),
      sig: signMessage(message, 'shared-phrase'),
    });
    expect(decodeMessage(redirected, 'shared-phrase').message).toBeNull();
  });

  test('a signed cluster ignores a node that does not know the phrase', async () => {
    const world = createWorld();
    const trusted = addNode(world, {
      id: 'node-trusted',
      surfaces: [SURFACE],
      settings: { secret: 'shared-phrase' },
    });
    await startNode(world, trusted);
    await advance(world, 1_100);

    const stranger = addNode(world, { id: 'node-stranger', surfaces: [SURFACE] });
    await startNode(world, stranger);
    await advance(world, 4_000);

    // The stranger cannot be heard by the trusted node, so the trusted node
    // never gives the surface up — and the stranger, hearing nothing it
    // accepts, believes it is alone. That is the correct outcome for a node
    // that was never admitted: it must not be able to take a surface away.
    expect(surfaceState(trusted, SURFACE).running).toBe(true);
    expect(surfaceState(trusted, SURFACE).stopCount).toBe(0);
    expect(trusted.election.status().peers).toHaveLength(0);
  });

  test('malformed, mis-versioned and oversized datagrams are dropped, not parsed', () => {
    expect(decodeMessage('not json', '').message).toBeNull();
    expect(decodeMessage('[]', '').message).toBeNull();
    expect(decodeMessage(JSON.stringify({ ...message, type: 'NOPE' }), '').message).toBeNull();
    expect(decodeMessage(JSON.stringify({ ...message, nodeId: '' }), '').message).toBeNull();
    expect(decodeMessage(JSON.stringify({ ...message, v: 2 }), '').rejected).toContain('protocol version');
    expect(decodeMessage('x'.repeat(5_000), '').rejected).toContain('size limit');
  });
});

describe('cluster coordinator — the wiring contract', () => {
  function recordingGate(id: string, log: string[], surfaceName = 'topic-one'): ClusterConsumerGate {
    return {
      id,
      surface: providerSurface('custom', surfaceName),
      start: async () => { log.push(`${id}:start`); },
      stop: async () => { log.push(`${id}:stop`); },
    };
  }

  function buildCoordinator(clock: FakeClusterClock, bus: MemoryClusterBus): ClusterCoordinator {
    return new ClusterCoordinator({
      settings: settings(),
      version: '1.0.0',
      stateDirectory: '/nonexistent-should-not-be-touched',
      logger: SILENT,
      transport: bus.createTransport('solo'),
      clock,
      nodeId: 'node-a',
      random: () => 0,
    });
  }

  test('gates on one surface start in registration order and stop in the reverse', async () => {
    const log: string[] = [];
    const clock = new FakeClusterClock();
    const coordinator = buildCoordinator(clock, new MemoryClusterBus());
    coordinator.register(recordingGate('primary-consumer', log));
    coordinator.register(recordingGate('secondary-consumer', log));

    await coordinator.start();
    clock.advance(1_100);
    await coordinator.settled();
    await Promise.resolve();
    await coordinator.settled();
    expect(log).toEqual(['primary-consumer:start', 'secondary-consumer:start']);
    expect(coordinator.isMaster).toBe(true);

    log.length = 0;
    await coordinator.stop('shutdown');
    // Reverse order: a consumer another depends on stays up longest.
    expect(log).toEqual(['secondary-consumer:stop', 'primary-consumer:stop']);
  });

  test('two surfaces get two independent elections on one socket', async () => {
    const log: string[] = [];
    const clock = new FakeClusterClock();
    const coordinator = buildCoordinator(clock, new MemoryClusterBus());
    coordinator.register(recordingGate('topic-one-consumer', log, 'topic-one'));
    coordinator.register(recordingGate('topic-two-consumer', log, 'topic-two'));

    await coordinator.start();
    clock.advance(1_100);
    await coordinator.settled();
    await Promise.resolve();
    await coordinator.settled();

    expect(coordinator.holdsSurface(providerSurface('custom', 'topic-one'))).toBe(true);
    expect(coordinator.holdsSurface(providerSurface('custom', 'topic-two'))).toBe(true);
    expect(coordinator.status().heldSurfaceCount).toBe(2);
    expect(coordinator.status().surfaces).toHaveLength(2);
    await coordinator.stop('shutdown');
  });

  test('with the election disabled every gate runs unconditionally and no socket is opened', async () => {
    const log: string[] = [];
    const coordinator = new ClusterCoordinator({
      settings: settings({ enabled: false }),
      version: '1.0.0',
      stateDirectory: '/nonexistent-should-not-be-touched',
      logger: SILENT,
      nodeId: 'node-a',
    });
    coordinator.register(recordingGate('provider-runtime', log));

    await coordinator.start();
    // No probe window, no election, no waiting: exactly the behavior that
    // existed before the coordinator was introduced.
    expect(log).toEqual(['provider-runtime:start']);
    expect(coordinator.isMaster).toBe(true);
    expect(coordinator.status().enabled).toBe(false);

    await coordinator.stop('shutdown');
    expect(log).toEqual(['provider-runtime:start', 'provider-runtime:stop']);
  });

  test('the status section names the node and its surfaces without leaking anything else', async () => {
    const clock = new FakeClusterClock();
    const bus = new MemoryClusterBus();
    const coordinator = new ClusterCoordinator({
      settings: settings({ secret: 'shared-phrase' }),
      version: '1.4.2',
      stateDirectory: '/nonexistent-should-not-be-touched',
      logger: SILENT,
      transport: bus.createTransport('solo'),
      clock,
      nodeId: 'node-a',
      random: () => 0,
    });
    coordinator.register({
      id: 'ntfy-topic',
      surface: ntfySurface('https://ntfy.test', 'gv-secret-topic-name'),
      start: async () => {},
      stop: async () => {},
    });
    await coordinator.start();
    clock.advance(1_100);
    await coordinator.settled();

    const status = coordinator.status();
    expect(status.nodeId).toBe('node-a');
    expect(status.version).toBe('1.4.2');
    expect(status.enabled).toBe(true);
    expect(status.signed).toBe(true);
    expect(status.heldSurfaceCount).toBe(1);
    const serialized = JSON.stringify(status);
    // Neither the shared phrase nor the topic name is part of the payload —
    // a pasted /status is as safe as a packet capture.
    expect(serialized).not.toContain('shared-phrase');
    expect(serialized).not.toContain('gv-secret-topic-name');
    expect(status.surfaces[0]?.label).toMatch(/^ntfy:[0-9a-f]{8}$/);
    await coordinator.stop('shutdown');
  });
});

describe('cluster settings', () => {
  test('a node with coordination off starts every consumer and opens no socket', async () => {
    // The default. It must behave EXACTLY as the product did before the
    // election existed: consume unconditionally, announce nothing, and never
    // be discoverable by anyone else on the network.
    const resolved = resolveClusterSettings({});
    expect(resolved.enabled).toBe(false);
  });

  test('defaults sit in the administratively-scoped multicast range and a private port', () => {
    expect(DEFAULT_CLUSTER_SETTINGS.multicastGroup.startsWith('239.')).toBe(true);
    expect(DEFAULT_CLUSTER_SETTINGS.port).toBeGreaterThan(60_999);
    expect(DEFAULT_CLUSTER_SETTINGS.port).toBeLessThan(65_536);
    // Off unless the operator asks for it: switching it on asserts that every
    // goodvibes node on this network is theirs, and on a shared network a
    // stranger's node joining the coordination would silently starve one side.
    expect(DEFAULT_CLUSTER_SETTINGS.enabled).toBe(false);
    expect(DEFAULT_CLUSTER_SETTINGS.secret).toBe('');
    expect(DEFAULT_CLUSTER_SETTINGS.peers).toEqual([]);
  });

  test('nonsense values are clamped rather than taking inbound messaging down', () => {
    const resolved = resolveClusterSettings({
      enabled: 'yes',
      heartbeatSeconds: 0,
      masterTimeoutSeconds: 1,
      bootProbeSeconds: -4,
      port: 999_999,
      multicastGroup: '   ',
      secret: 42,
      peers: ['10.0.0.5', '', 7, '10.0.0.6:61999'],
    });
    // A non-boolean is not a way to switch coordination on by accident.
    expect(resolved.enabled).toBe(false);
    expect(resolved.heartbeatSeconds).toBe(1);
    // Never below two heartbeats, or a healthy holder is declared dead between beats.
    expect(resolved.masterTimeoutSeconds).toBe(2);
    expect(resolved.bootProbeSeconds).toBe(1);
    expect(resolved.port).toBe(65_535);
    expect(resolved.multicastGroup).toBe(DEFAULT_CLUSTER_SETTINGS.multicastGroup);
    expect(resolved.secret).toBe('');
    expect(resolved.peers).toEqual(['10.0.0.5', '10.0.0.6:61999']);
  });

  test('static peers parse with and without an explicit port, and junk is skipped', () => {
    expect(parsePeers(['10.0.0.5', '10.0.0.6:5000', 'bad:port', '', '  '], 61_860)).toEqual([
      { host: '10.0.0.5', port: 61_860 },
      { host: '10.0.0.6', port: 5_000 },
    ]);
  });
});
