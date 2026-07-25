/**
 * Pending work proposals — the state half of the conversation-first gate.
 *
 * A proposal outlives the turn that created it (the owner may answer minutes
 * later from a phone), so it gets the standing housekeeping treatment:
 *
 * - bounded: a hard cap on simultaneously pending proposals, oldest evicted
 * - expiring: every record carries an absolute expiry; an expired proposal is
 *   not answerable, it is reported as expired
 * - content-validated: the persisted file is untrusted input; a malformed
 *   record is dropped and counted rather than throwing or being trusted
 * - reaped on recovery: the load path validates then immediately reaps, and a
 *   periodic sweep keeps a long-lived daemon from only cleaning up at boot
 * - disclosed: {@link WorkProposalStore.disclose} reports what was dropped and
 *   why, so a silently vanished proposal is never a mystery
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

export const WORK_PROPOSAL_SCHEMA_VERSION = 1;

/** How often a long-lived store re-sweeps for expired proposals. */
export const WORK_PROPOSAL_SWEEP_INTERVAL_MS = 5 * 60_000;

export type WorkProposalStatus = 'pending' | 'accepted' | 'declined' | 'expired';

export interface WorkProposalRecord {
  readonly id: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly status: WorkProposalStatus;
  /** The channel the proposal was sent over — agreement must arrive here. */
  readonly surfaceKind: string;
  readonly surfaceId?: string | undefined;
  readonly routeId?: string | undefined;
  readonly externalId?: string | undefined;
  readonly threadId?: string | undefined;
  readonly channelId?: string | undefined;
  readonly userId?: string | undefined;
  readonly sessionId?: string | undefined;
  /** The prompt that would be spawned if the owner agrees. */
  readonly task: string;
  /** One short line naming the work, for the proposal message. */
  readonly summary: string;
}

export interface WorkProposalReapSummary {
  readonly expired: number;
  readonly overCap: number;
  readonly malformed: number;
  readonly resolved: number;
  readonly total: number;
}

export const EMPTY_WORK_PROPOSAL_REAP_SUMMARY: WorkProposalReapSummary = {
  expired: 0,
  overCap: 0,
  malformed: 0,
  resolved: 0,
  total: 0,
};

interface PersistedFile {
  readonly version: number;
  readonly proposals: readonly WorkProposalRecord[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

const STATUSES: readonly WorkProposalStatus[] = ['pending', 'accepted', 'declined', 'expired'];

/** Cap on a single field so a hostile payload cannot bloat the store. */
const MAX_TASK_LENGTH = 8_000;
const MAX_SUMMARY_LENGTH = 200;

/**
 * Validate one persisted entry. Returns null (never throws) for anything that
 * is not a well-formed proposal, so one bad record cannot take out the file.
 */
export function validateWorkProposal(value: unknown): WorkProposalRecord | null {
  if (!isRecord(value)) return null;
  const id = optionalString(value.id);
  const task = optionalString(value.task);
  const surfaceKind = optionalString(value.surfaceKind);
  if (!id || !task || !surfaceKind) return null;
  if (task.length > MAX_TASK_LENGTH) return null;
  const createdAt = value.createdAt;
  const expiresAt = value.expiresAt;
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt)) return null;
  if ((expiresAt as number) <= (createdAt as number)) return null;
  const status = STATUSES.includes(value.status as WorkProposalStatus)
    ? (value.status as WorkProposalStatus)
    : 'pending';
  const summary = optionalString(value.summary) ?? task.slice(0, MAX_SUMMARY_LENGTH);
  return {
    id,
    createdAt: createdAt as number,
    expiresAt: expiresAt as number,
    status,
    surfaceKind,
    task,
    summary: summary.slice(0, MAX_SUMMARY_LENGTH),
    ...(optionalString(value.surfaceId) ? { surfaceId: optionalString(value.surfaceId) } : {}),
    ...(optionalString(value.routeId) ? { routeId: optionalString(value.routeId) } : {}),
    ...(optionalString(value.externalId) ? { externalId: optionalString(value.externalId) } : {}),
    ...(optionalString(value.threadId) ? { threadId: optionalString(value.threadId) } : {}),
    ...(optionalString(value.channelId) ? { channelId: optionalString(value.channelId) } : {}),
    ...(optionalString(value.userId) ? { userId: optionalString(value.userId) } : {}),
    ...(optionalString(value.sessionId) ? { sessionId: optionalString(value.sessionId) } : {}),
  };
}

