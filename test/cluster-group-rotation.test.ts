/**
 * cluster-group-rotation.test.ts — rotating the group key must be invisible.
 *
 * The failure this file exists to prevent: a rotation that makes members stop
 * verifying each other for a moment, so the watchdog fires, an election runs,
 * and a surface changes hands for no reason — once per rotation, forever.
 */
import { describe, expect, test, afterEach } from 'bun:test';
import {
  addGroupNode,
  advance,
  advanceStepped,
  createGroupWorld,
  destroyGroupWorld,
  settle,
  SILENT_LOGGER,
  stopGroupWorld,
  type GroupTestNode,
  type GroupTestWorld,
} from './cluster-group-harness.js';
import { createGroup, joinGroup } from '../packages/sdk/src/platform/cluster/group-operations.js';
import { advance } from './cluster-group-harness.js';
import { ClusterCoordinator } from '../packages/sdk/src/platform/cluster/coordinator.js';
import {
  adoptGroupKeys,
  GroupKeyring,
  MAX_KEY_AGE_MS,
  MAX_KEY_GENERATIONS,
  preferredKeyRecord,
  rotateGroupKeyMaterial,
  sweepKeyHistory,
  type GroupKeyMaterial,
  type GroupKeyRecord,
} from '../packages/sdk/src/platform/cluster/group-store.js';
import {
  decodeEnvelope,
  encodeEnvelope,
} from '../packages/sdk/src/platform/cluster/protocol-envelope.js';
import type { ClusterConsumerGate, ClusterSettings } from '../packages/sdk/src/platform/cluster/types.js';
import { surfaceIdFor, type ClusterSurfaceKey } from '../packages/sdk/src/platform/cluster/surface-id.js';
import { join } from 'node:path';

let world: GroupTestWorld | null = null;

afterEach(async () => {
  if (world) {
    await stopGroupWorld(world);
    destroyGroupWorld(world);
    world = null;
  }
});

function electionSettings(): ClusterSettings {
  return {
    enabled: true,
    heartbeatSeconds: 1,
    masterTimeoutSeconds: 3,
    bootProbeSeconds: 1,
    port: 0,
    multicastGroup: 'memory',
    secret: '',
    peers: [],
  };
}

interface Consumer {
  readonly gate: ClusterConsumerGate;
  starts: number;
  stops: number;
  running: boolean;
}

/**
 * The one surface both nodes contest.
 *
 * Identical on both by construction: this test is about a rotation NOT
 * disturbing a settled election, which only means anything if the two nodes are
 * in the same election. Two different surfaces would give each node its own
 * uncontested surface and the test would pass without proving anything.
 */
const CONTESTED_SURFACE: ClusterSurfaceKey = { kind: 'ntfy', discriminator: 'rotation-under-traffic' };

function makeConsumer(id: string, log: string[]): Consumer {
  const consumer: Consumer = {
    starts: 0,
    stops: 0,
    running: false,
    gate: {
      id,
      surface: CONTESTED_SURFACE,
      start: async () => {
        consumer.starts += 1;
        consumer.running = true;
        log.push(`${id}:start`);
      },
      stop: async () => {
        consumer.stops += 1;
        consumer.running = false;
        log.push(`${id}:stop`);
      },
    },
  };
  return consumer;
}

/** Wire an election onto a group member, riding the group key. */
function attachElection(
  node: GroupTestNode,
  world: GroupTestWorld,
  log: string[],
): { coordinator: ClusterCoordinator; consumer: Consumer } {
  const consumer = makeConsumer(node.id, log);
  const coordinator = new ClusterCoordinator({
    settings: electionSettings(),
    version: '1.0.0',
    stateDirectory: node.stateDirectory,
    logger: SILENT_LOGGER,
    transport: node.runtime.electionTransport(),
    clock: world.clock,
    nodeId: node.id,
    random: () => 0.5,
  });
  coordinator.register(consumer.gate);
  return { coordinator, consumer };
}

