/**
 * Multi-session Orchestration, Cross-Session Task Registry
 *
 * Wraps SessionTaskGraph with persistence to a host-owned task graph path
 * and reconnect/resume hydration.
 *
 * The registry is the single authoritative source for the cross-session task
 * graph within a process. Command handlers and sync integrations receive an
 * owned instance from the runtime service graph.
 *
 * Housekeeping contract (the persisted graph is a recoverable store, so it
 * carries the full set of store obligations; the pure half lives in
 * registry-housekeeping.ts):
 *  - REAP ON RECOVERY, hydration drops refs whose owning session no longer
 *    exists (via the injected `sessionExists` predicate), drops edges left
 *    dangling by that removal, and retires handoffs that have already fired.
 *  - BOUND, every collection has BOTH a count cap and an age TTL.
 *  - VALIDATE BY CONTENT, the file is parsed and shape-checked record by
 *    record; a torn/zero-byte/truncated file is rejected, never served.
 *  - SWEEP PERIODICALLY, the same reap runs on an interval, not only at
 *    startup, because a daemon-hosted registry can stay up for weeks.
 *  - DISCLOSE, every reap that removed anything logs its counts.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { writeFile } from 'node:fs/promises';
import { dirname } from 'path';
import { logger } from '../../utils/logger.js';
import { SessionTaskGraph } from './graph.js';
import type {
  CrossSessionTaskRef,
  TaskHandoffRecord,
  CancellationRequest,
  CancellationResult,
  SessionTaskGraphSnapshot,
} from './types.js';
import { makeRefKey } from './types.js';
import type { TaskLifecycleState } from '../../runtime/store/domains/tasks.js';
import { summarizeError } from '../../utils/error-display.js';
import {
  EMPTY_REAP_SUMMARY,
  GRAPH_SCHEMA_VERSION,
  QUARANTINE_RETENTION_MS,
  QUARANTINE_SUFFIX,
  SWEEP_INTERVAL_MS,
  parseGraphFile,
  reapGraphSnapshot,
  type CrossSessionGraphReapSummary,
} from './registry-housekeeping.js';

export type { CrossSessionGraphReapSummary } from './registry-housekeeping.js';

// ── CrossSessionTaskRegistry ──────────────────────────────────────────────────

/** Construction-time seams for {@link CrossSessionTaskRegistry}. */
export interface CrossSessionTaskRegistryOptions {
  /**
   * "Does this session still exist?", INJECTED so the registry can reap
   * records whose owning session is gone without growing a hard dependency on
   * the session store (and so tests can drive it directly).
   *
   * Omitted means owner-existence reaping is skipped entirely; the age TTL and
   * count caps still apply. Callers that can answer this question should pass
   * it, otherwise refs for vanished sessions survive until they age out.
   */
  readonly sessionExists?: ((sessionId: string) => boolean) | undefined;
  /** Clock seam (tests). Defaults to `Date.now`. */
  readonly now?: (() => number) | undefined;
  /** Periodic sweep interval in ms. `0` disables the timer (tests, short-lived processes). Defaults to one hour. */
  readonly sweepIntervalMs?: number | undefined;
}

/**
 * CrossSessionTaskRegistry, persistent wrapper around `SessionTaskGraph`.
 *
 * Responsibilities:
 * - Load the graph from disk on construction (reconnect/resume hydration),
 *   validating it by content and reaping records whose owner is gone.
 * - Flush the graph to disk after every mutation.
 * - Sweep the graph periodically, not only at startup.
 * - Expose a stable interface for command handlers and sync adapters.
 * - Generate unique handoff IDs.
 */
export class CrossSessionTaskRegistry {
  private _graph: SessionTaskGraph;
  private readonly _graphPath: string;
  private readonly _dir: string;
  private readonly _sessionExists: ((sessionId: string) => boolean) | undefined;
  private readonly _now: () => number;
  private _dirEnsured = false;
  private _flushTimer: ReturnType<typeof setTimeout> | null = null;
  private _sweepTimer: ReturnType<typeof setInterval> | null = null;
  private _lastReap: CrossSessionGraphReapSummary = EMPTY_REAP_SUMMARY;
  _exitHandler: (() => void) | null = null;

