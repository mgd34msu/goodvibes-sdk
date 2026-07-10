/**
 * Evaluation Harness — external task-suite adapter (Terminal-Bench-style).
 *
 * A Terminal-Bench task suite is a DIRECTORY of tasks, each its own
 * subdirectory holding a task definition and a verification script:
 *
 *   <suiteDir>/
 *     <taskId>/
 *       task.json     { id, instruction, verify, timeoutMs? }
 *       verify.sh     exits 0 = pass, non-zero = fail
 *       ...           any fixtures the task needs
 *
 * This adapter runs each task through a REAL session — supplied by the caller as
 * an injectable `TaskSessionExecutor` (the seam a consumer fills with an actual
 * model-driven session operating in the task's working directory) — and then
 * runs the task's verification script to decide pass/fail. It reports a
 * per-task result and an aggregate.
 *
 * SCOPE (honest). This is the adapter CONTRACT plus a default script verifier,
 * not a benchmark import: it does not bundle Terminal-Bench's task corpus, a
 * container runtime, or a specific model harness. The session executor and (if
 * desired) the verifier are injected, so the same contract drives the bundled
 * example suite in tests and a real suite + real session in a consumer.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** One task's on-disk definition (task.json). */
export interface TaskDefinition {
  /** Stable task id (used as the result key). Defaults to the task directory name when omitted. */
  readonly id: string;
  /** The instruction handed to the session. */
  readonly instruction: string;
  /** Path (relative to the task directory) to the verification script. Defaults to `verify.sh`. */
  readonly verify: string;
  /** Optional per-task wall-clock cap for the session executor, in ms. */
  readonly timeoutMs?: number;
}

/** What the session executor is given for one task. */
export interface TaskExecutionContext {
  readonly taskId: string;
  /** Absolute path to the task directory (definition + fixtures + verify script). */
  readonly taskDir: string;
  /** The instruction from the task definition. */
  readonly instruction: string;
  readonly timeoutMs?: number | undefined;
}

/** The outcome the session executor reports (whether the session ran to completion). */
export interface TaskSessionOutcome {
  readonly completed: boolean;
  readonly summary?: string;
}

/** The injectable "real session" seam: run one task's instruction in its directory. */
export type TaskSessionExecutor = (ctx: TaskExecutionContext) => Promise<TaskSessionOutcome>;

/** What the verifier is given. */
export interface TaskVerifyContext {
  readonly taskId: string;
  readonly taskDir: string;
  /** Absolute path to the verification script. */
  readonly verifyScript: string;
  readonly timeoutMs?: number | undefined;
}

/** The verifier's verdict. */
export interface TaskVerifyResult {
  readonly passed: boolean;
  readonly output: string;
}

/** Runs a task's verification script and decides pass/fail. Injectable; defaults to a shell runner. */
export type TaskVerifier = (ctx: TaskVerifyContext) => Promise<TaskVerifyResult>;

/** One task's result. */
export interface TaskResult {
  readonly taskId: string;
  readonly passed: boolean;
  readonly sessionCompleted: boolean;
  readonly verifierPassed: boolean;
  readonly verifierOutput: string;
  readonly reason: string;
  readonly durationMs: number;
}

/** The aggregate for a whole suite directory. */
export interface TaskSuiteResult {
  readonly suiteDir: string;
  readonly results: readonly TaskResult[];
  readonly passed: boolean;
  readonly total: number;
  readonly passedCount: number;
}

