/**
 * Wire schemas for the shared approval broker's operator surface: the
 * approval record/snapshot shapes and the approvals.* action inputs/outputs.
 * The decision fields (rememberTier / reason / modifiedArgs) travel over
 * HTTP into the same broker resolution the in-process path uses.
 */
import {
  BOOLEAN_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  arraySchema,
  objectSchema,
} from './method-catalog-shared.js';
import {
  METADATA_SCHEMA,
  TOOL_ARGUMENTS_SCHEMA,
  enumSchema,
  nullableSchema,
} from './operator-contract-schemas-shared.js';
import {
  PERMISSION_MODE_SCHEMA,
  PERMISSION_PROMPT_DECISION_SCHEMA,
  PERMISSION_PROMPT_REQUEST_SCHEMA,
  PERMISSION_REMEMBER_TIER_SCHEMA,
  PERMISSION_RUNTIME_DECISION_SCHEMA,
} from './operator-contract-schemas-permissions.js';

const APPROVAL_STATUS_SCHEMA = enumSchema(['pending', 'claimed', 'approved', 'denied', 'cancelled', 'expired']);

const SHARED_APPROVAL_AUDIT_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  action: enumSchema(['created', 'claimed', 'approved', 'denied', 'cancelled', 'expired', 'updated']),
  actor: STRING_SCHEMA,
  actorSurface: STRING_SCHEMA,
  createdAt: NUMBER_SCHEMA,
  note: STRING_SCHEMA,
}, ['id', 'action', 'actor', 'createdAt']);

export const SHARED_APPROVAL_RECORD_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  callId: STRING_SCHEMA,
  sessionId: STRING_SCHEMA,
  routeId: STRING_SCHEMA,
  status: APPROVAL_STATUS_SCHEMA,
  request: PERMISSION_PROMPT_REQUEST_SCHEMA,
  createdAt: NUMBER_SCHEMA,
  updatedAt: NUMBER_SCHEMA,
  claimedBy: STRING_SCHEMA,
  claimedAt: NUMBER_SCHEMA,
  resolvedAt: NUMBER_SCHEMA,
  resolvedBy: STRING_SCHEMA,
  decision: PERMISSION_PROMPT_DECISION_SCHEMA,
  // The session an ACCEPTED ask spawned, when acceptance starts one (e.g.
  // the CI fix-session a "fix this?" offer starts) — stamped after the spawn
  // and published as a record update so an attached surface can open the
  // session live. Never present on denied records.
  fixSessionId: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
  audit: arraySchema(SHARED_APPROVAL_AUDIT_SCHEMA),
}, ['id', 'callId', 'status', 'request', 'createdAt', 'updatedAt', 'metadata', 'audit']);

export const APPROVAL_SNAPSHOT_SCHEMA = objectSchema({
  awaitingDecision: BOOLEAN_SCHEMA,
  mode: PERMISSION_MODE_SCHEMA,
  lastDecision: PERMISSION_RUNTIME_DECISION_SCHEMA,
  approvalCount: NUMBER_SCHEMA,
  denialCount: NUMBER_SCHEMA,
  cachedChecks: NUMBER_SCHEMA,
  totalChecks: NUMBER_SCHEMA,
  approvals: arraySchema(SHARED_APPROVAL_RECORD_SCHEMA),
}, ['awaitingDecision', 'mode', 'approvalCount', 'denialCount', 'cachedChecks', 'totalChecks', 'approvals'], { additionalProperties: true });

export const APPROVAL_ACTION_INPUT_SCHEMA = objectSchema({
  approvalId: STRING_SCHEMA,
  note: STRING_SCHEMA,
  remember: BOOLEAN_SCHEMA,
}, ['approvalId'], { additionalProperties: false });

// approvals.deny carries the full decision reach: rememberTier ("always deny
// this...") and the user's free-text reason, which rides the structured
// declined result so the model adapts instead of guessing.
export const APPROVAL_DENY_INPUT_SCHEMA = objectSchema({
  approvalId: STRING_SCHEMA,
  note: STRING_SCHEMA,
  remember: BOOLEAN_SCHEMA,
  rememberTier: PERMISSION_REMEMBER_TIER_SCHEMA,
  reason: STRING_SCHEMA,
}, ['approvalId'], { additionalProperties: false });

// approvals.approve additionally accepts an optional per-hunk selection. Absent
// selectedHunks = approve the whole request (exact back-compat). When present,
// the broker filters the edit-tool `edits` array to those indices server-side
// so TUI and webui produce identical modified-edit args; an out-of-range index
// or a non-edit approval is a 400. rememberTier generalizes the decision
// (and sweeps queued asks it covers); modifiedArgs carries an
// argument-modifying approval (e.g. the typed answer to a command's terminal
// prompt) to the waiting call — selectedHunks, when present, supersedes it.
export const APPROVAL_APPROVE_INPUT_SCHEMA = objectSchema({
  approvalId: STRING_SCHEMA,
  note: STRING_SCHEMA,
  remember: BOOLEAN_SCHEMA,
  selectedHunks: arraySchema(NUMBER_SCHEMA),
  rememberTier: PERMISSION_REMEMBER_TIER_SCHEMA,
  reason: STRING_SCHEMA,
  modifiedArgs: TOOL_ARGUMENTS_SCHEMA,
}, ['approvalId'], { additionalProperties: false });

// What the broker actually recorded on the resolved decision — derived from
// the returned record, never echoed from the request, so a surface can report
// "tier recorded / reason stored / answer delivered" without claiming
// optimistically (an already-resolved approval keeps its original decision).
export const APPROVAL_RECORDED_DECISION_SCHEMA = objectSchema({
  approved: BOOLEAN_SCHEMA,
  rememberTier: nullableSchema(PERMISSION_REMEMBER_TIER_SCHEMA),
  reasonStored: BOOLEAN_SCHEMA,
  modifiedArgsDelivered: BOOLEAN_SCHEMA,
}, ['approved', 'rememberTier', 'reasonStored', 'modifiedArgsDelivered'], { additionalProperties: false });

export const APPROVAL_ACTION_OUTPUT_SCHEMA = objectSchema({
  approval: SHARED_APPROVAL_RECORD_SCHEMA,
  recorded: APPROVAL_RECORDED_DECISION_SCHEMA,
}, ['approval']);
