/**
 * cross-process-lock.ts, a file-based mutual-exclusion lock for a single
 * directory, shared by every process that touches it.
 *
 * WorkspaceCheckpointManager's `withLock` (manager.ts) is an in-process
 * promise chain: it serializes concurrent operations WITHIN one process, but
 * two separate processes sharing the same checkpoint directory (e.g. a
 * daemon and a CLI invocation, or two daemon instances pointed at the same
 * workspace) have no in-process chain in common, their `git add -A` /
 * `read-tree --reset` / `checkout-index` calls can interleave and corrupt the
 * shared side-repo index. This module is the cross-process half: an
 * advisory lock file acquired with `O_CREAT|O_EXCL` (atomic create-if-absent
 * on every POSIX filesystem), so only one process can hold it at a time.
 *
 * The four rules that make "only one at a time" actually true:
 *
 *  0. A PUBLISHED LOCK IS NEVER EMPTY. The lock file appears at its path with
 *     its ownership payload already in it (staging file + `link()`), because
 *     an unreadable payload is one of the staleness signals below: a plain
 *     `open(…,'wx')`-then-write publishes a zero-byte file for an instant, and
 *     a waiter reading it in that instant concludes "corrupt, therefore
 *     abandoned" and takes over a lock that was just legitimately acquired.
 *     See createLockAtomically.
 *
 *  1. A HELD LOCK STAYS VISIBLY ALIVE. The holder keeps the lock file's
 *     descriptor open and touches its mtime on a timer (unref'd, so it never
 *     holds a process open) for as long as it holds the lock. Age-based
 *     staleness therefore measures "nobody has been alive at this lock since
 *     `staleMs`", not "this operation has been running a while", a
 *     legitimately long operation (a large first snapshot, a slow restore)
 *     can no longer have its lock stolen out from under it mid-flight.
 *
 *  2. TAKEOVER HAS EXACTLY ONE WINNER, AND LEAVES NO GAP. Two things go wrong
 *     with the obvious "unlink the stale file, then create a fresh one":
 *     two waiters both unlink (the second one deleting the first's brand-new
 *     lock, leaving two holders), and the moment between the unlink and the
 *     create is a gap in which any third waiter's plain create succeeds. So
 *     takeover is (a) serialized by a short-lived takeover ticket,
 *     `<lock>.takeover`, itself an O_CREAT|O_EXCL file, so exactly one
 *     process performs a takeover at a time, and (b) performed as an ATOMIC
 *     REPLACE: the winner writes its payload into a staging file and
 *     `rename()`s it over the stale lock, so the lock path is never, at any
 *     instant, absent. The winner also re-checks the lock's INODE IDENTITY
 *     immediately before the rename and abandons the takeover if it changed.
 *
 *     That check is load-bearing, and its absence was a real defect. The
 *     ticket serializes takeovers against each other but NOT against the
 *     plain-create path: a stale holder can release between the verdict and
 *     the rename, another waiter's `open(…,'wx')` lands a fresh live lock, and
 *     the rename replaces it, two processes then hold. It reproduced as a
 *     millisecond-scale overlap between two different pids in the
 *     eight-process contention test, on a loaded host.
 *
 *     Residual, documented: taking over by AGE from a holder that is still
 *     alive but frozen (see rule 1, a running holder refreshes and is never
 *     judged stale) races that holder's own release. Advisory file locking
 *     has no compare-and-swap to close that last window; what it does have is
 *     rule 3, which keeps the dispossessed holder from deleting the winner's
 *     lock afterwards.
 *
 *  3. RELEASE ONLY DELETES ITS OWN LOCK. Release compares the open
 *     descriptor's inode against the file currently at the lock path and
 *     unlinks only on a match. After a takeover, the previous holder's late
 *     release finds a different inode and leaves the new holder's lock
 *     completely alone.
 *
 * Staleness signals: a holder is stale when its recorded pid is no longer
 * alive, when its payload is unreadable/malformed, or when its mtime is older
 * than `staleMs`. The pid check reclaims a crashed holder immediately; the
 * mtime check is the backstop that also covers pid reuse (a recycled pid can
 * make a dead holder look alive, but nothing is refreshing its mtime).
 */
