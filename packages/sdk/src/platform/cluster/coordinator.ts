/**
 * coordinator.ts — the one object a composition root wires up.
 *
 * A process has exactly ONE coordinator. Several inbound consumers register
 * with it — the SDK daemon facade registers Telegram ingress and one gate per
 * ntfy topic; the goodvibes-tui daemon additionally registers one gate per
 * inbox provider — and each of them follows the leadership OF ITS OWN SURFACE.
 * Two coordinators in one process would be two nodes in the group arguing with
 * each other, so a composition that already has one passes it down rather than
 * making a second.
 *
 * What changed from the whole-node design: registering a gate no longer puts a
 * consumer under one global leader. It declares that this node can serve one
 * specific surface, which starts an election for that surface alone. A node
 * with a Telegram token and an ntfy topic contests both; a node with only the
 * topic contests only ntfy and leaves Telegram entirely alone. A node that
 * registers nothing contests nothing and claims nothing.
 *
 * With `cluster.enabled` false the coordinator degrades to exactly the
 * behavior that existed before it: every gate starts on start() and stops on
 * stop(), no sockets are opened, and nothing is broadcast anywhere.
 */
import { ClusterElection } from './election-node.js';
import { ClusterSurfaceRegistry } from './surface-registry.js';
import { createSystemClusterClock } from './clock.js';
import { resolveNodeIdentity } from './identity.js';
import { surfaceIdFor, surfaceLabel, type ClusterSurfaceKey } from './surface-id.js';
import { UdpClusterTransport } from './udp-transport.js';
import type {
  ClusterClock,
  ClusterConsumerGate,
  ClusterConsumerStartContext,
  ClusterLogger,
  ClusterSettings,
  ClusterStatus,
  ClusterSurfaceHolding,
  ClusterSurfaceStatus,
  ClusterTransport,
} from './types.js';

export interface ClusterCoordinatorOptions {
  readonly settings: ClusterSettings;
  readonly version: string;
  /** Daemon state directory; holds the persistent node id. */
  readonly stateDirectory: string;
  readonly logger: ClusterLogger;
  /** Test seam: an in-memory transport instead of a real socket. */
  readonly transport?: ClusterTransport | undefined;
  readonly clock?: ClusterClock | undefined;
  readonly nodeId?: string | undefined;
  readonly random?: (() => number) | undefined;
}

export class ClusterCoordinator {
  private readonly registry: ClusterSurfaceRegistry;
  private readonly clock: ClusterClock;
  /**
   * Resolved on first use, never in the constructor: resolving it MINTS AND
   * WRITES a file, and merely composing a runtime (which every test that
   * builds RuntimeServices does) must not touch the state directory.
   */
  private nodeIdValue: string | null = null;
  private election: ClusterElection | null = null;
  private transport: ClusterTransport | null = null;
  private started = false;
  /** Only meaningful with the election off: every gate runs unconditionally. */
  private ungatedRunning = false;
  /** Run once at start(), before anything is contested. See `onPrepare`. */
  private readonly prepares: (() => Promise<void>)[] = [];

  constructor(private readonly options: ClusterCoordinatorOptions) {
    this.clock = options.clock ?? createSystemClusterClock();
    this.registry = new ClusterSurfaceRegistry(options.logger);
  }

  private get nodeId(): string {
    this.nodeIdValue ??= this.options.nodeId
      ?? resolveNodeIdentity({ stateDirectory: this.options.stateDirectory, logger: this.options.logger }).nodeId;
    return this.nodeIdValue;
  }

  get enabled(): boolean {
    return this.options.settings.enabled;
  }

  /**
   * True between `start()` and `stop()`.
   *
   * Read by anything that retries registering a surface in the background — a
   * Slack workspace whose identity would not resolve the first time — so it
   * stops retrying once the daemon is shutting down instead of registering
   * consumers into a coordinator that has already left the group.
   */
  get running(): boolean {
    return this.started;
  }

