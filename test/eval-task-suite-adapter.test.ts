/**
 * eval-task-suite-adapter.test.ts
 *
 * The Terminal-Bench-style external task-suite adapter, driven over the bundled
 * example suite (test/fixtures/eval/task-suite). Proves the adapter contract:
 * discover tasks from a directory, run each through the injected session
 * executor (the "real session" seam), run its verification script, and report
 * pass/fail per task — a task passes only when the session completed AND its
 * verifier passed.
 *
 * The suite is copied to a scratch directory per test so the session executor
 * can write into the working directory without mutating the committed fixture.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverTasks,
  runTaskSuite,
  formatTaskSuiteResult,
  type TaskSessionExecutor,
} from '../packages/sdk/src/platform/runtime/eval/task-suite.ts';

const FIXTURE_SUITE = join(import.meta.dir, 'fixtures', 'eval', 'task-suite');

let workSuite: string;

beforeEach(() => {
  const scratch = mkdtempSync(join(tmpdir(), 'gv-task-suite-'));
  workSuite = join(scratch, 'suite');
  cpSync(FIXTURE_SUITE, workSuite, { recursive: true });
});

afterEach(() => {
  rmSync(join(workSuite, '..'), { recursive: true, force: true });
});

describe('external task-suite adapter', () => {
  test('discovers the example task from its directory', () => {
    const tasks = discoverTasks(workSuite);
    expect(tasks.map((t) => t.definition.id)).toEqual(['echo-marker']);
    expect(tasks[0]!.definition.instruction).toContain('marker.txt');
  });

  test('a session that completes the task PASSES through the real shell verifier', async () => {
    // The "real session" writes the required marker file into the working dir.
    const executor: TaskSessionExecutor = async (ctx) => {
      writeFileSync(join(ctx.taskDir, 'marker.txt'), 'done');
      return { completed: true, summary: 'wrote marker.txt' };
    };
    const result = await runTaskSuite(workSuite, { executor });
    expect(result.passed).toBe(true);
    expect(result.passedCount).toBe(1);
    expect(result.results[0]!.sessionCompleted).toBe(true);
    expect(result.results[0]!.verifierPassed).toBe(true);
    // The formatter renders a per-task line.
    expect(formatTaskSuiteResult(result)).toContain('[PASS] echo-marker');
  });

  test('a session that completes but does NOT satisfy the task FAILS verification', async () => {
    const executor: TaskSessionExecutor = async (ctx) => {
      writeFileSync(join(ctx.taskDir, 'marker.txt'), 'WRONG');
      return { completed: true };
    };
    const result = await runTaskSuite(workSuite, { executor });
    expect(result.passed).toBe(false);
    expect(result.results[0]!.sessionCompleted).toBe(true);
    expect(result.results[0]!.verifierPassed).toBe(false);
    expect(result.results[0]!.reason).toContain('verification failed');
  });

  test('a session that does not complete is a fail, and the verifier is skipped', async () => {
    const executor: TaskSessionExecutor = async () => ({ completed: false, summary: 'gave up' });
    const result = await runTaskSuite(workSuite, { executor });
    expect(result.passed).toBe(false);
    expect(result.results[0]!.verifierPassed).toBe(false);
    expect(result.results[0]!.verifierOutput).toContain('skipped');
    expect(result.results[0]!.reason).toContain('did not complete');
  });

  test('an injected verifier can replace the shell runner (contract is seam-driven)', async () => {
    const executor: TaskSessionExecutor = async () => ({ completed: true });
    const result = await runTaskSuite(workSuite, {
      executor,
      verifier: async () => ({ passed: true, output: 'stub verifier' }),
    });
    expect(result.passed).toBe(true);
    expect(result.results[0]!.verifierOutput).toBe('stub verifier');
  });
});
