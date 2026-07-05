/**
 * method-catalog-fleet.ts
 *
 * W3-S2 — fleet.* + checkpoints.* method descriptors. Split out of
 * method-catalog-control-core.ts (which was already at the 800-line
 * source-file cap) rather than grown into it, mirroring how
 * method-catalog-control-automation.ts is a sibling split of the same file
 * merged back in by method-catalog-control.ts.
 *
 * Thin read (fleet) / checkpoint-lifecycle verbs over managers the daemon
 * ALREADY holds in-process (ProcessRegistry, WorkspaceCheckpointManager —
 * see routes/fleet.ts and routes/checkpoints.ts header comments). No `http`
 * REST path is bound: these are registered with a direct handler on the
 * catalog (RuntimeServices construction, ../runtime/services.ts).
 * `transport: ['ws']` with no `http` binding is the transport-parity gate's
 * (test/transport-parity.test.ts) own sanctioned category for a method
 * dispatchable ONLY via the generic invoke-by-id mechanism — see the
 * TRANSPORT NOTE above `sessions.search` in method-catalog-control-core.ts
 * for the full rationale (this block predates that comment only in file
 * position, not in reasoning).
 */
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import { EMPTY_OBJECT_SCHEMA, methodDescriptor } from './method-catalog-shared.js';
import {
  CHECKPOINTS_CREATE_INPUT_SCHEMA,
  CHECKPOINTS_CREATE_OUTPUT_SCHEMA,
  CHECKPOINTS_DIFF_INPUT_SCHEMA,
  CHECKPOINTS_DIFF_OUTPUT_SCHEMA,
  CHECKPOINTS_LIST_INPUT_SCHEMA,
  CHECKPOINTS_LIST_OUTPUT_SCHEMA,
  CHECKPOINTS_RESTORE_INPUT_SCHEMA,
  CHECKPOINTS_RESTORE_OUTPUT_SCHEMA,
  FLEET_LIST_INPUT_SCHEMA,
  FLEET_LIST_OUTPUT_SCHEMA,
  FLEET_SNAPSHOT_OUTPUT_SCHEMA,
} from './operator-contract-schemas.js';

export const builtinGatewayFleetMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'fleet.snapshot',
    title: 'Fleet Snapshot',
    description: 'Return a point-in-time capture of every live/completed runtime process (agents, WRFC chains/subtasks, workflow FSMs/triggers/schedules, watchers, background processes) as a flat, parentId-linked node list. Capped at 2000 nodes (truncated:true + totalCount when the live fleet exceeds the cap) — use fleet.list to page through a larger fleet.',
    category: 'fleet',
    scopes: ['read:fleet'],
    transport: ['ws'],
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: FLEET_SNAPSHOT_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'fleet.list',
    title: 'List Fleet Processes',
    description: 'Paginated, filtered (kinds/states) query over the live process registry. Cursor pagination returns disjoint pages that union to the full matching set at query time.',
    category: 'fleet',
    scopes: ['read:fleet'],
    transport: ['ws'],
    inputSchema: FLEET_LIST_INPUT_SCHEMA,
    outputSchema: FLEET_LIST_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'checkpoints.list',
    title: 'List Workspace Checkpoints',
    description: 'Return workspace checkpoints (whole-workspace filesystem snapshots), newest first, optionally filtered by kind/since and capped by limit.',
    category: 'checkpoints',
    scopes: ['read:checkpoints'],
    transport: ['ws'],
    inputSchema: CHECKPOINTS_LIST_INPUT_SCHEMA,
    outputSchema: CHECKPOINTS_LIST_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'checkpoints.create',
    title: 'Create Workspace Checkpoint',
    description: 'Create a new workspace checkpoint. Returns checkpoint:null, noop:true (not an error) when the workspace tree is identical to the most recent checkpoint — no commit, ref, or manifest entry is created in that case.',
    category: 'checkpoints',
    scopes: ['write:checkpoints'],
    transport: ['ws'],
    inputSchema: CHECKPOINTS_CREATE_INPUT_SCHEMA,
    outputSchema: CHECKPOINTS_CREATE_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'checkpoints.diff',
    title: 'Diff Workspace Checkpoints',
    description: 'Diff two checkpoints, or one checkpoint against the live working tree when `b` is omitted. An unknown/gc\'d checkpoint id is an honest 404, not a silent empty diff.',
    category: 'checkpoints',
    scopes: ['read:checkpoints'],
    transport: ['ws'],
    inputSchema: CHECKPOINTS_DIFF_INPUT_SCHEMA,
    outputSchema: CHECKPOINTS_DIFF_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'checkpoints.restore',
    title: 'Restore Workspace Checkpoint',
    description: 'DESTRUCTIVE: restore the workspace to the state captured by a checkpoint (git-backed workspace rewrite). Executes immediately with NO server-side confirmation — the calling surface (TUI/webui) owns the confirm UX before invoking this verb. An unknown/gc\'d checkpoint id is an honest 404, not a silent no-op.',
    category: 'checkpoints',
    scopes: ['write:checkpoints'],
    dangerous: true,
    transport: ['ws'],
    inputSchema: CHECKPOINTS_RESTORE_INPUT_SCHEMA,
    outputSchema: CHECKPOINTS_RESTORE_OUTPUT_SCHEMA,
  }),
];
