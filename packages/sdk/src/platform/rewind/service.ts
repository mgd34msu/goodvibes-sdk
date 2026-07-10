/**
 * service.ts — UnifiedRewindService.
 *
 * One coordinator over the platform's existing history stores. `plan()` is a
 * dry-run preview of exactly what a rewind to a turn anchor would change, plus
 * a single-use confirm token; `apply()` is confirm-gated and performs the
 * restore(s), recording an undo point so the rewind is itself reversible
 * (restore-the-restore). The workspace side reuses the checkpoint manager's
 * own pre-restore safety checkpoint as that undo point; the conversation side
 * reuses its store's captured pre-rewind snapshot. Every apply emits a receipt
 * event so surfaces can render it.
 */
import type { WorkspaceEvent } from '../../events/workspace.js';
import { RewindTokenStore, rewindFingerprint } from './tokens.js';
import type {
  RewindAnchor,
  RewindApplyResult,
  RewindCheckpointView,
  RewindConversationPort,
  RewindEventSink,
  RewindPlan,
  RewindPlanConversation,
  RewindPlanFiles,
  RewindReceiptConversation,
  RewindReceiptFiles,
  RewindScope,
  RewindUndo,
  RewindWorkspacePort,
} from './types.js';

/** Thrown when rewind.apply is handed an invalid/expired/mismatched confirm token. */
export class RewindTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RewindTokenError';
  }
}

/** The two ways to authorize an apply: a confirm token from plan, or `confirm: true`. */
export const REWIND_CONFIRM_OPTIONS = ['confirm', 'confirmToken'] as const;

export interface UnifiedRewindServiceDeps {
  /** The workspace-checkpoint store port. Absent → files rewind is honestly unavailable. */
  readonly workspace?: RewindWorkspacePort | null;
  /** The conversation store port. Absent → conversation rewind is honestly unavailable. */
  readonly conversation?: RewindConversationPort | null;
  /** Receipt event sink. Absent → no events emitted (a graceful degrade). */
  readonly emit?: RewindEventSink | null;
  readonly now?: () => number;
  readonly tokens?: RewindTokenStore;
}

export interface RewindApplyOptions {
  readonly confirm?: boolean | undefined;
  readonly confirmToken?: string | undefined;
}

function wants(scope: RewindScope, part: 'files' | 'conversation'): boolean {
  return scope === 'both' || scope === part;
}

export class UnifiedRewindService {
  private readonly workspace: RewindWorkspacePort | null;
  private readonly conversation: RewindConversationPort | null;
  private readonly emitSink: RewindEventSink | null;
  private readonly now: () => number;
  private readonly tokens: RewindTokenStore;

  constructor(deps: UnifiedRewindServiceDeps = {}) {
    this.workspace = deps.workspace ?? null;
    this.conversation = deps.conversation ?? null;
    this.emitSink = deps.emit ?? null;
    this.now = deps.now ?? Date.now;
    this.tokens = deps.tokens ?? new RewindTokenStore(this.now);
  }

  /** Dry-run preview of a rewind + a single-use confirm token authorizing it. */
  async plan(anchor: RewindAnchor, scope: RewindScope): Promise<RewindPlan> {
    const turnId = anchor.turnId ?? null;
    const warnings: string[] = [];
    const files = wants(scope, 'files') ? await this.planFiles(anchor, warnings) : null;
    const conversation = wants(scope, 'conversation') ? await this.planConversation(anchor, warnings) : null;

    const fingerprint = rewindFingerprint(anchor.sessionId, turnId, scope);
    const { token, expiresAt } = this.tokens.issue(fingerprint);
    this.emitEvent({ type: 'REWIND_PLANNED', sessionId: anchor.sessionId, turnId, scope }, anchor.sessionId);
    return { sessionId: anchor.sessionId, turnId, scope, token, expiresAt, files, conversation, warnings };
  }

  /** Confirm-gated apply. Unconfirmed → a non-error refusal; bad token → RewindTokenError. */
  async apply(anchor: RewindAnchor, scope: RewindScope, opts: RewindApplyOptions = {}): Promise<RewindApplyResult> {
    const turnId = anchor.turnId ?? null;
    const fingerprint = rewindFingerprint(anchor.sessionId, turnId, scope);
    if (opts.confirmToken !== undefined) {
      if (!this.tokens.consume(opts.confirmToken, fingerprint)) {
        throw new RewindTokenError(
          'confirmToken is invalid, already used, expired, or was issued for a different rewind. Re-run rewind.plan.',
        );
      }
    } else if (opts.confirm !== true) {
      return {
        receipt: null,
        refused: true,
        refusal: {
          reason: 'rewind.apply restores files and/or conversation and requires confirmation before it will run.',
          confirmField: 'confirm',
          planMethod: 'rewind.plan',
          options: [...REWIND_CONFIRM_OPTIONS],
        },
      };
    }

    const warnings: string[] = [];
    const { files, undoFiles } = wants(scope, 'files')
      ? await this.applyFiles(anchor, warnings)
      : { files: null as RewindReceiptFiles | null, undoFiles: null as RewindUndo['files'] };
    const { conversation, undoConversation } = wants(scope, 'conversation')
      ? await this.applyConversation(anchor, warnings)
      : { conversation: null as RewindReceiptConversation | null, undoConversation: null as RewindUndo['conversation'] };

    const receipt = {
      sessionId: anchor.sessionId,
      turnId,
      scope,
      appliedAt: this.now(),
      files,
      conversation,
      undo: { files: undoFiles, conversation: undoConversation },
      warnings,
    };
    this.emitEvent(
      {
        type: 'REWIND_APPLIED',
        sessionId: anchor.sessionId,
        turnId,
        scope,
        filesRestored: files?.restored ?? false,
        conversationRewound: conversation?.rewound ?? false,
        undoAvailable: undoFiles !== null || undoConversation !== null,
      },
      anchor.sessionId,
    );
    return { receipt, refused: false, refusal: null };
  }