import {
  closeSync,
  fstatSync,
  futimesSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';

export interface CrossProcessLockOptions {
  /**
   * A lock whose mtime has not moved for this long is treated as abandoned and
   * taken over. Default 30s. A live holder refreshes its mtime roughly every
   * `staleMs / 3`, so this bounds "how long after a holder dies (or its host
   * freezes) the store stays locked", NOT how long an operation may run.
   */
  readonly staleMs?: number | undefined;
  /** Initial retry backoff when the lock is held by someone else (and not stale). Default 25ms. */
  readonly initialBackoffMs?: number | undefined;
  /** Backoff cap; doubles each retry up to this ceiling. Default 500ms. */
  readonly maxBackoffMs?: number | undefined;
  /** Give up and throw after waiting this long in total. Default 15s. */
  readonly totalTimeoutMs?: number | undefined;
}

const DEFAULT_STALE_MS = 30_000;
const DEFAULT_INITIAL_BACKOFF_MS = 25;
const DEFAULT_MAX_BACKOFF_MS = 500;
const DEFAULT_TOTAL_TIMEOUT_MS = 15_000;
/** Bounds for the held-lock mtime refresh interval (derived from staleMs). */
const MIN_REFRESH_MS = 10;
const MAX_REFRESH_MS = 5_000;

function sleep(ms: number): Promise<void> {
  // Unref'd: a pending backoff or deadline race must never be what keeps the
  // process alive.
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * A sleep whose timer can be cancelled when it loses a `Promise.race`.
 *
 * The losing side of a race is never settled, so a plain `sleep()` used as a
 * deadline strands its handle until it finally elapses. On the queue race below
 * that is 15 seconds per lock acquisition, and lock acquisitions are frequent:
 * a full test run ended with 65 of these still pending. Unref'd handles do not
 * hold the process open, but they are still retained callbacks holding their
 * closures, and they still fire.
 */
function cancellableSleep(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
  return { promise, cancel: () => { if (timer !== undefined) clearTimeout(timer); } };
}

/** True when a process with this pid is still alive (or exists but we lack permission to signal it, still "alive" for our purposes). */
function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Parse a lock file's payload. Accepts the current JSON form
 * (`{"pid":…,"token":…,"acquiredAt":…}`) and the original whitespace form
 * (`<pid> <timestamp>`), so a lock written by an older build is still
 * understood rather than being misjudged as corrupt. Returns null on any
 * read/parse failure (the caller treats that as stale).
 */
function readLockHolder(lockPath: string): { pid: number; token: string } | null {
  try {
    const raw = readFileSync(lockPath, 'utf-8').trim();
    if (!raw) return null;
    if (raw.startsWith('{')) {
      const parsed = JSON.parse(raw) as { pid?: unknown; token?: unknown };
      const pid = Number(parsed.pid);
      if (!Number.isFinite(pid)) return null;
      return { pid, token: typeof parsed.token === 'string' ? parsed.token : '' };
    }
    const [pidStr] = raw.split(/\s+/);
    const pid = Number(pidStr);
    if (!Number.isFinite(pid)) return null;
    return { pid, token: '' };
  } catch {
    return null;
  }
}

/** A lock file's identity (inode) plus the staleness verdict passed on it. */
interface LockVerdict {
  readonly stale: boolean;
  readonly ino: number;
  readonly dev: number;
}

/**
 * Judge the lock currently at `lockPath`, returning its identity alongside the
 * verdict so a takeover can prove it moved the exact file it judged. Returns
 * null when the lock vanished between the failed create and this check,
 * there is nothing to take over, so the caller just retries the create.
 */
function inspectLock(lockPath: string, staleMs: number): LockVerdict | null {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(lockPath);
  } catch {
    return null;
  }
  const holder = readLockHolder(lockPath);
  const stale = !holder || !isPidAlive(holder.pid) || Date.now() - stat.mtimeMs > staleMs;
  return { stale, ino: Number(stat.ino), dev: Number(stat.dev) };
}

/**
 * Drop a takeover ticket that is far older than any real takeover could be
 * (a process that died mid-takeover). Best-effort; a takeover completes in
 * microseconds, so an old ticket is unambiguously abandoned.
 */
function reclaimAbandonedTicket(ticketPath: string, staleMs: number): void {
  try {
    if (Date.now() - statSync(ticketPath).mtimeMs <= staleMs) return;
  } catch {
    return; // gone already
  }
  try {
    unlinkSync(ticketPath);
  } catch {
    // best effort
  }
}

/**
 * The staging-file name prefix both populated-create paths use:
 * `<lock>.new-<pid>-<hex>`. A staging file is meant to live for microseconds,
 * it is created, written, and then either linked/renamed onto the lock path or
 * unlinked, but a process killed between the `openSync(…,'wx')` and the
 * `linkSync`/`unlinkSync` pair leaves one behind with nothing to clean it up.
 */
function stagingPrefix(lockPath: string): string {
  return `${basename(lockPath)}.new-`;
}

/** A fresh, collision-proof staging path for `lockPath` (the only place this name is built). */
function newStagingPath(lockPath: string): string {
  return join(dirname(lockPath), `${stagingPrefix(lockPath)}${process.pid}-${randomBytes(6).toString('hex')}`);
}

/**
 * Remember when each lock directory was last swept for staging litter, so an
 * acquire-heavy workload does not pay a readdir per acquire. Bounded by the
 * number of distinct lock paths a process touches (one per checkpoint store).
 */
const lastStagingSweepAt = new Map<string, number>();

/**
 * Reclaim orphaned staging files left by a process that died mid-create.
 *
 * Safety rests entirely on the age threshold: another process's IN-FLIGHT
 * staging file is at most microseconds old, so reaping only files whose mtime
 * is older than `staleMs` (the same threshold that judges an abandoned takeover
 * ticket) can never delete a staging file someone is about to link. ENOENT is
 * success, another sweep, or the owner itself, got there first. Best-effort
 * throughout: this is litter collection, never a correctness requirement.
 */
function reclaimAbandonedStagingFiles(lockPath: string, staleMs: number): void {
  const now = Date.now();
  const lastSweep = lastStagingSweepAt.get(lockPath);
  if (lastSweep !== undefined && now - lastSweep < staleMs) return;
  lastStagingSweepAt.set(lockPath, now);

  const dir = dirname(lockPath);
  const prefix = stagingPrefix(lockPath);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return; // directory gone or unreadable — nothing to sweep
  }
  let reclaimed = 0;
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs <= staleMs) continue; // possibly in flight — leave it
    } catch {
      continue; // vanished between listing and stat
    }
    try {
      unlinkSync(path);
      reclaimed += 1;
    } catch (error) {
      // ENOENT is success: another sweep already reclaimed it, and the
      // post-state is the one we wanted, it is simply not ours to count.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn('cross-process-lock: could not reclaim an abandoned staging file', {
          lockPath,
          error: summarizeError(error),
        });
      }
    }
  }
  if (reclaimed > 0) {
    logger.debug('cross-process-lock: reclaimed abandoned staging files', { lockPath, reclaimed });
  }
}

