/**
 * operator-contract-schemas-rewind.ts
 *
 * Input/output JSON schemas for rewind.plan + rewind.apply — the unified
 * message-anchored rewind (see platform/rewind/). rewind.plan is a read-only
 * dry-run preview that mints a single-use confirm token; rewind.apply consumes
 * it (or confirm:true) and returns a receipt whose `undo` block records how to
 * reverse the rewind. ws-only invoke verbs (no REST binding). Handlers:
 * routes/rewind.ts.
 */
import {
  BOOLEAN_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  STRING_LIST_SCHEMA,
  enumSchema,
  nullableSchema,
  objectSchema,
} from './operator-contract-schemas-shared.js';

const REWIND_SCOPE_SCHEMA = enumSchema(['files', 'conversation', 'both']);

export const REWIND_PLAN_INPUT_SCHEMA = objectSchema(
  {
    sessionId: STRING_SCHEMA,
    turnId: STRING_SCHEMA,
    scope: REWIND_SCOPE_SCHEMA,
  },
  ['sessionId', 'scope'],
);

export const REWIND_APPLY_INPUT_SCHEMA = objectSchema(
  {
    sessionId: STRING_SCHEMA,
    turnId: STRING_SCHEMA,
    scope: REWIND_SCOPE_SCHEMA,
    confirm: BOOLEAN_SCHEMA,
    confirmToken: STRING_SCHEMA,
  },
  ['sessionId', 'scope'],
);

const REWIND_PLAN_FILES_SCHEMA = objectSchema(
  {
    available: BOOLEAN_SCHEMA,
    checkpointId: nullableSchema(STRING_SCHEMA),
    checkpointLabel: nullableSchema(STRING_SCHEMA),
    affectedFileCount: NUMBER_SCHEMA,
  },
  ['available', 'checkpointId', 'checkpointLabel', 'affectedFileCount'],
);

const REWIND_PLAN_CONVERSATION_SCHEMA = objectSchema(
  {
    available: BOOLEAN_SCHEMA,
    messagesToDrop: NUMBER_SCHEMA,
    messagesRemaining: NUMBER_SCHEMA,
  },
  ['available', 'messagesToDrop', 'messagesRemaining'],
);

export const REWIND_PLAN_OUTPUT_SCHEMA = objectSchema(
  {
    sessionId: STRING_SCHEMA,
    turnId: nullableSchema(STRING_SCHEMA),
    scope: REWIND_SCOPE_SCHEMA,
    token: STRING_SCHEMA,
    expiresAt: NUMBER_SCHEMA,
    files: nullableSchema(REWIND_PLAN_FILES_SCHEMA),
    conversation: nullableSchema(REWIND_PLAN_CONVERSATION_SCHEMA),
    warnings: STRING_LIST_SCHEMA,
  },
  ['sessionId', 'turnId', 'scope', 'token', 'expiresAt', 'files', 'conversation', 'warnings'],
);

const REWIND_RECEIPT_FILES_SCHEMA = objectSchema(
  {
    restored: BOOLEAN_SCHEMA,
    checkpointId: nullableSchema(STRING_SCHEMA),
    safetyCheckpointId: nullableSchema(STRING_SCHEMA),
    restoredFileCount: NUMBER_SCHEMA,
    removedFileCount: NUMBER_SCHEMA,
  },
  ['restored', 'checkpointId', 'safetyCheckpointId', 'restoredFileCount', 'removedFileCount'],
);

const REWIND_RECEIPT_CONVERSATION_SCHEMA = objectSchema(
  {
    rewound: BOOLEAN_SCHEMA,
    droppedMessages: NUMBER_SCHEMA,
    undoSnapshotId: nullableSchema(STRING_SCHEMA),
  },
  ['rewound', 'droppedMessages', 'undoSnapshotId'],
);

const REWIND_UNDO_SCHEMA = objectSchema(
  {
    files: nullableSchema(objectSchema({ restoreCheckpointId: STRING_SCHEMA }, ['restoreCheckpointId'])),
    conversation: nullableSchema(objectSchema({ undoSnapshotId: STRING_SCHEMA }, ['undoSnapshotId'])),
  },
  ['files', 'conversation'],
);

const REWIND_RECEIPT_SCHEMA = objectSchema(
  {
    sessionId: STRING_SCHEMA,
    turnId: nullableSchema(STRING_SCHEMA),
    scope: REWIND_SCOPE_SCHEMA,
    appliedAt: NUMBER_SCHEMA,
    files: nullableSchema(REWIND_RECEIPT_FILES_SCHEMA),
    conversation: nullableSchema(REWIND_RECEIPT_CONVERSATION_SCHEMA),
    undo: REWIND_UNDO_SCHEMA,
    warnings: STRING_LIST_SCHEMA,
  },
  ['sessionId', 'turnId', 'scope', 'appliedAt', 'files', 'conversation', 'undo', 'warnings'],
);

const REWIND_REFUSAL_SCHEMA = objectSchema(
  {
    reason: STRING_SCHEMA,
    confirmField: STRING_SCHEMA,
    planMethod: STRING_SCHEMA,
    options: STRING_LIST_SCHEMA,
  },
  ['reason', 'confirmField', 'planMethod', 'options'],
);

export const REWIND_APPLY_OUTPUT_SCHEMA = objectSchema(
  {
    receipt: nullableSchema(REWIND_RECEIPT_SCHEMA),
    refused: BOOLEAN_SCHEMA,
    refusal: nullableSchema(REWIND_REFUSAL_SCHEMA),
  },
  ['receipt', 'refused', 'refusal'],
);
