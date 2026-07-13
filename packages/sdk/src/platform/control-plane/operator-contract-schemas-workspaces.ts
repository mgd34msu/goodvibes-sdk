/**
 * operator-contract-schemas-workspaces.ts
 *
 * Input/output JSON schemas for the shared registered-workspace registry verbs:
 * workspaces.registrations.list / .add / .remove and workspaces.resolve (see
 * platform/workspace/registration/). The registry answers "which registered
 * root, if any, covers this path" for the whole platform; coverage flows down a
 * root's subtree and follows the git worktree→main-repo link. Handlers:
 * routes/workspaces.ts.
 */
import {
  BOOLEAN_SCHEMA,
  STRING_SCHEMA,
  arraySchema,
  enumSchema,
  nullableSchema,
  objectSchema,
} from './operator-contract-schemas-shared.js';

const REGISTERED_WORKSPACE_SCHEMA = objectSchema(
  {
    root: STRING_SCHEMA,
    registeredAt: STRING_SCHEMA,
    label: STRING_SCHEMA,
    // Provenance: which surface/flow wrote the record. Absent on records
    // written before provenance existed.
    origin: STRING_SCHEMA,
    // Whether this root is in scope for the automatic checkpoint boundary.
    // ABSENT MEANS FALSE: a plain self-recording never widens another
    // consumer's checkpoint scope; the checkpoint-owning consumer stamps its
    // own roots (re-adding an existing root with this flag upgrades it).
    checkpointEligible: BOOLEAN_SCHEMA,
  },
  ['root', 'registeredAt'],
);

const DECLINED_WORKSPACE_SCHEMA = objectSchema(
  {
    root: STRING_SCHEMA,
    declinedAt: STRING_SCHEMA,
  },
  ['root', 'declinedAt'],
);

// ── workspaces.registrations.list ─────────────────────────────────────────────
export const WORKSPACES_REGISTRATIONS_LIST_INPUT_SCHEMA = objectSchema({}, []);
export const WORKSPACES_REGISTRATIONS_LIST_OUTPUT_SCHEMA = objectSchema(
  {
    workspaces: arraySchema(REGISTERED_WORKSPACE_SCHEMA),
    declines: arraySchema(DECLINED_WORKSPACE_SCHEMA),
  },
  ['workspaces', 'declines'],
);

// ── workspaces.registrations.add ──────────────────────────────────────────────
export const WORKSPACES_REGISTRATIONS_ADD_INPUT_SCHEMA = objectSchema(
  {
    root: STRING_SCHEMA,
    label: STRING_SCHEMA,
    origin: STRING_SCHEMA,
    checkpointEligible: BOOLEAN_SCHEMA,
  },
  ['root'],
);
export const WORKSPACES_REGISTRATIONS_ADD_OUTPUT_SCHEMA = objectSchema(
  {
    workspace: REGISTERED_WORKSPACE_SCHEMA,
    alreadyRegistered: BOOLEAN_SCHEMA,
  },
  ['workspace', 'alreadyRegistered'],
);

// ── workspaces.registrations.remove ───────────────────────────────────────────
export const WORKSPACES_REGISTRATIONS_REMOVE_INPUT_SCHEMA = objectSchema(
  { root: STRING_SCHEMA },
  ['root'],
);
export const WORKSPACES_REGISTRATIONS_REMOVE_OUTPUT_SCHEMA = objectSchema(
  {
    root: STRING_SCHEMA,
    removed: BOOLEAN_SCHEMA,
  },
  ['root', 'removed'],
);

// ── workspaces.resolve ────────────────────────────────────────────────────────
const COVERAGE_STATUS_SCHEMA = enumSchema(['covered', 'declined', 'unknown']);

export const WORKSPACES_RESOLVE_INPUT_SCHEMA = objectSchema(
  {
    path: STRING_SCHEMA,
    // Optional caller-supplied override for the worktree→main-repo link. When
    // absent the daemon probes it. Present mainly so a caller with the git facts
    // in hand can resolve without a second git spawn.
    mainWorktreeRoot: STRING_SCHEMA,
  },
  ['path'],
);
export const WORKSPACES_RESOLVE_OUTPUT_SCHEMA = objectSchema(
  {
    path: STRING_SCHEMA,
    status: COVERAGE_STATUS_SCHEMA,
    coveredBy: nullableSchema(STRING_SCHEMA),
    declinedRoot: nullableSchema(STRING_SCHEMA),
    viaWorktreeLink: BOOLEAN_SCHEMA,
    reason: STRING_SCHEMA,
  },
  ['path', 'status', 'coveredBy', 'declinedRoot', 'viaWorktreeLink', 'reason'],
);
