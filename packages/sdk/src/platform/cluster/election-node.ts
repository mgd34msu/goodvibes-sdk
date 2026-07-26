/**
 * election-node.ts — this node's seat in the group, and one election per
 * surface underneath it.
 *
 * Everything that is genuinely per-NODE lives here: the single socket, the
 * single peer table, the single suspend watchdog, the holdings ledger. Every
 * decision about who reads what lives one level down, in a SurfaceElection per
 * surface (election.ts). A node running Telegram and two ntfy topics has one
 * socket and three independent state machines.
 *
 * The datagram path is: decode -> authenticate -> drop our own loopback ->
 * deduplicate by sequence -> record the peer and its holdings -> route by
 * surfaceId to the one election that cares. A datagram for a surface this node
 * does not serve is still RECORDED — that is how the holdings ledger learns
 * what the rest of the network is carrying without anyone announcing it — but
 * it is not dispatched anywhere, because this node has no business in that
 * election.
 *
 * A datagram whose `surfaceId` is null is group-level: not about any one
 * surface, and nothing this module sends. It is recorded as peer liveness and
 * otherwise ignored, so the group's other traffic passes through without
 * being mistaken for an election message.
 */
import { SurfaceElection, type SurfaceElectionHost } from './election.js';
import { ClusterHoldingsLedger } from './holdings.js';
import { decodeMessage, encodeMessage } from './protocol.js';
import { deriveClusterTiming, type ClusterTiming } from './timing.js';
import { CLUSTER_PROTOCOL_VERSION } from './types.js';
import type { ClusterSurfaceRegistry } from './surface-registry.js';
import type {
  ClusterClock,
  ClusterConsumerStartContext,
  ClusterLogger,
  ClusterMessage,
  ClusterMessageType,
  ClusterPeerStatus,
  ClusterRole,
  ClusterSettings,
  ClusterStatus,
  ClusterSurfaceStatus,
  ClusterTransport,
} from './types.js';

/** How many peers are retained for /status before the oldest is dropped. */
const MAX_TRACKED_PEERS = 64;

export interface ClusterElectionOptions {
  readonly nodeId: string;
  readonly version: string;
  readonly settings: ClusterSettings;
  readonly transport: ClusterTransport;
  readonly clock: ClusterClock;
  readonly logger: ClusterLogger;
  /** The surfaces this node can actually serve. */
  readonly registry: ClusterSurfaceRegistry;
  /** Test seam for the CLAIM jitter draw. Defaults to Math.random. */
  readonly random?: (() => number) | undefined;
}

interface TrackedPeer {
  readonly nodeId: string;
  readonly version: string;
  readonly lastSeenAt: number;
  readonly lastMessageType: ClusterMessageType;
  readonly lastSeq: number;
  /** Sender's wall clock on that datagram; distinguishes restart from replay. */
  readonly lastTs: number;
}

export class ClusterElection {
  private readonly timing: ClusterTiming;
  private readonly ledger: ClusterHoldingsLedger;
  private readonly elections = new Map<string, SurfaceElection>();
  private readonly peers = new Map<string, TrackedPeer>();
  private readonly host: SurfaceElectionHost;

  private running = false;
  private seq = 0;
  /**
   * Monotonic reading at start(), or null before it. NOT a numeric sentinel:
   * a monotonic clock legitimately reads 0, and treating that as "not started"
   * pins this node's uptime at zero for its whole life.
   *
   * Uptime is no longer a ranking tier — the spread ranking dropped it because
   * it concentrated every surface on the longest-lived node — but it is still
   * reported, because "how long has this node been up" is the first thing
   * anyone reads a `/status` for.
   */
  private startMonotonic: number | null = null;

  private cancelWatchdog: (() => void) | null = null;
  private unsubscribeRegistry: (() => void) | null = null;
  /** Monotonic reading of this node's last voluntary yield; damps rebalancing. */
  private lastYieldMono: number | null = null;

  /** Wall/monotonic pair from the previous watchdog tick, for suspend detection. */
  private lastTickWall = 0;
  private lastTickMono = 0;