describe('rotation under continuous traffic', () => {
  test('does not cause an election and does not move consumption', async () => {
    const created = createGroupWorld();
    world = created;
    const log: string[] = [];

    const a = await addGroupNode(created, 'node-a');
    const b = await addGroupNode(created, 'node-b');
    const group = await createGroup(a.context, { displayName: 'workshop' });
    expect(group.ok).toBe(true);
    if (!group.ok) return;
    const joined = await joinGroup(b.context, { groupId: group.data.groupId, joinKey: group.data.joinKey });
    expect(joined.ok).toBe(true);
    await settle();

    // Started in sequence, with the boot window allowed to close in between,
    // so the group is in a settled steady state before the rotation. Starting
    // both at once is a different scenario (a simultaneous boot race) and it
    // would hide what this test is about.
    const first = attachElection(a, created, log);
    await first.coordinator.start();
    await advanceStepped(created, 6_000);
    const second = attachElection(b, created, log);
    await second.coordinator.start();
    await advanceStepped(created, 8_000);

    const masterBefore = first.coordinator.isMaster ? 'node-a' : second.coordinator.isMaster ? 'node-b' : null;
    expect(masterBefore).not.toBeNull();
    // Exactly one node consumes.
    expect([first.consumer.running, second.consumer.running].filter(Boolean)).toHaveLength(1);
    const startsBefore = first.consumer.starts + second.consumer.starts;
    const stopsBefore = first.consumer.stops + second.consumer.stops;
    expect(startsBefore).toBe(1);
    expect(stopsBefore).toBe(0);

    const wireBefore = created.wire.length;
    const generationBefore = a.runtime.keyMaterial?.currentGeneration ?? -1;

    // Rotate while heartbeats keep flowing on both sides.
    await advanceStepped(created, 2_000);
    await a.runtime.rotate('scheduled', 'test rotation');
    await advanceStepped(created, 20_000);

    const generationAfter = a.runtime.keyMaterial?.currentGeneration ?? -1;
    expect(generationAfter).toBe(generationBefore + 1);
    expect(b.runtime.keyMaterial?.currentGeneration).toBe(generationAfter);

    const masterAfter = first.coordinator.isMaster ? 'node-a' : second.coordinator.isMaster ? 'node-b' : null;
    expect(masterAfter).toBe(masterBefore);
    // Consumption never moved: no extra start, no stop at all.
    expect(first.consumer.starts + second.consumer.starts).toBe(startsBefore);
    expect(first.consumer.stops + second.consumer.stops).toBe(0);
    expect([first.consumer.running, second.consumer.running].filter(Boolean)).toHaveLength(1);

    // And nobody contested the role: no CLAIM went out after the rotation.
    const after = created.wire.slice(wireBefore).map((entry) => JSON.parse(entry.raw) as Record<string, unknown>);
    expect(after.filter((entry) => entry['type'] === 'CLAIM')).toHaveLength(0);
    expect(after.filter((entry) => entry['type'] === 'RESIGN')).toHaveLength(0);
    // Heartbeats did keep flowing, so the absence of a claim means something.
    expect(after.filter((entry) => entry['type'] === 'HEARTBEAT').length).toBeGreaterThan(5);

    // No datagram was dropped for a signature or a generation on either node.
    for (const node of [a, b]) {
      expect(node.runtime.wireCounters?.droppedBadSignature).toBe(0);
      expect(node.runtime.wireCounters?.droppedOldGeneration).toBe(0);
    }

    await first.coordinator.stop();
    await second.coordinator.stop();
  });
});

