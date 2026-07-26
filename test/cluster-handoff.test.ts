/**
 * LAN leader election — handoffs, and the ordering that makes them safe.
 *
 * The single property under test throughout this file: a successor NEVER
 * starts consuming before its predecessor has finished stopping. Every
 * assertion on `world.events` is an ordering assertion, because "exactly one
 * consumer" is not a state you can check at a single instant — it is a
 * property of the sequence.
 */
import { describe, expect, test } from 'bun:test';
import { ClusterCoordinator } from '../packages/sdk/src/platform/cluster/coordinator.js';
import { FakeClusterClock } from '../packages/sdk/src/platform/cluster/clock.js';
import { MemoryClusterBus } from '../packages/sdk/src/platform/cluster/memory-transport.js';
import { decodeMessage, encodeMessage, signMessage } from '../packages/sdk/src/platform/cluster/protocol.js';
import { DEFAULT_CLUSTER_SETTINGS, resolveClusterSettings } from '../packages/sdk/src/platform/cluster/settings.js';
import { parsePeers } from '../packages/sdk/src/platform/cluster/udp-transport.js';
import type { ClusterConsumerGate, ClusterMessage } from '../packages/sdk/src/platform/cluster/types.js';
import { addNode, advance, createWorld, flush, masters, settings, startNode, SILENT } from './cluster-harness.js';

/** Index of an event in the global ordered log; -1 when it never happened. */
function at(events: readonly string[], event: string): number {
  return events.indexOf(event);
}

describe('cluster handoff — preemption by a strictly newer build', () => {
  test('the old master stops consuming BEFORE it resigns, and only then does the new one start', async () => {
    const world = createWorld();
    const oldBuild = addNode(world, { id: 'node-old', version: '1.0.0' });
    await startNode(world, oldBuild);
    await advance(world, 1_100);
    expect(oldBuild.running).toBe(true);

    world.events.length = 0;
    const newBuild = addNode(world, { id: 'node-new', version: '1.1.0' });
    await startNode(world, newBuild);
    await advance(world, 1_500);

    const stopped = at(world.events, 'node-old:consumers-stop');
    const resigned = at(world.events, 'node-old:send:RESIGN');
    const started = at(world.events, 'node-new:consumers-start');
    expect(stopped).toBeGreaterThanOrEqual(0);
    expect(resigned).toBeGreaterThan(stopped);
    // The whole point: the successor's first byte of consumption happens after
    // the predecessor's last. Reverse these and one message is answered twice.
    expect(started).toBeGreaterThan(resigned);

    expect(newBuild.running).toBe(true);
    expect(oldBuild.running).toBe(false);
    expect(masters(world)).toEqual([newBuild]);

    // An ORDERED handoff replays NOTHING. The predecessor consumed right up to
    // its stop, so resuming from its last heartbeat would re-deliver every
    // message it already handled in between — which is not a near-miss but the
    // exact symptom this feature exists to prevent, arriving through the fix.
    // Caught live on 2026-07-26: a message published during a version handoff
    // was consumed by both nodes until this distinction was drawn.
    expect(newBuild.lastReplayFromMs).toBeNull();
  });

  test('a handoff the predecessor never completed DOES replay, because the gap is real', async () => {
    const world = createWorld();
    const oldBuild = addNode(world, { id: 'node-old', version: '1.0.0', stopHangs: true });
    await startNode(world, oldBuild);
    await advance(world, 1_100);
    const newBuild = addNode(world, { id: 'node-new', version: '1.1.0' });
    await startNode(world, newBuild);
    await flush(world);
    const lastHeardAt = newBuild.election.status().lastMasterHeartbeatAt;

    await advance(world, 1_500);
    expect(newBuild.running).toBe(true);
    // The grace timer fired, so we do NOT know the predecessor finished
    // stopping. Replaying a window is the right call: a duplicate is a
    // nuisance, a lost message is not recoverable.
    expect(newBuild.lastReplayFromMs).toBe(lastHeardAt);
  });

  test('an older build never preempts a newer one, and a longer uptime never does either', async () => {
    const world = createWorld();
    const newBuild = addNode(world, { id: 'node-new', version: '1.1.0' });
    await startNode(world, newBuild);
    await advance(world, 1_100);

    // Older version AND (soon) far more uptime than the master. Neither is
    // grounds to interrupt a node that is already doing the work.
    const oldBuild = addNode(world, { id: 'aaa-old', version: '1.0.0' });
    await startNode(world, oldBuild);
    await advance(world, 20_000);

    expect(newBuild.running).toBe(true);
    expect(oldBuild.running).toBe(false);
    expect(newBuild.stopCount).toBe(0);
  });

  test('a preemptor whose predecessor wedges on stop takes over on the grace timeout', async () => {
    const world = createWorld();
    // Its consumer never finishes closing — a long poll whose socket hangs —
    // so the RESIGN this handoff is waiting on will never be sent.
    const oldBuild = addNode(world, { id: 'node-old', version: '1.0.0', stopHangs: true });
    await startNode(world, oldBuild);
    await advance(world, 1_100);
    expect(oldBuild.running).toBe(true);

    const newBuild = addNode(world, { id: 'node-new', version: '1.1.0' });
    await startNode(world, newBuild);
    await flush(world);
    expect(newBuild.election.currentRole).toBe('awaiting-handoff');
    // It waits rather than seizing the role: the ordered path gets its chance.
    expect(newBuild.running).toBe(false);
    expect(world.events).not.toContain('node-old:send:RESIGN');
    // The predecessor did at least stop consuming before it wedged.
    expect(world.events).toContain('node-old:consumers-stop');
    expect(oldBuild.running).toBe(false);

    // Grace elapses (masterTimeout/3 = 1s here) and the successor proceeds.
    await advance(world, 1_500);
    expect(newBuild.election.currentRole).toBe('master');
    expect(newBuild.running).toBe(true);
  });
});

