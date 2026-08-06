/**
 * home-single-writer.ts — one live process per surface home, checked at boot.
 *
 * ── The failure this closes ────────────────────────────────────────────────
 *
 * A turn forked a SECOND full agent onto the home a live agent was already
 * running out of (`python -c 'pty.fork()'` then `execvp goodvibes-agent`). Two
 * processes then owned one `.goodvibes/agent/` tree: two writers over the same
 * session files, the same state store, the same transcript — which is how a
 * temp-file race killed a process, and how a ghost session was left marked
 * "active" by a writer that no longer existed.
 *
 * Nothing refused, because nothing was asking. A surface home had no notion of
 * an owner at all: whoever opened it, owned it, and the second opener was
 * indistinguishable from the first.
 *
 * ── What this is, and what it is not ───────────────────────────────────────
 *
 * This is the PROCESS-level guard: at boot, a surface claims its home, and a
 * second live process claiming the same home is REFUSED with a message naming
 * the pid that holds it. It is not a mutex around a write and it does not wait
 * — waiting is the wrong answer to "another copy of me is already running", and
 * a boot that hangs is worse than a boot that says why it stopped.
 *
 * The STORE-level half — serializing two writers of one JSON file so neither
 * tears the other's write — is a different layer with a different answer
 * (`acquireCrossProcessLock`, and the atomic-store work alongside it). Both are
 * wanted; neither substitutes for the other. A single-writer boot guard cannot
 * help a daemon and a CLI legitimately sharing a file, and a write lock cannot
 * stop a second agent from existing.
 *
 * ── How ownership is decided ───────────────────────────────────────────────
 *
 * The claim is a small JSON record at `<home>/.goodvibes/<surface>/owner.json`
 * carrying the pid, when it was claimed, and an identity string. A claim is
 * LIVE when its pid is still alive AND that pid still looks like the same
 * program (its argv, read from `/proc/<pid>/cmdline` on Linux, still matches
 * the recorded identity). The second half is what keeps a recycled pid from
 * producing a refusal that names a process which has nothing to do with us —
 * a false refusal at boot is a product that will not start, so the check errs
 * toward letting the boot proceed.
 *
 * Everything the decision needs is passed in, so the whole rule is exercisable
 * without spawning a process or writing a file: {@link decideHomeClaim} is
 * pure, and {@link claimSurfaceHome} is the thin filesystem shell around it.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

/** The record written to the claim file. */
export interface HomeOwnerClaim {
  readonly pid: number;
  /** Epoch millis the claim was written. */
  readonly claimedAt: number;
  /**
   * A short, stable description of the program holding the home — the argv of
   * the process that claimed it. Compared against the CURRENT argv of that pid
   * so a recycled pid does not masquerade as a live holder.
   */
  readonly identity: string;
}

/** What {@link decideHomeClaim} was asked. */
export interface HomeClaimInput {
  /** The claim currently on disk, or null when the home is unclaimed. */
  readonly existing: HomeOwnerClaim | null;
  /** This process's pid. */
  readonly pid: number;
  /** This process's identity string. */
  readonly identity: string;
  /**
   * The identity of the pid recorded in `existing`, as it looks RIGHT NOW, or
   * null when that pid is not alive (or cannot be read). Null ⇒ nothing holds
   * the home.
   */
  readonly holderIdentityNow: string | null;
}

/** The verdict. */
export type HomeClaimDecision =
  /** The home is ours to take; write the claim. */
  | { readonly outcome: 'claim' }
  /** We already hold it (same pid). Nothing to write; nothing to refuse. */
  | { readonly outcome: 'already-held' }
  /** Another live process holds it. `message` is the plain refusal. */
  | { readonly outcome: 'refuse'; readonly holderPid: number; readonly message: string };

/**
 * How a refusal reads. Names the pid, the home, and what to do — a message
 * that only says "already running" leaves the person with no next step.
 */
export function homeClaimRefusalMessage(input: {
  readonly holderPid: number;
  readonly surfaceRoot: string;
  readonly homePath: string;
  readonly claimedAt: number;
}): string {
  return [
    `Refusing to start: this ${input.surfaceRoot} home is already owned by a live process.`,
    `  home: ${input.homePath}`,
    `  owner pid: ${input.holderPid} (claimed ${new Date(input.claimedAt).toISOString()})`,
    'Two processes writing one home is what corrupts sessions and leaves ghost "active"',
    'entries behind, so this one is stopping instead.',
    `Use the process that is already running, or stop it (pid ${input.holderPid}) and start again.`,
  ].join('\n');
}

/**
 * Decide whether this process may claim the home. Pure.
 *
 * The bias is deliberate and one-directional: every uncertainty resolves to
 * `claim`. An unreadable claim, a dead pid, a pid whose identity no longer
 * matches — all of those mean nothing is holding the home, because refusing a
 * boot on a stale record is a product that will not start for a reason that is
 * not true.
 */
export function decideHomeClaim(input: HomeClaimInput, options?: {
  readonly surfaceRoot?: string | undefined;
  readonly homePath?: string | undefined;
}): HomeClaimDecision {
  const existing = input.existing;
  if (!existing) return { outcome: 'claim' };
  if (existing.pid === input.pid) return { outcome: 'already-held' };
  if (input.holderIdentityNow === null) return { outcome: 'claim' };
  // A pid that is alive but is now some OTHER program is a recycled pid, not a
  // second copy of us.
  if (input.holderIdentityNow !== existing.identity) return { outcome: 'claim' };
  return {
    outcome: 'refuse',
    holderPid: existing.pid,
    message: homeClaimRefusalMessage({
      holderPid: existing.pid,
      surfaceRoot: options?.surfaceRoot ?? 'goodvibes',
      homePath: options?.homePath ?? '(unknown)',
      claimedAt: existing.claimedAt,
    }),
  };
}