  constructor(private readonly options: ClusterElectionOptions) {
    this.timing = deriveClusterTiming(options.settings);
    this.ledger = new ClusterHoldingsLedger({
      holderTtlMs: this.timing.masterTimeoutMs,
      candidateTtlMs: this.timing.candidateTtlMs,
    });
    this.host = {
      nodeId: options.nodeId,
      version: options.version,
      logger: options.logger,
      clock: options.clock,
      timing: this.timing,
      ledger: this.ledger,
      send: (type, surfaceId) => this.send(type, surfaceId),
      canServe: (surfaceId) => this.options.registry.canServe(surfaceId),
      startConsumer: (surfaceId, context) => this.startConsumer(surfaceId, context),
      stopConsumer: (surfaceId, reason) => this.options.registry.stopSurface(surfaceId, reason),
      tryReserveYield: (mono) => this.tryReserveYield(mono),
    };
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Join the group: open the transport, then run one boot probe per surface.
   *
   * A node with NOTHING to serve still opens the transport, and that is
   * deliberate: it takes part in nobody's election and claims nothing, but it
   * hears the group, so its `/status` can say who holds what. It sends no
   * datagram of its own until a surface is registered.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.startMonotonic = this.options.clock.monotonicNow();
    this.lastTickWall = this.options.clock.now();
    this.lastTickMono = this.startMonotonic ?? 0;
    await this.options.transport.start((raw) => this.receive(raw));
    this.armWatchdog();
    this.unsubscribeRegistry = this.options.registry.onChange((surfaceId) => {
      void this.syncSurface(surfaceId);
    });
    if (this.options.registry.size === 0) {
      this.options.logger.debug('cluster: this node serves no inbound surfaces, so it contests none');
    }
    await Promise.all(this.options.registry.list().map((surface) => this.syncSurface(surface.surfaceId)));
  }

