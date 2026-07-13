/**
 * Automation scheduler honesty when a job fails or is slept through:
 *  1. Failure notices default to the job's own delivery targets (override wins,
 *     push/fallback targets as fallback), and an unreachable job logs the gap.
 *  2. A run missed past the catch-up window becomes a first-class `missed`
 *     record that flows the same delivery path as a failure.
 *  3. The runs source can be filtered to "since" a moment (the away-digest read).
 *  4. Scheduling detects drift and records the miss (the mechanism the daemon's
 *     boot + reachability-heartbeat reconcile drives).
 */

import { describe, expect, test } from 'bun:test';
import {
  maybeDeliverAutomationFailureNotice,
  resolveAutomationFailureNoticeTargets,
} from '../packages/sdk/src/platform/automation/manager-runtime-delivery.ts';
import {
  describeMissedRunReason,
  recordAutomationMissedRun,
} from '../packages/sdk/src/platform/automation/manager-runtime-missed.ts';
import { scheduleAutomationJob } from '../packages/sdk/src/platform/automation/manager-runtime-scheduling.ts';
import { createDaemonRuntimeAutomationRouteHandlers } from '../packages/daemon-sdk/src/runtime-automation-routes.ts';
import type { AutomationDeliveryManager } from '../packages/sdk/src/platform/automation/delivery-manager.ts';
import type { AutomationDeliveryTarget } from '../packages/sdk/src/platform/automation/delivery.ts';
import type { AutomationJob } from '../packages/sdk/src/platform/automation/jobs.ts';
import type { AutomationRun } from '../packages/sdk/src/platform/automation/runs.ts';

function makeJob(overrides: Partial<AutomationJob> = {}): AutomationJob {
  const now = Date.now();
  return {
    id: 'job-1',
    labels: [],
    createdAt: now,
    updatedAt: now,
    name: 'Nightly report',
    status: 'enabled',
    enabled: true,
    schedule: { kind: 'every', intervalMs: 3_600_000 },
    execution: { prompt: 'do it', target: { kind: 'isolated' } },
    delivery: {
      mode: 'surface',
      targets: [],
      fallbackTargets: [],
      includeSummary: false,
      includeTranscript: false,
      includeLinks: false,
    },
    failure: {
      action: 'retry',
      maxConsecutiveFailures: 3,
      cooldownMs: 1_000,
      retryPolicy: { maxAttempts: 1, delayMs: 1_000, strategy: 'fixed' },
    },
    source: {
      id: 'src-1',
      kind: 'schedule',
      label: 'schedule',
      enabled: true,
      createdAt: now,
      updatedAt: now,
      metadata: {},
    },
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    deleteAfterRun: false,
    ...overrides,
  };
}

function makeRun(overrides: Partial<AutomationRun> = {}): AutomationRun {
  const now = Date.now();
  return {
    id: 'run-1',
    labels: [],
    createdAt: now,
    updatedAt: now,
    jobId: 'job-1',
    status: 'failed',
    triggeredBy: {
      id: 'src-1',
      kind: 'schedule',
      label: 'schedule',
      enabled: true,
      createdAt: now,
      updatedAt: now,
      metadata: {},
    },
    target: { kind: 'isolated' },
    execution: { prompt: 'do it', target: { kind: 'isolated' } },
    queuedAt: now,
    forceRun: false,
    dueRun: true,
    attempt: 1,
    deliveryIds: [],
    error: 'boom',
    ...overrides,
  };
}

const target = (routeId: string): AutomationDeliveryTarget => ({ kind: 'surface', routeId });