  /**
   * @param graphPath - Absolute host-owned task graph path.
   * @param options - Injected seams (session-existence predicate, clock, sweep interval).
   */
  public constructor(graphPath: string, options: CrossSessionTaskRegistryOptions = {}) {
    this._graphPath = graphPath;
    this._dir = dirname(graphPath);
    this._sessionExists = options.sessionExists;
    this._now = options.now ?? Date.now;
    this._graph = new SessionTaskGraph();
    this._load();
    this._exitHandler = () => {
      if (this._flushTimer) {
        clearTimeout(this._flushTimer);
        this._flushTimer = null;
        this._flushSync();
      }
    };
    process.on('exit', this._exitHandler);

    const sweepIntervalMs = options.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
    if (sweepIntervalMs > 0) {
      this._sweepTimer = setInterval(() => {
        this.reap();
        this._sweepQuarantine();
      }, sweepIntervalMs);
      this._sweepTimer.unref?.();
    }
  }

  // ── Task ref operations ───────────────────────────────────────────────────────

  /**
   * Link a task into the global graph, registers the task as a
   * cross-session ref and optionally adds a dependency edge.
   *
   * @param ref - The task ref to link.
   * @param dependsOn - Optional ref this task depends on.
   * @param reason - Optional reason for the dependency edge.
   * @returns Result of the link operation.
   */
  public linkTask(
    ref: CrossSessionTaskRef,
    dependsOn?: { sessionId: string; taskId: string },
    reason?: string,
  ): { ok: boolean; error?: string | undefined } {
    this._graph.upsertRef(ref);

    if (dependsOn) {
      const edgeResult = this._graph.addEdge(
        { sessionId: ref.sessionId, taskId: ref.taskId },
        dependsOn,
        reason,
      );
      if (!edgeResult.ok) {
        this._flush();
        return { ok: false, error: edgeResult.error };
      }
    }

    this._flush();
    return { ok: true };
  }

  /**
   * Update the status of a task ref.
   *
   * @param sessionId - Owning session.
   * @param taskId - Target task.
   * @param status - New lifecycle status.
   * @returns `true` if the status changed and was flushed.
   */
  public propagateStatus(
    sessionId: string,
    taskId: string,
    status: TaskLifecycleState,
  ): boolean {
    const changed = this._graph.propagateStatus(sessionId, taskId, status);
    if (changed) this._flush();
    return changed;
  }

  /**
   * Look up a ref by session + task ID.
   */
  public getRef(sessionId: string, taskId: string): CrossSessionTaskRef | undefined {
    return this._graph.getRef(sessionId, taskId);
  }

  /**
   * Return all refs in the graph.
   */
  public getAllRefs(): CrossSessionTaskRef[] {
    return this._graph.getAllRefs();
  }

  /**
   * Return all refs for a given session.
   */
  public getRefsBySession(sessionId: string): CrossSessionTaskRef[] {
    return this._graph.getRefsBySession(sessionId);
  }

  /**
   * Return all direct dependencies of a task.
   */
  public getDependencies(sessionId: string, taskId: string): CrossSessionTaskRef[] {
    return this._graph.getDependencies(sessionId, taskId);
  }

  /**
   * Return all direct dependents of a task.
   */
  public getDependents(sessionId: string, taskId: string): CrossSessionTaskRef[] {
    return this._graph.getDependents(sessionId, taskId);
  }

  // ── Handoff operations ────────────────────────────────────────────────────────

