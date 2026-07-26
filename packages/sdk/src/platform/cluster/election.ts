/**
 * election.ts — the leader-election state machine.
 *
 * Everything this class touches is injected: the transport, the clock, the
 * randomness behind the CLAIM jitter, and the two callbacks that start and
 * stop inbound consumption. There is no socket and no wall-clock dependency in
 * here, which is what makes a 90-second watchdog takeover a test that runs in
 * microseconds.
 *
 * The one invariant everything else serves: AT MOST ONE node has consumers
 * running at any moment, and a handoff never starts the successor before the
 * predecessor has finished stopping.
 *
 * Every role transition runs through a single serialized queue. Consumer
 * start and stop are awaited, and datagrams keep arriving while they run, so
 * without serialization a HEARTBEAT landing mid-`start()` could interleave a
 * second transition into a half-applied one.
 */
import {
  compareRank,
  isStrictlyNewerVersion,
  outranks,
  type ClusterRankable,
} from './ranking.js';
import { decodeMessage, encodeMessage } from './protocol.js';
import { deriveClusterTiming, type ClusterTiming } from './timing.js';
import type {
  ClusterConsumerStartContext,
  ClusterClock,
  ClusterLogger,
  ClusterMessage,
  ClusterMessageType,
  ClusterPeerStatus,
  ClusterRole,
  ClusterSettings,
  ClusterStatus,
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
  /**
   * Begin inbound consumption. Must not resolve until consumers are actually
   * running; a rejection leaves this node master with consumers reported down.
   */
  readonly onBecomeMaster: (context: ClusterConsumerStartContext) => Promise<void>;
  /**
   * Stop inbound consumption. Must not resolve until consumption has genuinely
   * ceased — the ordered handoff sends RESIGN only after this settles.
   */
  readonly onResignMaster: (reason: string) => Promise<void>;
  /** Test seam for the CLAIM jitter draw. Defaults to Math.random. */
  readonly random?: (() => number) | undefined;
}

interface TrackedPeer extends ClusterPeerStatus {
  readonly lastSeq: number;
}

export class ClusterElection {
  private readonly timing: ClusterTiming;
  private readonly random: () => number;

  private role: ClusterRole = 'stopped';
  private seq = 0;
  /**
   * Monotonic reading at start(), or null before it. NOT a numeric sentinel:
   * a monotonic clock legitimately reads 0, and treating that as "not started"
   * pins this node's uptime at zero for its whole life — which silently loses
   * it every uptime tiebreak it should have won.
   */
  private startMonotonic: number | null = null;
  private consumersRunning = false;

  private masterNodeId: string | null = null;
  private lastMasterHeartbeatAt: number | null = null;
  private lastMasterHeartbeatMono: number | null = null;

  private readonly peers = new Map<string, TrackedPeer>();

  private cancelProbe: (() => void) | null = null;
  private cancelHeartbeat: (() => void) | null = null;
  private cancelWatchdog: (() => void) | null = null;
  private cancelElection: (() => void) | null = null;
  private cancelSettle: (() => void) | null = null;
  private cancelHandoff: (() => void) | null = null;

  private claimSentThisElection = false;
  private preemptTarget: string | null = null;

  /** Wall/monotonic pair from the previous watchdog tick, for suspend detection. */
  private lastTickWall = 0;
  private lastTickMono = 0;

