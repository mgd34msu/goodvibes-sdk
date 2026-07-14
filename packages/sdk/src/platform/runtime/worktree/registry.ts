import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { GitService } from '../../git/service.js';
import { resolveScopedDirectory } from '../surface-root.js';
import type { WorktreeSetupResult } from './setup.js';

export type ManagedWorktreeState = 'active' | 'paused' | 'kept' | 'discard' | 'pending-cleanup';
export type ManagedWorktreeKind = 'agent' | 'orchestrator' | 'manual';

export interface ManagedWorktreeMeta {
  readonly path: string;
  readonly kind: ManagedWorktreeKind;
  readonly state: ManagedWorktreeState;
  readonly ownerId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly updatedAt: number;
  /**
   * Cold-start setup outcome for this worktree, when setup ran (on creation or
   * a re-run). Persisted so a failed setup is a VISIBLE worktree/fleet-node
   * state, never silent — surfaces read it straight off the worktree record
   * (worktrees.snapshot). Absent when no setup has ever run for this worktree.
   */
  readonly setup?: WorktreeSetupResult | undefined;
}

interface WorktreeStore {
  readonly version: 1;
  readonly records: Record<string, ManagedWorktreeMeta>;
}

export interface WorktreeStatusRecord extends ManagedWorktreeMeta {
  readonly branch: string;
  readonly head: string;
}

export interface WorktreeOwnershipSummary {
  readonly total: number;
  readonly active: number;
  readonly paused: number;
  readonly kept: number;
  readonly discard: number;
  readonly pendingCleanup: number;
  readonly sessionAttached: number;
  readonly taskAttached: number;
  readonly agentOwned: number;
  readonly orchestratorOwned: number;
  readonly manualOwned: number;
}

export interface WorktreeAttachmentReview {
  readonly targetKind: 'session' | 'task';
  readonly targetId: string;
  readonly total: number;
  readonly active: number;
  readonly paused: number;
  readonly kept: number;
  readonly discard: number;
  readonly pendingCleanup: number;
  readonly records: readonly ManagedWorktreeMeta[];
}

export interface WorktreeRegistryPaths {
  readonly workingDirectory: string;
  readonly surfaceRoot?: string | undefined;
}

function getStorePath(workingDirectory: string, surfaceRoot?: string): string {
  return resolveScopedDirectory(workingDirectory, surfaceRoot, 'worktrees.json');
}

function defaultStore(): WorktreeStore {
  return { version: 1, records: {} };
}

function normalizePath(path: string, workingDirectory: string): string {
  return resolve(workingDirectory, path);
}

function readStore(storePath: string): WorktreeStore {
  try {
    return JSON.parse(readFileSync(storePath, 'utf-8')) as WorktreeStore;
  } catch {
    return defaultStore();
  }
}

