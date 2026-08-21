/**
 * update-status.ts, what a daemon can say about updating itself.
 *
 * The state was always there: the loop tracked its cadence, its consecutive
 * failures, the release it had already downloaded and verified, and the one a
 * crash-loop rollback rejected. None of it was answerable from outside the
 * process, so "this daemon has not updated" read identically whether there was
 * nothing to update to, the loop was never armed, or every check had been
 * failing for a week. It lives in its own file because the shape is read by
 * the lifecycle that produces it and by the verbs that serve it, and neither
 * should have to import the other.
 */

/** What a daemon can say about updating itself. See DaemonLifecycleRuntime.updateStatus. */
export interface DaemonUpdateStatus {
  /** Whether the self-update loop is running. */
  readonly armed: boolean;
  /** Why it is not, in one line. Empty when it is. */
  readonly offReason: string;
  /** The running artifact's version, or null when this host ships none. */
  readonly currentVersion: string | null;
  /** Where release tags are resolved from, or empty when nothing is configured. */
  readonly releasesUrl: string;
  /** The cadence between checks, or null when the loop is off. */
  readonly checkIntervalMs: number | null;
  /** The delay before the first check after a boot, or null when the loop is off. */
  readonly firstCheckDelayMs: number | null;
  /** Consecutive checks that threw. Zero once one completes. */
  readonly failedCheckCount: number;
  /** What the most recent failing check said, or null when none is failing. */
  readonly lastCheckFailure: string | null;
  /** A downloaded-and-verified release waiting for an idle moment, or null. */
  readonly pendingVersion: string | null;
  /** A release a crash-loop rollback rejected and no boot has cleared, or null. */
  readonly rejectedVersion: string | null;
}