  /** True when this node holds at least one inbound surface. */
  get isMaster(): boolean {
    if (!this.options.settings.enabled) return this.started;
    return this.election?.isMaster ?? false;
  }

  /** True when this node currently holds the given surface. */
  holdsSurface(surface: ClusterSurfaceKey): boolean {
    if (!this.options.settings.enabled) return this.ungatedRunning;
    return this.election?.surfaceRole(surfaceIdFor(surface)) === 'master';
  }

  /**
   * The surfaces this node is currently consuming, and why — the answer
   * `ClusterGroupRuntimeOptions.surfaceHoldings` asks for.
   *
   * The per-surface election owns this fact, so the group layer is handed a
   * reader for it rather than keeping a second copy that could disagree with
   * the elections actually running. `null` — not an empty array — when there is
   * no election to ask, because "this node holds nothing" and "nobody can say
   * what this node holds" are different answers and `cluster status` prints
   * them differently.
   *
   * Every `surfaceId` here is already the digest the election routes on, never
   * a topic or chat id; the group layer digests again on the way out, which is
   * a no-op for a value of this shape and a backstop for one that is not.
   */
  surfaceHoldings(): readonly ClusterSurfaceHolding[] | null {
    // Clustering off means this node consumes everything it can, ungated. That
    // is a real and reportable state, but it is not an election result, and
    // presenting it as one would put surfaces in `cluster status` that no
    // election ever awarded.
    if (!this.options.settings.enabled) return null;
    const election = this.election;
    if (!election) return null;
    return election.status().surfaces
      .filter((surface) => surface.role === 'master')
      .map((surface) => ({
        surfaceId: surface.surfaceId,
        reason: surface.consuming
          ? `elected for ${surface.kind} (${surface.label})`
          : `elected for ${surface.kind} (${surface.label}), consumer not yet running`,
      }));
  }

  /**
   * Register an inbound consumer for one surface. Returns an unregister
   * function.
   *
   * Registering while the node is already running starts that surface's
   * election immediately, so a consumer composed late — a topic added at
   * runtime, an account that finished authenticating — still comes up without
   * a restart.
   */
  register(gate: ClusterConsumerGate): () => void {
    const unregister = this.registry.register(gate);
    if (this.ungatedRunning) {
      void this.startGateUngated(gate, {
        replayFromMs: null,
        reason: 'registered while this node was already consuming',
      });
    }
    return unregister;
  }

