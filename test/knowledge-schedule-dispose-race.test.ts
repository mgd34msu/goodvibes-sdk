/**
 * knowledge-schedule-dispose-race.test.ts
 *
 * `KnowledgeScheduleService` arms its bootstrap schedules from an async path the
 * constructor starts fire-and-forget. That path awaits `store.init()` and then
 * an upsert per schedule, so it is routinely still in flight a few milliseconds
 * after construction returns.
 *
 * `dispose()` cleared the timer map but set no flag, so a teardown that landed
 * inside that window did its work and then watched the in-flight initializer arm
 * three fresh timers behind it. Waiting for the graph to go quiet first hid the
 * defect entirely — which is exactly why this test disposes IMMEDIATELY, the way
 * a short-lived process that composes a graph, answers one question and exits
 * actually behaves.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KnowledgeScheduleService } from '../packages/sdk/src/platform/knowledge/scheduling.ts';
import { KnowledgeStore } from '../packages/sdk/src/platform/knowledge/store.ts';

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
/**
 * Only timers created BY the scheduler are counted, matched on the creation
 * stack. The suite runs every file in one process, so a global pending-timer
 * count also sees unrelated in-flight work left by earlier files — which made
 * this test pass alone and fail in-suite, measuring the suite rather than the
 * subject.
 */
const OWNER = /knowledge\/scheduling\.ts/;
let pending: Map<unknown, string>;
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'knowledge-dispose-race-'));
  pending = new Map<unknown, string>();
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    const stack = new Error().stack ?? '';
    let handle: unknown;
    const wrapped = (...a: unknown[]): void => { pending.delete(handle); (fn as (...x: unknown[]) => void)(...a); };
    handle = realSetTimeout(wrapped as never, ms as never, ...(rest as never[]));
    if (OWNER.test(stack)) pending.set(handle, stack.split('\n')[2]?.trim() ?? '');
    return handle as ReturnType<typeof globalThis.setTimeout>;
  }) as typeof globalThis.setTimeout;
  globalThis.clearTimeout = ((h: never) => { pending.delete(h); return realClearTimeout(h); }) as typeof globalThis.clearTimeout;
});

afterEach(() => {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  rmSync(root, { recursive: true, force: true });
});

function buildService(): KnowledgeScheduleService {
  // The family/file pairing is guarded at construction (store-config.ts), so
  // this uses the real wiki pairing rather than an invented file name.
  const store = new KnowledgeStore({
    configManager: { getControlPlaneConfigDir: () => root },
    family: 'wiki',
  } as never);
  return new KnowledgeScheduleService({
    store,
    emitIfReady: () => undefined,
    runJobByKind: async () => ({}),
  });
}

test('dispose() during in-flight schedule initialization leaves nothing armed', async () => {
  const service = buildService();
  // No quiescence wait: initializeSchedules() is mid-await right now.
  service.dispose();

  // Let the initializer run to completion against a disposed service.
  await new Promise((resolve) => realSetTimeout(resolve, 500));

  expect([...pending.values()]).toEqual([]);
});

test('dispose() after initialization has settled also leaves nothing armed', async () => {
  const service = buildService();
  await new Promise((resolve) => realSetTimeout(resolve, 500));
  service.dispose();
  await new Promise((resolve) => realSetTimeout(resolve, 100));

  expect([...pending.values()]).toEqual([]);
});