describe('what this machine holds reaches cluster status', () => {
  test('the group layer reports the elections actually running, not a placeholder', async () => {
    // The group layer defines `surfaceHoldings` but owns no elections; the
    // per-surface election owns the fact but has no group to report it to.
    // Unwired, `cluster status` renders an honest null and tells the operator
    // nothing about which machine is reading which inbox.
    const created = createGroupWorld();
    world = created;
    const log: string[] = [];

    // The composition root's own shape: the runtime is built before the
    // coordinator exists, so it is handed a reader rather than a value.
    let coordinator: ClusterCoordinator | null = null;
    const a = await addGroupNode(created, 'node-a', {
      surfaceHoldings: () => coordinator?.surfaceHoldings() ?? [],
    });
    const group = await createGroup(a.context, { displayName: 'workshop' });
    expect(group.ok).toBe(true);
    if (!group.ok) return;
    await settle();

    // Nothing elected yet: the reader is wired, and it says so honestly.
    expect(a.runtime.surfaceHoldings()).toEqual([]);

    const attached = attachElection(a, created, log);
    coordinator = attached.coordinator;
    await attached.coordinator.start();
    await advanceStepped(created, 6_000);

    expect(attached.coordinator.isMaster).toBe(true);
    const holdings = a.runtime.surfaceHoldings();
    expect(holdings).not.toBeNull();
    expect(holdings).toHaveLength(1);

    const held = holdings![0]!;
    // The surface it reports is the one that was actually elected.
    expect(held.surfaceId).toBe(surfaceIdFor(CONTESTED_SURFACE));
    expect(held.reason).toContain('elected');
    // And it is a digest by the time anyone can read it: the discriminator
    // names the operator's inbox and must not survive into status output.
    expect(held.surfaceId).toMatch(/^[0-9a-f]{32}$/);
    expect(held.surfaceId).not.toContain('rotation-under-traffic');

    await attached.coordinator.stop();
  });

  test('a machine with clustering off says nothing rather than claiming everything', async () => {
    // Ungated consumption is a real state, but it is not an election result.
    // Reporting it as one would list surfaces in `cluster status` that no
    // election ever awarded.
    const created = createGroupWorld();
    world = created;
    const coordinator = new ClusterCoordinator({
      settings: { ...electionSettings(), enabled: false },
      version: '1.0.0',
      stateDirectory: join(created.tempRoot, 'off'),
      logger: SILENT_LOGGER,
      clock: created.clock,
      nodeId: 'node-off',
    });
    expect(coordinator.surfaceHoldings()).toBeNull();
  });
});

describe('the machine that mints a rotation', () => {
  test('does not warn that its own rotation left it out', async () => {
    const created = createGroupWorld();
    world = created;
    const warnings: string[] = [];
    const noisy = {
      debug: () => {},
      info: () => {},
      warn: (message: string) => { warnings.push(message); },
      error: (message: string) => { warnings.push(message); },
    };
    const a = await addGroupNode(created, 'node-a', { logger: noisy });
    const b = await addGroupNode(created, 'node-b');
    const group = await createGroup(a.context, { displayName: 'workshop' });
    if (!group.ok) return;
    await joinGroup(b.context, { groupId: group.data.groupId, joinKey: group.data.joinKey });
    await settle();

    await a.runtime.rotate('scheduled', 'test rotation');
    await advance(created, 5_000);

    // Its own announcement comes back through loopback carrying no wrap for it.
    expect(warnings.filter((line) => line.includes('did not include this machine'))).toEqual([]);
    // And the other machine did get one.
    expect(b.runtime.keyMaterial?.currentGeneration).toBe(a.runtime.keyMaterial?.currentGeneration);
  });
});