describe('failure-notice target resolution (item 1)', () => {
  test('per-job failure override wins over the delivery targets', () => {
    const job = makeJob({
      delivery: { mode: 'surface', targets: [target('normal')], fallbackTargets: [target('fb')], includeSummary: false, includeTranscript: false, includeLinks: false },
      failure: { action: 'retry', maxConsecutiveFailures: 3, cooldownMs: 1_000, retryPolicy: { maxAttempts: 1, delayMs: 1_000, strategy: 'fixed' }, notifyRouteId: 'alert-route' },
    });
    const resolved = resolveAutomationFailureNoticeTargets(job);
    expect(resolved.primary.map((t) => t.routeId)).toEqual(['alert-route']);
    expect(resolved.fallback).toEqual([]);
  });

  test('with no override, defaults to the job\'s own delivery targets + fallback', () => {
    const job = makeJob({
      delivery: { mode: 'surface', targets: [target('normal')], fallbackTargets: [target('push')], includeSummary: false, includeTranscript: false, includeLinks: false },
    });
    const resolved = resolveAutomationFailureNoticeTargets(job);
    expect(resolved.primary.map((t) => t.routeId)).toEqual(['normal']);
    expect(resolved.fallback.map((t) => t.routeId)).toEqual(['push']);
  });

  test('falls back to replyToRouteId when no explicit targets', () => {
    const job = makeJob({
      delivery: { mode: 'surface', targets: [], fallbackTargets: [], includeSummary: false, includeTranscript: false, includeLinks: false, replyToRouteId: 'reply-route' },
    });
    const resolved = resolveAutomationFailureNoticeTargets(job);
    expect(resolved.primary.map((t) => t.routeId)).toEqual(['reply-route']);
  });

  test('delivery mode "none" with no override yields no target', () => {
    const job = makeJob({
      delivery: { mode: 'none', targets: [target('ignored')], fallbackTargets: [], includeSummary: false, includeTranscript: false, includeLinks: false },
    });
    const resolved = resolveAutomationFailureNoticeTargets(job);
    expect(resolved.primary).toEqual([]);
    expect(resolved.fallback).toEqual([]);
  });

  test('a job with no reachable target invokes the honest-gap callback and does not deliver', () => {
    const job = makeJob({
      delivery: { mode: 'none', targets: [], fallbackTargets: [], includeSummary: false, includeTranscript: false, includeLinks: false },
    });
    let gapCount = 0;
    let delivered = 0;
    const fakeManager = {
      deliverText: async () => { delivered += 1; return []; },
    } as unknown as AutomationDeliveryManager;
    maybeDeliverAutomationFailureNotice(fakeManager, job, makeRun(), () => { gapCount += 1; });
    expect(gapCount).toBe(1);
    expect(delivered).toBe(0);
  });

  test('a reachable job delivers to its own targets', async () => {
    const job = makeJob({
      delivery: { mode: 'surface', targets: [target('normal')], fallbackTargets: [], includeSummary: false, includeTranscript: false, includeLinks: false },
    });
    const seen: AutomationDeliveryTarget[][] = [];
    const fakeManager = {
      deliverText: async (_j: AutomationJob, _r: AutomationRun, _b: string, targets: readonly AutomationDeliveryTarget[]) => {
        seen.push([...targets]);
        return targets.map((t) => ({ id: 'd', runId: 'run-1', jobId: 'job-1', target: t, status: 'sent' as const }));
      },
    } as unknown as AutomationDeliveryManager;
    let gaps = 0;
    maybeDeliverAutomationFailureNotice(fakeManager, job, makeRun(), () => { gaps += 1; });
    await Promise.resolve();
    await Promise.resolve();
    expect(gaps).toBe(0);
    expect(seen[0]?.map((t) => t.routeId)).toEqual(['normal']);
  });
});

