/**
 * cluster-harness.ts — shared rig for the leader-election tests.
 *
 * Not a test file (the runner globs *.test.ts): it builds a world of nodes on
 * one in-memory bus and one fake clock, records every consumer start/stop and
 * every datagram in a single ordered log, and gives the tests a way to move
 * time forward that lets each node's async transitions settle in between.
 *
 * Nodes are described by the SURFACES they can serve, because that is the
 * thing the design turns on: a node holding a Telegram token and a node
 * holding only an ntfy topic must contest ntfy and leave Telegram alone. A
 * node's surface list here is exactly what its composition root would have
 * registered — a credential it holds and a consumer it can start.
 *
 * The ordered log is the point. Most of what these tests assert is not "who
 * won" but "in what order did things happen" — a handoff that starts the
 * successor before the predecessor stopped consuming is the bug, and only an
 * interleaved log can catch it.
 */
import { ClusterElection } from '../packages/sdk/src/platform/cluster/election-node.js';
import { ClusterSurfaceRegistry } from '../packages/sdk/src/platform/cluster/surface-registry.js';
import { FakeClusterClock } from '../packages/sdk/src/platform/cluster/clock.js';
import { MemoryClusterBus, type MemoryClusterTransport } from '../packages/sdk/src/platform/cluster/memory-transport.js';
import { decodeMessage } from '../packages/sdk/src/platform/cluster/protocol.js';
import {
  ntfySurface,
  providerSurface,
  surfaceIdFor,
  telegramSurface,
  type ClusterSurfaceKey,
} from '../packages/sdk/src/platform/cluster/surface-id.js';
import type {
  ClusterLogger,
  ClusterSettings,
  ClusterTransport,
} from '../packages/sdk/src/platform/cluster/types.js';

const SILENT: ClusterLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** The ntfy server the test topics live on. Never a real one. */
const TEST_NTFY_BASE = 'https://ntfy.test';

/**
 * Turn a short test name into a real surface key.
 *
 * Names beginning `telegram` and `ntfy` produce the genuine key shapes so the
 * tests exercise the same digest derivation the daemon uses; anything else
 * becomes a custom surface, which is what an inbox account or a plugin
 * consumer looks like.
 */
function keyFor(name: string): ClusterSurfaceKey {
  if (name.startsWith('telegram')) return telegramSurface(`${name}:REDACTED-SECRET-HALF`);
  if (name.startsWith('ntfy')) return ntfySurface(TEST_NTFY_BASE, name);
  // `slack-T0ACME999` becomes the real shape a resolved workspace identity
  // produces, so the socket-surface tests exercise the same digest derivation
  // the daemon uses rather than a look-alike.
  if (name.startsWith('slack-')) return providerSurface('slack', name.slice('slack-'.length));
  if (name.startsWith('discord-')) return providerSurface('discord', name.slice('discord-'.length));
  return providerSurface('custom', name);
}

function idFor(name: string): string {
  return surfaceIdFor(keyFor(name));
}

/**
 * Short but proportional: 1s heartbeat, 3s master timeout, 1s boot probe.
 * deriveClusterTiming scales everything else from these, so the protocol
 * behaves the same shape it does with the 30/90/3 defaults.
 */
function settings(overrides: Partial<ClusterSettings> = {}): ClusterSettings {
  return {
    enabled: true,
    heartbeatSeconds: 1,
    masterTimeoutSeconds: 3,
    bootProbeSeconds: 1,
    port: 0,
    multicastGroup: 'memory',
    secret: '',
    peers: [],
    ...overrides,
  };
}

interface TestSurfaceState {
  running: boolean;
  startCount: number;
  stopCount: number;
  lastReplayFromMs: number | null;
}

interface TestNode {
  readonly id: string;
  readonly election: ClusterElection;
  readonly registry: ClusterSurfaceRegistry;
  readonly transport: MemoryClusterTransport;
  /** Keyed by the short surface NAME, not the digest, so tests stay readable. */
  readonly surfaces: Map<string, TestSurfaceState>;
  readonly unregister: Map<string, () => void>;
}

interface World {
  readonly clock: FakeClusterClock;
  readonly bus: MemoryClusterBus;
  readonly nodes: TestNode[];
  /** Global, ordered log of consumer starts/stops and datagram sends. */
  readonly events: string[];
}

function createWorld(): World {
  return { clock: new FakeClusterClock(), bus: new MemoryClusterBus(), nodes: [], events: [] };
}

/**
 * Wrap the memory transport so a send lands in the same ordered log as gates.
 *
 * The surface is logged by its short NAME where the test knows one, resolved
 * from the digest on the datagram — the datagram itself only ever carries the
 * digest, which is what `surfaceId is a digest` asserts against.
 */
function logged(
  inner: MemoryClusterTransport,
  id: string,
  world: World,
  names: readonly string[],
): ClusterTransport {
  const byDigest = new Map(names.map((name) => [idFor(name), name]));
  return {
    start: (onMessage) => inner.start(onMessage),
    send: async (raw) => {
      const decoded = decodeMessage(raw, '');
      const surfaceId = decoded.message?.surfaceId ?? null;
      const name = surfaceId === null ? 'group' : byDigest.get(surfaceId) ?? surfaceId.slice(0, 8);
      world.events.push(`${id}:${name}:send:${decoded.message?.type ?? 'BAD'}`);
      await inner.send(raw);
    },
    stop: () => inner.stop(),
    describe: () => inner.describe(),
  };
}

