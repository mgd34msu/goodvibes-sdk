/**
 * workspace/registration/store.ts
 *
 * The daemon-side registered-workspace store (user-scoped state, injectable
 * I/O) plus the impure worktree-link probe the resolver's git metadata comes
 * from.
 *
 * PERSISTENCE follows the sibling control-plane stores (PrincipalStore,
 * ChannelProfileStore …): a versioned JSON document over the shared
 * PersistentStore, which supports a `:memory:` path for deterministic tests —
 * that is the injectable-I/O seam. The persisted `workspaces` array is
 * field-identical to the agent registry so its file migrates in.
 *
 * ROOT-GUARD. `add` refuses an absurdly broad root ($HOME, the filesystem root,
 * or the daemon state dir) via the SAME broadRootReason the checkpoint manager
 * already uses — a registration store must never let automatic coverage sweep a
 * whole home directory.
 */

import { PersistentStore } from '../../state/persistent-store.js';
import { broadRootReason } from '../checkpoint/root-guard.js';
import { normalizeWorkspaceRoot, resolveWorkspaceRegistration } from './resolution.js';
import {
  WorkspaceRegistrationError,
  type DeclinedWorkspaceRecord,
  type RegisteredWorkspaceRecord,
  type ResolveWorkspaceInput,
  type WorkspaceGitMetadata,
  type WorkspaceRegistrySnapshot,
  type WorkspaceResolution,
} from './types.js';
import { probeWorktreeLink } from './worktree-link.js';

interface PersistedRegistry extends Record<string, unknown> {
  version: 1;
  workspaces: RegisteredWorkspaceRecord[];
  declines: DeclinedWorkspaceRecord[];
}

function validate(snapshot: PersistedRegistry | null): PersistedRegistry {
  if (!snapshot) return { version: 1, workspaces: [], declines: [] };
  if (snapshot.version !== 1 || !Array.isArray(snapshot.workspaces)) {
    throw new Error('Workspace registration store snapshot is invalid.');
  }
  return {
    version: 1,
    workspaces: snapshot.workspaces,
    declines: Array.isArray(snapshot.declines) ? snapshot.declines : [],
  };
}

export interface WorkspaceRegistrationStoreOptions {
  /** Persistence path (or `:memory:` for tests). */
  readonly path: string;
  /** The user's home directory — refused as a broad root. */
  readonly homeDir: string;
  /** The daemon state directory (~/.goodvibes) — refused as a broad root. */
  readonly daemonStateDir: string;
  /** Injectable worktree-link probe; defaults to a real `git rev-parse` probe. */
  readonly probe?: (path: string) => WorkspaceGitMetadata;
}

export interface RegisterWorkspaceResult {
  readonly record: RegisteredWorkspaceRecord;
  readonly alreadyRegistered: boolean;
}

export class WorkspaceRegistrationStore {
  private readonly store: PersistentStore<PersistedRegistry>;
  private readonly homeDir: string;
  private readonly daemonStateDir: string;
  private readonly probe: (path: string) => WorkspaceGitMetadata;

  constructor(options: WorkspaceRegistrationStoreOptions) {
    this.store = new PersistentStore<PersistedRegistry>(options.path);
    this.homeDir = options.homeDir;
    this.daemonStateDir = options.daemonStateDir;
    this.probe = options.probe ?? probeWorktreeLink;
  }

  private async read(): Promise<PersistedRegistry> {
    return validate(await this.store.load());
  }

  async snapshot(): Promise<WorkspaceRegistrySnapshot> {
    const state = await this.read();
    return { workspaces: state.workspaces, declines: state.declines };
  }

  /** Register a root, refusing an empty or absurdly broad one. Idempotent on the normalized root. */
  async add(root: string, opts?: { readonly label?: string }): Promise<RegisterWorkspaceResult> {
    const target = this.requireRegistrableRoot(root);
    const state = await this.read();
    const existing = state.workspaces.find((w) => w.root === target);
    if (existing) return { record: existing, alreadyRegistered: true };

    const record: RegisteredWorkspaceRecord = {
      root: target,
      registeredAt: new Date().toISOString(),
      ...(opts?.label?.trim() ? { label: opts.label.trim() } : {}),
    };
    // Registering a root clears any remembered decline at exactly that root.
    const declines = state.declines.filter((d) => d.root !== target);
    await this.store.persist({ version: 1, workspaces: [...state.workspaces, record], declines });
    return { record, alreadyRegistered: false };
  }

  /** Remove a registered root. Returns whether anything was removed (honest boolean, never a phantom). */
  async remove(root: string): Promise<{ readonly root: string; readonly removed: boolean }> {
    const target = normalizeWorkspaceRoot(root);
    const state = await this.read();
    const workspaces = state.workspaces.filter((w) => w.root !== target);
    const removed = workspaces.length !== state.workspaces.length;
    if (removed) await this.store.persist({ version: 1, workspaces, declines: state.declines });
    return { root: target, removed };
  }

  /** Remember a subtree-scoped decline at a root. Idempotent. Used by prompt consumers, not a wire verb. */
  async decline(root: string): Promise<{ readonly root: string; readonly alreadyDeclined: boolean }> {
    const target = normalizeWorkspaceRoot(root);
    const state = await this.read();
    if (state.declines.some((d) => d.root === target)) return { root: target, alreadyDeclined: true };
    const record: DeclinedWorkspaceRecord = { root: target, declinedAt: new Date().toISOString() };
    await this.store.persist({ version: 1, workspaces: state.workspaces, declines: [...state.declines, record] });
    return { root: target, alreadyDeclined: false };
  }

  /**
   * Resolve a path against the registry. When `git` is omitted, the store probes
   * the worktree→main-repo link itself so a linked sibling worktree inherits its
   * main repo's registration.
   */
  async resolve(path: string, git?: WorkspaceGitMetadata): Promise<WorkspaceResolution> {
    const state = await this.read();
    const gitMeta = git ?? this.probe(path);
    const input: ResolveWorkspaceInput = {
      path,
      git: gitMeta,
      registrations: state.workspaces,
      declines: state.declines,
    };
    return resolveWorkspaceRegistration(input);
  }

  private requireRegistrableRoot(root: string): string {
    if (typeof root !== 'string' || root.trim().length === 0) {
      throw new WorkspaceRegistrationError('root is required');
    }
    const target = normalizeWorkspaceRoot(root);
    const broad = broadRootReason(target, this.homeDir, this.daemonStateDir);
    if (broad) {
      throw new WorkspaceRegistrationError(
        `refusing to register "${target}" because it is ${broad}: coverage flows down a root's whole subtree, ` +
          `so registering a root this broad would sweep far more than a project. Register a specific project root.`,
      );
    }
    return target;
  }
}
