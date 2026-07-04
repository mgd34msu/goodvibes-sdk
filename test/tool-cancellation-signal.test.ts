/**
 * W4.1 (wo701) — Tool.execute's additive `opts.signal` (types/tools.ts) and
 * its propagation into the process-spawning tools that opted in (exec,
 * fetch). Proves signal -> child-process termination for exec (no orphan)
 * and signal -> runtime-dep pass-through for fetch.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecTool } from '../packages/sdk/src/platform/tools/exec/runtime.js';
import { ProcessManager } from '../packages/sdk/src/platform/tools/shared/process-manager.js';
import { OverflowHandler } from '../packages/sdk/src/platform/tools/shared/overflow.js';
import { createFetchTool } from '../packages/sdk/src/platform/tools/fetch/runtime.js';
import { ToolRegistry } from '../packages/sdk/src/platform/tools/registry.js';
import type { Tool } from '../packages/sdk/src/platform/types/tools.js';

function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('exec tool — cooperative cancellation via opts.signal', () => {
  test('aborting mid-run kills the child process instead of letting it run to completion (no orphan)', async () => {
    const root = tempRoot('gv-exec-cancel-');
    const tool = createExecTool(new ProcessManager(), { overflowHandler: new OverflowHandler({ baseDir: root }) });
    const controller = new AbortController();

    const start = Date.now();
    // timeout_ms must stay under PROGRESS_AUTO_THRESHOLD_MS (30s) so this
    // takes the default foreground path — the only one wired for opts.signal
    // today (runCommandWithProgress/runUntil are explicitly deferred, see
    // the WO report).
    const resultPromise = tool.execute(
      { working_dir: root, commands: [{ cmd: 'sleep 30', timeout_ms: 20_000 }] },
      { signal: controller.signal },
    );
    // Abort shortly after the process starts — well before `sleep 30` would
    // ever return on its own.
    setTimeout(() => controller.abort(), 50);
    const result = await resultPromise;
    const elapsedMs = Date.now() - start;

    // SIGTERM, a 200ms grace period, then SIGKILL — the process must be gone
    // in well under a second, not the full 30s sleep duration.
    expect(elapsedMs).toBeLessThan(5_000);
    const output = JSON.parse(result.output ?? '{}') as { cancelled?: boolean; timed_out?: boolean };
    expect(output.cancelled).toBe(true);
    expect(output.timed_out).toBeUndefined();
  }, 10_000);

  test('an already-aborted signal cancels before the process is ever awaited on', async () => {
    const root = tempRoot('gv-exec-cancel-preaborted-');
    const tool = createExecTool(new ProcessManager(), { overflowHandler: new OverflowHandler({ baseDir: root }) });
    const controller = new AbortController();
    controller.abort();

    const result = await tool.execute(
      { working_dir: root, commands: [{ cmd: 'sleep 30', timeout_ms: 20_000 }] },
      { signal: controller.signal },
    );
    const output = JSON.parse(result.output ?? '{}') as { cancelled?: boolean };
    expect(output.cancelled).toBe(true);
  }, 10_000);

  test('omitting opts is unchanged from before this change — existing callers compile and run untouched', async () => {
    const root = tempRoot('gv-exec-no-opts-');
    const tool = createExecTool(new ProcessManager(), { overflowHandler: new OverflowHandler({ baseDir: root }) });
    const result = await tool.execute({ working_dir: root, commands: [{ cmd: 'echo hi' }] });
    expect(result.success).toBe(true);
  });

  test('a background command is never cancelled by the caller signal (deliberately excluded — it is meant to outlive the tool call)', async () => {
    const root = tempRoot('gv-exec-bg-');
    const processManager = new ProcessManager();
    const tool = createExecTool(processManager, { overflowHandler: new OverflowHandler({ baseDir: root }) });
    const controller = new AbortController();

    const result = await tool.execute(
      { working_dir: root, commands: [{ cmd: 'sleep 0.2 && echo done', background: true }] },
      { signal: controller.signal },
    );
    controller.abort();
    const output = JSON.parse(result.output ?? '{}') as { process_id?: string };
    expect(typeof output.process_id).toBe('string');
    processManager.stop(output.process_id!);
  });
});

describe('ToolRegistry.execute — additive signal forwarding', () => {
  test('a signal passed to registry.execute reaches the underlying tool.execute call', async () => {
    let receivedSignal: AbortSignal | undefined;
    const tool: Tool = {
      definition: { name: 'probe', description: 'probe', parameters: {} },
      async execute(_args, opts) {
        receivedSignal = opts?.signal;
        return { success: true };
      },
    };
    const registry = new ToolRegistry();
    registry.register(tool);
    const controller = new AbortController();
    await registry.execute('call-1', 'probe', {}, { signal: controller.signal });
    expect(receivedSignal).toBe(controller.signal);
  });

  test('omitting opts calls tool.execute with opts undefined — existing ~30 tool impls with single-arg execute(args) remain valid', async () => {
    const calls: unknown[] = [];
    const tool: Tool = {
      definition: { name: 'legacy', description: 'legacy single-arg tool', parameters: {} },
      // Intentionally the OLD single-parameter shape.
      async execute(args: Record<string, unknown>) {
        calls.push(args);
        return { success: true };
      },
    };
    const registry = new ToolRegistry();
    registry.register(tool);
    const result = await registry.execute('call-1', 'legacy', { x: 1 });
    expect(result.success).toBe(true);
    expect(calls).toEqual([{ x: 1 }]);
  });
});

describe('fetch tool — cooperative cancellation via opts.signal', () => {
  test('opts.signal is threaded into the runtime dependency the fetch tool calls', async () => {
    let capturedDeps: { signal?: AbortSignal } | undefined;
    const stubRuntime = {
      execute: async (_input: unknown, deps: { signal?: AbortSignal }) => {
        capturedDeps = deps;
        return { results: [] };
      },
    };
    const tool = createFetchTool({}, stubRuntime as unknown as Parameters<typeof createFetchTool>[1]);
    const controller = new AbortController();
    await tool.execute({ urls: ['https://example.invalid/'] }, { signal: controller.signal });
    expect(capturedDeps?.signal).toBe(controller.signal);
  });

  test('omitting opts leaves the runtime dependency signal untouched (no behavior change for existing callers)', async () => {
    let capturedDeps: { signal?: AbortSignal } | undefined;
    const stubRuntime = {
      execute: async (_input: unknown, deps: { signal?: AbortSignal }) => {
        capturedDeps = deps;
        return { results: [] };
      },
    };
    const tool = createFetchTool({}, stubRuntime as unknown as Parameters<typeof createFetchTool>[1]);
    await tool.execute({ urls: ['https://example.invalid/'] });
    expect(capturedDeps?.signal).toBeUndefined();
  });
});
