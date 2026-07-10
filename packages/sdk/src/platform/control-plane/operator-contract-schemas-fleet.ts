/**
 * operator-contract-schemas-fleet.ts
 *
 * (see CHANGELOG 1.0.0) — contract schemas for fleet.*, checkpoints.*, and sessions.search.
 * Split out of operator-contract-schemas-runtime.ts (which was already at
 * the 800-line source-file cap) rather than grown into it; re-exported
 * through operator-contract-schemas.ts alongside the other schema modules.
 */
import {
  BOOLEAN_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  arraySchema,
  objectSchema,
} from './method-catalog-shared.js';
import {
  STRING_LIST_SCHEMA,
  enumSchema,
  nullableSchema,
} from './operator-contract-schemas-shared.js';
import { SHARED_SESSION_KIND_READ_SCHEMA, SHARED_SESSION_RECORD_SCHEMA } from './operator-contract-schemas-runtime.js';

const PROCESS_KIND_SCHEMA = enumSchema([
  'agent',
  'wrfc-chain',
  'wrfc-subtask',
  'workflow',
  'trigger',
  'schedule',
  'watcher',
  'background-process',
  'workstream',
  'phase',
  'work-item',
  'code-index',
]);
const PROCESS_STATE_SCHEMA = enumSchema([
  'thinking',
  'executing-tool',
  'awaiting-approval',
  'streaming',
  'stalled',
  'retrying',
  'done',
  'failed',
  'killed',
  'interrupted',
  'idle',
  'queued',
  'paused',
]);
const PROCESS_COST_STATE_SCHEMA = enumSchema(['priced', 'unpriced', 'estimated']);

const PROCESS_USAGE_SCHEMA = objectSchema({
  inputTokens: NUMBER_SCHEMA,
  outputTokens: NUMBER_SCHEMA,
  cacheReadTokens: NUMBER_SCHEMA,
  cacheWriteTokens: NUMBER_SCHEMA,
  reasoningTokens: NUMBER_SCHEMA,
  llmCallCount: NUMBER_SCHEMA,
  turnCount: NUMBER_SCHEMA,
  toolCallCount: NUMBER_SCHEMA,
}, ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'llmCallCount', 'turnCount', 'toolCallCount']);

const PROCESS_ACTIVITY_SCHEMA = objectSchema({
  kind: enumSchema(['tool', 'output-line', 'phase']),
  text: STRING_SCHEMA,
  toolName: STRING_SCHEMA,
  at: NUMBER_SCHEMA,
}, ['kind', 'text', 'at']);

const PROCESS_CAPABILITIES_SCHEMA = objectSchema({
  interruptible: BOOLEAN_SCHEMA,
  killable: BOOLEAN_SCHEMA,
  pausable: BOOLEAN_SCHEMA,
  resumable: BOOLEAN_SCHEMA,
  steerable: BOOLEAN_SCHEMA,
}, ['interruptible', 'killable', 'pausable', 'resumable', 'steerable']);

const PROCESS_SESSION_REF_SCHEMA = objectSchema({
  sessionId: STRING_SCHEMA,
  agentId: STRING_SCHEMA,
}, []);

const PROCESS_ATTENTION_SCHEMA = objectSchema({
  reason: enumSchema(['approval', 'input']),
  detail: STRING_SCHEMA,
}, ['reason']);

export const PROCESS_NODE_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  kind: PROCESS_KIND_SCHEMA,
  parentId: STRING_SCHEMA,
  label: STRING_SCHEMA,
  task: STRING_SCHEMA,
  state: PROCESS_STATE_SCHEMA,
  startedAt: NUMBER_SCHEMA,
  completedAt: NUMBER_SCHEMA,
  elapsedMs: NUMBER_SCHEMA,
  usage: PROCESS_USAGE_SCHEMA,
  model: STRING_SCHEMA,
  provider: STRING_SCHEMA,
  costUsd: nullableSchema(NUMBER_SCHEMA),
  costState: PROCESS_COST_STATE_SCHEMA,
  currentActivity: PROCESS_ACTIVITY_SCHEMA,
  capabilities: PROCESS_CAPABILITIES_SCHEMA,
  needsAttention: PROCESS_ATTENTION_SCHEMA,
  sessionRef: PROCESS_SESSION_REF_SCHEMA,
}, ['id', 'kind', 'label', 'state', 'elapsedMs', 'costState', 'capabilities'], { additionalProperties: true });