export interface WorkProposalStoreOptions {
  /** Absent = memory only (tests, isolated contexts). */
  readonly storePath?: string | undefined;
  readonly maxPending?: number | undefined;
  readonly now?: (() => number) | undefined;
}

export interface CreateWorkProposalInput {
  readonly surfaceKind: string;
  readonly task: string;
  readonly summary: string;
  readonly ttlMs: number;
  readonly surfaceId?: string | undefined;
  readonly routeId?: string | undefined;
  readonly externalId?: string | undefined;
  readonly threadId?: string | undefined;
  readonly channelId?: string | undefined;
  readonly userId?: string | undefined;
  readonly sessionId?: string | undefined;
}

export class WorkProposalStore {
  private readonly proposals = new Map<string, WorkProposalRecord>();
  private readonly storePath: string | undefined;
  private readonly maxPending: number;
  private readonly now: () => number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private sweepInterval = WORK_PROPOSAL_SWEEP_INTERVAL_MS;
  private lastReap: WorkProposalReapSummary = EMPTY_WORK_PROPOSAL_REAP_SUMMARY;
  private loadMalformed = 0;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: WorkProposalStoreOptions = {}) {
    this.storePath = options.storePath;
    this.maxPending = Math.max(1, options.maxPending ?? 20);
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Load, validate, and reap. Fail-safe: an unreadable or corrupt store means
   * no pending proposals, never a crash — the worst case is that the owner
   * has to ask again, which is strictly better than answering a bad record.
   */
  async init(): Promise<WorkProposalReapSummary> {
    if (this.storePath) {
      try {
        const text = await readFile(this.storePath, 'utf-8');
        const parsed: unknown = JSON.parse(text);
        if (isRecord(parsed) && Array.isArray(parsed.proposals)) {
          const file = parsed as unknown as PersistedFile;
          if (file.version === WORK_PROPOSAL_SCHEMA_VERSION) {
            for (const entry of parsed.proposals) {
              const record = validateWorkProposal(entry);
              if (!record) {
                this.loadMalformed += 1;
                continue;
              }
              this.proposals.set(record.id, record);
            }
          } else {
            logger.info('WorkProposalStore: dropping proposals written by a different schema version', {
              found: file.version,
              expected: WORK_PROPOSAL_SCHEMA_VERSION,
            });
          }
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (code !== 'ENOENT') {
          logger.warn('WorkProposalStore: unreadable store; starting empty', { error: summarizeError(error) });
        }
      }
    }
    const summary = this.reap();
    this.startSweep();
    return summary;
  }

  /**
   * Begin the periodic expiry sweep. Idempotent, and only ever running while
   * something is actually pending — a daemon with no open proposals carries no
   * timer at all, and the sweep stops itself once the last one is resolved or
   * expires. That is what lets the store need no external disposal hook.
   */
  startSweep(intervalMs = WORK_PROPOSAL_SWEEP_INTERVAL_MS): void {
    if (this.sweepTimer) return;
    this.sweepInterval = intervalMs;
    if (!this.hasPending()) return;
    this.sweepTimer = setInterval(() => {
      const summary = this.reap();
      if (summary.total > 0) void this.persist();
      if (!this.hasPending()) this.dispose();
    }, intervalMs);
    this.sweepTimer.unref?.();
  }

  private hasPending(): boolean {
    for (const record of this.proposals.values()) {
      if (record.status === 'pending') return true;
    }
    return false;
  }

  dispose(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  create(input: CreateWorkProposalInput): WorkProposalRecord {
    this.reap();
    const createdAt = this.now();
    const record: WorkProposalRecord = {
      id: `wp_${randomUUID()}`,
      createdAt,
      expiresAt: createdAt + Math.max(1, input.ttlMs),
      status: 'pending',
      surfaceKind: input.surfaceKind,
      task: input.task.slice(0, MAX_TASK_LENGTH),
      summary: input.summary.slice(0, MAX_SUMMARY_LENGTH),
      ...(input.surfaceId ? { surfaceId: input.surfaceId } : {}),
      ...(input.routeId ? { routeId: input.routeId } : {}),
      ...(input.externalId ? { externalId: input.externalId } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.channelId ? { channelId: input.channelId } : {}),
      ...(input.userId ? { userId: input.userId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    };
    this.proposals.set(record.id, record);
    this.startSweep(this.sweepInterval);
    const overCap = this.enforceCap();
    if (overCap > 0) {
      // Disclose the eviction: a proposal that vanished because the cap was
      // reached must be visible in the housekeeping report, not silent.
      this.lastReap = {
        ...this.lastReap,
        overCap: this.lastReap.overCap + overCap,
        total: this.lastReap.total + overCap,
      };
    }
    void this.persist();
    return record;
  }

  get(id: string): WorkProposalRecord | null {
    this.reap();
    return this.proposals.get(id) ?? null;
  }

  /**
   * Pending proposals, newest first, optionally narrowed to one surface. The
   * reap runs first so an expired proposal is never returned as answerable.
   */
  listPending(filter: { readonly surfaceKind?: string | undefined; readonly userId?: string | undefined } = {}): WorkProposalRecord[] {
    this.reap();
    return [...this.proposals.values()]
      .filter((record) => record.status === 'pending')
      .filter((record) => !filter.surfaceKind || record.surfaceKind === filter.surfaceKind)
      .filter((record) => !filter.userId || !record.userId || record.userId === filter.userId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Resolve a proposal. Returns null when the id is unknown or the proposal is
   * no longer pending — an already-answered or expired proposal cannot be
   * answered a second time.
   */
  resolve(id: string, outcome: 'accepted' | 'declined'): WorkProposalRecord | null {
    this.reap();
    const record = this.proposals.get(id);
    if (!record || record.status !== 'pending') return null;
    const resolved: WorkProposalRecord = { ...record, status: outcome };
    this.proposals.set(id, resolved);
    void this.persist();
    return resolved;
  }

  /**
   * Drop expired, resolved, and over-cap records. Pure with respect to I/O —
   * the caller persists. Safe to call on every read path.
   */
  reap(): WorkProposalReapSummary {
    const now = this.now();
    let expired = 0;
    let resolved = 0;
    for (const [id, record] of this.proposals) {
      if (record.status !== 'pending') {
        // Resolved records are kept only long enough to answer a duplicate
        // reply arriving right behind the first one.
        if (now - record.createdAt > record.expiresAt - record.createdAt) {
          this.proposals.delete(id);
          resolved += 1;
        }
        continue;
      }
      if (record.expiresAt <= now) {
        this.proposals.delete(id);
        expired += 1;
      }
    }
    const overCap = this.enforceCap();
    const summary: WorkProposalReapSummary = {
      expired,
      overCap,
      malformed: this.loadMalformed,
      resolved,
      total: expired + overCap + this.loadMalformed + resolved,
    };
    this.loadMalformed = 0;
    if (summary.total > 0) {
      this.lastReap = {
        expired: this.lastReap.expired + summary.expired,
        overCap: this.lastReap.overCap + summary.overCap,
        malformed: this.lastReap.malformed + summary.malformed,
        resolved: this.lastReap.resolved + summary.resolved,
        total: this.lastReap.total + summary.total,
      };
    }
    return summary;
  }

  /** Cumulative housekeeping disclosure — what was dropped and why. */
  disclose(): { readonly pending: number; readonly tracked: number; readonly reaped: WorkProposalReapSummary } {
    return {
      pending: [...this.proposals.values()].filter((record) => record.status === 'pending').length,
      tracked: this.proposals.size,
      reaped: this.lastReap,
    };
  }

  private enforceCap(): number {
    const pending = [...this.proposals.values()]
      .filter((record) => record.status === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt);
    if (pending.length <= this.maxPending) return 0;
    const excess = pending.slice(0, pending.length - this.maxPending);
    for (const record of excess) this.proposals.delete(record.id);
    return excess.length;
  }

  /** Best-effort durable write, serialized so concurrent resolves cannot interleave. */
  private persist(): Promise<void> {
    const path = this.storePath;
    if (!path) return Promise.resolve();
    const snapshot: PersistedFile = {
      version: WORK_PROPOSAL_SCHEMA_VERSION,
      proposals: [...this.proposals.values()],
    };
    this.writeChain = this.writeChain.then(async () => {
      try {
        await mkdir(dirname(path), { recursive: true });
        const temp = `${path}.tmp`;
        await writeFile(temp, JSON.stringify(snapshot, null, 2), 'utf-8');
        await rename(temp, path);
      } catch (error) {
        logger.warn('WorkProposalStore: persist failed', { error: summarizeError(error) });
      }
    });
    return this.writeChain;
  }

  /** Test seam: await any in-flight write. */
  async flush(): Promise<void> {
    await this.writeChain;
  }
}
