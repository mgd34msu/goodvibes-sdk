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
 *   WORKSPACE_SWAP_FAILED    — when mkdir or rerootStores fails
 */

import { mkdirSync, existsSync } from 'node:fs';
import { isAbsolute, resolve, join } from 'node:path';
import { writeDaemonSetting } from './daemon-home.js';
import type { WorkspaceEvent } from '../../events/workspace.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import { createEventEnvelope } from '../runtime/events/index.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

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
  private swapInProgress: Promise<WorkspaceSwapResult> | null = null;

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
    if (this.swapInProgress) {
      return { ok: false, code: 'WORKSPACE_BUSY', reason: 'Another workspace swap is already in progress.', retryAfter: 1 };
    }
    this.swapInProgress = this._requestSwapInner(newWorkingDir);
    try {
      return await this.swapInProgress;
    } finally {
      this.swapInProgress = null;
    }
  }

  private async _requestSwapInner(newWorkingDir: string): Promise<WorkspaceSwapResult> {
    const raw = newWorkingDir.trim();
    if (!raw) {
      return { ok: false, code: 'INVALID_PATH', reason: 'Working directory path must not be empty.' };
    }

    const resolved = isAbsolute(raw) ? resolve(raw) : resolve(this.currentWorkingDir, raw);
    const from = this.currentWorkingDir;
    const to = resolved;

    // Check busy sessions BEFORE emitting STARTED — don't emit STARTED if we'll immediately refuse.
    const busyCount = this.deps.getBusySessionCount();
    if (busyCount > 0) {
      const reason = `${busyCount} session(s) have pending input. Retry after active inputs complete.`;
      this._emit({ type: 'WORKSPACE_SWAP_REFUSED', from, to, reason, retryAfter: 5 });
      return { ok: false, code: 'WORKSPACE_BUSY', reason, retryAfter: 5 };
    }

    // Swap is proceeding — emit STARTED now that busy check passed.
    this._emit({ type: 'WORKSPACE_SWAP_STARTED', from, to });

    // Validate and create directory
    try {
      mkdirSync(join(resolved, '.goodvibes', 'sessions'), { recursive: true });
      mkdirSync(join(resolved, '.goodvibes', 'memory'), { recursive: true });
      mkdirSync(join(resolved, '.goodvibes', 'logs'), { recursive: true });
    } catch (err: unknown) {
      const reason = `Cannot create workspace directory at '${resolved}': ${
        err instanceof Error ? err.message : String(err)
      }`;
      // emit WORKSPACE_SWAP_FAILED so subscribers that saw STARTED get terminal resolution
      this._emit({ type: 'WORKSPACE_SWAP_FAILED', from, to, code: 'INVALID_PATH', reason });
      return { ok: false, code: 'INVALID_PATH', reason };
    }

    // Re-root all stores
    try {
      await this.deps.rerootStores(resolved);
    } catch (err: unknown) {
      const reason = `Failed to re-initialize stores at '${resolved}': ${
        err instanceof Error ? err.message : String(err)
      }`;
      // emit WORKSPACE_SWAP_FAILED so subscribers that saw STARTED get terminal resolution
      this._emit({ type: 'WORKSPACE_SWAP_FAILED', from, to, code: 'REROOT_FAILED', reason });
      return { ok: false, code: 'INVALID_PATH', reason };
    }

    this.currentWorkingDir = resolved;

    // Persist to daemon settings
    let persistedInDaemonSettings = false;
    try {
      writeDaemonSetting(this.deps.daemonHomeDir, 'runtime.workingDir', resolved);
      persistedInDaemonSettings = true;
    } catch (err: unknown) {
      // Swap succeeded but persistence failed. Log so ops can diagnose.
      logger.warn('[WorkspaceSwap] daemon settings persistence failed — workingDir will not survive restart', {
        error: summarizeError(err),
        daemonHomeDir: this.deps.daemonHomeDir,
        resolvedPath: resolved,
      });
    }

    this._emit({ type: 'WORKSPACE_SWAP_COMPLETED', from, to: resolved, persistedInDaemonSettings });

    return { ok: true, previous: from, current: resolved };
  }

  private _emit(payload: WorkspaceEvent): void {
    if (!this.deps.runtimeBus) return;
    try {
      const envelope = createEventEnvelope(
        payload.type,
        payload,
        { sessionId: '', source: 'workspace-swap-manager' },
      );
      this.deps.runtimeBus.emit<'workspace'>(
        'workspace',
        // WorkspaceEvent is the DomainEventMap['workspace'] union; createEventEnvelope
        // infers the payload type as the concrete member rather than the full union.
        // A single widening cast (not through unknown) is safe here.
        envelope as import('../runtime/events/index.js').RuntimeEventEnvelope<WorkspaceEvent['type'], WorkspaceEvent>,
      );
    } catch {
      // Never throw from event emission
    }
  }
}