describe('cluster handoff — clean shutdown', () => {
  test('a master stops consuming and says goodbye, so failover does not wait out the crash timeout', async () => {
    const world = createWorld();
    const leaving = addNode(world, { id: 'node-a' });
    await startNode(world, leaving);
    await advance(world, 1_100);
    const successor = addNode(world, { id: 'node-b' });
    await startNode(world, successor);
    await advance(world, 1_000);
    expect(successor.running).toBe(false);

    world.events.length = 0;
    await leaving.election.stop('SIGTERM');
    await flush(world);

    const stopped = at(world.events, 'node-a:consumers-stop');
    const resigned = at(world.events, 'node-a:send:RESIGN');
    expect(stopped).toBeGreaterThanOrEqual(0);
    expect(resigned).toBeGreaterThan(stopped);
    expect(leaving.running).toBe(false);

    // The crash timeout is 3s here. A clean goodbye must not wait for it.
    await advance(world, 1_200);
    expect(successor.election.currentRole).toBe('master');
    expect(successor.running).toBe(true);
    expect(at(world.events, 'node-b:consumers-start')).toBeGreaterThan(resigned);
    // A clean goodbye is an ordered handoff too: nothing to replay.
    expect(successor.lastReplayFromMs).toBeNull();
  });

  test('stopping a standby is silent and disturbs nobody', async () => {
    const world = createWorld();
    const master = addNode(world, { id: 'node-a' });
    await startNode(world, master);
    await advance(world, 1_100);
    const standby = addNode(world, { id: 'node-b' });
    await startNode(world, standby);
    await flush(world);

    world.events.length = 0;
    await standby.election.stop('SIGTERM');
    await advance(world, 5_000);

    expect(world.events).not.toContain('node-b:consumers-stop');
    expect(master.running).toBe(true);
    expect(master.stopCount).toBe(0);
  });
});

describe('cluster handoff — partition and heal', () => {
  test('both sides elect while split; on heal the better-ranked one keeps the role', async () => {
    const world = createWorld();
    const first = addNode(world, { id: 'node-a' });
    world.bus.partition(first.transport, 'left');
    await startNode(world, first);
    await advance(world, 1_100);

    const second = addNode(world, { id: 'node-b' });
    world.bus.partition(second.transport, 'right');
    await startNode(world, second);
    await advance(world, 1_100);

    // A genuine split brain: neither side can hear the other, so both are
    // correctly consuming for their own side of the network.
    expect(first.running).toBe(true);
    expect(second.running).toBe(true);

    world.events.length = 0;
    world.bus.heal();
    await advance(world, 3_000);

    // One survivor, decided by rank without any negotiation: `first` has the
    // longer uptime at equal versions.
    expect(masters(world)).toEqual([first]);
    const stopped = at(world.events, 'node-b:consumers-stop');
    const resigned = at(world.events, 'node-b:send:RESIGN');
    expect(stopped).toBeGreaterThanOrEqual(0);
    expect(resigned).toBeGreaterThan(stopped);
    // The winner never stopped: it was already the right answer.
    expect(first.stopCount).toBe(0);
    expect(first.startCount).toBe(1);
  });
});

describe('cluster handoff — the provider-conflict backstop', () => {
  test('a 409 naming another consumer makes this node stand down instead of fighting', async () => {
    const world = createWorld();
    const node = addNode(world, { id: 'node-a' });
    await startNode(world, node);
    await advance(world, 1_100);
    expect(node.running).toBe(true);

    world.events.length = 0;
    node.election.reportConsumerConflict('terminated by other getUpdates request');
    await flush(world);

    // Stop first, then say so. Retrying instead would produce two processes
    // each terminating the other's long poll while messages go nowhere.
    const stopped = at(world.events, 'node-a:consumers-stop');
    expect(stopped).toBeGreaterThanOrEqual(0);
    expect(at(world.events, 'node-a:send:RESIGN')).toBeGreaterThan(stopped);
    expect(node.running).toBe(false);
    expect(node.election.currentRole).toBe('standby');

    // It backs off, re-probes, and — if the conflict was transient and nobody
    // else claims — comes back on its own rather than staying dead.
    await advance(world, 2_000);
    expect(node.election.currentRole).toBe('master');
    expect(node.running).toBe(true);
  });

  test('a conflict reported to a standby changes nothing', async () => {
    const world = createWorld();
    const master = addNode(world, { id: 'node-a' });
    await startNode(world, master);
    await advance(world, 1_100);
    const standby = addNode(world, { id: 'node-b' });
    await startNode(world, standby);
    await flush(world);

    standby.election.reportConsumerConflict('terminated by other getUpdates request');
    await advance(world, 2_000);
    expect(standby.stopCount).toBe(0);
    expect(master.running).toBe(true);
  });
});