export const FLEET_SNAPSHOT_OUTPUT_SCHEMA = objectSchema({
  capturedAt: NUMBER_SCHEMA,
  nodes: arraySchema(PROCESS_NODE_SCHEMA),
  truncated: BOOLEAN_SCHEMA,
  totalCount: NUMBER_SCHEMA,
}, ['capturedAt', 'nodes', 'truncated', 'totalCount']);

export const FLEET_LIST_INPUT_SCHEMA = objectSchema({
  kinds: STRING_LIST_SCHEMA,
  states: STRING_LIST_SCHEMA,
  limit: NUMBER_SCHEMA,
  cursor: STRING_SCHEMA,
}, []);

export const FLEET_LIST_OUTPUT_SCHEMA = objectSchema({
  items: arraySchema(PROCESS_NODE_SCHEMA),
  nextCursor: STRING_SCHEMA,
  hasMore: BOOLEAN_SCHEMA,
  capturedAt: NUMBER_SCHEMA,
}, ['items', 'hasMore', 'capturedAt']);

export const FLEET_ARCHIVE_INPUT_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
}, ['id']);

export const FLEET_ARCHIVE_OUTPUT_SCHEMA = objectSchema({
  archived: BOOLEAN_SCHEMA,
  count: NUMBER_SCHEMA,
  reason: STRING_SCHEMA,
}, ['archived', 'count']);

export const FLEET_UNARCHIVE_OUTPUT_SCHEMA = objectSchema({
  restored: NUMBER_SCHEMA,
}, ['restored']);

export const FLEET_ARCHIVE_FINISHED_OUTPUT_SCHEMA = objectSchema({
  archivedCount: NUMBER_SCHEMA,
}, ['archivedCount']);

export const FLEET_ARCHIVED_LIST_OUTPUT_SCHEMA = objectSchema({
  capturedAt: NUMBER_SCHEMA,
  nodes: arraySchema(PROCESS_NODE_SCHEMA),
}, ['capturedAt', 'nodes']);

const CHECKPOINT_KIND_SCHEMA = enumSchema(['turn', 'agent-run', 'manual']);
const RETENTION_CLASS_SCHEMA = enumSchema(['short', 'standard', 'forensic']);

export const WORKSPACE_CHECKPOINT_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  kind: CHECKPOINT_KIND_SCHEMA,
  label: STRING_SCHEMA,
  createdAt: NUMBER_SCHEMA,
  parentId: nullableSchema(STRING_SCHEMA),
  turnId: STRING_SCHEMA,
  agentId: STRING_SCHEMA,
  sessionId: STRING_SCHEMA,
  retentionClass: RETENTION_CLASS_SCHEMA,
  commit: STRING_SCHEMA,
  sizeBytes: NUMBER_SCHEMA,
}, ['id', 'kind', 'label', 'createdAt', 'parentId', 'retentionClass', 'commit', 'sizeBytes']);

export const CHECKPOINTS_LIST_INPUT_SCHEMA = objectSchema({
  kind: CHECKPOINT_KIND_SCHEMA,
  sessionId: STRING_SCHEMA,
  since: NUMBER_SCHEMA,
  limit: NUMBER_SCHEMA,
}, []);

export const CHECKPOINTS_LIST_OUTPUT_SCHEMA = objectSchema({
  checkpoints: arraySchema(WORKSPACE_CHECKPOINT_SCHEMA),
}, ['checkpoints']);

export const CHECKPOINTS_CREATE_INPUT_SCHEMA = objectSchema({
  kind: CHECKPOINT_KIND_SCHEMA,
  label: STRING_SCHEMA,
  retentionClass: RETENTION_CLASS_SCHEMA,
  turnId: STRING_SCHEMA,
  agentId: STRING_SCHEMA,
  sessionId: STRING_SCHEMA,
  paths: STRING_LIST_SCHEMA,
}, ['kind']);

export const CHECKPOINTS_CREATE_OUTPUT_SCHEMA = objectSchema({
  checkpoint: nullableSchema(WORKSPACE_CHECKPOINT_SCHEMA),
  noop: BOOLEAN_SCHEMA,
}, ['checkpoint', 'noop']);

export const CHECKPOINT_DIFF_SCHEMA = objectSchema({
  from: STRING_SCHEMA,
  to: STRING_SCHEMA,
  files: STRING_LIST_SCHEMA,
  unifiedDiff: STRING_SCHEMA,
  stat: STRING_SCHEMA,
}, ['from', 'to', 'files', 'unifiedDiff', 'stat']);

export const CHECKPOINTS_DIFF_INPUT_SCHEMA = objectSchema({
  a: STRING_SCHEMA,
  b: STRING_SCHEMA,
}, ['a']);

