/**
 * Unified message-anchored rewind, one coordinator over the platform's three
 * existing history stores (workspace checkpoints, conversation snapshots, file
 * undo). Restores files, conversation, or both to a session turn anchor; never
 * a fourth history system.
 */
export { UnifiedRewindService, RewindTokenError, REWIND_CONFIRM_OPTIONS } from './service.js';
export type { UnifiedRewindServiceDeps, RewindApplyOptions } from './service.js';
export { RewindTokenStore, rewindFingerprint, REWIND_TOKEN_TTL_MS } from './tokens.js';
export type { IssuedRewindToken } from './tokens.js';
export {
  ConversationRewindHostBroker,
  ConversationRewindHostError,
  CONVERSATION_ANSWER_TIMEOUT_MS,
  CONVERSATION_HOST_DEFAULT_LEASE_MS,
  CONVERSATION_HOST_MAX_HOSTS,
  CONVERSATION_HOST_MAX_LEASE_MS,
  CONVERSATION_HOST_MAX_PENDING,
  CONVERSATION_HOST_MAX_WAIT_MS,
  CONVERSATION_HOST_MIN_LEASE_MS,
} from './conversation-host-broker.js';
export type {
  ConversationRewindAnswer,
  ConversationRewindHost,
  ConversationRewindHostBrokerOptions,
  ConversationRewindRefusal,
  ConversationRewindRequest,
  ConversationRewindRequestKind,
} from './conversation-host-broker.js';
export type {
  RewindScope,
  RewindAnchor,
  RewindConversationAvailability,
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

export {
  ANCHOR_SIDECAR_SETTLE_MS,
  ANCHOR_TMP_MAX_AGE_MS,
  clearTurnAnchors,
  getTurnAnchors,
  persistTurnAnchors,
  reapOrphanedAnchorSidecars,
  recordTurnAnchor,
  resolveTurnAnchor,
  restoreTurnAnchors,
  summarizeTurnLabel,
} from './turn-anchors.js';
export type {
  AnchorSidecarReapOptions,
  AnchorSidecarReapResult,
  TurnAnchor,
} from './turn-anchors.js';