export function listPersistedWorktreeMeta(options: WorktreeRegistryPaths): ManagedWorktreeMeta[] {
  return Object.values(readStore(getStorePath(options.workingDirectory, options.surfaceRoot)).records)
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function getPersistedWorktreeMeta(path: string, options: WorktreeRegistryPaths): ManagedWorktreeMeta | null {
  const normalized = normalizePath(path, options.workingDirectory);
  return readStore(getStorePath(options.workingDirectory, options.surfaceRoot)).records[normalized] ?? null;
}

export function reviewWorktreeAttachments(
  targetKind: 'session' | 'task',
  targetId: string,
  options: WorktreeRegistryPaths,
): WorktreeAttachmentReview {
  const records = listPersistedWorktreeMeta(options).filter((record) => (
    targetKind === 'session' ? record.sessionId === targetId : record.taskId === targetId
  ));
  return records.reduce<WorktreeAttachmentReview>((summary, record) => ({
    ...summary,
    total: summary.total + 1,
    active: summary.active + (record.state === 'active' ? 1 : 0),
    paused: summary.paused + (record.state === 'paused' ? 1 : 0),
    kept: summary.kept + (record.state === 'kept' ? 1 : 0),
    discard: summary.discard + (record.state === 'discard' ? 1 : 0),
    pendingCleanup: summary.pendingCleanup + (record.state === 'pending-cleanup' ? 1 : 0),
    records: [...summary.records, record],
  }), {
    targetKind,
    targetId,
    total: 0,
    active: 0,
    paused: 0,
    kept: 0,
    discard: 0,
    pendingCleanup: 0,
    records: [],
  });
}

export function summarizeWorktreeOwnership(records: readonly ManagedWorktreeMeta[]): WorktreeOwnershipSummary {
  return records.reduce<WorktreeOwnershipSummary>((summary, record) => ({
    total: summary.total + 1,
    active: summary.active + (record.state === 'active' ? 1 : 0),
    paused: summary.paused + (record.state === 'paused' ? 1 : 0),
    kept: summary.kept + (record.state === 'kept' ? 1 : 0),
    discard: summary.discard + (record.state === 'discard' ? 1 : 0),
    pendingCleanup: summary.pendingCleanup + (record.state === 'pending-cleanup' ? 1 : 0),
    sessionAttached: summary.sessionAttached + (record.sessionId ? 1 : 0),
    taskAttached: summary.taskAttached + (record.taskId ? 1 : 0),
    agentOwned: summary.agentOwned + (record.kind === 'agent' ? 1 : 0),
    orchestratorOwned: summary.orchestratorOwned + (record.kind === 'orchestrator' ? 1 : 0),
    manualOwned: summary.manualOwned + (record.kind === 'manual' ? 1 : 0),
  }), {
    total: 0,
    active: 0,
    paused: 0,
    kept: 0,
    discard: 0,
    pendingCleanup: 0,
    sessionAttached: 0,
    taskAttached: 0,
    agentOwned: 0,
    orchestratorOwned: 0,
    manualOwned: 0,
  });
}

function writeStore(store: WorktreeStore, storePath: string): void {
  mkdirSync(dirname(storePath), { recursive: true });
  writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`, 'utf-8');
}

function classifyWorktreePath(path: string, workingDirectory: string): Pick<ManagedWorktreeMeta, 'kind' | 'ownerId'> {
  const normalized = normalizePath(path, workingDirectory);
  const agentMatch = normalized.match(/[/\\]\.goodvibes[/\\]\.worktrees[/\\]agent-([^/\\]+)$/);
  if (agentMatch) {
    return { kind: 'agent', ownerId: agentMatch[1] };
  }
  if (normalized.includes(`${join('.goodvibes', '.worktrees')}`)) {
    return { kind: 'orchestrator' };
  }
  return { kind: 'manual' };
}

export class WorktreeRegistry {
  private readonly git: GitService;
  private readonly workingDirectory: string;
  private readonly surfaceRoot?: string | undefined;

  public constructor(workingDirectory: string, options?: { readonly surfaceRoot?: string }) {
    this.workingDirectory = workingDirectory;
    this.surfaceRoot = options?.surfaceRoot;
    this.git = new GitService(workingDirectory);
  }

  public async list(): Promise<WorktreeStatusRecord[]> {
    const store = readStore(getStorePath(this.workingDirectory, this.surfaceRoot));
    const listed = await this.git.worktreeList();
    const present = new Set(listed.map((entry) => normalizePath(entry.path, this.workingDirectory)));
    const records: WorktreeStatusRecord[] = listed.map((entry) => {
      const path = normalizePath(entry.path, this.workingDirectory);
      const meta = store.records[path]!;
      const classified = classifyWorktreePath(path, this.workingDirectory);
      return {
        path,
        branch: entry.branch,
        head: entry.head,
        kind: meta?.kind ?? classified.kind,
        state: meta?.state ?? 'active',
        ...(meta?.ownerId ?? classified.ownerId ? { ownerId: meta?.ownerId ?? classified.ownerId } : {}),
        ...(meta?.sessionId ? { sessionId: meta.sessionId } : {}),
        ...(meta?.taskId ? { taskId: meta.taskId } : {}),
        ...(meta?.setup ? { setup: meta.setup } : {}),
        updatedAt: meta?.updatedAt ?? Date.now(),
      };
    });
    const nextRecords: Record<string, ManagedWorktreeMeta> = {};
    for (const record of records) {
      nextRecords[record.path] = {
        path: record.path,
        kind: record.kind,
        state: record.state,
        ...(record.ownerId ? { ownerId: record.ownerId } : {}),
        ...(record.sessionId ? { sessionId: record.sessionId } : {}),
        ...(record.taskId ? { taskId: record.taskId } : {}),
        ...(record.setup ? { setup: record.setup } : {}),
        updatedAt: record.updatedAt,
      };
    }
    for (const [path, meta] of Object.entries(store.records)) {
      if (!present.has(path) && meta.state === 'kept') nextRecords[path] = meta;
    }
    writeStore({ version: 1, records: nextRecords }, getStorePath(this.workingDirectory, this.surfaceRoot));
    return records.sort((a, b) => a.path.localeCompare(b.path));
  }

  public attach(path: string, target: { sessionId?: string; taskId?: string }): void {
    const store = readStore(getStorePath(this.workingDirectory, this.surfaceRoot));
    const normalized = normalizePath(path, this.workingDirectory);
    const existing = store.records[normalized]!;
    const classified = classifyWorktreePath(normalized, this.workingDirectory);
    store.records[normalized] = {
      path: normalized,
      kind: existing?.kind ?? classified.kind,
      state: existing?.state ?? 'active',
      ...(existing?.ownerId ?? classified.ownerId ? { ownerId: existing?.ownerId ?? classified.ownerId } : {}),
      ...(target.sessionId ? { sessionId: target.sessionId } : {}),
      ...(target.taskId ? { taskId: target.taskId } : {}),
      ...(existing?.setup ? { setup: existing.setup } : {}),
      updatedAt: Date.now(),
    };
    writeStore(store, getStorePath(this.workingDirectory, this.surfaceRoot));
  }

  public setState(path: string, state: ManagedWorktreeState): void {
    const store = readStore(getStorePath(this.workingDirectory, this.surfaceRoot));
    const normalized = normalizePath(path, this.workingDirectory);
    const existing = store.records[normalized]!;
    const classified = classifyWorktreePath(normalized, this.workingDirectory);
    store.records[normalized] = {
      path: normalized,
      kind: existing?.kind ?? classified.kind,
      state,
      ...(existing?.ownerId ?? classified.ownerId ? { ownerId: existing?.ownerId ?? classified.ownerId } : {}),
      ...(existing?.sessionId ? { sessionId: existing.sessionId } : {}),
      ...(existing?.taskId ? { taskId: existing.taskId } : {}),
      ...(existing?.setup ? { setup: existing.setup } : {}),
      updatedAt: Date.now(),
    };
    writeStore(store, getStorePath(this.workingDirectory, this.surfaceRoot));
  }

  /**
   * Record a cold-start setup outcome onto a worktree's record (on creation or
   * a re-run), so a failed setup is a visible, queryable worktree/fleet-node
   * state rather than a lost log. Upserts the record if setup ran before the
   * worktree was otherwise registered.
   */
  public recordSetup(path: string, setup: WorktreeSetupResult): void {
    const store = readStore(getStorePath(this.workingDirectory, this.surfaceRoot));
    const normalized = normalizePath(path, this.workingDirectory);
    const existing = store.records[normalized];
    const classified = classifyWorktreePath(normalized, this.workingDirectory);
    store.records[normalized] = {
      path: normalized,
      kind: existing?.kind ?? classified.kind,
      state: existing?.state ?? 'active',
      ...(existing?.ownerId ?? classified.ownerId ? { ownerId: existing?.ownerId ?? classified.ownerId } : {}),
      ...(existing?.sessionId ? { sessionId: existing.sessionId } : {}),
      ...(existing?.taskId ? { taskId: existing.taskId } : {}),
      setup,
      updatedAt: Date.now(),
    };
    writeStore(store, getStorePath(this.workingDirectory, this.surfaceRoot));
  }

  public async cleanup(path: string): Promise<void> {
    const normalized = isAbsolute(path) ? path : normalizePath(path, this.workingDirectory);
    await this.git.worktreeRemove(normalized);
    const store = readStore(getStorePath(this.workingDirectory, this.surfaceRoot));
    delete store.records[normalized];
    writeStore(store, getStorePath(this.workingDirectory, this.surfaceRoot));
  }

  /**
   * DISCARD actually discards — per the eviction-preserving rules:
   *  1. Any uncommitted state is first COMMITTED onto the worktree's branch
   *     (data safety; a preservation failure refuses the removal rather than
   *     losing work).
   *  2. The worktree DIRECTORY is removed (`git worktree remove`).
   *  3. The BRANCH is kept — never deleted on this path.
   * Returns an honest receipt either way; the record is dropped only when the
   * directory really came off disk.
   */
  public async discard(path: string): Promise<WorktreeDiscardReceipt> {
    const normalized = isAbsolute(path) ? path : normalizePath(path, this.workingDirectory);
    const discardedAt = Date.now();
    const worktreeGit = this.createWorktreeGit(normalized);
    let branch: string | undefined;
    let preservedCommit: string | undefined;
    try {
      branch = (await worktreeGit.branch()).current;
      const status = await worktreeGit.status();
      if (!status.isClean()) {
        await worktreeGit.addAll();
        const commit = await worktreeGit.commit('goodvibes: preserve working state before discard', {
          noVerify: true,
          fallbackIdentity: { name: 'goodvibes', email: 'goodvibes@localhost' },
        });
        preservedCommit = commit.hash;
      }
    } catch (error) {
      // Preservation failed — refuse the removal (losing work is worse than a
      // lingering directory) and say so honestly.
      return {
        path: normalized,
        ok: false,
        ...(branch ? { branch } : {}),
        discardedAt,
        detail: `discard refused: could not preserve uncommitted state (${String(error instanceof Error ? error.message : error)})`,
      };
    }
    try {
      await this.git.worktreeRemove(normalized);
    } catch (error) {
      return {
        path: normalized,
        ok: false,
        ...(branch ? { branch } : {}),
        ...(preservedCommit ? { preservedCommit } : {}),
        discardedAt,
        detail: `discard failed: worktree removal did not complete (${String(error instanceof Error ? error.message : error)})`,
      };
    }
    const store = readStore(getStorePath(this.workingDirectory, this.surfaceRoot));
    delete store.records[normalized];
    writeStore(store, getStorePath(this.workingDirectory, this.surfaceRoot));
    return {
      path: normalized,
      ok: true,
      ...(branch ? { branch } : {}),
      ...(preservedCommit ? { preservedCommit } : {}),
      discardedAt,
      detail: preservedCommit
        ? `worktree removed; uncommitted state preserved as ${preservedCommit.slice(0, 12)} on kept branch ${branch ?? '(unknown)'}`
        : `worktree removed; branch ${branch ?? '(unknown)'} kept`,
    };
  }

  /** Injectable seam for tests: a GitService rooted INSIDE the worktree being discarded. */
  protected createWorktreeGit(worktreePath: string): Pick<GitService, 'branch' | 'status' | 'addAll' | 'commit'> {
    return new GitService(worktreePath);
  }
}

/** The honest record of one discard: what came off disk, what was kept, what was preserved. */
export interface WorktreeDiscardReceipt {
  readonly path: string;
  /** True only when the directory really came off disk. */
  readonly ok: boolean;
  /** The branch that was KEPT (never deleted by discard). */
  readonly branch?: string | undefined;
  /** The preservation commit recorded for uncommitted state, when the tree was dirty. */
  readonly preservedCommit?: string | undefined;
  readonly discardedAt: number;
  readonly detail: string;
}