  private async resolveCheckpoint(anchor: RewindAnchor): Promise<RewindCheckpointView | null> {
    if (!this.workspace) return null;
    const list = await this.workspace.list({ sessionId: anchor.sessionId });
    if (list.length === 0) return null;
    if (anchor.turnId !== undefined) {
      return list.find((c) => c.turnId === anchor.turnId) ?? null;
    }
    // No turn anchor → the session's most recent checkpoint (do not assume list order).
    return [...list].sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
  }

  private async planFiles(anchor: RewindAnchor, warnings: string[]): Promise<RewindPlanFiles> {
    if (!this.workspace) {
      warnings.push('files rewind unavailable: no workspace checkpoint store is wired on this runtime');
      return { available: false, checkpointId: null, checkpointLabel: null, affectedFileCount: 0 };
    }
    const checkpoint = await this.resolveCheckpoint(anchor);
    if (!checkpoint) {
      warnings.push('files rewind: no workspace checkpoint found for this anchor');
      return { available: false, checkpointId: null, checkpointLabel: null, affectedFileCount: 0 };
    }
    const diff = await this.workspace.diff(checkpoint.id);
    return {
      available: true,
      checkpointId: checkpoint.id,
      checkpointLabel: checkpoint.label,
      affectedFileCount: diff.files.length,
    };
  }

  private async planConversation(anchor: RewindAnchor, warnings: string[]): Promise<RewindPlanConversation> {
    if (!this.conversation) {
      warnings.push('conversation rewind unavailable: no conversation store is wired on this runtime');
      return { available: false, messagesToDrop: 0, messagesRemaining: 0 };
    }
    const preview = await this.conversation.preview(anchor);
    return { available: true, messagesToDrop: preview.messagesToDrop, messagesRemaining: preview.messagesRemaining };
  }

  private async applyFiles(
    anchor: RewindAnchor,
    warnings: string[],
  ): Promise<{ files: RewindReceiptFiles; undoFiles: RewindUndo['files'] }> {
    const checkpoint = this.workspace ? await this.resolveCheckpoint(anchor) : null;
    if (!this.workspace || !checkpoint) {
      warnings.push('files rewind skipped: no workspace checkpoint available for this anchor');
      return {
        files: { restored: false, checkpointId: checkpoint?.id ?? null, safetyCheckpointId: null, restoredFileCount: 0, removedFileCount: 0 },
        undoFiles: null,
      };
    }
    // safetyCheckpoint: true records the pre-restore state — the undo point that
    // makes this rewind reversible (restore that checkpoint to reverse it).
    const result = await this.workspace.restore(checkpoint.id, { safetyCheckpoint: true });
    return {
      files: {
        restored: true,
        checkpointId: result.checkpointId,
        safetyCheckpointId: result.safetyCheckpointId,
        restoredFileCount: result.restoredFiles.length,
        removedFileCount: result.removedFiles.length,
      },
      undoFiles: result.safetyCheckpointId ? { restoreCheckpointId: result.safetyCheckpointId } : null,
    };
  }

  private async applyConversation(
    anchor: RewindAnchor,
    warnings: string[],
  ): Promise<{ conversation: RewindReceiptConversation; undoConversation: RewindUndo['conversation'] }> {
    if (!this.conversation) {
      warnings.push('conversation rewind skipped: no conversation store is wired on this runtime');
      return { conversation: { rewound: false, droppedMessages: 0, undoSnapshotId: null }, undoConversation: null };
    }
    const outcome = await this.conversation.rewind(anchor);
    return {
      conversation: { rewound: true, droppedMessages: outcome.droppedMessages, undoSnapshotId: outcome.undoSnapshotId },
      undoConversation: { undoSnapshotId: outcome.undoSnapshotId },
    };
  }

  private emitEvent(event: WorkspaceEvent, sessionId: string): void {
    if (!this.emitSink) return;
    try {
      this.emitSink(event, sessionId);
    } catch {
      // Never throw from event emission.
    }
  }
}