  /** Leave every election cleanly, then close the socket. */
  async stop(reason = 'shutdown'): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.unsubscribeRegistry?.();
    this.unsubscribeRegistry = null;
    this.cancelWatchdog?.();
    this.cancelWatchdog = null;
    await Promise.all([...this.elections.values()].map((election) => election.stop(reason)));
    this.elections.clear();
    await this.options.transport.stop();
  }

  /** Resolves once every surface's queued transitions have finished. */
  async settled(): Promise<void> {
    await Promise.all([...this.elections.values()].map((election) => election.settled()));
  }

  // ── inspection ────────────────────────────────────────────────────────────

  /** True when this node holds at least one surface. */
  get isMaster(): boolean {
    return this.heldSurfaceIds.length > 0;
  }

  get heldSurfaceIds(): string[] {
    return [...this.elections.values()].filter((election) => election.isMaster).map((election) => election.id);
  }

  surfaceRole(surfaceId: string): ClusterRole {
    return this.elections.get(surfaceId)?.currentRole ?? 'stopped';
  }

  status(): ClusterStatus {
    const mono = this.options.clock.monotonicNow();
    const surfaces: ClusterSurfaceStatus[] = [...this.elections.values()]
      .map((election) => election.status())
      .sort((a, b) => (a.surfaceId < b.surfaceId ? -1 : 1));
    const held = surfaces.filter((surface) => surface.role === 'master');
    return {
      enabled: this.options.settings.enabled,
      role: this.aggregateRole(surfaces),
      nodeId: this.options.nodeId,
      version: this.options.version,
      uptimeMs: this.uptimeMs(),
      consumersRunning: surfaces.some((surface) => surface.consuming),
      heldSurfaceCount: held.length,
      signed: this.options.settings.secret.length > 0,
      surfaces,
      peers: [...this.peers.values()].map((peer) => ({
        nodeId: peer.nodeId,
        version: peer.version,
        lastSeenAt: peer.lastSeenAt,
        lastMessageType: peer.lastMessageType,
        holds: this.ledger.surfacesHeldBy(peer.nodeId, mono),
      })),
      transport: this.options.transport.describe(),
    };
  }

  private aggregateRole(surfaces: readonly ClusterSurfaceStatus[]): ClusterRole {
    if (!this.running) return 'stopped';
    if (surfaces.some((surface) => surface.role === 'master')) return 'master';
    if (surfaces.length === 0) return 'standby';
    return surfaces.some((surface) => surface.role !== 'standby') ? 'electing' : 'standby';
  }

  // ── external signals ──────────────────────────────────────────────────────

  /**
   * A provider reported that something else is already consuming.
   *
   * Routed to ONE surface when the caller knows which — a Telegram 409 is
   * about one bot token and says nothing about ntfy. Without a surface it
   * reaches every surface this node currently holds, which is the conservative
   * reading of an unattributed conflict.
   */
  reportConsumerConflict(detail: string, surfaceId?: string): void {
    if (surfaceId) {
      this.elections.get(surfaceId)?.reportConsumerConflict(detail);
      return;
    }
    for (const election of this.elections.values()) election.reportConsumerConflict(detail);
  }

  // ── surface lifecycle ─────────────────────────────────────────────────────

  /**
   * Bring the running elections into line with what this node can serve.
   *
   * A surface that appears gets an election and a boot probe. A surface that
   * disappears — the credential was removed, the consumer was unregistered —
   * gets stopped through the ordered path, so if this node was holding it, it
   * stops consuming and says goodbye rather than going quiet and making the
   * rest of the network wait out the crash timeout.
   */
  private async syncSurface(surfaceId: string): Promise<void> {
    if (!this.running) return;
    const registered = this.options.registry.get(surfaceId);
    const existing = this.elections.get(surfaceId);
    if (registered && !existing) {
      const election = new SurfaceElection({
        surfaceId,
        label: registered.label,
        kind: registered.key.kind,
        host: this.host,
        ...(this.options.random ? { random: this.options.random } : {}),
      });
      this.elections.set(surfaceId, election);
      await election.start();
      return;
    }
    if (!registered && existing) {
      this.elections.delete(surfaceId);
      await existing.stop('this node can no longer serve the surface');
      // Only now is the consumer genuinely finished with; the registry kept it
      // reachable so the stop that precedes the RESIGN had something to stop.
      this.options.registry.forget(surfaceId);
    }
  }

  private async startConsumer(surfaceId: string, context: ClusterConsumerStartContext): Promise<void> {
    await this.options.registry.startSurface(surfaceId, context);
  }

  /**
   * The node's single rebalancing slot. See `SurfaceElectionHost` for why it
   * belongs to the node and not to each surface.
   *
   * One surface moves per cooldown, deliberately. A node three surfaces ahead
   * converges in successive steps rather than in one lurch, and each step is
   * taken against freshly observed numbers rather than against a snapshot
   * every surface read at the same instant.
   */
  private tryReserveYield(mono: number): boolean {
    if (this.lastYieldMono !== null && mono - this.lastYieldMono < this.timing.yieldCooldownMs) return false;
    this.lastYieldMono = mono;
    return true;
  }

  // ── inbound datagrams ─────────────────────────────────────────────────────

  private receive(raw: string): void {
    const { message, rejected } = decodeMessage(raw, this.options.settings.secret);
    if (!message) {
      this.options.logger.debug('cluster: dropped a datagram', { reason: rejected });
      return;
    }
    // Multicast loopback is deliberately ON so same-host processes coordinate
    // through the identical mechanism, which means we also hear ourselves.
    if (message.nodeId === this.options.nodeId) return;
    if (!this.recordPeer(message)) return;
    this.recordHoldings(message);
    if (message.surfaceId === null) return;
    // Recorded above either way: a surface this node cannot serve still tells
    // us what the sender is carrying, which is what makes spread ranking work
    // without anyone advertising their own load.
    this.elections.get(message.surfaceId)?.deliver(message);
  }

  /** Track the peer; returns false for a duplicate or reordered datagram. */
  private recordPeer(message: ClusterMessage): boolean {
    const known = this.peers.get(message.nodeId);
    // A restarted peer resets its counter, so its sequence goes backwards. Its
    // wall clock does not: a datagram with a lower seq but a LATER ts is a new
    // run, while one with a lower seq and an earlier ts is the network
    // redelivering something old. Without this the whole first session of a
    // restarted peer would be discarded as stale.
    const restarted = known !== undefined && message.seq <= known.lastSeq && message.ts > known.lastTs;
    if (known && !restarted && message.seq <= known.lastSeq) return false;
    if (!known && this.peers.size >= MAX_TRACKED_PEERS) {
      const oldest = [...this.peers.values()].sort((a, b) => a.lastSeenAt - b.lastSeenAt)[0];
      if (oldest) this.peers.delete(oldest.nodeId);
    }
    this.peers.set(message.nodeId, {
      nodeId: message.nodeId,
      version: message.nodeVersion,
      lastSeenAt: this.options.clock.now(),
      lastMessageType: message.type,
      lastSeq: message.seq,
      lastTs: message.ts,
    });
    return true;
  }

  /**
   * Update the holdings ledger from observed traffic.
   *
   * Only a HEARTBEAT counts as holding. A CLAIM is a node saying it WANTS the
   * surface, and most claims lose — counting them would briefly credit every
   * losing candidate in an election with a surface it never got, and the
   * spread ranking would rank against numbers that were never true. A holder
   * sends its first HEARTBEAT in the same breath as the CLAIM that took the
   * surface, so nothing is lost by waiting for it. RESIGN is letting go.
   *
   * Any datagram at all — a PROBE from a standby included — proves the sender
   * can serve that surface, which is what makes it a rebalancing candidate.
   */
  private recordHoldings(message: ClusterMessage): void {
    if (message.surfaceId === null) return;
    const mono = this.options.clock.monotonicNow();
    this.ledger.noteCandidate(message.surfaceId, message.nodeId, mono);
    if (message.type === 'HEARTBEAT') {
      this.ledger.noteHolder(message.surfaceId, message.nodeId, mono);
      return;
    }
    if (message.type === 'RESIGN') this.ledger.noteReleased(message.surfaceId, message.nodeId);
  }

  // ── timers ────────────────────────────────────────────────────────────────

  private armWatchdog(): void {
    this.cancelWatchdog?.();
    const tick = (): void => {
      this.onWatchdogTick();
      if (this.running) {
        this.cancelWatchdog = this.options.clock.setTimer(tick, this.timing.watchdogTickMs);
      }
    };
    this.cancelWatchdog = this.options.clock.setTimer(tick, this.timing.watchdogTickMs);
  }

  /**
   * One tick does two jobs: notice that this host was asleep, and let every
   * surface notice a holder that stopped breathing.
   *
   * Suspend is node-level — the whole process was frozen, so every surface's
   * consumer was frozen with it — while holder timeout is per surface.
   */
  private onWatchdogTick(): void {
    if (!this.running) return;
    const wall = this.options.clock.now();
    const mono = this.options.clock.monotonicNow();
    const wallDelta = wall - this.lastTickWall;
    const monoDelta = mono - this.lastTickMono;
    this.lastTickWall = wall;
    this.lastTickMono = mono;

    // A suspend freezes the monotonic clock while the wall clock keeps going,
    // and it also stops timers from firing. Either signal alone is enough.
    const slept = wallDelta - monoDelta >= this.timing.suspendThresholdMs
      || monoDelta - this.timing.watchdogTickMs >= this.timing.suspendThresholdMs;
    if (slept) {
      const gapMs = Math.max(wallDelta, monoDelta);
      // The ledger describes a network that moved on without us. Acting on it
      // would rank this node against holdings recorded before the sleep.
      this.ledger.forgetAll();
      // Rebalancing restarts from scratch too: the slot was last used against a
      // picture of the network that no longer applies.
      this.lastYieldMono = null;
      for (const election of this.elections.values()) election.onWakeFromSuspend(gapMs);
      return;
    }

    for (const election of this.elections.values()) election.onWatchdogTick(mono);
  }

  // ── plumbing ──────────────────────────────────────────────────────────────

  private uptimeMs(): number {
    if (this.startMonotonic === null) return 0;
    return Math.max(0, this.options.clock.monotonicNow() - this.startMonotonic);
  }

  private async send(type: ClusterMessageType, surfaceId: string | null): Promise<void> {
    this.seq += 1;
    const message: ClusterMessage = {
      v: CLUSTER_PROTOCOL_VERSION,
      type,
      surfaceId,
      nodeId: this.options.nodeId,
      nodeVersion: this.options.version,
      seq: this.seq,
      ts: this.options.clock.now(),
    };
    try {
      await this.options.transport.send(encodeMessage(message, this.options.settings.secret));
    } catch (error) {
      this.options.logger.debug('cluster: datagram send failed', {
        type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