  /**
   * Register work that decides WHICH surfaces this node can serve, to run once
   * at `start()` before any election begins.
   *
   * It exists because that decision is asynchronous — a surface is servable
   * only if its credential actually resolves, and a `goodvibes://secrets/...`
   * reference resolves off disk — while composition roots are not. Registering
   * a surface after the boot probe would make it sit out its own first
   * election; guessing synchronously would let a node with an unresolvable
   * token win one and then read nothing.
   *
   * Several callers may add their own: a host that composes inbound consumers
   * of its own shares this coordinator rather than making a second one, and
   * each contributes the surfaces it knows about.
   */
  onPrepare(prepare: () => Promise<void>): void {
    this.prepares.push(prepare);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    for (const prepare of [...this.prepares]) {
      try {
        await prepare();
      } catch (error) {
        // A surface that could not be resolved is a surface this node will not
        // contest. Said out loud, because the visible symptom otherwise is a
        // machine that quietly reads nothing.
        this.options.logger.error('cluster: could not work out which inbound surfaces this node can serve', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (!this.options.settings.enabled) {
      this.options.logger.debug('cluster: leader election is disabled; consuming on this node unconditionally');
      await this.startAllUngated('cluster.enabled is false');
      return;
    }

    this.transport = this.options.transport ?? new UdpClusterTransport({
      port: this.options.settings.port,
      multicastGroup: this.options.settings.multicastGroup,
      peers: this.options.settings.peers,
      logger: this.options.logger,
    });

    this.election = new ClusterElection({
      nodeId: this.nodeId,
      version: this.options.version,
      settings: this.options.settings,
      transport: this.transport,
      clock: this.clock,
      logger: this.options.logger,
      registry: this.registry,
      ...(this.options.random ? { random: this.options.random } : {}),
    });
    try {
      await this.election.start();
    } catch (error) {
      // Coordination could not be established at all — the socket would not
      // bind, or the transport threw. Consume anyway. A node that answers a
      // message twice is a nuisance; a network where NOBODY reads the inbox
      // is a user whose messages vanish, and that is strictly worse. Said at
      // error level so the cause is visible rather than inferred from silence.
      this.options.logger.error('cluster: could not join the local coordination group; consuming unconditionally', {
        error: error instanceof Error ? error.message : String(error),
        impact: 'if another goodvibes node is running on this network, an inbound message may be answered twice',
        action: `check that UDP port ${this.options.settings.port} is free, or set cluster.enabled false to silence this`,
      });
      this.election = null;
      this.transport = null;
      await this.startAllUngated('coordination unavailable');
    }
  }

  async stop(reason = 'shutdown'): Promise<void> {
    if (!this.started) return;
    this.started = false;
    if (this.election) {
      // The election's own stop performs the ordered stop-then-RESIGN, per
      // surface.
      await this.election.stop(reason);
      this.election = null;
      this.transport = null;
      return;
    }
    await this.stopAllUngated(reason);
  }

  /** Wait for any in-flight transition — tests and orderly shutdown use it. */
  async settled(): Promise<void> {
    await this.election?.settled();
  }

  /**
   * A provider reported that something else is already consuming a surface
   * (Telegram's 409 on getUpdates is the live case). Never contest it.
   *
   * Pass the surface when it is known: a 409 from one bot token is not a
   * reason for this node to give up an unrelated ntfy topic.
   */
  reportConsumerConflict(detail: string, surface?: ClusterSurfaceKey): void {
    if (!this.election) return;
    if (surface) this.election.reportConsumerConflict(detail, surfaceIdFor(surface));
    else this.election.reportConsumerConflict(detail);
  }

  /** The `cluster` section of /status. Inspection only. */
  status(): ClusterStatus {
    if (this.election) return this.election.status();
    const surfaces: ClusterSurfaceStatus[] = this.registry.list().map((surface) => ({
      surfaceId: surface.surfaceId,
      label: surface.label,
      kind: surface.key.kind,
      role: this.ungatedRunning ? 'master' : 'stopped',
      holderNodeId: this.ungatedRunning ? this.nodeId : null,
      consuming: this.ungatedRunning,
      lastHolderHeartbeatAt: null,
    }));
    return {
      enabled: this.options.settings.enabled,
      role: this.started ? 'master' : 'stopped',
      nodeId: this.nodeId,
      version: this.options.version,
      uptimeMs: 0,
      consumersRunning: this.ungatedRunning,
      heldSurfaceCount: this.ungatedRunning ? surfaces.length : 0,
      signed: false,
      surfaces,
      peers: [],
      transport: { mode: 'in-memory', group: '', port: 0, peers: [] },
    };
  }

  // ── the election-off path ─────────────────────────────────────────────────

  private async startAllUngated(reason: string): Promise<void> {
    this.ungatedRunning = true;
    for (const surface of this.registry.list()) {
      await this.registry.startSurface(surface.surfaceId, { replayFromMs: null, reason });
    }
  }

  private async stopAllUngated(reason: string): Promise<void> {
    for (const surface of [...this.registry.list()].reverse()) {
      await this.registry.stopSurface(surface.surfaceId, reason);
    }
    this.ungatedRunning = false;
  }

  private async startGateUngated(
    gate: ClusterConsumerGate,
    context: ClusterConsumerStartContext,
  ): Promise<void> {
    try {
      await gate.start(context);
    } catch (error) {
      this.options.logger.error('cluster: an inbound consumer failed to start', {
        surface: surfaceLabel(gate.surface),
        consumer: gate.id,
        reason: context.reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
