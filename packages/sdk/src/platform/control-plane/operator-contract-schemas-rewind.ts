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
  arraySchema,
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

// ── Conversation hosting: the surface-facing half of conversation rewind ─────
//
// A surface offers the conversation it is running for a session, takes the
// questions the daemon puts to it, and answers them. See
// platform/rewind/conversation-host-broker.ts for why this is a reverse call
// on the surface's own connection rather than a store the daemon could read.

const CONVERSATION_HOST_SCHEMA = objectSchema(
  {
    hostId: STRING_SCHEMA,
    sessionId: STRING_SCHEMA,
    label: STRING_SCHEMA,
    registeredAt: NUMBER_SCHEMA,
    leaseExpiresAt: NUMBER_SCHEMA,
  },
  ['hostId', 'sessionId', 'label', 'registeredAt', 'leaseExpiresAt'],
);

const CONVERSATION_REQUEST_SCHEMA = objectSchema(
  {
    requestId: STRING_SCHEMA,
    sessionId: STRING_SCHEMA,
    turnId: nullableSchema(STRING_SCHEMA),
    kind: enumSchema(['preview', 'rewind']),
    expiresAt: NUMBER_SCHEMA,
  },
  ['requestId', 'sessionId', 'turnId', 'kind', 'expiresAt'],
);

export const REWIND_CONVERSATION_HOST_REGISTER_INPUT_SCHEMA = objectSchema(
  {
    sessionId: STRING_SCHEMA,
    hostId: STRING_SCHEMA,
    label: STRING_SCHEMA,
    leaseMs: NUMBER_SCHEMA,
  },
  ['sessionId'],
);

export const REWIND_CONVERSATION_HOST_REGISTER_OUTPUT_SCHEMA = objectSchema(
  {
    host: CONVERSATION_HOST_SCHEMA,
    renewed: BOOLEAN_SCHEMA,
    /** The longest a take call may hold open, so a host can size its poll loop. */
    maxWaitMs: NUMBER_SCHEMA,
    /** How long the daemon waits for an answer before reporting unavailable. */
    answerTimeoutMs: NUMBER_SCHEMA,
  },
  ['host', 'renewed', 'maxWaitMs', 'answerTimeoutMs'],
);

export const REWIND_CONVERSATION_HOST_RELEASE_INPUT_SCHEMA = objectSchema(
  {
    sessionId: STRING_SCHEMA,
    hostId: STRING_SCHEMA,
  },
  ['sessionId', 'hostId'],
);

export const REWIND_CONVERSATION_HOST_RELEASE_OUTPUT_SCHEMA = objectSchema(
  {
    released: BOOLEAN_SCHEMA,
    host: CONVERSATION_HOST_SCHEMA,
  },
  ['released', 'host'],
);

export const REWIND_CONVERSATION_HOSTS_LIST_INPUT_SCHEMA = objectSchema({}, []);

export const REWIND_CONVERSATION_HOSTS_LIST_OUTPUT_SCHEMA = objectSchema(
  {
    hosts: arraySchema(CONVERSATION_HOST_SCHEMA),
  },
  ['hosts'],
);

export const REWIND_CONVERSATION_REQUESTS_TAKE_INPUT_SCHEMA = objectSchema(
  {
    hostId: STRING_SCHEMA,
    waitMs: NUMBER_SCHEMA,
    limit: NUMBER_SCHEMA,
  },
  ['hostId'],
);

export const REWIND_CONVERSATION_REQUESTS_TAKE_OUTPUT_SCHEMA = objectSchema(
  {
    requests: arraySchema(CONVERSATION_REQUEST_SCHEMA),
    host: CONVERSATION_HOST_SCHEMA,
  },
  ['requests', 'host'],
);

/**
 * What is required beyond hostId and requestId follows from the REQUEST, not
 * from anything the caller declares: a request is a preview or a rewind, the
 * broker recorded which when it raised it, and an answer that restated it could
 * only ever disagree with it. So the flat required array here is the honest
 * one — there is no client-supplied discriminator a schema could branch on, and
 * naming `messagesToDrop` required would refuse every rewind answer.
 *
 * `unavailableReason` is the one field that overrides the request's kind: a
 * non-empty reason means "this surface cannot serve it", which is a valid
 * answer to either kind and the only way to give one.
 */
export const REWIND_CONVERSATION_REQUESTS_ANSWER_INPUT_SCHEMA = objectSchema(
  {
    hostId: STRING_SCHEMA,
    requestId: STRING_SCHEMA,
    /** Preview answers: how many messages the rewind would drop, and leave. */
    messagesToDrop: NUMBER_SCHEMA,
    messagesRemaining: NUMBER_SCHEMA,
    /** Rewind answers: how many were dropped, and the handle that restores them. */
    droppedMessages: NUMBER_SCHEMA,
    undoSnapshotId: STRING_SCHEMA,
    /** Non-empty: this surface cannot serve the request, and this is why. */
    unavailableReason: STRING_SCHEMA,
  },
  ['hostId', 'requestId'],
);

export const REWIND_CONVERSATION_REQUESTS_ANSWER_OUTPUT_SCHEMA = objectSchema(
  {
    accepted: BOOLEAN_SCHEMA,
    request: CONVERSATION_REQUEST_SCHEMA,
  },
  ['accepted', 'request'],
);
