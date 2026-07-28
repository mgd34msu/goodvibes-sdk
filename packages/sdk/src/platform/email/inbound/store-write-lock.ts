/**
 * store-write-lock.ts — the cross-process half of "one writer at a time" for
 * the three inbound-mail stores (docs/inbound-email.md §9).
 *
 * Each store already has an in-process `writeChain`, and a chain is exactly as
 * wide as the object holding it: two `InboundMailStore` instances over one file
 * — which is what two daemon processes on one machine are — share no chain at
 * all. Measured on the unfixed code: six records written by two writers left
 * THREE on disk, because each writer read the same three-record file, appended
 * its own, and wrote four over the other's four.
 *
 * WHETHER THAT IS REACHABLE WAS CHECKED RATHER THAN ASSUMED, and it is:
 *
 *   - The only thing standing between this machine and two daemons is
 *     `requirePortAvailable` (daemon/port-check.ts), called from
 *     `DaemonFacade.start` and the HTTP listener. It refuses a start when the
 *     CONFIGURED PORT is already bound.
 *   - The port is configuration (`resolveHostBinding`, daemon/host-resolver.ts,
 *     `validPort(customPort) ?? DEFAULT_PORTS[serverType]`), and the store paths
 *     are `shellPaths.resolveUserPath('daemon', …)` — derived from `$HOME`,
 *     with no port in them. So two daemons on two ports under one home
 *     directory share every one of these files, and neither refuses to start.
 *   - `lifecycle-marker.ts` records a pid and a `running` state but is
 *     explicitly a crash-receipt marker, not a mutex: a second start reads it,
 *     writes a receipt, and proceeds.
 *   - The port probe is also connect-then-bind, so it is advisory even for one
 *     port.
 *
 * So the daemon is NOT single-instance by construction, and the lock is not a
 * lock nobody needs. It is `acquireCrossProcessLock` — the same advisory lock
 * the checkpoint store and the push subscription store already use, reused
 * rather than reinvented, because it has already answered the hard parts
 * (populated-before-published, single-winner takeover, release-only-your-own,
 * staleness by pid AND mtime, and reclamation of its own staging litter, so it
 * does not itself become persisted state with no GC).
 *
 * An in-memory store has no file to contend on and takes the chain only.
 */
import { acquireCrossProcessLock } from '../../workspace/checkpoint/cross-process-lock.js';

/**
 * How long a writer waits for the lock before failing loudly.
 *
 * These are small JSON files: a held critical section is one read, one
 * validation pass and one write, so ten seconds is a wedged-peer ceiling
 * rather than a patience budget. A peer that actually died is reclaimed by the
 * lock's own staleness check well inside this, and a timeout surfaces as a
 * thrown write — which the callers already treat as a failed write — rather
 * than as a silent hang.
 */
export const INBOUND_STORE_LOCK_TIMEOUT_MS = 10_000;

/** Run `fn` as the only writer of `lockPath`, across every process on this machine. */
export async function withInboundStoreWriteLock<T>(
  lockPath: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  if (lockPath === null) return fn();
  const release = await acquireCrossProcessLock(lockPath, {
    totalTimeoutMs: INBOUND_STORE_LOCK_TIMEOUT_MS,
  });
  try {
    return await fn();
  } finally {
    release();
  }
}