/** Where a surface's claim file lives. */
export function surfaceHomeClaimPath(homeDirectory: string, surfaceRoot: string): string {
  return join(homeDirectory, '.goodvibes', surfaceRoot, 'owner.json');
}

/**
 * This process's identity string: its argv, joined. Short, stable for the life
 * of the process, and comparable against what `/proc` reports for a pid.
 */
export function currentProcessIdentity(argv: readonly string[] = process.argv): string {
  return argv.join(' ').slice(0, 512);
}

/**
 * The identity of a live pid, or null when it is not alive / not readable.
 *
 * Linux reads `/proc/<pid>/cmdline` (NUL-separated argv). Everywhere else there
 * is no portable way to read another process's argv without spawning, and this
 * runs at boot — so the answer is null, which resolves to `claim`. On those
 * hosts the guard degrades to "pid liveness is not proof", which is honest: it
 * refuses nothing rather than refusing on a guess.
 */
export function readProcessIdentity(pid: number): string | null {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
  } catch (error) {
    // EPERM means it exists but is not ours to signal — still alive.
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') return null;
  }
  if (process.platform !== 'linux') return null;
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
    const argv = raw.split('\0').filter((part) => part !== '');
    if (argv.length === 0) return null;
    return argv.join(' ').slice(0, 512);
  } catch {
    return null;
  }
}

/** Read the claim on disk, or null when there is none / it is unreadable. */
function readClaim(path: string): HomeOwnerClaim | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<HomeOwnerClaim>;
    const pid = Number(parsed.pid);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    return {
      pid,
      claimedAt: Number.isFinite(Number(parsed.claimedAt)) ? Number(parsed.claimedAt) : 0,
      identity: typeof parsed.identity === 'string' ? parsed.identity : '',
    };
  } catch {
    return null;
  }
}

/** Raised when another live process already owns this home. */
export class SurfaceHomeInUseError extends Error {
  readonly holderPid: number;
  constructor(message: string, holderPid: number) {
    super(message);
    this.name = 'SurfaceHomeInUseError';
    this.holderPid = holderPid;
  }
}

/** What a successful claim hands back. */
export interface SurfaceHomeClaim {
  /** The file this process now owns. */
  readonly path: string;
  /** Drop the claim. Idempotent, and only ever removes a claim this process wrote. */
  release(): void;
}

/**
 * How many live holders this process has per claim path.
 *
 * One process may legitimately compose several graphs over one home — the
 * daemon builds a workspace floor per hosted workspace, all under its own home
 * and its own pid. Those are `already-held`, and the first of them to be
 * disposed must not delete a claim the others are still standing on. Counted,
 * so the file goes away when the LAST holder in this process releases.
 */
const heldClaims = new Map<string, number>();

export interface ClaimSurfaceHomeOptions {
  readonly homeDirectory: string;
  readonly surfaceRoot: string;
  /** Seams for tests; the real ones are the defaults. */
  readonly pid?: number | undefined;
  readonly identity?: string | undefined;
  readonly identityOf?: ((pid: number) => string | null) | undefined;
  readonly now?: (() => number) | undefined;
}

/**
 * Claim this surface's home for this process, or refuse.
 *
 * @throws SurfaceHomeInUseError when another live process holds it. The message
 *   names the holding pid and is written to be shown to a person as-is.
 */
export function claimSurfaceHome(options: ClaimSurfaceHomeOptions): SurfaceHomeClaim {
  const pid = options.pid ?? process.pid;
  const identity = options.identity ?? currentProcessIdentity();
  const identityOf = options.identityOf ?? readProcessIdentity;
  const now = options.now ?? Date.now;
  const path = surfaceHomeClaimPath(options.homeDirectory, options.surfaceRoot);

  const existing = readClaim(path);
  const decision = decideHomeClaim(
    {
      existing,
      pid,
      identity,
      holderIdentityNow: existing && existing.pid !== pid ? identityOf(existing.pid) : null,
    },
    { surfaceRoot: options.surfaceRoot, homePath: path },
  );

  if (decision.outcome === 'refuse') {
    throw new SurfaceHomeInUseError(decision.message, decision.holderPid);
  }

  heldClaims.set(path, (heldClaims.get(path) ?? 0) + 1);
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    const remaining = (heldClaims.get(path) ?? 1) - 1;
    if (remaining > 0) {
      heldClaims.set(path, remaining);
      return; // another graph in this process is still standing on it
    }
    heldClaims.delete(path);
    // Only ever remove a claim this process still owns: a claim that has since
    // been rewritten by someone else belongs to them.
    const onDisk = readClaim(path);
    if (onDisk && onDisk.pid !== pid) return;
    try {
      rmSync(path, { force: true });
    } catch (error) {
      logger.debug('home-single-writer: releasing the home claim failed (best-effort)', {
        path,
        error: summarizeError(error),
      });
    }
  };

  if (decision.outcome === 'already-held') return { path, release };

  const claim: HomeOwnerClaim = { pid, claimedAt: now(), identity };
  try {
    mkdirSync(join(options.homeDirectory, '.goodvibes', options.surfaceRoot), { recursive: true });
    writeFileSync(path, JSON.stringify(claim), 'utf-8');
  } catch (error) {
    // An unwritable home is a problem this guard must not turn into a refusal:
    // the product's own storage layer will report it far better than a boot
    // guard can, and refusing here would block a boot over a guard's own file.
    logger.warn('home-single-writer: could not record the home claim — continuing without it', {
      path,
      error: summarizeError(error),
    });
  }
  return { path, release };
}
