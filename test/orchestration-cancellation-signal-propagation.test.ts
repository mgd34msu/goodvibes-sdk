/**
 * W4.1 (wo701) — cooperative cancellation, the exec/fetch propagation half.
 *
 * The engine-level cancellation tests (test/orchestration-engine.test.ts)
 * prove that engine.kill(itemId) aborts the item's registered AbortSignal
 * and calls AgentManager.cancel. This file proves the OTHER half the brief
 * calls out as the actual point of W0.1's original deferral: that an
 * AbortSignal threaded into Tool.execute's new optional `opts` param really
 * does reach a live child process (exec/Bun.spawn) or in-flight request
 * (fetch), instead of leaving it orphaned after the tool call's caller has
 * moved on.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecTool } from '../packages/sdk/src/platform/tools/exec/runtime.js';
import { ProcessManager } from '../packages/sdk/src/platform/tools/shared/process-manager.js';
import { OverflowHandler } from '../packages/sdk/src/platform/tools/shared/overflow.js';
import { createFetchTool } from '../packages/sdk/src/platform/tools/fetch/runtime.js';

function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('exec tool — AbortSignal reaches the spawned child process', () => {
  test('aborting mid-run kills the process well before its own duration or the default timeout elapse — proves no orphan', async () => {
    const root = tempRoot('gv-exec-cancel-live-');
    const tool = createExecTool(new ProcessManager(), { overflowHandler: new OverflowHandler({ baseDir: root }) });
    const controller = new AbortController();

    const start = Date.now();
    // timeout_ms stays under PROGRESS_AUTO_THRESHOLD_MS (30s, exec/
    // runtime.ts) so this exercises the plain foreground path specifically;
    // the progress-streamed path (timeout_ms above the threshold, which is
    // what the exec tool's own 120s DEFAULT timeout always triggers) is
    // covered separately below — both are wired for opts.signal. Only
    // `until`-pattern commands (runUntil) are explicitly deferred, see the
    // WO report.
    const resultPromise = tool.execute(
      { working_dir: root, commands: [{ cmd: 'sleep 30', timeout_ms: 20_000 }] },
      { signal: controller.signal },
    );
    // Give `sleep` a moment to actually spawn before aborting mid-flight.
    await sleep(150);
    controller.abort();
    const result = await resultPromise;
    const elapsedMs = Date.now() - start;

    // If the signal had NOT reached Bun.spawn's child process, this would
    // block for the full 30s sleep (or the 120s default global timeout) —
    // bun:test's own per-test timeout would fail this test long before a
    // false pass could sneak through.
    expect(elapsedMs).toBeLessThan(5_000);
    expect(result.success).toBe(false);
    const output = JSON.parse(result.output ?? '{}') as { cancelled?: boolean; timed_out?: boolean };
    expect(output.cancelled).toBe(true);
    expect(output.timed_out).toBeUndefined();
  }, 10_000);

  test('an already-aborted signal cancels before the command ever gets to run out its duration', async () => {
    const root = tempRoot('gv-exec-cancel-pre-');
    const tool = createExecTool(new ProcessManager(), { overflowHandler: new OverflowHandler({ baseDir: root }) });
    const controller = new AbortController();
    controller.abort();

    const start = Date.now();
    const result = await tool.execute(
      { working_dir: root, commands: [{ cmd: 'sleep 30', timeout_ms: 20_000 }] },
      { signal: controller.signal },
    );
    expect(Date.now() - start).toBeLessThan(5_000);
    const output = JSON.parse(result.output ?? '{}') as { cancelled?: boolean };
    expect(output.cancelled).toBe(true);
  }, 10_000);

  test('cancellation is never retried — a cancelled command with retry configured does not respawn', async () => {
    const root = tempRoot('gv-exec-cancel-noretry-');
    const tool = createExecTool(new ProcessManager(), { overflowHandler: new OverflowHandler({ baseDir: root }) });
    const controller = new AbortController();
    controller.abort();

    const result = await tool.execute(
      { working_dir: root, commands: [{ cmd: 'sleep 30', timeout_ms: 20_000, retry: { max: 3, delay_ms: 1 } }] },
      { signal: controller.signal },
    );
    const output = JSON.parse(result.output ?? '{}') as { cancelled?: boolean; retries?: number };
    expect(output.cancelled).toBe(true);
    expect(output.retries ?? 0).toBe(0);
  }, 10_000);

  test('a tool call with no opts (the pre-existing call shape) behaves exactly as before — additive, not breaking', async () => {
    const root = tempRoot('gv-exec-no-opts-');
    const tool = createExecTool(new ProcessManager(), { overflowHandler: new OverflowHandler({ baseDir: root }) });
    const result = await tool.execute({ working_dir: root, commands: [{ cmd: 'echo hi' }] });
    expect(result.success).toBe(true);
  });

  test('the progress-streamed path (timeout_ms above the 30s auto-threshold — the exec tool\'s own 120s DEFAULT) also honors the signal', async () => {
    const root = tempRoot('gv-exec-cancel-progress-');
    const tool = createExecTool(new ProcessManager(), { overflowHandler: new OverflowHandler({ baseDir: root }) });
    const controller = new AbortController();

    const start = Date.now();
    // No explicit timeout_ms — this is the real-world default shape, and
    // the exec tool's own 120s DEFAULT_TIMEOUT_MS exceeds
    // PROGRESS_AUTO_THRESHOLD_MS (30s), so it auto-engages
    // runCommandWithProgress. Before this WO wired that path too, a
    // cancellation here would silently do nothing until the full 120s
    // default elapsed — exactly the orphaned-child-process gap the brief
    // calls out.
    const resultPromise = tool.execute(
      { working_dir: root, commands: [{ cmd: 'sleep 60' }] },
      { signal: controller.signal },
    );
    await sleep(150);
    controller.abort();
    const result = await resultPromise;
    expect(Date.now() - start).toBeLessThan(5_000);
    const output = JSON.parse(result.output ?? '{}') as { cancelled?: boolean; progress_file?: string };
    expect(output.cancelled).toBe(true);
    expect(typeof output.progress_file).toBe('string');
  }, 10_000);
});

describe('fetch tool — AbortSignal reaches the in-flight request', () => {
  test('aborting mid-request cuts off a slow server response instead of waiting it out', async () => {
    const server = Bun.serve({
      port: 0,
      async fetch() {
        await sleep(10_000);
        return new Response('too slow');
      },
    });
    try {
      const tool = createFetchTool({});
      const controller = new AbortController();
      const start = Date.now();
      const resultPromise = tool.execute(
        { urls: [{ url: `http://127.0.0.1:${server.port}/slow`, timeout_ms: 30_000 }] },
        { signal: controller.signal },
      );
      await sleep(150);
      controller.abort();
      const result = await resultPromise;
      const elapsedMs = Date.now() - start;

      expect(elapsedMs).toBeLessThan(5_000);
      expect(result.success).toBe(true); // fetch tool reports per-URL errors inside output, not a top-level failure
      const output = JSON.parse(result.output ?? '{}') as { results?: Array<{ error?: string }>; error?: string };
      const urlResult = output.results?.[0] ?? output;
      expect(typeof (urlResult as { error?: string }).error).toBe('string');
    } finally {
      server.stop(true);
    }
  }, 10_000);

  test('a tool call with no opts (the pre-existing call shape) behaves exactly as before — additive, not breaking', async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response('ok') });
    try {
      const tool = createFetchTool({});
      const result = await tool.execute({ urls: [{ url: `http://127.0.0.1:${server.port}/` }] });
      expect(result.success).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});
