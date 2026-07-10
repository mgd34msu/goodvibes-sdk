/**
 * method-catalog-rewind.ts
 *
 * The rewind.plan + rewind.apply descriptors — the unified message-anchored
 * rewind that restores files (nearest workspace checkpoint), conversation
 * (truncate session state to the anchor), or both, reusing the platform's
 * existing history stores. rewind.plan is a read-only dry-run preview that
 * mints a single-use confirm token; rewind.apply is destructive and requires
 * that token (or confirm:true), following the checkpoints.restore confirm
 * idiom. ws-only invoke verbs (no REST binding). Handlers: routes/rewind.ts.
 */
import { methodDescriptor } from './method-catalog-shared.js';
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import {
  REWIND_PLAN_INPUT_SCHEMA,
  REWIND_PLAN_OUTPUT_SCHEMA,
  REWIND_APPLY_INPUT_SCHEMA,
  REWIND_APPLY_OUTPUT_SCHEMA,
} from './operator-contract-schemas-rewind.js';

export const builtinGatewayRewindMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'rewind.plan',
    title: 'Preview a Unified Rewind',
    description:
      'Dry-run preview of a unified rewind to a session turn anchor: exactly what restoring files (the nearest workspace checkpoint), conversation (truncating session state to the anchor), or both would change, and a short-lived single-use confirm token authorizing the matching rewind.apply. Read-only — nothing is changed. A part with no store wired on this runtime is reported unavailable in a warning, never faked.',
    category: 'rewind',
    scopes: ['read:checkpoints'],
    transport: ['ws'],
    inputSchema: REWIND_PLAN_INPUT_SCHEMA,
    outputSchema: REWIND_PLAN_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'rewind.apply',
    title: 'Apply a Unified Rewind',
    description:
      'Apply a unified rewind to a session turn anchor, restoring files and/or conversation. DESTRUCTIVE: requires confirmation — either the confirmToken minted by rewind.plan (single-use, ~2 min) or confirm:true. Called without either, it returns a non-error refusal (refused:true) naming rewind.plan, never a silent no-op; a bad token is a 400. Every apply records an undo point (the workspace restore takes a pre-restore safety checkpoint; the conversation store captures its pre-rewind snapshot) so the rewind is itself reversible, and returns a receipt whose `undo` block carries how to reverse it. Emits a REWIND_APPLIED receipt event.',
    category: 'rewind',
    scopes: ['write:checkpoints'],
    transport: ['ws'],
    dangerous: true,
    inputSchema: REWIND_APPLY_INPUT_SCHEMA,
    outputSchema: REWIND_APPLY_OUTPUT_SCHEMA,
  }),
];
