/**
 * method-catalog-update.ts — asking a daemon whether it is keeping itself current.
 *
 * The self-update loop already knew all of this: its cadence, how many checks
 * in a row had thrown and what the last one said, a release it had downloaded
 * and verified and was holding until the daemon went idle, and a release a
 * crash-loop rollback had rejected and will not reinstall. All of it lived in
 * one process's memory and a log file, so the only way to answer "is this
 * daemon updating itself" was shell access to the host.
 *
 * That is the gap these two verbs close, and the reason it matters is on the
 * record: a daemon whose update checks had been failing stayed on an old build
 * while three releases shipped, and every surface reported it as healthy,
 * because "has not updated" and "cannot update" produce identical silence.
 *
 * `update.check` runs the SAME tick the schedule runs — not a second path — so
 * an on-demand check and the hourly one cannot come to different conclusions.
 * It does not force an install: a verified swap still waits for a moment when
 * no work is in flight, which is what `pendingVersion` reports.
 */
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import {
  BOOLEAN_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  methodDescriptor,
  objectSchema,
} from './method-catalog-shared.js';

const UPDATE_STATUS_SCHEMA = objectSchema({
  armed: BOOLEAN_SCHEMA,
  offReason: STRING_SCHEMA,
  currentVersion: { anyOf: [STRING_SCHEMA, { type: 'null' }] },
  releasesUrl: STRING_SCHEMA,
  checkIntervalMs: { anyOf: [NUMBER_SCHEMA, { type: 'null' }] },
  firstCheckDelayMs: { anyOf: [NUMBER_SCHEMA, { type: 'null' }] },
  failedCheckCount: NUMBER_SCHEMA,
  lastCheckFailure: { anyOf: [STRING_SCHEMA, { type: 'null' }] },
  pendingVersion: { anyOf: [STRING_SCHEMA, { type: 'null' }] },
  rejectedVersion: { anyOf: [STRING_SCHEMA, { type: 'null' }] },
}, [
  'armed', 'offReason', 'currentVersion', 'releasesUrl', 'checkIntervalMs',
  'firstCheckDelayMs', 'failedCheckCount', 'lastCheckFailure', 'pendingVersion', 'rejectedVersion',
]);

export const builtinGatewayUpdateMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'update.status',
    title: 'Self-Update Status',
    description: 'Whether this daemon is keeping itself current, and — when it is not — the reason in one line. `armed` is false whenever no loop is running and `offReason` says which gate stopped it: update.auto not set, no artifact identity (a host that manages its own updates), or no release URL to resolve tags from. `failedCheckCount` with `lastCheckFailure` is the case that used to be invisible: checks running on schedule and failing every time, which looks exactly like having nothing to update to. `pendingVersion` is a release already downloaded and verified, waiting for a moment when no work is in flight. `rejectedVersion` is a release that was installed here, failed to start, and was rolled back — it is deliberately not reinstalled.',
    category: 'control-plane',
    scopes: ['read:control-plane'],
    transport: ['ws'],
    // Declared and empty rather than omitted: the invoke gate skips a verb with
    // no typed inputSchema, so "takes nothing" has to be stated to be enforced.
    inputSchema: objectSchema({}, []),
    outputSchema: UPDATE_STATUS_SCHEMA,
  }),
  methodDescriptor({
    id: 'update.check',
    title: 'Check For An Update Now',
    description: 'Run one update check immediately instead of waiting for the next interval, and return the status afterwards. This is the same tick the schedule runs, so an on-demand check and the hourly one cannot reach different conclusions. It never forces an install: a downloaded-and-verified release still waits for a moment when no work is in flight, which the returned `pendingVersion` reports. A check that fails is reported in `failedCheckCount` and `lastCheckFailure` rather than refused — the caller asked what the state is, and "the check failed" is the answer. On a daemon with no loop armed this returns the same status `update.status` would, with `offReason` saying why nothing ran.',
    category: 'control-plane',
    scopes: ['write:control-plane'],
    access: 'admin',
    transport: ['ws'],
    inputSchema: objectSchema({}, []),
    outputSchema: UPDATE_STATUS_SCHEMA,
  }),
];