describe('missed-run records (item 2)', () => {
  test('records a missed run, delivers it, and dedupes the same occurrence', () => {
    const runs = new Map<string, AutomationRun>();
    const delivered: AutomationRun[] = [];
    const ctx = {
      runs,
      saveRuns: async () => {},
      syncRunToRuntime: () => {},
      deliverFailureNotice: (_j: AutomationJob, r: AutomationRun) => { delivered.push(r); },
      pruneRunHistory: () => {},
    };
    const job = makeJob();
    const plannedRunAt = Date.now() - 3_600_000;

    const first = recordAutomationMissedRun(ctx, job, plannedRunAt);
    expect(first.status).toBe('missed');
    expect(first.queuedAt).toBe(plannedRunAt);
    expect(runs.size).toBe(1);
    expect(delivered).toHaveLength(1);

    const second = recordAutomationMissedRun(ctx, job, plannedRunAt);
    expect(second.id).toBe(first.id);
    expect(runs.size).toBe(1);
    expect(delivered).toHaveLength(1);
  });

  test('reason states the observable fact and the overdue magnitude', () => {
    const now = 10 * 3_600_000;
    const reason = describeMissedRunReason(now - 2 * 3_600_000, now);
    expect(reason).toContain('missed');
    expect(reason).toContain('120 min');
  });
});

describe('runs source filters by "since" (item 3)', () => {
  function handlersForRuns(runs: readonly { id: string; jobId: string; status: string; queuedAt: number; endedAt?: number }[]) {
    const context = { automationManager: { listRuns: () => runs } } as never;
    return createDaemonRuntimeAutomationRouteHandlers(context);
  }

  test('?since keeps only runs active on or after the moment (by queuedAt or endedAt)', async () => {
    const handlers = handlersForRuns([
      { id: 'old', jobId: 'j', status: 'completed', queuedAt: 1_000, endedAt: 1_500 },
      { id: 'spanning', jobId: 'j', status: 'failed', queuedAt: 1_000, endedAt: 9_000 },
      { id: 'recent', jobId: 'j', status: 'missed', queuedAt: 8_000 },
    ]);
    const res = handlers.getAutomationRuns(new URL('http://d/api/automation/runs?since=5000'));
    const body = await res.json() as { runs: { id: string }[] };
    expect(body.runs.map((r) => r.id).sort()).toEqual(['recent', 'spanning']);
  });

  test('no ?since returns the full list unchanged', async () => {
    const handlers = handlersForRuns([
      { id: 'a', jobId: 'j', status: 'completed', queuedAt: 1_000 },
      { id: 'b', jobId: 'j', status: 'failed', queuedAt: 2_000 },
    ]);
    const res = handlers.getAutomationRuns(new URL('http://d/api/automation/runs'));
    const body = await res.json() as { runs: { id: string }[] };
    expect(body.runs.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });
});

describe('scheduling detects drift and records the miss (items 2 & 4)', () => {
  test('an occurrence older than the catch-up window records a missed run', () => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const missed: number[] = [];
    const job = makeJob({ nextRunAt: Date.now() - 24 * 3_600_000 });
    scheduleAutomationJob({
      configManager: { get: (key: string) => (key === 'automation.catchUpWindowMinutes' ? 30 : undefined) } as never,
      jobs: new Map([[job.id, job]]),
      timers,
      heartbeatWakes: new Map(),
      running: () => true,
      saveJobs: async () => {},
      activeRunCount: () => 0,
      maxConcurrentRuns: () => 4,
      executeJob: async () => makeRun(),
      recordMissedRun: (_job, plannedRunAt) => { missed.push(plannedRunAt); },
    }, job);
    for (const t of timers.values()) clearTimeout(t);
    expect(missed).toHaveLength(1);
  });

  test('a fresh future occurrence records no miss', () => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const missed: number[] = [];
    const job = makeJob({ nextRunAt: Date.now() + 3_600_000 });
    scheduleAutomationJob({
      configManager: { get: (key: string) => (key === 'automation.catchUpWindowMinutes' ? 30 : undefined) } as never,
      jobs: new Map([[job.id, job]]),
      timers,
      heartbeatWakes: new Map(),
      running: () => true,
      saveJobs: async () => {},
      activeRunCount: () => 0,
      maxConcurrentRuns: () => 4,
      executeJob: async () => makeRun(),
      recordMissedRun: (_job, plannedRunAt) => { missed.push(plannedRunAt); },
    }, job);
    for (const t of timers.values()) clearTimeout(t);
    expect(missed).toHaveLength(0);
  });
});