export interface RunTaskSuiteOptions {
  /** The real-session seam. Required — there is no faked default session. */
  readonly executor: TaskSessionExecutor;
  /** Verification runner. Defaults to {@link defaultShellVerifier} (runs the script, exit 0 = pass). */
  readonly verifier?: TaskVerifier;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Load and validate a task.json from a task directory. Throws a named error on a malformed definition. */
export function loadTaskDefinition(taskDir: string): TaskDefinition {
  const defPath = join(taskDir, 'task.json');
  if (!existsSync(defPath)) {
    throw new Error(`task-suite: ${taskDir} has no task.json`);
  }
  const parsed = JSON.parse(readFileSync(defPath, 'utf-8')) as unknown;
  if (!isRecord(parsed) || typeof parsed.instruction !== 'string' || parsed.instruction.length === 0) {
    throw new Error(`task-suite: ${defPath} is missing a non-empty "instruction"`);
  }
  const dirName = taskDir.split(/[\\/]/).filter(Boolean).pop() ?? taskDir;
  const id = typeof parsed.id === 'string' && parsed.id.length > 0 ? parsed.id : dirName;
  const verify = typeof parsed.verify === 'string' && parsed.verify.length > 0 ? parsed.verify : 'verify.sh';
  const timeoutMs = typeof parsed.timeoutMs === 'number' ? parsed.timeoutMs : undefined;
  return { id, instruction: parsed.instruction, verify, ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
}

/** A discovered task: its parsed definition and the absolute directory it lives in. */
export interface DiscoveredTask {
  readonly definition: TaskDefinition;
  readonly taskDir: string;
}

/** Discover the task subdirectories (each containing a task.json) of a suite directory, sorted by id. */
export function discoverTasks(suiteDir: string): DiscoveredTask[] {
  const root = resolve(suiteDir);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`task-suite: ${root} is not a directory`);
  }
  const tasks: DiscoveredTask[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const taskDir = join(root, entry.name);
    if (!existsSync(join(taskDir, 'task.json'))) continue;
    tasks.push({ definition: loadTaskDefinition(taskDir), taskDir });
  }
  return tasks.sort((a, b) => a.definition.id.localeCompare(b.definition.id));
}

/** Default verifier: run the verification script through `bash` and treat exit 0 as pass. */
export const defaultShellVerifier: TaskVerifier = async (ctx) => {
  if (!existsSync(ctx.verifyScript)) {
    return { passed: false, output: `verification script not found: ${ctx.verifyScript}` };
  }
  const result = spawnSync('bash', [ctx.verifyScript], {
    cwd: ctx.taskDir,
    encoding: 'utf-8',
    timeout: ctx.timeoutMs ?? 60_000,
    windowsHide: true,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  return { passed: result.status === 0, output };
};

/**
 * Run every task in `suiteDir` through the injected session executor, then its
 * verification script, and report pass/fail per task. A task passes only when
 * the session completed AND its verifier passed.
 */
export async function runTaskSuite(suiteDir: string, options: RunTaskSuiteOptions): Promise<TaskSuiteResult> {
  const root = resolve(suiteDir);
  const verifier = options.verifier ?? defaultShellVerifier;
  const tasks = discoverTasks(root);
  const results: TaskResult[] = [];

  for (const { definition: task, taskDir } of tasks) {
    const startedAt = Date.now();

    let sessionCompleted = false;
    let sessionSummary = '';
    try {
      const outcome = await options.executor({
        taskId: task.id,
        taskDir,
        instruction: task.instruction,
        timeoutMs: task.timeoutMs,
      });
      sessionCompleted = outcome.completed;
      sessionSummary = outcome.summary ?? '';
    } catch (err) {
      sessionCompleted = false;
      sessionSummary = err instanceof Error ? err.message : String(err);
    }

    let verifierPassed = false;
    let verifierOutput = 'skipped (session did not complete)';
    if (sessionCompleted) {
      const verdict = await verifier({
        taskId: task.id,
        taskDir,
        verifyScript: join(taskDir, task.verify),
        timeoutMs: task.timeoutMs,
      });
      verifierPassed = verdict.passed;
      verifierOutput = verdict.output;
    }

    const passed = sessionCompleted && verifierPassed;
    results.push({
      taskId: task.id,
      passed,
      sessionCompleted,
      verifierPassed,
      verifierOutput,
      reason: !sessionCompleted
        ? `session did not complete${sessionSummary ? `: ${sessionSummary}` : ''}`
        : verifierPassed
          ? 'session completed and verification passed'
          : 'session completed but verification failed',
      durationMs: Date.now() - startedAt,
    });
  }

  const passedCount = results.filter((r) => r.passed).length;
  return {
    suiteDir: root,
    results,
    total: results.length,
    passedCount,
    passed: results.length > 0 && passedCount === results.length,
  };
}

/** Format a task-suite result as a per-task, one-line-each report. */
export function formatTaskSuiteResult(result: TaskSuiteResult): string {
  const hr = '-'.repeat(72);
  const lines: string[] = [hr, `Task suite: ${result.suiteDir}`, `Tasks: ${result.passedCount}/${result.total} passed`, hr];
  for (const r of result.results) {
    lines.push(`  [${r.passed ? 'PASS' : 'FAIL'}] ${r.taskId.padEnd(40)} ${r.reason}`);
  }
  lines.push(hr);
  return lines.join('\n');
}
