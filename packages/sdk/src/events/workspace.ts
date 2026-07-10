/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * WorkspaceEvent — discriminated union covering workspace swap lifecycle events.
 *
 * Emitted under the 'workspace' domain on the RuntimeEventBus.
 * Subscribers can react to working-directory changes without polling config.
 */

export type WorkspaceEvent =
  /** Emitted immediately before the swap procedure begins. */
  | {
      type: 'WORKSPACE_SWAP_STARTED';
      from: string;
      to: string;
    }
  /** Emitted after all stores have been re-rooted at the new working directory. */
  | {
      type: 'WORKSPACE_SWAP_COMPLETED';
      from: string;
      to: string;
      /** True if the new path was persisted to daemon-settings.json. */
      persistedInDaemonSettings: boolean;
    }
  /** Emitted when a swap is rejected because at least one session has pending input. */
  | {
      type: 'WORKSPACE_SWAP_REFUSED';
      from: string;
      to: string;
      /** Human-readable reason string. */
      reason: string;
      /** Suggested retry delay in seconds. */
      retryAfter: number;
    }
  /**
   * Emitted when a workspace swap fails (mkdir or rerootStores threw).
   * Any subscriber that saw WORKSPACE_SWAP_STARTED without a subsequent
   * WORKSPACE_SWAP_COMPLETED should watch for this event.
   */
  | {
      type: 'WORKSPACE_SWAP_FAILED';
      /** Original working directory (swap source). */
      from: string;
      /** Target path that was attempted. */
      to: string;
      /** Machine-readable failure code. */
      code: 'INVALID_PATH' | 'REROOT_FAILED' | 'UNKNOWN';
      /** Human-readable reason. */
      reason: string;
    }
  /**
   * A unified rewind was PREVIEWED (rewind.plan) — a surface can render that a
   * rewind to this turn anchor is staged and awaiting confirmation. Read-only:
   * nothing has changed yet.
   */
  | {
      type: 'REWIND_PLANNED';
      sessionId: string;
      /** The turn boundary rewound to, or null for the session's most recent checkpoint. */
      turnId: string | null;
      scope: 'files' | 'conversation' | 'both';
    }
  /**
   * A unified rewind was APPLIED (rewind.apply) — the receipt surfaces render.
   * `undoAvailable` is true when the apply recorded an undo point (a pre-restore
   * safety checkpoint and/or a captured conversation snapshot) so the rewind can
   * be reversed.
   */
  | {
      type: 'REWIND_APPLIED';
      sessionId: string;
      turnId: string | null;
      scope: 'files' | 'conversation' | 'both';
      filesRestored: boolean;
      conversationRewound: boolean;
      undoAvailable: boolean;
    };

export type WorkspaceEventType = WorkspaceEvent['type'];
