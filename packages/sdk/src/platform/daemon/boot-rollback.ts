/**
 * Crash-loop auto-rollback: the safety net under the self-update loop.
 *
 * An update that verified its checksums can still be a bad build, one that
 * dies during startup on THIS host. Until now the kept `<path>.previous` copy
 * only came back by hand (`/update rollback`), which is exactly the command an
 * owner cannot run when the thing that will not start is the daemon.
 *
 * The rule: every boot records a start attempt before doing anything that can
 * fail, and clears it once the daemon is fully started. When a boot finds that
 * the three attempts before it never reached a fully-started daemon, and they
 * were rapid, within the crash-loop window, the startup path restores each
 * kept previous file over the live one, records a receipt saying so, and hands
 * over to the restored binary instead of repeating the same failure a fourth
 * time.
 *
 * Two things it deliberately does NOT do:
 *   - it never rolls back twice in a row. A rollback EXCHANGES the live file
 *     with its kept previous, so a second automatic rollback would roll
 *     FORWARD onto the same bad build; the marker's `autoRollbackAt` stamp
 *     blocks that until a fully-started boot re-arms it.
 *   - it never claims a rollback it could not perform. With no kept previous
 *     copy on disk there is nothing to restore, and the boot continues (loudly
 *     logged) rather than pretending it recovered.
 *
 * Pure decision logic here; the marker I/O lives in lifecycle-marker.ts and
 * the rename mechanics in runtime/self-update.ts, so all three are testable
 * apart from a real install.
 */
import { formatReceiptTime } from './receipts.js';

/** Consecutive failed starts that arm the automatic rollback. */
export const CRASH_LOOP_FAILED_START_THRESHOLD = 3;

export interface CrashLoopRollbackInput {
  /**
   * Consecutive PREVIOUS start attempts that never reached a fully-started
   * daemon (this boot excluded, it has not failed yet).
   */
  readonly failedStarts: number;
  /** When an automatic rollback last fired, if no fully-started boot cleared it since. */
  readonly autoRollbackAt: number | undefined;
  /** Override for tests; defaults to CRASH_LOOP_FAILED_START_THRESHOLD. */
  readonly threshold?: number | undefined;
}

export type CrashLoopRollbackVerdict =
  | { readonly rollback: false; readonly reason: 'healthy' | 'already-rolled-back' }
  | { readonly rollback: true; readonly failedStarts: number };

/**
 * Whether this boot should restore the kept previous version before it tries
 * to start. Reached at the very top of the startup path, so the decision costs
 * one file read on a healthy host.
 */
export function decideCrashLoopRollback(input: CrashLoopRollbackInput): CrashLoopRollbackVerdict {
  const threshold = Math.max(1, input.threshold ?? CRASH_LOOP_FAILED_START_THRESHOLD);
  if (input.failedStarts < threshold) return { rollback: false, reason: 'healthy' };
  // A rollback already fired and no boot has been healthy since: rolling back
  // again would exchange straight back onto the build that was failing.
  if (input.autoRollbackAt !== undefined) return { rollback: false, reason: 'already-rolled-back' };
  return { rollback: true, failedStarts: input.failedStarts };
}

export interface CrashLoopReceiptInput {
  readonly failedStarts: number;
  readonly restored: readonly { readonly label: string }[];
  readonly at: number;
}

/**
 * The owner-facing receipt for an automatic rollback. It names what happened,
 * how the daemon decided, and which files went back, a restart that silently
 * changed versions would be worse than the crash loop it fixed.
 */
export function crashLoopRollbackReceipt(input: CrashLoopReceiptInput): string {
  const files = input.restored.map((target) => target.label).join(', ');
  return (
    `rolled back to the previously installed version at ${formatReceiptTime(input.at)}`
    + `, the last update failed to start ${input.failedStarts} times in a row (${files} restored from the kept previous copy);`
    + ` the version that failed is now the kept previous copy, so /update rollback rolls forward onto it again`
  );
}
