/**
 * perf-03-scheduler-history.test.ts
 *
 * PERF-03: TaskScheduler pushHistory O(1) per-task Map + debounced save.
 * Verifies history is stable under many runs and correctly capped per task.
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskScheduler } from '../packages/sdk/src/_internal/platform/scheduler/scheduler.ts';
import type { TaskRunRecord } from '../packages/sdk/src/_internal/platform/scheduler/scheduler.ts';

function tempDir(suffix: string): string {
  const d = join(tmpdir(), `gv-perf03-${suffix}-${Date.now()}`);
  mkdirSync(d, { recursive: true });
  return d;
}

function makeScheduler(): { scheduler: TaskScheduler; cleanup: () => void } {
  const dir = tempDir('sched');
  const storePath = join(dir, 'scheduler.json');
  const scheduler = new TaskScheduler({ storePath });
  return {
    scheduler,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('PERF-03: TaskScheduler per-task history Map', () => {
  test('getHistory returns records for the given taskId only', () => {
    const { scheduler, cleanup } = makeScheduler();
    try {
      const s = scheduler as unknown as { pushHistory: (rec: TaskRunRecord) => void };

      s.pushHistory({ taskId: 'task-a', startedAt: 1000, agentId: 'ag-1', status: 'completed' });
      s.pushHistory({ taskId: 'task-b', startedAt: 3000, agentId: 'ag-2', status: 'failed', error: 'oops' });
      s.pushHistory({ taskId: 'task-a', startedAt: 5000, agentId: 'ag-3', status: 'completed' });

      const histA = scheduler.getHistory('task-a');
      const histB = scheduler.getHistory('task-b');

      expect(histA.length).toBe(2);
      expect(histA.every((r) => r.taskId === 'task-a')).toBe(true);
      expect(histB.length).toBe(1);
      expect(histB[0]!.taskId).toBe('task-b');
    } finally {
      cleanup();
    }
  });

  test('history is capped at MAX_HISTORY_PER_TASK (1000) per task', () => {
    const { scheduler, cleanup } = makeScheduler();
    try {
      const s = scheduler as unknown as { pushHistory: (rec: TaskRunRecord) => void };

      const MAX = 1000;
      for (let i = 0; i < MAX + 50; i++) {
        s.pushHistory({ taskId: 'task-cap', startedAt: i, agentId: `ag-${i}`, status: 'completed' });
      }

      const hist = scheduler.getHistory('task-cap');
      expect(hist.length).toBeLessThanOrEqual(MAX);
      // Most recent record should be among the last pushed
      expect(hist[hist.length - 1]!.startedAt).toBe(MAX + 49);
    } finally {
      cleanup();
    }
  });

  test('getAllHistory returns records from all tasks', () => {
    const { scheduler, cleanup } = makeScheduler();
    try {
      const s = scheduler as unknown as { pushHistory: (rec: TaskRunRecord) => void };

      s.pushHistory({ taskId: 'task-x', startedAt: 1, agentId: 'ag-x', status: 'completed' });
      s.pushHistory({ taskId: 'task-y', startedAt: 3, agentId: 'ag-y', status: 'completed' });

      const all = scheduler.getAllHistory();
      expect(all.length).toBe(2);
      const taskIds = new Set(all.map((r) => r.taskId));
      expect(taskIds.has('task-x')).toBe(true);
      expect(taskIds.has('task-y')).toBe(true);
    } finally {
      cleanup();
    }
  });
});
