/**
 * timing.ts — every interval the state machine uses, derived from four
 * operator-facing settings.
 *
 * Only `heartbeatSeconds`, `masterTimeoutSeconds` and `bootProbeSeconds` are
 * configurable. Everything else is derived PROPORTIONALLY from them rather
 * than hard-coded, so shortening the timeouts (which is exactly what a test
 * rig and a live sandbox both do) shortens the whole protocol coherently
 * instead of leaving a 30-second grace window inside a 4-second election.
 */
import type { ClusterSettings } from './types.js';

export interface ClusterTiming {
  /** How long a booting node waits for a master to answer its PROBE. */
  readonly bootProbeMs: number;
  /** Master heartbeat period. */
  readonly heartbeatMs: number;
  /** Silence after which a standby declares the master gone. Crash-only path. */
  readonly masterTimeoutMs: number;
  /** Jitter window for a watchdog-triggered election. */
  readonly electionWindowMs: number;
  /**
   * Jitter window for an election triggered by a RESIGN we actually received.
   * Much shorter: the master told us it was leaving, so there is nothing to
   * wait for beyond letting peers spread their claims out.
   */
  readonly resignElectionWindowMs: number;
  /** After sending a CLAIM, how long to let a better claim arrive. */
  readonly claimSettleMs: number;
  /** How long a preemptor waits for the old master's ordered RESIGN. */
  readonly preemptGraceMs: number;
  /** Watchdog cadence: master-liveness and suspend detection. */
  readonly watchdogTickMs: number;
  /**
   * A tick this late — or a wall clock that ran this far ahead of the
   * monotonic clock — means the host was suspended, not merely busy.
   */
  readonly suspendThresholdMs: number;
  /** Backoff after a provider told us someone else is already consuming. */
  readonly consumerConflictBackoffMs: number;
  /**
   * Ceiling for the consumer-conflict backoff as it doubles.
   *
   * A consumer conflict is not a transient network fault that clears itself —
   * it means a DIFFERENT process holds the credential, and only a human can
   * decide which one should. Retrying at a constant rate forever is therefore
   * a hot loop against somebody else's API: on a node with no peer to hand the
   * surface to, every retry resigns, re-probes, wins its own election again,
   * restarts the consumer and is refused again. Measured on a two-node group
   * before this cap existed, with a 4s master timeout: 44 getUpdates calls in
   * 40 seconds, all of them refused.
   *
   * Proportional like everything else here, so a test rig that shortens the
   * timeouts shortens this too, with a fifteen-minute ceiling for a real
   * install — long enough to stop hammering, short enough that fixing the
   * other process is noticed without a restart.
   */
  readonly consumerConflictBackoffMaxMs: number;
  /**
   * How often a STANDBY re-announces that it can serve a surface.
   *
   * A standby is silent by design, and a silent node is invisible to the
   * holdings ledger. Without this beat an overloaded holder would believe it
   * had nobody to hand a surface to and would never rebalance. One small
   * datagram per surface per period, and it doubles as a liveness check: the
   * holder answers a PROBE with a HEARTBEAT.
   */
  readonly candidacyAnnounceMs: number;
  /**
   * How long a node stays a believed candidate after its last datagram.
   *
   * Three announce periods, so two lost datagrams in a row do not make a
   * healthy standby vanish from the ledger and freeze rebalancing.
   */
  readonly candidateTtlMs: number;
  /** How often a holder re-examines whether it should yield a surface. */
  readonly yieldCheckMs: number;
  /**
   * The shortest interval between two voluntary yields by one node.
   *
   * A yield is an ordered handoff: the consumer stops, then restarts
   * elsewhere. Doing several in quick succession would take more surfaces
   * briefly offline than the imbalance costs, so a node gives the cluster time
   * to re-converge and re-observe before it gives up anything else.
   */
  readonly yieldCooldownMs: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function deriveClusterTiming(settings: ClusterSettings): ClusterTiming {
  const heartbeatMs = clamp(settings.heartbeatSeconds * 1_000, 100, 3_600_000);
  const masterTimeoutMs = clamp(settings.masterTimeoutSeconds * 1_000, heartbeatMs * 2, 86_400_000);
  const bootProbeMs = clamp(settings.bootProbeSeconds * 1_000, 50, masterTimeoutMs);
  const electionWindowMs = clamp(masterTimeoutMs / 4, 100, 5_000);
  return {
    bootProbeMs,
    heartbeatMs,
    masterTimeoutMs,
    electionWindowMs,
    resignElectionWindowMs: Math.min(600, electionWindowMs),
    claimSettleMs: Math.min(400, electionWindowMs / 2),
    preemptGraceMs: clamp(masterTimeoutMs / 3, 500, 30_000),
    watchdogTickMs: clamp(Math.min(heartbeatMs, masterTimeoutMs / 3), 50, 30_000),
    suspendThresholdMs: Math.max(masterTimeoutMs / 2, 1_000),
    consumerConflictBackoffMs: clamp(masterTimeoutMs / 6, 250, 15_000),
    consumerConflictBackoffMaxMs: clamp(masterTimeoutMs * 10, 1_000, 900_000),
    candidacyAnnounceMs: masterTimeoutMs,
    candidateTtlMs: masterTimeoutMs * 3,
    yieldCheckMs: masterTimeoutMs,
    yieldCooldownMs: masterTimeoutMs * 2,
  };
}
