/**
 * coordinator.ts — the one object a composition root wires up.
 *
 * A process has exactly ONE coordinator. Several inbound consumers register
 * with it — the SDK daemon facade registers Telegram ingress and the channel
 * provider runtime; the goodvibes-tui daemon additionally registers its own
 * inbox poller — and all of them follow the same leadership. Two coordinators
 * in one process would be two nodes in the election arguing with each other,
 * so a composition that already has one passes it down rather than making a
 * second.
 *
 * Ordering guarantees the state machine relies on and this class provides:
 *   - gates START in registration order and STOP in reverse, so a consumer
 *     that another depends on is up first and down last;
 *   - `stopGates` does not resolve until every gate's `stop()` has settled,
 *     which is what makes the RESIGN that follows it truthful.
 *
 * With `cluster.enabled` false the coordinator degrades to exactly the
 * behavior that existed before it: every gate starts on start() and stops on
 * stop(), no sockets are opened, and nothing is broadcast anywhere.
 */
import { ClusterElection } from './election.js';
import { createSystemClusterClock } from './clock.js';
import { resolveNodeIdentity } from './identity.js';
import { UdpClusterTransport } from './udp-transport.js';
import type {
  ClusterClock,
  ClusterConsumerGate,
  ClusterConsumerStartContext,
  ClusterLogger,
  ClusterSettings,
  ClusterStatus,
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
  private readonly gates: ClusterConsumerGate[] = [];
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
  private gatesRunning = false;

  constructor(private readonly options: ClusterCoordinatorOptions) {
    this.clock = options.clock ?? createSystemClusterClock();
  }

  private get nodeId(): string {
    this.nodeIdValue ??= this.options.nodeId
      ?? resolveNodeIdentity({ stateDirectory: this.options.stateDirectory, logger: this.options.logger }).nodeId;
    return this.nodeIdValue;
  }

  get enabled(): boolean {
    return this.options.settings.enabled;
  }

  /** True when this node currently holds responsibility for inbound consumption. */
  get isMaster(): boolean {
    if (!this.options.settings.enabled) return this.started;
    return this.election?.isMaster ?? false;
  }

  /**
   * Register an inbound consumer. Returns an unregister function.
   *
   * Registering while this node is already master starts the gate
   * immediately, so a consumer composed late still comes up.
   */
  register(gate: ClusterConsumerGate): () => void {
    this.gates.push(gate);
    if (this.gatesRunning) {
      void this.startOneGate(gate, {
        replayFromMs: null,
        reason: 'registered while this node was already responsible',
      });
    }
    return () => {
      const index = this.gates.indexOf(gate);
      if (index >= 0) this.gates.splice(index, 1);
    };
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    if (!this.options.settings.enabled) {
      this.options.logger.debug('cluster: leader election is disabled; consuming on this node unconditionally');
      await this.startGates({ replayFromMs: null, reason: 'cluster.enabled is false' });
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
      onBecomeMaster: (context) => this.startGates(context),
      onResignMaster: (reason) => this.stopGates(reason),
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
      await this.startGates({ replayFromMs: null, reason: 'coordination unavailable' });
    }
  }

  async stop(reason = 'shutdown'): Promise<void> {
    if (!this.started) return;
    this.started = false;
    if (this.election) {
      // The election's own stop performs the ordered stop-then-RESIGN.
      await this.election.stop(reason);
      this.election = null;
      this.transport = null;
      return;
    }
    await this.stopGates(reason);
  }

  /** Wait for any in-flight transition — tests and orderly shutdown use it. */
  async settled(): Promise<void> {
    await this.election?.settled();
  }

  /**
   * A provider reported that something else is already consuming this surface
   * (Telegram's 409 on getUpdates is the live case). Never contest it.
   */
  reportConsumerConflict(detail: string): void {
    this.election?.reportConsumerConflict(detail);
  }

  /** The `cluster` section of /status. Inspection only. */
  status(): ClusterStatus {
    if (this.election) return this.election.status();
    return {
      enabled: this.options.settings.enabled,
      role: this.started ? 'master' : 'stopped',
      nodeId: this.nodeId,
      version: this.options.version,
      uptimeMs: 0,
      masterNodeId: this.started ? this.nodeId : null,
      lastMasterHeartbeatAt: null,
      consumersRunning: this.gatesRunning,
      signed: false,
      peers: [],
      transport: { mode: 'in-memory', group: '', port: 0, peers: [] },
    };
  }

  // ── gate fan-out ──────────────────────────────────────────────────────────

  private async startGates(context: ClusterConsumerStartContext): Promise<void> {
    this.gatesRunning = true;
    for (const gate of [...this.gates]) {
      await this.startOneGate(gate, context);
    }
  }

  private async startOneGate(gate: ClusterConsumerGate, context: ClusterConsumerStartContext): Promise<void> {
    try {
      await gate.start(context);
    } catch (error) {
      // One consumer failing to start must not strand the others, and must not
      // leave the node believing it is not responsible when it is.
      this.options.logger.error('cluster: an inbound consumer failed to start on becoming responsible', {
        consumer: gate.id,
        reason: context.reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Stop every gate, newest first, and do not resolve until they have all
   * settled. The RESIGN that follows this is a claim that consumption has
   * genuinely ceased, so it must not be sent a moment early.
   */
  private async stopGates(reason: string): Promise<void> {
    for (const gate of [...this.gates].reverse()) {
      try {
        await gate.stop(reason);
      } catch (error) {
        this.options.logger.error('cluster: an inbound consumer did not stop cleanly', {
          consumer: gate.id,
          reason,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.gatesRunning = false;
  }
}