describe('the dual-generation acceptance window', () => {
  function materialWith(generations: readonly number[], now: number): GroupKeyMaterial {
    return {
      version: 1,
      groupId: 'gTESTTESTTESTTEST',
      groupRoot: null,
      joinKey: 'gvj1-AAAA',
      joinSalt: 'c2FsdHNhbHRzYWx0c2E',
      joinVerifier: 'dmVyaWZpZXI',
      keys: generations.map((generation) => ({
        generation,
        key: `key-${generation}`,
        createdAt: now,
        mintedBy: 'node-a',
      })),
      currentGeneration: Math.max(...generations),
      previousAcceptedUntil: now + 60_000,
      node: {
        identity: { publicKey: 'p'.repeat(43), privateKey: 'q'.repeat(43) },
        agreement: { publicKey: 'r'.repeat(43), privateKey: 's'.repeat(43) },
      },
      groupSigning: { publicKey: 'g'.repeat(43), privateKey: 'h'.repeat(43), generation: 0 },
    };
  }

  test('accepts the previous generation during the window and refuses it after', () => {
    let now = 1_000_000;
    const material = materialWith([3, 4], now);
    const keyring = new GroupKeyring(() => material, () => now);

    expect(keyring.acceptedGenerations()).toEqual([4, 3]);

    // A datagram signed with the OUTGOING generation still verifies.
    const previous = encodeEnvelope(
      { type: 'HEARTBEAT', nodeId: 'node-b', nodeVersion: '1.0.0', seq: 1, ts: now },
      new GroupKeyring(() => ({ ...material, currentGeneration: 3 }), () => now),
    );
    expect(decodeEnvelope(previous, keyring).envelope?.keyGen).toBe(3);

    // Once the window closes it does not.
    now = 1_000_000 + 61_000;
    expect(keyring.acceptedGenerations()).toEqual([4]);
    const closed = decodeEnvelope(previous, keyring);
    expect(closed.envelope).toBeNull();
    expect(closed.rejected).toBe('generation-not-accepted');
  });

  test('a revocation rotation opens no window at all', () => {
    const now = 2_000_000;
    const base = materialWith([1], now);
    const scheduled = rotateGroupKeyMaterial(base, 'scheduled', 'node-a', now, 60_000);
    const revoked = rotateGroupKeyMaterial(base, 'revocation', 'node-a', now, 60_000);

    expect(new GroupKeyring(() => scheduled, () => now).acceptedGenerations()).toEqual([2, 1]);
    expect(new GroupKeyring(() => revoked, () => now).acceptedGenerations()).toEqual([2]);
  });
});

describe('two rotations at once', () => {
  test('a partition that produced two candidate keys converges on one', () => {
    const now = 3_000_000;
    const fromA: GroupKeyRecord = { generation: 7, key: 'key-from-a', createdAt: now, mintedBy: 'node-a' };
    const fromB: GroupKeyRecord = { generation: 7, key: 'key-from-b', createdAt: now + 5, mintedBy: 'node-b' };

    // The tiebreak is on the minter, not on arrival order or timestamp.
    expect(preferredKeyRecord(fromA, fromB)).toEqual(fromA);
    expect(preferredKeyRecord(fromB, fromA)).toEqual(fromA);

    const base: GroupKeyMaterial = {
      version: 1,
      groupId: 'gTESTTESTTESTTEST',
      groupRoot: null,
      joinKey: 'gvj1-AAAA',
      joinSalt: 'c2FsdHNhbHRzYWx0c2E',
      joinVerifier: 'dmVyaWZpZXI',
      keys: [{ generation: 6, key: 'key-6', createdAt: now, mintedBy: 'node-a' }],
      currentGeneration: 6,
      previousAcceptedUntil: 0,
      node: {
        identity: { publicKey: 'p'.repeat(43), privateKey: 'q'.repeat(43) },
        agreement: { publicKey: 'r'.repeat(43), privateKey: 's'.repeat(43) },
      },
      groupSigning: { publicKey: 'g'.repeat(43), privateKey: 'h'.repeat(43), generation: 0 },
    };

    // Whichever order the two announcements arrive in, both sides land on the
    // same key — which is what lets the healed partition talk again.
    const oneWay = adoptGroupKeys(adoptGroupKeys(base, [fromA], 7, now, 0), [fromB], 7, now, 0);
    const otherWay = adoptGroupKeys(adoptGroupKeys(base, [fromB], 7, now, 0), [fromA], 7, now, 0);
    expect(oneWay.keys.find((entry) => entry.generation === 7)?.key).toBe('key-from-a');
    expect(otherWay.keys.find((entry) => entry.generation === 7)?.key).toBe('key-from-a');
  });
});

