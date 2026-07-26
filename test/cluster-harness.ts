/**
 * cluster-harness.ts — shared rig for the leader-election tests.
 *
 * Not a test file (the runner globs *.test.ts): it builds a world of nodes on
 * one in-memory bus and one fake clock, records every consumer start/stop and
 * every datagram in a single ordered log, and gives the tests a way to move
 * time forward that lets each node's async transitions settle in between.
 *
 * The ordered log is the point. Most of what these tests assert is not "who
 * won" but "in what order did things happen" — a handoff that starts the
 * successor before the predecessor stopped consuming is the bug, and only an
 * interleaved log can catch it.
 */
import { ClusterElection } from '../packages/sdk/src/platform/cluster/election.js';
import { FakeClusterClock } from '../packages/sdk/src/platform/cluster/clock.js';
import { MemoryClusterBus, type MemoryClusterTransport } from '../packages/sdk/src/platform/cluster/memory-transport.js';
import { decodeMessage } from '../packages/sdk/src/platform/cluster/protocol.js';
import { compareRank, compareVersions } from '../packages/sdk/src/platform/cluster/ranking.js';
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

interface TestNode {
  readonly id: string;
  readonly election: ClusterElection;
  readonly transport: MemoryClusterTransport;
  running: boolean;
  startCount: number;
  stopCount: number;
  lastReplayFromMs: number | null;
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

/** Wrap the memory transport so a send lands in the same ordered log as gates. */
function logged(inner: MemoryClusterTransport, id: string, events: string[]): ClusterTransport {
  return {
    start: (onMessage) => inner.start(onMessage),
    send: async (raw) => {
      const decoded = decodeMessage(raw, '');
      events.push(`${id}:send:${decoded.message?.type ?? 'BAD'}`);
      await inner.send(raw);
    },
    stop: () => inner.stop(),
    describe: () => inner.describe(),
  };
}

function addNode(
  world: World,
  options: {
    readonly id: string;
    readonly version?: string;
    readonly jitter?: number;
    readonly settings?: Partial<ClusterSettings>;
    /**
     * Model a consumer that wedges on stop — a long poll whose socket never
     * closes. The node's transition queue blocks forever, which is exactly
     * what the preemption grace timer exists to survive.
     */
    readonly stopHangs?: boolean;
  },
): TestNode {
  const transport = world.bus.createTransport(options.id);
  const node: TestNode = {
    id: options.id,
    transport,
    running: false,
    startCount: 0,
    stopCount: 0,
    lastReplayFromMs: null,
    election: undefined as unknown as ClusterElection,
  };
  const election = new ClusterElection({
    nodeId: options.id,
    version: options.version ?? '1.0.0',
    settings: settings(options.settings),
    transport: logged(transport, options.id, world.events),
    clock: world.clock,
    logger: SILENT,
    random: () => options.jitter ?? 0,
    onBecomeMaster: async (context) => {
      node.running = true;
      node.startCount += 1;
      node.lastReplayFromMs = context.replayFromMs;
      world.events.push(`${options.id}:consumers-start`);
    },
    onResignMaster: async () => {
      node.running = false;
      node.stopCount += 1;
      world.events.push(`${options.id}:consumers-stop`);
      if (options.stopHangs) await new Promise<void>(() => { /* never resolves */ });
    },
  });
  (node as { election: ClusterElection }).election = election;
  world.nodes.push(node);
  return node;
}

/** Drain `count` microtask turns without depending on any node's queue. */
async function drain(count: number): Promise<void> {
  for (let turn = 0; turn < count; turn += 1) await Promise.resolve();
}

/**
 * Let every node's queued transitions run.
 *
 * Each wait is RACED against a plain microtask drain rather than awaited
 * outright: a node whose consumer wedges on stop blocks its own queue forever,
 * and the rest of the cluster has to keep running — that is the whole reason
 * the preemption grace timer exists. Awaiting such a node would deadlock the
 * test instead of exercising the behavior.
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

function masters(world: World): TestNode[] {
  return world.nodes.filter((node) => node.running);
}

function indexOfEvent(world: World, event: string): number {
  return world.events.indexOf(event);
}

export {
  addNode,
  advance,
  createWorld,
  flush,
  masters,
  settings,
  startNode,
  SILENT,
};
export type { TestNode, World };