  /**
   * Initiate a task handoff from one session to another.
   *
   * Both sessions must have their task refs registered before calling this.
   * The originating task ref status is updated to 'blocked' (awaiting handoff).
   *
   * @param taskRef - The task being handed off.
   * @param fromSessionId - Source session.
   * @param toSessionId - Destination session.
   * @param reason - Optional human-readable reason.
   * @returns Result of the handoff operation.
   */
  public initiateHandoff(
    taskRef: { sessionId: string; taskId: string },
    fromSessionId: string,
    toSessionId: string,
    reason?: string,
  ): { ok: boolean; handoffId?: string; error?: string | undefined } {
    const ref = this._graph.getRef(taskRef.sessionId, taskRef.taskId);
    if (!ref) {
      return {
        ok: false,
        error: `Task ref not found: ${makeRefKey(taskRef.sessionId, taskRef.taskId)}. ` +
          'Register the task with /session link-task first.',
      };
    }

    const handoffId = crypto.randomUUID();
    const record: TaskHandoffRecord = {
      handoffId,
      taskRef: { sessionId: taskRef.sessionId, taskId: taskRef.taskId },
      fromSessionId,
      toSessionId,
      reason,
      initiatedAt: this._now(),
      acknowledged: false,
    };

    this._graph.recordHandoff(record);

    // Mark the task as blocked while awaiting handoff acknowledgement
    this._graph.propagateStatus(taskRef.sessionId, taskRef.taskId, 'blocked');

    this._flush();
    return { ok: true, handoffId };
  }

  /**
   * Acknowledge a handoff from the destination session.
   *
   * @param handoffId - The handoff to acknowledge.
   * @returns `true` if the handoff was found and acknowledged.
   */
  public acknowledgeHandoff(handoffId: string): boolean {
    const ok = this._graph.acknowledgeHandoff(handoffId);
    if (ok) this._flush();
    return ok;
  }

  /**
   * Return all handoff records.
   */
  public getHandoffs(): TaskHandoffRecord[] {
    return this._graph.getHandoffs();
  }

  // ── Scoped cancellation ───────────────────────────────────────────────────────

  /**
   * Apply a scoped cancellation to the graph.
   *
   * @param request - The cancellation request.
   * @returns Result describing what was cancelled and what was skipped.
   */
  public cancel(request: CancellationRequest): CancellationResult {
    const result = this._graph.applyCancellation(request);
    if (result.ok && result.cancelled.length > 0) this._flush();
    return result;
  }

  // ── Snapshot / persistence ────────────────────────────────────────────────────

  /**
   * Take a snapshot of the current graph state.
   * Suitable for display (e.g. `/session graph`).
   */
  public snapshot(): SessionTaskGraphSnapshot {
    return this._graph.snapshot();
  }

  /**
   * Run a housekeeping pass over the in-memory graph now: drop refs whose
   * owning session is gone, refs past their TTL, dangling edges, fired or
   * aged-out handoffs, and anything over the count caps.
   *
   * Safe to call at any time and idempotent, a second call immediately after
   * a first reclaims nothing. Concurrent processes are safe because the reap
   * is computed over this process's in-memory graph and persisted through the
   * ordinary flush path; the loser of a concurrent flush simply reaps again.
   *
   * @returns The counts reclaimed by this pass.
   */
  public reap(): CrossSessionGraphReapSummary {
    const { snapshot, summary } = reapGraphSnapshot(this._graph.snapshot(), {
      sessionExists: this._sessionExists,
      now: this._now(),
    });
    this._lastReap = summary;
    if (summary.total === 0) return summary;

    // SessionTaskGraph.hydrate upserts into existing state and has no clear(),
    // so the reaped snapshot is rebuilt into a fresh graph. Edge `linkedAt`
    // timestamps are re-stamped by addEdge; they are display-only and carry no
    // retention meaning, so nothing depends on their original value.
    const rebuilt = new SessionTaskGraph();
    rebuilt.hydrate(snapshot);
    this._graph = rebuilt;
    this._disclose('sweep', summary);
    this._flush();
    return summary;
  }

  /** The counts reclaimed by the most recent reap pass (hydration or sweep). */
  public lastReapSummary(): CrossSessionGraphReapSummary {
    return this._lastReap;
  }

