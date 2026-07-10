/**
 * method-catalog-ci.ts
 *
 * Contract descriptors for CI-watch: the one-shot per-job status tool
 * (ci.status) and the standing subscription mechanism (ci.watches.*). ci.status
 * lists every job and its conclusion — the doctrine forbids reporting green from
 * a rollup — and the report's overall verdict is derived from those per-job
 * conclusions with continue-on-error jobs flagged as violations.
 */
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import {
  BOOLEAN_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  arraySchema,
  entityOutputSchema,
  listOutputSchema,
  methodDescriptor,
  objectSchema,
} from './method-catalog-shared.js';

const NULLABLE_STRING_SCHEMA = { anyOf: [STRING_SCHEMA, { type: 'null' }] } as const;
const CI_JOB_STATUS_SCHEMA = { type: 'string', enum: ['queued', 'in_progress', 'completed'] } as const;
const CI_OVERALL_SCHEMA = { type: 'string', enum: ['passed', 'failed', 'pending', 'unknown'] } as const;

export const CI_JOB_SCHEMA = objectSchema({
  name: STRING_SCHEMA,
  status: CI_JOB_STATUS_SCHEMA,
  conclusion: NULLABLE_STRING_SCHEMA,
  continueOnError: BOOLEAN_SCHEMA,
  url: STRING_SCHEMA,
}, ['name', 'status', 'conclusion']);

export const CI_REPORT_SCHEMA = objectSchema({
  repo: STRING_SCHEMA,
  ref: STRING_SCHEMA,
  prNumber: NUMBER_SCHEMA,
  overall: CI_OVERALL_SCHEMA,
  jobs: arraySchema(CI_JOB_SCHEMA),
  violations: arraySchema(STRING_SCHEMA),
  checkedAt: NUMBER_SCHEMA,
}, ['repo', 'overall', 'jobs', 'violations', 'checkedAt']);

export const CI_WATCH_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  repo: STRING_SCHEMA,
  ref: STRING_SCHEMA,
  prNumber: NUMBER_SCHEMA,
  deliveryChannel: STRING_SCHEMA,
  triggerFixSession: BOOLEAN_SCHEMA,
  lastOverall: CI_OVERALL_SCHEMA,
  createdAt: NUMBER_SCHEMA,
  updatedAt: NUMBER_SCHEMA,
}, ['id', 'repo', 'deliveryChannel', 'triggerFixSession', 'createdAt', 'updatedAt']);

export const CI_STATUS_INPUT_SCHEMA = objectSchema({
  repo: STRING_SCHEMA,
  ref: STRING_SCHEMA,
  prNumber: NUMBER_SCHEMA,
}, ['repo']);
export const CI_STATUS_OUTPUT_SCHEMA = entityOutputSchema('report', CI_REPORT_SCHEMA);

export const CI_WATCHES_LIST_INPUT_SCHEMA = objectSchema({}, []);
export const CI_WATCHES_LIST_OUTPUT_SCHEMA = listOutputSchema('watches', CI_WATCH_SCHEMA);

export const CI_WATCHES_CREATE_INPUT_SCHEMA = objectSchema({
  repo: STRING_SCHEMA,
  ref: STRING_SCHEMA,
  prNumber: NUMBER_SCHEMA,
  deliveryChannel: STRING_SCHEMA,
  triggerFixSession: BOOLEAN_SCHEMA,
}, ['repo', 'deliveryChannel']);
export const CI_WATCHES_CREATE_OUTPUT_SCHEMA = entityOutputSchema('watch', CI_WATCH_SCHEMA);

export const CI_WATCHES_DELETE_INPUT_SCHEMA = objectSchema({ watchId: STRING_SCHEMA }, ['watchId']);
export const CI_WATCHES_DELETE_OUTPUT_SCHEMA = objectSchema({
  watchId: STRING_SCHEMA,
  deleted: BOOLEAN_SCHEMA,
}, ['watchId', 'deleted']);

export const CI_WATCHES_RUN_INPUT_SCHEMA = objectSchema({ watchId: STRING_SCHEMA }, ['watchId']);
export const CI_WATCHES_RUN_OUTPUT_SCHEMA = objectSchema({
  report: CI_REPORT_SCHEMA,
  notified: BOOLEAN_SCHEMA,
  notificationId: STRING_SCHEMA,
  fixSessionTriggered: BOOLEAN_SCHEMA,
  fixSessionId: STRING_SCHEMA,
}, ['report', 'notified', 'fixSessionTriggered']);

export const builtinGatewayCiMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'ci.status',
    title: 'CI Per-Job Status',
    description: 'Poll GitHub for a repo/ref/PR and return EVERY job with its conclusion. The overall verdict is derived from the per-job conclusions (never a rollup); continue-on-error jobs are surfaced as violations and force the verdict off "passed".',
    category: 'ci',
    scopes: ['read:ci'],
    http: { method: 'POST', path: '/api/ci/status' },
    inputSchema: CI_STATUS_INPUT_SCHEMA,
    outputSchema: CI_STATUS_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'ci.watches.list',
    title: 'List CI Watches',
    description: 'Return every standing CI watch (repo/ref/PR, delivery channel, and whether a fix-session is opted in on failure).',
    category: 'ci',
    scopes: ['read:ci'],
    http: { method: 'GET', path: '/api/ci/watches' },
    inputSchema: CI_WATCHES_LIST_INPUT_SCHEMA,
    outputSchema: CI_WATCHES_LIST_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'ci.watches.create',
    title: 'Create CI Watch',
    description: 'Create a standing watch on a repo/ref or PR. On transition to a terminal verdict it notifies the delivery channel; set triggerFixSession to opt in to starting a fix-session pre-briefed with the failing jobs on failure.',
    category: 'ci',
    scopes: ['write:ci'],
    http: { method: 'POST', path: '/api/ci/watches' },
    inputSchema: CI_WATCHES_CREATE_INPUT_SCHEMA,
    outputSchema: CI_WATCHES_CREATE_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'ci.watches.delete',
    title: 'Delete CI Watch',
    description: 'Remove a standing CI watch. Returns { deleted: false } when no watch with that id existed.',
    category: 'ci',
    scopes: ['write:ci'],
    http: { method: 'DELETE', path: '/api/ci/watches/{watchId}' },
    inputSchema: CI_WATCHES_DELETE_INPUT_SCHEMA,
    outputSchema: CI_WATCHES_DELETE_OUTPUT_SCHEMA,
    dangerous: true,
  }),
  methodDescriptor({
    id: 'ci.watches.run',
    title: 'Check CI Watch Now',
    description: 'Poll a standing watch immediately: returns the per-job report, whether a completion notification fired, and whether an opted-in fix-session was triggered on failure.',
    category: 'ci',
    scopes: ['write:ci'],
    http: { method: 'POST', path: '/api/ci/watches/{watchId}/run' },
    inputSchema: CI_WATCHES_RUN_INPUT_SCHEMA,
    outputSchema: CI_WATCHES_RUN_OUTPUT_SCHEMA,
  }),
];
