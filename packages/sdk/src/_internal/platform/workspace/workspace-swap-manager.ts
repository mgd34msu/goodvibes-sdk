/**
 * workspace-swap-manager.ts
 *
 * Manages mutable runtime.workingDir transitions.
 *
 * The working directory hosts all conversation-scoped state:
 * sessions, memory, logs, artifacts, knowledge stores. It can be swapped
 * at runtime via POST /config {key:"runtime.workingDir", value:"<path>"}.
 *
 * Swap policy:
 *   - Refused with WORKSPACE_BUSY when any session has pendingInputCount > 0.
 *   - Returns INVALID_PATH when the new path cannot be created.
 *   - On success, persists the new path to <daemonHomeDir>/daemon-settings.json.
 *
 * Events emitted on runtimeBus (domain: 'workspace'):
 *   WORKSPACE_SWAP_STARTED   — before swap begins
 *   WORKSPACE_SWAP_REFUSED   — when swap is rejected
 *   WORKSPACE_SWAP_COMPLETED — after all stores re-rooted
 */

import { mkdirSync, existsSync } from 'node:fs';
import { isAbsolute, resolve, join } from 'node:path';
import { writeDaemonSetting } from './daemon-home.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import { createEventEnvelope } from '../runtime/events/index.js';

// ---------------------------------------------------------------------------
// Minimal interface requirements (avoids coupling to full store types)
// ---------------------------------------------------------------------------

export interface WorkspaceSwapDeps {
  readonly runtimeBus: RuntimeEventBus | null;
  readonly daemonHomeDir: string;
  /**
   * Called by the manager to check whether any session currently has pending
   * input (i.e. `pendingInputCount > 0`). Returns the count of busy sessions.
   */
  readonly getBusySessionCount: () => number;
  /**
   * Called after the manager validates the new path.
   * Implementations must close existing stores and re-open them at newWorkingDir.
   * May throw; the manager catches and returns INVALID_PATH.
   */
  readonly rerootStores: (newWorkingDir: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type WorkspaceSwapResult =
  | { ok: true; previous: string; current: string }
  | { ok: false; code: 'WORKSPACE_BUSY'; reason: string; retryAfter: number }
  | { ok: false; code: 'INVALID_PATH'; reason: string };

// ---------------------------------------------------------------------------
// WorkspaceSwapManager
// ---------------------------------------------------------------------------

export class WorkspaceSwapManager {
  private currentWorkingDir: string;

  constructor(
    initialWorkingDir: string,
    private readonly deps: WorkspaceSwapDeps,
  ) {
    this.currentWorkingDir = initialWorkingDir;
  }

  getCurrentWorkingDir(): string {
    return this.currentWorkingDir;
  }

  async requestSwap(newWorkingDir: string): Promise<WorkspaceSwapResult> {
    const raw = newWorkingDir.trim();
    if (!raw) {
      return { ok: false, code: 'INVALID_PATH', reason: 'Working directory path must not be empty.' };
    }

    const resolved = isAbsolute(raw) ? resolve(raw) : resolve(this.currentWorkingDir, raw);
    const from = this.currentWorkingDir;
    const to = resolved;

    // Emit started
    this._emit('WORKSPACE_SWAP_STARTED', { type: 'WORKSPACE_SWAP_STARTED', from, to });

    // Check busy sessions
    const busyCount = this.deps.getBusySessionCount();
    if (busyCount > 0) {
      const reason = `${busyCount} session(s) have pending input. Retry after active inputs complete.`;
      this._emit('WORKSPACE_SWAP_REFUSED', {
        type: 'WORKSPACE_SWAP_REFUSED',
        from,
        to,
        reason,
        retryAfter: 5,
      });
      return { ok: false, code: 'WORKSPACE_BUSY', reason, retryAfter: 5 };
    }

    // Validate and create directory
    try {
      mkdirSync(join(resolved, '.goodvibes', 'sessions'), { recursive: true });
      mkdirSync(join(resolved, '.goodvibes', 'memory'), { recursive: true });
      mkdirSync(join(resolved, '.goodvibes', 'logs'), { recursive: true });
    } catch (err: unknown) {
      const reason = `Cannot create workspace directory at '${resolved}': ${
        err instanceof Error ? err.message : String(err)
      }`;
      return { ok: false, code: 'INVALID_PATH', reason };
    }

    // Re-root all stores
    try {
      await this.deps.rerootStores(resolved);
    } catch (err: unknown) {
      const reason = `Failed to re-initialize stores at '${resolved}': ${
        err instanceof Error ? err.message : String(err)
      }`;
      return { ok: false, code: 'INVALID_PATH', reason };
    }

    // Update internal state
    this.currentWorkingDir = resolved;

    // Persist to daemon settings
    let persistedInDaemonSettings = false;
    try {
      writeDaemonSetting(this.deps.daemonHomeDir, 'runtime.workingDir', resolved);
      persistedInDaemonSettings = true;
    } catch {
      // Non-fatal — swap succeeded but persistence failed
    }

    this._emit('WORKSPACE_SWAP_COMPLETED', {
      type: 'WORKSPACE_SWAP_COMPLETED',
      from,
      to: resolved,
      persistedInDaemonSettings,
    });

    return { ok: true, previous: from, current: resolved };
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private _emit(
    type: 'WORKSPACE_SWAP_STARTED' | 'WORKSPACE_SWAP_REFUSED' | 'WORKSPACE_SWAP_COMPLETED',
    payload: {
      type: typeof type;
      from: string;
      to: string;
      reason?: string;
      retryAfter?: number;
      persistedInDaemonSettings?: boolean;
    },
  ): void {
    if (!this.deps.runtimeBus) return;
    try {
      this.deps.runtimeBus.emit(
        'workspace',
        createEventEnvelope(type, payload as Parameters<typeof createEventEnvelope>[1]),
      );
    } catch {
      // Never throw from event emission
    }
  }
}
