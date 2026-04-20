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
   * Emitted when a daemon-home identity file is successfully copied during
   * the one-time migration (0.21.19+ startup with a new daemon home).
   */
  | {
      type: 'WORKSPACE_IDENTITY_MIGRATED';
      /** Source path the file was copied from. */
      from: string;
      /** Destination path under the new daemon home. */
      to: string;
    }
  /**
   * Emitted when a candidate identity file is skipped during migration because
   * it contains corrupt JSON that cannot be safely migrated.
   */
  | {
      type: 'WORKSPACE_IDENTITY_MIGRATION_FAILED';
      /** Path of the source file that was skipped. */
      sourcePath: string;
      /** Human-readable reason (e.g. JSON parse error message). */
      reason: string;
    };

export type WorkspaceEventType = WorkspaceEvent['type'];