describe('cluster protocol — signing', () => {
  const message: ClusterMessage = {
    type: 'CLAIM',
    nodeId: 'node-a',
    version: '1.2.3',
    uptimeMs: 4_000,
    seq: 7,
  };

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
      version: '9.9.9',
      sig: signMessage(message, 'shared-phrase'),
    });
    expect(decodeMessage(tampered, 'shared-phrase').message).toBeNull();
  });

  test('a signed cluster ignores a node that does not know the phrase', async () => {
    const world = createWorld();
    const trusted = addNode(world, { id: 'node-trusted', settings: { secret: 'shared-phrase' } });
    await startNode(world, trusted);
    await advance(world, 1_100);

    const stranger = addNode(world, { id: 'node-stranger' });
    await startNode(world, stranger);
    await advance(world, 4_000);

    // The stranger cannot be heard by the trusted node, so the trusted node
    // never gives up the role — and the stranger, hearing nothing it accepts,
    // believes it is alone. That is the correct outcome for a node that was
    // never admitted: it must not be able to take the role away.
    expect(trusted.running).toBe(true);
    expect(trusted.stopCount).toBe(0);
    expect(trusted.election.status().peers).toHaveLength(0);
  });

  test('malformed and oversized datagrams are dropped, not parsed', () => {
    expect(decodeMessage('not json', '').message).toBeNull();
    expect(decodeMessage('[]', '').message).toBeNull();
    expect(decodeMessage(JSON.stringify({ type: 'NOPE', nodeId: 'a', version: '1', uptimeMs: 0, seq: 0 }), '').message).toBeNull();
    expect(decodeMessage(JSON.stringify({ type: 'CLAIM', nodeId: '', version: '1', uptimeMs: 0, seq: 0 }), '').message).toBeNull();
    expect(decodeMessage('x'.repeat(5_000), '').rejected).toContain('size limit');
  });
});

describe('cluster coordinator — the wiring contract', () => {
  function recordingGate(id: string, log: string[]): ClusterConsumerGate {
    return {
      id,
      start: async () => { log.push(`${id}:start`); },
      stop: async () => { log.push(`${id}:stop`); },
    };
  }

  test('gates start in registration order and stop in the reverse', async () => {
    const log: string[] = [];
    const bus = new MemoryClusterBus();
    const clock = new FakeClusterClock();
    const coordinator = new ClusterCoordinator({
      settings: settings(),
      version: '1.0.0',
      stateDirectory: '/nonexistent-should-not-be-touched',
      logger: SILENT,
      transport: bus.createTransport('solo'),
      clock,
      nodeId: 'node-a',
      random: () => 0,
    });
    coordinator.register(recordingGate('provider-runtime', log));
    coordinator.register(recordingGate('telegram-ingress', log));

    await coordinator.start();
    clock.advance(1_100);
    await coordinator.settled();
    await Promise.resolve();
    await coordinator.settled();
    expect(log).toEqual(['provider-runtime:start', 'telegram-ingress:start']);
    expect(coordinator.isMaster).toBe(true);

    log.length = 0;
    await coordinator.stop('shutdown');
    // Reverse order: a consumer another depends on stays up longest.
    expect(log).toEqual(['telegram-ingress:stop', 'provider-runtime:stop']);
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

  test('the status section names the node, its role and its peers without leaking anything else', async () => {
    const bus = new MemoryClusterBus();
    const clock = new FakeClusterClock();
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
    await coordinator.start();
    clock.advance(1_100);
    await coordinator.settled();

    const status = coordinator.status();
    expect(status.nodeId).toBe('node-a');
    expect(status.version).toBe('1.4.2');
    expect(status.enabled).toBe(true);
    expect(status.signed).toBe(true);
    // The shared phrase itself is never part of the payload.
    expect(JSON.stringify(status)).not.toContain('shared-phrase');
    await coordinator.stop('shutdown');
  });
});

describe('cluster settings', () => {
  test('defaults sit in the administratively-scoped multicast range and a private port', () => {
    expect(DEFAULT_CLUSTER_SETTINGS.multicastGroup.startsWith('239.')).toBe(true);
    expect(DEFAULT_CLUSTER_SETTINGS.port).toBeGreaterThan(60_999);
    expect(DEFAULT_CLUSTER_SETTINGS.port).toBeLessThan(65_536);
    expect(DEFAULT_CLUSTER_SETTINGS.enabled).toBe(true);
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
    expect(resolved.enabled).toBe(true);
    expect(resolved.heartbeatSeconds).toBe(1);
    // Never below two heartbeats, or a healthy master is declared dead between beats.
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
