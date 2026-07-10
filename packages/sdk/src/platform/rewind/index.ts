/**
 * Unified message-anchored rewind — one coordinator over the platform's three
 * existing history stores (workspace checkpoints, conversation snapshots, file
 * undo). Restores files, conversation, or both to a session turn anchor; never
 * a fourth history system.
 */
export { UnifiedRewindService, RewindTokenError, REWIND_CONFIRM_OPTIONS } from './service.js';
export type { UnifiedRewindServiceDeps, RewindApplyOptions } from './service.js';
export { RewindTokenStore, rewindFingerprint, REWIND_TOKEN_TTL_MS } from './tokens.js';
export type { IssuedRewindToken } from './tokens.js';
export type {
  RewindScope,
  RewindAnchor,
  RewindCheckpointView,
  RewindCheckpointDiff,
  RewindRestoreResult,
  RewindWorkspacePort,
  RewindConversationPort,
  RewindConversationPreview,
  RewindConversationOutcome,
  RewindEventSink,
  RewindPlan,
  RewindPlanFiles,
  RewindPlanConversation,
  RewindReceipt,
  RewindReceiptFiles,
  RewindReceiptConversation,
  RewindUndo,
  RewindRefusal,
  RewindApplyResult,
} from './types.js';