interface AddNodeOptions {
  readonly id: string;
  readonly version?: string;
  readonly jitter?: number;
  /** Surfaces this node can ACTUALLY serve. Empty means it contests nothing. */
  readonly surfaces: readonly string[];
  readonly settings?: Partial<ClusterSettings>;
  /**
   * Model a consumer that wedges on stop — a long poll whose socket never
   * closes. That surface's transition queue blocks forever, which is exactly
   * what the preemption grace timer exists to survive.
   */
  readonly stopHangs?: boolean;
}

function addNode(world: World, options: AddNodeOptions): TestNode {
  const transport = world.bus.createTransport(options.id);
  const registry = new ClusterSurfaceRegistry(SILENT);
  const node: TestNode = {
    id: options.id,
    transport,
    registry,
    surfaces: new Map(),
    unregister: new Map(),
    election: undefined as unknown as ClusterElection,
  };
  // Every surface name in the world, so the log can name digests it sees from
  // peers as well as the ones this node serves.
  const allNames = [...new Set([...options.surfaces, ...world.nodes.flatMap((n) => [...n.surfaces.keys()])])];
  const election = new ClusterElection({
    nodeId: options.id,
    version: options.version ?? '1.0.0',
    settings: settings(options.settings),
    transport: logged(transport, options.id, world, allNames),
    clock: world.clock,
    logger: SILENT,
    registry,
    random: () => options.jitter ?? 0,
  });
  (node as { election: ClusterElection }).election = election;
  world.nodes.push(node);
  for (const name of options.surfaces) {
    registerSurface(world, node, name, options.stopHangs ?? false);
  }
  return node;
}

/** Register a consumer for one surface on a node, recording into the log. */
function registerSurface(world: World, node: TestNode, name: string, stopHangs = false): void {
  const state: TestSurfaceState = { running: false, startCount: 0, stopCount: 0, lastReplayFromMs: null };
  node.surfaces.set(name, state);
  const unregister = node.registry.register({
    id: `${name}-consumer`,
    surface: keyFor(name),
    start: async (context) => {
      state.running = true;
      state.startCount += 1;
      state.lastReplayFromMs = context.replayFromMs;
      world.events.push(`${node.id}:${name}:consumers-start`);
    },
    stop: async () => {
      state.running = false;
      state.stopCount += 1;
      world.events.push(`${node.id}:${name}:consumers-stop`);
      if (stopHangs) await new Promise<void>(() => { /* never resolves */ });
    },
  });
  node.unregister.set(name, unregister);
}

/** Take a surface away from a node — a credential removed while it runs. */
function removeSurface(node: TestNode, name: string): void {
  node.unregister.get(name)?.();
  node.unregister.delete(name);
  node.surfaces.delete(name);
}

/** Drain `count` microtask turns without depending on any node's queue. */
async function drain(count: number): Promise<void> {
  for (let turn = 0; turn < count; turn += 1) await Promise.resolve();
}

/**
 * Let every node's queued transitions run.
 *
 * Each wait is RACED against a plain microtask drain rather than awaited
 * outright: a node whose consumer wedges on stop blocks that surface's queue
 * forever, and the rest of the cluster has to keep running — that is the whole
 * reason the preemption grace timer exists. Awaiting such a node would deadlock
 * the test instead of exercising the behavior.
 */
async function flush(world: World): Promise<void> {
  for (let round = 0; round < 10; round += 1) {
    for (const node of world.nodes) {
      await Promise.race([node.election.settled(), drain(6)]);
    }
    await Promise.resolve();
  }
}

/** Move time forward in small steps, letting every queued transition settle. */
async function advance(world: World, totalMs: number): Promise<void> {
  await flush(world);
  let remaining = totalMs;
  while (remaining > 0) {
    const delta = Math.min(50, remaining);
    world.clock.advance(delta);
    remaining -= delta;
    await flush(world);
  }
}

async function startNode(world: World, node: TestNode): Promise<void> {
  await node.election.start();
  await flush(world);
}

/** Nodes whose consumer for `name` is running. Should never exceed one. */
function holders(world: World, name: string): TestNode[] {
  return world.nodes.filter((node) => node.surfaces.get(name)?.running === true);
}

/** How many surfaces `node`'s own consumers are running. */
function heldCount(node: TestNode): number {
  return [...node.surfaces.values()].filter((state) => state.running).length;
}

/** This node's protocol role for one surface. */
function roleOf(node: TestNode, name: string): string {
  return node.election.surfaceRole(idFor(name));
}

/** This node's `/status` entry for one surface. */
function surfaceStatusOf(node: TestNode, name: string) {
  const digest = idFor(name);
  const entry = node.election.status().surfaces.find((surface) => surface.surfaceId === digest);
  if (!entry) throw new Error(`node ${node.id} reports no status for surface ${name}`);
  return entry;
}

function surfaceState(node: TestNode, name: string): TestSurfaceState {
  const state = node.surfaces.get(name);
  if (!state) throw new Error(`node ${node.id} has no surface ${name}`);
  return state;
}

function indexOfEvent(world: World, event: string): number {
  return world.events.indexOf(event);
}

export {
  addNode,
  advance,
  createWorld,
  flush,
  heldCount,
  holders,
  idFor,
  indexOfEvent,
  keyFor,
  registerSurface,
  removeSurface,
  roleOf,
  settings,
  startNode,
  surfaceState,
  surfaceStatusOf,
  SILENT,
  TEST_NTFY_BASE,
};
export type { TestNode, TestSurfaceState, World };
