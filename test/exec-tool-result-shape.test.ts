/**
 * exec-tool-result-shape.test.ts
 *
 * Regression coverage for W0.1 fix #2: createExecTool(...).execute() must
 * populate a top-level `error` summary whenever any command fails, so that
 * consumers keying off `.error` alone (not just `.output`) get a coherent
 * signal. `output` already carried the full per-command diagnostics before
 * this fix — this only adds the top-level summary.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecTool } from '../packages/sdk/src/platform/tools/exec/runtime.ts';
import { ProcessManager } from '../packages/sdk/src/platform/tools/shared/process-manager.ts';
import { OverflowHandler } from '../packages/sdk/src/platform/tools/shared/overflow.ts';

function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeTool(root: string) {
  return createExecTool(new ProcessManager(), { overflowHandler: new OverflowHandler({ baseDir: root }) });
}

describe('exec tool — failure result shape', () => {
  test('a single failing command returns success:false, full diagnostics in output, and a populated error summary', async () => {
    const root = tempRoot('gv-exec-fail-single-');
    const tool = makeTool(root);

    const result = await tool.execute({ working_dir: root, commands: [{ cmd: 'exit 1' }] });

    expect(result.success).toBe(false);
    const output = JSON.parse(result.output ?? '{}') as { exit_code?: number };
    expect(output.exit_code).toBe(1);
    expect(typeof result.error).toBe('string');
    expect(result.error).toContain('exit 1');
    expect(result.error).not.toBe('Unknown error');
  });

  test('fail_fast batch: skipped entries and the failing command are both reflected in output, and error names the failure', async () => {
    const root = tempRoot('gv-exec-fail-fast-');
    const tool = makeTool(root);

    const result = await tool.execute({
      working_dir: root,
      fail_fast: true,
      commands: [{ cmd: 'exit 1' }, { cmd: 'echo should-be-skipped' }],
    });

    expect(result.success).toBe(false);
    const output = JSON.parse(result.output ?? '{}') as { commands: Array<{ cmd: string; skipped?: boolean; exit_code?: number | null }> };
    expect(output.commands[0]?.exit_code).toBe(1);
    expect(output.commands[1]?.skipped).toBe(true);
    expect(result.error).toContain('exit 1');
  });

  test('a passing command has no top-level error', async () => {
    const root = tempRoot('gv-exec-pass-');
    const tool = makeTool(root);

    const result = await tool.execute({ working_dir: root, commands: [{ cmd: 'true' }] });

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });
});