  /** Serializes every role transition; see the file header. */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: ClusterElectionOptions) {
    this.timing = deriveClusterTiming(options.settings);
    this.random = options.random ?? Math.random;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /** Join the cluster: open the transport and run the boot probe. */
  async start(): Promise<void> {
    if (this.role !== 'stopped') return;
    this.startMonotonic = this.options.clock.monotonicNow();
    this.lastTickWall = this.options.clock.now();
    this.lastTickMono = this.startMonotonic ?? 0;
    await this.options.transport.start((raw) => this.receive(raw));
    this.armWatchdog();
    this.enqueue(() => this.beginProbe('boot'));
    await this.settled();
  }

  /**
   * Leave the cluster cleanly.
   *
   * A master stops consumers and broadcasts RESIGN on the way out, which is
   * what turns a restart from a 90-second outage into a sub-second one. The
   * watchdog exists for the case this path never runs — a crash, a kill -9, a
   * lost power cable — not for the ordinary case.
   */
  async stop(reason = 'shutdown'): Promise<void> {
    if (this.role === 'stopped') return;
    this.enqueue(async () => {
      if (this.role === 'master') await this.stopConsumersThenResign(reason, null);
      this.clearAllTimers();
      this.role = 'stopped';
    });
    await this.settled();
    await this.options.transport.stop();
  }

  /** Resolves once every queued transition has finished. */
  async settled(): Promise<void> {
    await this.queue;
  }

  // ── inspection ────────────────────────────────────────────────────────────

  get currentRole(): ClusterRole {
    return this.role;
  }

  get isMaster(): boolean {
    return this.role === 'master';
  }

  status(): ClusterStatus {
    return {
      enabled: this.options.settings.enabled,
      role: this.role,
      nodeId: this.options.nodeId,
      version: this.options.version,
      uptimeMs: this.uptimeMs(),
      masterNodeId: this.role === 'master' ? this.options.nodeId : this.masterNodeId,
      lastMasterHeartbeatAt: this.lastMasterHeartbeatAt,
      consumersRunning: this.consumersRunning,
      signed: this.options.settings.secret.length > 0,
      peers: [...this.peers.values()].map((peer) => ({
        nodeId: peer.nodeId,
        version: peer.version,
        uptimeMs: peer.uptimeMs,
        lastSeenAt: peer.lastSeenAt,
        lastMessageType: peer.lastMessageType,
      })),
      transport: this.options.transport.describe(),
    };
  }

  // ── external signals ──────────────────────────────────────────────────────

  /**
   * A provider told us somebody else is already consuming — Telegram answers a
   * concurrent getUpdates with 409.
   *
   * Never fight over it. The other consumer is real whether or not it speaks
   * this protocol, so stop, back off, and re-probe. Fighting produces two
   * processes that each keep terminating the other's long poll and a user
   * whose messages arrive nowhere.
   */
  reportConsumerConflict(detail: string): void {
    if (this.role === 'stopped') return;
    this.enqueue(async () => {
      if (this.role !== 'master') return;
      this.options.logger.warn('cluster: another consumer is already reading this surface; standing down', {
        detail,
        backoffMs: this.timing.consumerConflictBackoffMs,
      });
      await this.stopConsumersThenResign(`consumer conflict: ${detail}`, null);
      this.role = 'standby';
      this.cancelProbe?.();
      this.cancelProbe = this.options.clock.setTimer(() => {
        this.enqueue(() => this.beginProbe('re-probe after a consumer conflict'));
      }, this.timing.consumerConflictBackoffMs);
    });
  }

  // ── probing ───────────────────────────────────────────────────────────────

  private async beginProbe(reason: string): Promise<void> {
    this.clearElectionTimers();
    this.role = 'probing';
    this.preemptTarget = null;
    this.options.logger.debug('cluster: probing for a master', { reason });
    await this.send('PROBE');
    this.cancelProbe?.();
    this.cancelProbe = this.options.clock.setTimer(() => {
      this.enqueue(async () => {
        if (this.role !== 'probing') return;
        await this.becomeMaster('no master answered the boot probe', 'ordered');
      });
    }, this.timing.bootProbeMs);
  }

  // ── election ──────────────────────────────────────────────────────────────

  private beginElection(windowMs: number, reason: string, handoff: 'ordered' | 'gap'): void {
    this.clearElectionTimers();
    this.role = 'electing';
    this.claimSentThisElection = false;
    const jitter = Math.floor(this.random() * windowMs);
    this.options.logger.debug('cluster: starting an election', { reason, jitterMs: jitter });
    this.cancelElection = this.options.clock.setTimer(() => {
      this.enqueue(async () => {
        if (this.role !== 'electing') return;
        await this.sendClaim();
        this.cancelSettle = this.options.clock.setTimer(() => {
          this.enqueue(async () => {
            if (this.role !== 'electing') return;
            await this.becomeMaster(reason, handoff);
          });
        }, this.timing.claimSettleMs);
      });
    }, jitter);
  }

  private async sendClaim(): Promise<void> {
    this.claimSentThisElection = true;
    await this.send('CLAIM');
  }

  // ── role transitions ──────────────────────────────────────────────────────

  /**
   * Take the role and start consuming.
   *
   * `handoff` decides where consumption resumes from, and the distinction is
   * not cosmetic — it is the difference between losing messages and answering
   * them twice:
   *
   *   'ordered'  — the predecessor stopped consuming and THEN said so, so it
   *                read right up to its last moment. There is no gap. Resuming
   *                from its last heartbeat would replay everything it already
   *                handled between that heartbeat and its stop, and the user
   *                would get a second answer to a message that was answered.
   *
   *   'gap'      — the predecessor vanished (crash, kill -9, a handoff it never
   *                completed). The last moment it is KNOWN to have been alive
   *                is its last heartbeat, so consumption resumes there. A
   *                provider without a per-subscriber cursor may redeliver a
   *                message or two from that window; a duplicate is a nuisance
   *                and a lost message is not recoverable, so the window is
   *                deliberately replayed rather than skipped.
   */
  private async becomeMaster(reason: string, handoff: 'ordered' | 'gap'): Promise<void> {
    this.clearElectionTimers();
    this.role = 'master';
    this.preemptTarget = null;
    // Announce before consuming: a strictly newer peer that disagrees gets its
    // chance to preempt through the ordered path rather than by racing us.
    await this.send('CLAIM');
    const context: ClusterConsumerStartContext = {
      replayFromMs: handoff === 'gap' ? this.lastMasterHeartbeatAt : null,
      reason,
    };
    try {
      await this.options.onBecomeMaster(context);
      this.consumersRunning = true;
      this.options.logger.info('cluster: this node is now responsible for inbound channel consumption', {
        nodeId: this.options.nodeId,
        version: this.options.version,
        reason,
        replayFromMs: context.replayFromMs,
      });
    } catch (error) {
      this.consumersRunning = false;
      this.options.logger.error('cluster: became responsible but inbound consumers failed to start', {
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.armHeartbeat();
    await this.send('HEARTBEAT');
  }

  /**
   * The ordered half of every handoff: consumers stop FIRST, and only once
   * they have genuinely stopped does RESIGN go out. The successor keys off
   * RESIGN, so this ordering is the entire reason a handoff cannot
   * double-consume. Reversing these two lines would reintroduce the bug this
   * module exists to fix.
   */
  private async stopConsumersThenResign(reason: string, nextMasterNodeId: string | null): Promise<void> {
    this.role = 'resigning';
    this.cancelHeartbeat?.();
    this.cancelHeartbeat = null;
    if (this.consumersRunning) {
      try {
        await this.options.onResignMaster(reason);
      } catch (error) {
        this.options.logger.error('cluster: inbound consumers did not stop cleanly before resigning', {
          reason,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.consumersRunning = false;
    }
    await this.send('RESIGN');
    this.masterNodeId = nextMasterNodeId;
    this.options.logger.info('cluster: released responsibility for inbound channel consumption', {
      reason,
      ...(nextMasterNodeId ? { successor: nextMasterNodeId } : {}),
    });
  }

  private becomeStandby(masterNodeId: string | null, reason: string): void {
    this.clearElectionTimers();
    this.role = 'standby';
    this.preemptTarget = null;
    if (masterNodeId) this.masterNodeId = masterNodeId;
    this.options.logger.debug('cluster: standing by', { master: this.masterNodeId, reason });
  }

  /**
   * Take the role from a sitting master because this build is strictly newer.
   *
   * We do NOT start consuming here. The old master owns the stop; we wait for
   * its RESIGN, with a grace timer for the case it died mid-handoff.
   */
  private async beginPreemption(target: ClusterMessage): Promise<void> {
    this.clearElectionTimers();
    this.role = 'awaiting-handoff';
    this.preemptTarget = target.nodeId;
    this.options.logger.info('cluster: preempting an older master and waiting for its handoff', {
      master: target.nodeId,
      masterVersion: target.version,
      version: this.options.version,
    });
    await this.send('CLAIM');
    this.cancelHandoff = this.options.clock.setTimer(() => {
      this.enqueue(async () => {
        if (this.role !== 'awaiting-handoff') return;
        this.options.logger.warn('cluster: the preempted master did not resign in time; taking over', {
          master: this.preemptTarget,
          graceMs: this.timing.preemptGraceMs,
        });
        await this.becomeMaster('preemption grace elapsed', 'gap');
      });
    }, this.timing.preemptGraceMs);
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
    this.enqueue(() => this.dispatch(message));
  }

  /** Track the peer; returns false for a duplicate or reordered datagram. */
  private recordPeer(message: ClusterMessage): boolean {
    const known = this.peers.get(message.nodeId);
    // A restarted peer resets its counter, which shows up as uptime going
    // backwards. Without this, its whole first session would be discarded.
    const restarted = known !== undefined && message.uptimeMs < known.uptimeMs;
    if (known && !restarted && message.seq <= known.lastSeq) return false;
    if (!known && this.peers.size >= MAX_TRACKED_PEERS) {
      const oldest = [...this.peers.values()].sort((a, b) => a.lastSeenAt - b.lastSeenAt)[0];
      if (oldest) this.peers.delete(oldest.nodeId);
    }
    this.peers.set(message.nodeId, {
      nodeId: message.nodeId,
      version: message.version,
      uptimeMs: message.uptimeMs,
      lastSeenAt: this.options.clock.now(),
      lastMessageType: message.type,
      lastSeq: message.seq,
    });
    return true;
  }

  private async dispatch(message: ClusterMessage): Promise<void> {
    if (this.role === 'stopped' || this.role === 'resigning') return;
    switch (message.type) {
      case 'PROBE': return this.onProbe();
      case 'HEARTBEAT': return this.onHeartbeat(message);
      case 'CLAIM': return this.onClaim(message);
      case 'RESIGN': return this.onResign(message);
    }
  }

  /** A node is booting. Only the master answers, and it answers immediately. */
  private async onProbe(): Promise<void> {
    if (this.role !== 'master') return;
    await this.send('HEARTBEAT');
  }

  private async onHeartbeat(message: ClusterMessage): Promise<void> {
    this.noteMasterAlive(message.nodeId);
    switch (this.role) {
      case 'probing':
        if (isStrictlyNewerVersion(this.self(), message)) {
          await this.beginPreemption(message);
          return;
        }
        this.becomeStandby(message.nodeId, 'a master answered the boot probe');
        return;
      case 'electing':
        this.becomeStandby(message.nodeId, 'a master spoke up during the election');
        return;
      case 'awaiting-handoff':
        // A DIFFERENT node than the one we preempted is master: our premise is
        // stale, so abandon the preemption rather than take over behind it.
        if (message.nodeId !== this.preemptTarget && !isStrictlyNewerVersion(this.self(), message)) {
          this.becomeStandby(message.nodeId, 'a different master holds the role');
        }
        return;
      case 'master':
        await this.reconcileWithPeerMaster(message);
        return;
      default:
        this.masterNodeId = message.nodeId;
    }
  }

  /**
   * Two masters can hear each other after a partition heals. Both sides run
   * the same total ordering over the same two candidates, so they agree on the
   * winner without negotiating; the loser performs the ordered stop-then-
   * RESIGN and the winner — which never stopped — simply carries on.
   */
  private async reconcileWithPeerMaster(message: ClusterMessage): Promise<void> {
    if (compareRank(message, this.self()) < 0) {
      this.options.logger.info('cluster: a better-ranked master appeared; handing the role over', {
        peer: message.nodeId,
        peerVersion: message.version,
      });
      await this.stopConsumersThenResign('a better-ranked master appeared', message.nodeId);
      this.becomeStandby(message.nodeId, 'lost the split-brain reconciliation');
      return;
    }
    // We outrank it: assert, so the other side reconciles the same way.
    await this.send('HEARTBEAT');
  }

  private async onClaim(message: ClusterMessage): Promise<void> {
    switch (this.role) {
      case 'master':
        if (isStrictlyNewerVersion(message, this.self())) {
          await this.stopConsumersThenResign('preempted by a strictly newer build', message.nodeId);
          this.becomeStandby(message.nodeId, 'preempted by a strictly newer build');
          return;
        }
        // Not newer: hold the role and assert it, which silences the claimer.
        await this.send('HEARTBEAT');
        return;
      case 'electing':
      case 'probing':
        if (outranks(message, this.self())) {
          this.becomeStandby(message.nodeId, 'a better-ranked node claimed the role');
          return;
        }
        // A worse claim: answer once so the claimer stands down promptly
        // instead of running its settle window out against us.
        if (!this.claimSentThisElection) await this.sendClaim();
        return;
      case 'awaiting-handoff':
        if (outranks(message, this.self())) {
          this.becomeStandby(message.nodeId, 'a better-ranked node claimed during our handoff');
        }
        return;
      default:
        return;
    }
  }

  private async onResign(message: ClusterMessage): Promise<void> {
    if (this.role === 'awaiting-handoff' && message.nodeId === this.preemptTarget) {
      this.cancelHandoff?.();
      this.cancelHandoff = null;
      await this.becomeMaster('the preempted master handed the role over', 'ordered');
      return;
    }
    // Only a STANDBY shortcuts to an election here. A probing node is already
    // running its own boot window and would gain nothing by jumping the queue,
    // and a node that has just woken from suspend is deliberately made to
    // re-probe rather than act on a farewell it may have received minutes ago.
    if (this.role === 'standby') {
      if (this.masterNodeId !== null && message.nodeId !== this.masterNodeId) return;
      this.masterNodeId = null;
      // The master said goodbye, so there is nothing to wait out: run the
      // short election window instead of the crash-only watchdog timeout.
      // It stopped consuming before it said goodbye, so nothing was missed.
      this.beginElection(this.timing.resignElectionWindowMs, 'the master resigned', 'ordered');
    }
  }

  private noteMasterAlive(nodeId: string): void {
    this.lastMasterHeartbeatAt = this.options.clock.now();
    this.lastMasterHeartbeatMono = this.options.clock.monotonicNow();
    if (this.role !== 'master') this.masterNodeId = nodeId;
  }

  // ── timers ────────────────────────────────────────────────────────────────

  private armHeartbeat(): void {
    this.cancelHeartbeat?.();
    const tick = (): void => {
      this.enqueue(async () => {
        if (this.role !== 'master') return;
        await this.send('HEARTBEAT');
        this.cancelHeartbeat = this.options.clock.setTimer(tick, this.timing.heartbeatMs);
      });
    };
    this.cancelHeartbeat = this.options.clock.setTimer(tick, this.timing.heartbeatMs);
  }

  private armWatchdog(): void {
    this.cancelWatchdog?.();
    const tick = (): void => {
      this.enqueue(() => this.onWatchdogTick());
      if (this.role !== 'stopped') {
        this.cancelWatchdog = this.options.clock.setTimer(tick, this.timing.watchdogTickMs);
      }
    };
    this.cancelWatchdog = this.options.clock.setTimer(tick, this.timing.watchdogTickMs);
  }

  /**
   * One tick does two jobs: notice a master that stopped breathing, and notice
   * that this host was asleep.
   */
  private async onWatchdogTick(): Promise<void> {
    if (this.role === 'stopped') return;
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
      await this.onWakeFromSuspend(Math.max(wallDelta, monoDelta));
      return;
    }

    if (this.role !== 'standby' || this.lastMasterHeartbeatMono === null) return;
    if (mono - this.lastMasterHeartbeatMono < this.timing.masterTimeoutMs) return;
    this.beginElection(this.timing.electionWindowMs, 'the master stopped heartbeating', 'gap');
  }

  /**
   * A woken node knows nothing about who is responsible now, and its own
   * consumers were frozen mid-flight. Stop first, THEN re-probe — resuming a
   * long poll that a successor has already taken over is precisely the double
   * consumption this module prevents.
   */
  private async onWakeFromSuspend(gapMs: number): Promise<void> {
    this.options.logger.info('cluster: the host was suspended; re-probing before consuming anything', {
      gapMs,
      roleBeforeSuspend: this.role,
    });
    if (this.role === 'master') {
      await this.stopConsumersThenResign('the host was suspended', null);
    }
    this.lastMasterHeartbeatAt = null;
    this.lastMasterHeartbeatMono = null;
    this.masterNodeId = null;
    await this.beginProbe('woke from suspend');
  }

  private clearElectionTimers(): void {
    this.cancelProbe?.();
    this.cancelProbe = null;
    this.cancelElection?.();
    this.cancelElection = null;
    this.cancelSettle?.();
    this.cancelSettle = null;
    this.cancelHandoff?.();
    this.cancelHandoff = null;
  }

  private clearAllTimers(): void {
    this.clearElectionTimers();
    this.cancelHeartbeat?.();
    this.cancelHeartbeat = null;
    this.cancelWatchdog?.();
    this.cancelWatchdog = null;
  }

  // ── plumbing ──────────────────────────────────────────────────────────────

  private self(): ClusterRankable {
    return {
      nodeId: this.options.nodeId,
      version: this.options.version,
      uptimeMs: this.uptimeMs(),
    };
  }

  private uptimeMs(): number {
    if (this.startMonotonic === null) return 0;
    return Math.max(0, this.options.clock.monotonicNow() - this.startMonotonic);
  }

  private async send(type: ClusterMessageType): Promise<void> {
    this.seq += 1;
    const message: ClusterMessage = {
      type,
      nodeId: this.options.nodeId,
      version: this.options.version,
      uptimeMs: this.uptimeMs(),
      seq: this.seq,
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

  private enqueue(work: () => Promise<void>): void {
    this.queue = this.queue.then(work).catch((error: unknown) => {
      this.options.logger.error('cluster: a state transition failed', {
        role: this.role,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}