/**
 * Try to take over a lock judged stale (see rule 2 in the module header).
 * Returns the open descriptor of the lock file this process now owns, or null
 * when the takeover did not happen (another process is taking over, the lock
 * turned out to be live after all, or the lock vanished and a plain create
 * should be retried instead). Never throws.
 */
function tryTakeOverStaleLock(lockPath: string, staleMs: number, token: string): number | null {
  const ticketPath = `${lockPath}.takeover`;
  let ticketFd: number;
  try {
    ticketFd = openSync(ticketPath, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') reclaimAbandonedTicket(ticketPath, staleMs);
    return null; // someone else is taking over right now; retry the normal path
  }

  let stagingPath: string | undefined;
  try {
    try {
      writeSync(ticketFd, `${process.pid} ${Date.now()}`);
    } catch {
      // The ticket's content is diagnostic only; its existence is the mutex.
    }

    // Re-judge under the ticket. A lock that is gone is NOT taken over: the
    // path is free, so another waiter's plain create may land at any moment
    // and replacing it would hand out a second holder. Retry the plain create.
    const verdict = inspectLock(lockPath, staleMs);
    if (!verdict || !verdict.stale) return null;

    stagingPath = newStagingPath(lockPath);
    const fd = openSync(stagingPath, 'wx');
    try {
      writeLockPayload(fd, token);
      // Prove the lock is STILL the file we judged, immediately before
      // replacing it.
      //
      // The ticket serializes takeovers against each other, but not against
      // the plain-create path: between the verdict above and this rename, the
      // stale holder can release and another waiter's `open(…,'wx')` can land a
      // fresh, live lock. Renaming over that hands out a second holder, and
      // both processes then believe they hold it, which is exactly what the
      // eight-process contention test caught, as a genuine millisecond-scale
      // overlap between two different pids.
      //
      // inspectLock already returns the inode identity for this purpose. The
      // check simply was not made, so the window spanned a staging create and a
      // payload write; it is now a stat immediately followed by the rename.
      const current = inspectLock(lockPath, staleMs);
      if (!current || current.ino !== verdict.ino || current.dev !== verdict.dev) {
        // Someone replaced it. Not ours to take: retry the ordinary path.
        try {
          closeSync(fd);
        } catch { /* best effort */ }
        return null;
      }
      // Atomic replace: the lock path goes straight from the stale file to
      // ours, never through "absent". No third waiter can slip a create in.
      renameSync(stagingPath, lockPath);
      stagingPath = undefined;
      return fd;
    } catch (error) {
      try {
        closeSync(fd);
      } catch { /* best effort */ }
      logger.warn('cross-process-lock: stale-lock takeover failed', { lockPath, error: summarizeError(error) });
      return null;
    }
  } finally {
    if (stagingPath) {
      try {
        unlinkSync(stagingPath);
      } catch { /* best effort */ }
    }
    try {
      closeSync(ticketFd);
    } catch { /* best effort */ }
    try {
      unlinkSync(ticketPath);
    } catch { /* best effort */ }
  }
}

/** Write this process's ownership payload into a freshly-opened lock fd. */
function writeLockPayload(fd: number, token: string): void {
  writeSync(fd, JSON.stringify({ pid: process.pid, token, acquiredAt: Date.now() }));
}

/** Latched once a filesystem proves it cannot hardlink, so the fallback is not re-probed per acquire. */
let hardlinkUnsupported = false;

/**
 * Create the lock file with its payload ALREADY IN IT, atomically: write a
 * staging file, then `link()` it to the lock path (create-if-absent, so a
 * concurrent holder is never clobbered), then drop the staging name.
 *
 * Why not simply `open(lockPath, 'wx')` and write afterwards: that publishes a
 * ZERO-BYTE lock file for the instant between create and write, and a waiter
 * that reads it in that instant sees an unreadable payload, which is exactly
 * the "corrupt, therefore stale" signal, and takes over a lock that was just
 * legitimately acquired. Two holders. Populating before publishing removes the
 * window entirely.
 *
 * Returns the open descriptor of the lock file this process now owns, or null
 * when someone else holds the lock (EEXIST, ordinary contention).
 */
function createLockAtomically(lockPath: string, token: string): number | null {
  if (hardlinkUnsupported) return createLockDirectly(lockPath, token);

  const stagingPath = newStagingPath(lockPath);
  let fd: number;
  try {
    fd = openSync(stagingPath, 'wx');
  } catch {
    return null; // staging name collided (astronomically unlikely) — just retry
  }
  try {
    writeLockPayload(fd, token);
    linkSync(stagingPath, lockPath);
  } catch (error) {
    try {
      closeSync(fd);
    } catch { /* best effort */ }
    try {
      unlinkSync(stagingPath);
    } catch { /* best effort */ }
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return null; // someone else holds it
    if (code === 'EPERM' || code === 'ENOSYS' || code === 'EOPNOTSUPP' || code === 'EXDEV') {
      // A filesystem without hardlinks (exFAT and friends). Fall back to the
      // plain create, it reintroduces the tiny zero-byte window described
      // above, which is the best an FS with no atomic populated-create offers.
      hardlinkUnsupported = true;
      logger.warn('cross-process-lock: filesystem does not support hardlinks, falling back to plain lock creation', {
        lockPath,
        error: summarizeError(error),
      });
      return createLockDirectly(lockPath, token);
    }
    throw error;
  }
  try {
    unlinkSync(stagingPath);
  } catch { /* best effort — the lock path is the authoritative name */ }
  return fd;
}

/** The no-hardlink fallback: plain O_CREAT|O_EXCL create, then write. */
function createLockDirectly(lockPath: string, token: string): number | null {
  let fd: number;
  try {
    fd = openSync(lockPath, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw error;
  }
  try {
    writeLockPayload(fd, token);
  } catch (error) {
    try {
      closeSync(fd);
    } catch { /* best effort */ }
    try {
      unlinkSync(lockPath);
    } catch { /* best effort */ }
    throw error;
  }
  return fd;
}

/** Touch a held lock's mtime through its own descriptor, so age-based staleness tracks liveness. */
function refreshLockMtime(fd: number): void {
  try {
    const nowSeconds = Date.now() / 1000;
    futimesSync(fd, nowSeconds, nowSeconds);
  } catch {
    // Best effort: if the lock was already taken over, the descriptor points
    // at a file that is no longer at the lock path and touching it is a no-op.
  }
}

/**
 * In-process waiters, keyed by lock path. The file lock alone cannot serialize
 * acquisitions from WITHIN one process: a second acquisition here sees a lock
 * whose pid is alive (its own) and whose mtime the first holder's refresh
 * timer keeps fresh, never stale, so it can only wait out `totalTimeoutMs`
 * and fail. Two checkpoint managers over one store in one process (a daemon
 * host plus a runtime, or two test fixtures) is a legitimate shape, so
 * same-process acquisitions queue FIFO here and only the queue head ever
 * contends on the file. The map entry is removed when its queue drains, so
 * the map stays bounded by concurrently-locked paths.
 */
const inProcessTails = new Map<string, Promise<void>>();

/**
 * Acquire the cross-process lock at `lockPath`, retrying with capped
 * exponential backoff while it is held (and not stale) by another process.
 * Same-process acquisitions of one path queue in order rather than contending
 * (see `inProcessTails`). Returns a release function; the caller MUST call it
 * (typically in a `finally`) even if the protected work throws. Release is
 * idempotent, and only ever deletes a lock file this call actually owns.
 *
 * Throws if the lock cannot be acquired within `totalTimeoutMs`, counted
 * from entry, spanning both the in-process queue wait and the file
 * acquisition, a wedged lock this function itself declines to take over
 * (still fresh, still owned by a live pid) must surface as an honest
 * failure, not a silent hang.
 */
export async function acquireCrossProcessLock(
  lockPath: string,
  options: CrossProcessLockOptions = {},
): Promise<() => void> {
  const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const entered = Date.now();

  const prior = inProcessTails.get(lockPath) ?? Promise.resolve();
  let releaseSlot!: () => void;
  const slot = new Promise<void>((r) => {
    releaseSlot = r;
  });
  const tail = prior.then(() => slot);
  inProcessTails.set(lockPath, tail);
  const dropTailIfOurs = () => {
    if (inProcessTails.get(lockPath) === tail) inProcessTails.delete(lockPath);
  };

  // Wait for earlier in-process holders, but never past the deadline. On
  // timeout the slot resolves immediately so later waiters are not wedged
  // behind a acquisition that never happened.
  const deadline = cancellableSleep(totalTimeoutMs);
  let queueOutcome: 'ready' | 'timeout';
  try {
    queueOutcome = await Promise.race([
      prior.then(() => 'ready' as const),
      deadline.promise.then(() => 'timeout' as const),
    ]);
  } finally {
    // Whichever side won, the deadline handle is done with. Without this the
    // common case, `prior` already resolved, strands a full-length timer on
    // every single acquisition.
    deadline.cancel();
  }
  if (queueOutcome === 'timeout') {
    releaseSlot();
    dropTailIfOurs();
    throw new Error(
      `cross-process-lock: timed out after ${totalTimeoutMs}ms waiting for lock at "${lockPath}" (queued behind this process's own holder)`,
    );
  }

  try {
    const remainingMs = Math.max(1, totalTimeoutMs - (Date.now() - entered));
    const releaseFile = await acquireFileLock(lockPath, { ...options, totalTimeoutMs: remainingMs });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try {
        releaseFile();
      } finally {
        releaseSlot();
        dropTailIfOurs();
      }
    };
  } catch (error) {
    releaseSlot();
    dropTailIfOurs();
    throw error;
  }
}

/** The file-level half of acquisition: only ever entered by one caller per path per process. */
async function acquireFileLock(
  lockPath: string,
  options: CrossProcessLockOptions = {},
): Promise<() => void> {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  let backoffMs = options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
  const refreshMs = Math.min(MAX_REFRESH_MS, Math.max(MIN_REFRESH_MS, Math.floor(staleMs / 3)));

  mkdirSync(dirname(lockPath), { recursive: true });
  // Housekeeping on the way in: drop staging files abandoned by a process that
  // died mid-create. Throttled to once per staleMs per lock path, and only ever
  // touches files older than staleMs, so a concurrent acquire's in-flight
  // staging file is never at risk.
  reclaimAbandonedStagingFiles(lockPath, staleMs);

  const start = Date.now();
  const token = randomBytes(8).toString('hex');
  for (;;) {
    // `fd` is the descriptor of the lock file we now own, from a plain
    // create, or from a takeover's atomic replace. It stays open for the
    // lock's lifetime: it is both the refresh handle (futimes) and the
    // ownership proof (inode).
    let fd = createLockAtomically(lockPath, token);
    if (fd === null) {
      if (Date.now() - start >= totalTimeoutMs) {
        throw new Error(
          `cross-process-lock: timed out after ${totalTimeoutMs}ms waiting for lock at "${lockPath}"`,
        );
      }

      const verdict = inspectLock(lockPath, staleMs);
      if (!verdict) continue; // vanished — retry the create immediately
      if (verdict.stale) fd = tryTakeOverStaleLock(lockPath, staleMs, token);
      if (fd === null) {
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
        continue;
      }
    }

    const refreshTimer = setInterval(() => refreshLockMtime(fd), refreshMs);
    refreshTimer.unref?.();

    let released = false;
    return () => {
      if (released) return;
      released = true;
      clearInterval(refreshTimer);

      let owned: { ino: number; dev: number } | null = null;
      try {
        const mine = fstatSync(fd);
        owned = { ino: Number(mine.ino), dev: Number(mine.dev) };
      } catch {
        owned = null;
      }
      try {
        closeSync(fd);
      } catch { /* best effort */ }

      try {
        const onDisk = statSync(lockPath);
        if (!owned || Number(onDisk.ino) !== owned.ino || Number(onDisk.dev) !== owned.dev) {
          // Someone took this lock over while we held it (we ran longer than
          // staleMs without refreshing, or the file was replaced by hand).
          // The file at the lock path belongs to the current holder, leave it.
          logger.warn('cross-process-lock: release skipped, the lock file is no longer the one we created', { lockPath });
          return;
        }
        unlinkSync(lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; // already reclaimed; nothing to do
        logger.warn('cross-process-lock: release failed (best-effort)', {
          lockPath,
          error: summarizeError(error),
        });
      }
    };
  }
}