describe('key history bounds', () => {
  test('is capped by count, expired by age, and always keeps the two live generations', () => {
    const now = 4_000_000;
    const keys: GroupKeyRecord[] = [];
    for (let generation = 0; generation <= 40; generation += 1) {
      keys.push({ generation, key: `key-${generation}`, createdAt: now, mintedBy: 'node-a' });
    }
    const capped = sweepKeyHistory(keys, 40, now);
    expect(capped.keys.length).toBe(MAX_KEY_GENERATIONS);
    expect(capped.dropped).toBe(41 - MAX_KEY_GENERATIONS);
    expect(capped.keys.map((entry) => entry.generation)).toContain(40);
    expect(capped.keys.map((entry) => entry.generation)).toContain(39);

    // Ancient keys go, and the current pair stays regardless of how old it is.
    const ancient: GroupKeyRecord[] = [
      { generation: 40, key: 'key-40', createdAt: 0, mintedBy: 'node-a' },
      { generation: 39, key: 'key-39', createdAt: 0, mintedBy: 'node-a' },
      { generation: 38, key: 'key-38', createdAt: 0, mintedBy: 'node-a' },
    ];
    const aged = sweepKeyHistory(ancient, 40, MAX_KEY_AGE_MS * 2);
    expect(aged.keys.map((entry) => entry.generation).sort((x, y) => y - x)).toEqual([40, 39]);
    expect(aged.dropped).toBe(1);
  });

  test('history never grows past the cap across many real rotations', () => {
    let material: GroupKeyMaterial = {
      version: 1,
      groupId: 'gTESTTESTTESTTEST',
      groupRoot: null,
      joinKey: 'gvj1-AAAA',
      joinSalt: 'c2FsdHNhbHRzYWx0c2E',
      joinVerifier: 'dmVyaWZpZXI',
      keys: [{ generation: 0, key: 'key-0', createdAt: 5_000_000, mintedBy: 'node-a' }],
      currentGeneration: 0,
      previousAcceptedUntil: 0,
      node: {
        identity: { publicKey: 'p'.repeat(43), privateKey: 'q'.repeat(43) },
        agreement: { publicKey: 'r'.repeat(43), privateKey: 's'.repeat(43) },
      },
      groupSigning: { publicKey: 'g'.repeat(43), privateKey: 'h'.repeat(43), generation: 0 },
    };
    let now = 5_000_000;
    for (let index = 0; index < 100; index += 1) {
      now += 60_000;
      material = rotateGroupKeyMaterial(material, 'scheduled', 'node-a', now, 1_000);
      expect(material.keys.length).toBeLessThanOrEqual(MAX_KEY_GENERATIONS);
    }
    expect(material.currentGeneration).toBe(100);
    expect(material.keys.length).toBe(MAX_KEY_GENERATIONS);
  });
});

describe('the housekeeping timer', () => {
  test('rotates once when the interval passes, and only the minting member mints it', async () => {
    const created = createGroupWorld();
    world = created;
    // A long beacon interval keeps the test cheap while leaving every member
    // well inside the "recently heard from" window that decides who mints.
    const settings = { keyRotationHours: 1, beaconSeconds: 600, rosterGossipSeconds: 900 };
    const a = await addGroupNode(created, 'node-a', { settings });
    const b = await addGroupNode(created, 'node-b', { settings });
    const group = await createGroup(a.context, { displayName: 'workshop' });
    if (!group.ok) return;
    await joinGroup(b.context, { groupId: group.data.groupId, joinKey: group.data.joinKey });
    await settle();

    const before = a.runtime.keyMaterial?.currentGeneration ?? -1;
    // Stepped at the housekeeping interval so every tick actually completes —
    // one jump would let the first tick's reentrancy guard swallow the rest.
    const tick = 30 * 1_000;
    // Short of the interval: nothing should rotate yet.
    await advanceStepped(created, 50 * 60 * 1_000, tick);
    expect(a.runtime.keyMaterial?.currentGeneration).toBe(before);

    // Past it: exactly one rotation, minted by the lowest node id.
    await advanceStepped(created, 20 * 60 * 1_000, tick);
    await settle();

    expect(a.runtime.keyMaterial?.currentGeneration).toBe(before + 1);
    expect(b.runtime.keyMaterial?.currentGeneration).toBe(before + 1);

    const minted = a.runtime.keyMaterial?.keys.find((entry) => entry.generation === before + 1);
    expect(minted?.mintedBy).toBe('node-a');
    expect(b.runtime.keyMaterial?.keys.find((entry) => entry.generation === before + 1)?.key)
      .toBe(minted?.key);
  });
});