  /**
   * Force a synchronous flush to disk.
   * Use on shutdown/dispose to ensure all pending data is written.
   */
  public flush(): void {
    if (this._flushTimer !== null) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    this._flushSync();
  }

  /**
   * Release process-level resources held by the registry.
   *
   * Safe to call multiple times. Flushes pending state before detaching the
   * process exit handler and stopping the periodic sweep.
   */
  public dispose(): void {
    this.flush();
    if (this._sweepTimer !== null) {
      clearInterval(this._sweepTimer);
      this._sweepTimer = null;
    }
    if (this._exitHandler) {
      process.removeListener('exit', this._exitHandler);
      this._exitHandler = null;
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────────

  /**
   * Load the persisted graph from disk and hydrate the in-memory graph.
   *
   * The file is validated by CONTENT, a zero-byte, truncated or otherwise
   * torn file is rejected and preserved aside rather than partially trusted.
   * Surviving records are then reaped before hydration, so recovery never
   * re-imports records whose owning session is gone.
   */
  private _load(): void {
    this._sweepQuarantine();
    if (!existsSync(this._graphPath)) return;

    let text: string;
    try {
      text = readFileSync(this._graphPath, 'utf-8');
    } catch (e) {
      logger.warn('CrossSessionTaskRegistry: could not read task graph', {
        path: this._graphPath,
        error: summarizeError(e),
      });
      return;
    }

    const verdict = parseGraphFile(text);
    if (verdict.kind === 'future') {
      logger.warn('CrossSessionTaskRegistry: task graph written by a newer runtime, not loaded, preserved aside', {
        path: this._graphPath,
        fileVersion: verdict.version,
        supportedVersion: GRAPH_SCHEMA_VERSION,
      });
      this._quarantine('future schema version');
      return;
    }
    if (verdict.kind === 'corrupt') {
      logger.warn('CrossSessionTaskRegistry: task graph failed content validation, not loaded, preserved aside', {
        path: this._graphPath,
        detail: verdict.detail,
        bytes: Buffer.byteLength(text, 'utf-8'),
      });
      this._quarantine(verdict.detail);
      return;
    }

    const { snapshot, summary } = reapGraphSnapshot(verdict.snapshot, {
      sessionExists: this._sessionExists,
      now: this._now(),
    });
    this._graph.hydrate(snapshot);

    const hydrationSummary: CrossSessionGraphReapSummary = {
      ...summary,
      refsMalformed: verdict.refsMalformed,
      handoffsMalformed: verdict.handoffsMalformed,
      total: summary.total + verdict.refsMalformed + verdict.handoffsMalformed,
    };
    this._lastReap = hydrationSummary;

    logger.debug('CrossSessionTaskRegistry: hydrated graph from disk', {
      path: this._graphPath,
      refs: Object.keys(snapshot.refs).length,
    });

    if (hydrationSummary.total > 0) {
      this._disclose('hydration', hydrationSummary);
      this._flush();
    }
  }

  /** Surface what a reap reclaimed. Counts only, graph contents are never logged. */
  private _disclose(phase: 'hydration' | 'sweep', summary: CrossSessionGraphReapSummary): void {
    logger.info('CrossSessionTaskRegistry: reclaimed stale task graph records', {
      phase,
      path: this._graphPath,
      refsMissingSession: summary.refsMissingSession,
      refsExpired: summary.refsExpired,
      // Reported on its own line rather than folded into refsExpired: this is
      // the pre-binding `'local'` store draining away, which an operator
      // watching an upgrade land should be able to see for what it is.
      refsLegacyNamespaceExpired: summary.refsLegacyNamespaceExpired,
      refsOverCap: summary.refsOverCap,
      refsMalformed: summary.refsMalformed,
      edgesDangling: summary.edgesDangling,
      handoffsOrphaned: summary.handoffsOrphaned,
      handoffsRetired: summary.handoffsRetired,
      handoffsOverCap: summary.handoffsOverCap,
      handoffsMalformed: summary.handoffsMalformed,
      total: summary.total,
    });
  }

  /**
   * Preserve an untrustworthy graph file aside instead of letting the next
   * flush overwrite it. The quarantine name is fixed, so at most one such file
   * ever exists; {@link _sweepQuarantine} ages it out.
   */
  private _quarantine(reason: string): void {
    const quarantinePath = `${this._graphPath}${QUARANTINE_SUFFIX}`;
    try {
      renameSync(this._graphPath, quarantinePath);
      logger.warn('CrossSessionTaskRegistry: preserved unreadable task graph aside', {
        path: this._graphPath,
        quarantinePath,
        reason,
      });
    } catch (e) {
      logger.error('CrossSessionTaskRegistry: failed to preserve unreadable task graph aside', {
        path: this._graphPath,
        error: summarizeError(e),
      });
    }
  }

  /** Delete a preserved-aside graph file once it is past {@link QUARANTINE_RETENTION_MS}. ENOENT is success. */
  private _sweepQuarantine(): void {
    const quarantinePath = `${this._graphPath}${QUARANTINE_SUFFIX}`;
    let ageMs: number;
    let bytes: number;
    try {
      const stat = statSync(quarantinePath);
      ageMs = this._now() - stat.mtimeMs;
      bytes = stat.size;
    } catch {
      return; // Missing quarantine file: nothing to sweep.
    }
    if (ageMs <= QUARANTINE_RETENTION_MS) return;
    try {
      unlinkSync(quarantinePath);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== 'ENOENT') {
        logger.warn('CrossSessionTaskRegistry: failed to remove expired preserved task graph', {
          quarantinePath,
          error: summarizeError(e),
        });
      }
      return;
    }
    logger.info('CrossSessionTaskRegistry: removed expired preserved task graph', {
      quarantinePath,
      ageMs,
      bytes,
    });
  }

  /**
   * Flush the current graph snapshot to disk.
   * If the write fails, logs a warning and continues with the in-memory graph.
   */
  private _flush(): void {
    this._scheduledFlush();
  }

  /** Schedule a debounced async write (coalesces rapid successive mutations). */
  private _scheduledFlush(): void {
    if (this._flushTimer !== null) return;
    this._flushTimer = setTimeout(async () => {
      this._flushTimer = null;
      try {
        if (!this._dirEnsured) {
          mkdirSync(this._dir, { recursive: true });
          this._dirEnsured = true;
        }
        // Temp-file-plus-rename: a crash mid-write can only leave a stray temp
        // file, never a torn graph file. The pid+timestamp suffix keeps two
        // processes from sharing one temp path.
        const tempPath = this._tempPath();
        await writeFile(tempPath, JSON.stringify(this._graph.snapshot(), null, 2), 'utf-8');
        renameSync(tempPath, this._graphPath);
      } catch (e) {
        logger.warn('CrossSessionTaskRegistry: failed to flush task graph', {
          path: this._graphPath,
          error: summarizeError(e),
        });
      }
    }, 100);
    this._flushTimer.unref?.();
  }

  /** Perform a synchronous write, used by shutdown/dispose and flush(). */
  private _flushSync(): void {
    try {
      if (!this._dirEnsured) {
        mkdirSync(this._dir, { recursive: true });
        this._dirEnsured = true;
      }
      const snap = this._graph.snapshot();
      const tempPath = this._tempPath();
      writeFileSync(tempPath, JSON.stringify(snap, null, 2), 'utf-8');
      renameSync(tempPath, this._graphPath);
    } catch (e) {
      // Failed persistence leaves the in-memory graph authoritative.
      logger.warn('CrossSessionTaskRegistry: failed to flush task graph', {
        path: this._graphPath,
        error: summarizeError(e),
      });
    }
  }

  /** Per-process temp path for atomic writes. */
  private _tempPath(): string {
    return `${this._graphPath}.${process.pid}.${Date.now()}.tmp`;
  }
}
