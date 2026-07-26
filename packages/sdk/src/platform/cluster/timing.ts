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
  };
}