export const CHECKPOINTS_DIFF_OUTPUT_SCHEMA = objectSchema({
  diff: CHECKPOINT_DIFF_SCHEMA,
}, ['diff']);

export const CHECKPOINT_RESTORE_RESULT_SCHEMA = objectSchema({
  checkpointId: STRING_SCHEMA,
  safetyCheckpointId: nullableSchema(STRING_SCHEMA),
  restoredFiles: STRING_LIST_SCHEMA,
  removedFiles: STRING_LIST_SCHEMA,
}, ['checkpointId', 'safetyCheckpointId', 'restoredFiles', 'removedFiles']);

/**
 * The structured, non-error body returned when `checkpoints.restore` is called
 * WITHOUT confirmation (`result` is null, `refused` is true). It names both
 * acknowledgment paths so a caller can act without guessing — this is an
 * honest "here is how to proceed", not a failure.
 */
export const CHECKPOINT_RESTORE_REFUSAL_SCHEMA = objectSchema({
  reason: STRING_SCHEMA,
  confirmField: STRING_SCHEMA,
  previewMethod: STRING_SCHEMA,
  options: STRING_LIST_SCHEMA,
}, ['reason', 'confirmField', 'previewMethod', 'options']);

export const CHECKPOINTS_RESTORE_INPUT_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  paths: STRING_LIST_SCHEMA,
  safetyCheckpoint: BOOLEAN_SCHEMA,
  confirm: BOOLEAN_SCHEMA,
  confirmToken: STRING_SCHEMA,
}, ['id']);

export const CHECKPOINTS_RESTORE_OUTPUT_SCHEMA = objectSchema({
  result: nullableSchema(CHECKPOINT_RESTORE_RESULT_SCHEMA),
  refused: BOOLEAN_SCHEMA,
  refusal: nullableSchema(CHECKPOINT_RESTORE_REFUSAL_SCHEMA),
}, ['result', 'refused', 'refusal']);

/** What a restore of a given checkpoint would change, computed from the manager's own diff. */
export const CHECKPOINT_RESTORE_PREVIEW_SCHEMA = objectSchema({
  checkpointId: STRING_SCHEMA,
  label: STRING_SCHEMA,
  affectedPathCount: NUMBER_SCHEMA,
  affectedPathSample: STRING_LIST_SCHEMA,
  stat: STRING_SCHEMA,
}, ['checkpointId', 'label', 'affectedPathCount', 'affectedPathSample', 'stat']);

export const CHECKPOINTS_RESTORE_PREVIEW_INPUT_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  paths: STRING_LIST_SCHEMA,
}, ['id']);

export const CHECKPOINTS_RESTORE_PREVIEW_OUTPUT_SCHEMA = objectSchema({
  token: STRING_SCHEMA,
  expiresAt: NUMBER_SCHEMA,
  preview: CHECKPOINT_RESTORE_PREVIEW_SCHEMA,
}, ['token', 'expiresAt', 'preview']);

// ── Per-hunk revert (checkpoints.revertHunkPreview / checkpoints.revertHunk) ──
// A confirm-gated reverse-apply of ONE unified-diff hunk (copied out of a
// checkpoints.diff / sessions.changes.get diff) against the live working tree.
// The preview validates the hunk still reverse-applies cleanly and mints a
// single-use token; the apply consumes it, snapshots, and writes. Both ws-only.

export const CHECKPOINTS_REVERT_HUNK_PREVIEW_INPUT_SCHEMA = objectSchema({
  path: STRING_SCHEMA,
  hunk: STRING_SCHEMA,
  sessionId: STRING_SCHEMA,
}, ['path', 'hunk']);

/**
 * Whether reverting `hunk` in `path` would apply cleanly right now (read-only).
 * `applies:false` with a human-readable `conflict` (and null token) is an honest
 * "this hunk is stale", NOT an error. A token is minted only when `applies:true`.
 */
export const CHECKPOINTS_REVERT_HUNK_PREVIEW_OUTPUT_SCHEMA = objectSchema({
  path: STRING_SCHEMA,
  applies: BOOLEAN_SCHEMA,
  conflict: nullableSchema(STRING_SCHEMA),
  hunkHeader: nullableSchema(STRING_SCHEMA),
  addedLinesRemoved: NUMBER_SCHEMA,
  removedLinesRestored: NUMBER_SCHEMA,
  matchedAtLine: nullableSchema(NUMBER_SCHEMA),
  token: nullableSchema(STRING_SCHEMA),
  expiresAt: nullableSchema(NUMBER_SCHEMA),
}, ['path', 'applies', 'conflict', 'hunkHeader', 'addedLinesRemoved', 'removedLinesRestored', 'matchedAtLine', 'token', 'expiresAt']);

export const CHECKPOINTS_REVERT_HUNK_INPUT_SCHEMA = objectSchema({
  path: STRING_SCHEMA,
  hunk: STRING_SCHEMA,
  sessionId: STRING_SCHEMA,
  confirm: BOOLEAN_SCHEMA,
  confirmToken: STRING_SCHEMA,
}, ['path', 'hunk']);

/** The undo handle recorded before the revert: restore this checkpoint to reverse it. */
export const CHECKPOINTS_REVERT_HUNK_UNDO_SCHEMA = objectSchema({
  restoreCheckpointId: STRING_SCHEMA,
}, ['restoreCheckpointId']);

/** The receipt of a single applied hunk revert — reversible via `undo`. */
export const CHECKPOINTS_REVERT_HUNK_RECEIPT_SCHEMA = objectSchema({
  reverted: BOOLEAN_SCHEMA,
  path: STRING_SCHEMA,
  hunkHeader: STRING_SCHEMA,
  addedLinesRemoved: NUMBER_SCHEMA,
  removedLinesRestored: NUMBER_SCHEMA,
  safetyCheckpointId: nullableSchema(STRING_SCHEMA),
  undo: nullableSchema(CHECKPOINTS_REVERT_HUNK_UNDO_SCHEMA),
}, ['reverted', 'path', 'hunkHeader', 'addedLinesRemoved', 'removedLinesRestored', 'safetyCheckpointId', 'undo']);

/**
 * The non-error body returned when checkpoints.revertHunk is called WITHOUT
 * confirmation (`receipt` null, `refused` true), naming both acknowledgment
 * paths — the same honest-refusal shape checkpoints.restore / rewind.apply use.
 */
export const CHECKPOINTS_REVERT_HUNK_REFUSAL_SCHEMA = objectSchema({
  reason: STRING_SCHEMA,
  confirmField: STRING_SCHEMA,
  previewMethod: STRING_SCHEMA,
  options: STRING_LIST_SCHEMA,
}, ['reason', 'confirmField', 'previewMethod', 'options']);

export const CHECKPOINTS_REVERT_HUNK_OUTPUT_SCHEMA = objectSchema({
  receipt: nullableSchema(CHECKPOINTS_REVERT_HUNK_RECEIPT_SCHEMA),
  refused: BOOLEAN_SCHEMA,
  refusal: nullableSchema(CHECKPOINTS_REVERT_HUNK_REFUSAL_SCHEMA),
}, ['receipt', 'refused', 'refusal']);

export const SESSIONS_SEARCH_INPUT_SCHEMA = objectSchema({
  query: STRING_SCHEMA,
  project: STRING_SCHEMA,
  kind: SHARED_SESSION_KIND_READ_SCHEMA,
  surfaceKind: STRING_SCHEMA,
  status: enumSchema(['active', 'closed']),
  includeClosed: BOOLEAN_SCHEMA,
  limit: NUMBER_SCHEMA,
  cursor: STRING_SCHEMA,
}, []);

export const SESSIONS_SEARCH_OUTPUT_SCHEMA = objectSchema({
  sessions: arraySchema(SHARED_SESSION_RECORD_SCHEMA),
  nextCursor: STRING_SCHEMA,
  hasMore: BOOLEAN_SCHEMA,
}, ['sessions', 'hasMore']);

export const SESSIONS_CHANGES_GET_INPUT_SCHEMA = objectSchema({
  sessionId: STRING_SCHEMA,
}, ['sessionId']);

/**
 * The aggregate workspace file changes a session made, joined over its
 * session-stamped checkpoints (see WorkspaceCheckpointManager.sessionChanges).
 * `checkpointCount: 0` with an empty diff is an honest "nothing recorded for
 * this session", not an error.
 */
export const SESSIONS_CHANGES_GET_OUTPUT_SCHEMA = objectSchema({
  sessionId: STRING_SCHEMA,
  checkpointCount: NUMBER_SCHEMA,
  checkpointIds: STRING_LIST_SCHEMA,
  from: STRING_SCHEMA,
  to: STRING_SCHEMA,
  files: STRING_LIST_SCHEMA,
  unifiedDiff: STRING_SCHEMA,
  stat: STRING_SCHEMA,
}, ['sessionId', 'checkpointCount', 'checkpointIds', 'from', 'to', 'files', 'unifiedDiff', 'stat']);
