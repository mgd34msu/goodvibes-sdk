/**
 * exec-working-dir-default.test.ts
 *
 * The exec tool used to throw "exec requires an explicit
 * working_dir" whenever a call omitted the top-level working_dir — including
 * a model's FIRST exec call right after the user approved it (the approval
 * card's Directory line is sourced from the session's own working directory
 * independently of this arg, so the user had already seen the correct
 * directory before the tool call failed on a technicality). createExecTool
 * now accepts a `defaultWorkingDirectory` (the session/tool-context working
 * directory the caller already has) and falls back to it when working_dir is
 * omitted, while an explicit working_dir still always wins and the result
 * still honestly reports the resolved cwd (verbose verbosity echoes `cwd`).
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecTool } from '../packages/sdk/src/platform/tools/exec/runtime.ts';
import { ProcessManager } from '../packages/sdk/src/platform/tools/shared/process-manager.ts';
import { OverflowHandler } from '../packages/sdk/src/platform/tools/shared/overflow.ts';

function tempRoot(prefix: string): string {
  // realpath: on macOS tmpdir() is a symlink (/tmp -> /private/tmp) and `pwd`
  // inside the spawned shell resolves the real path, so compare against that.
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

describe('exec tool — working_dir default fallback', () => {
  test('omitting working_dir runs in the session working directory supplied at registration', async () => {
    const root = tempRoot('gv-exec-default-cwd-');
    const tool = createExecTool(new ProcessManager(), {
      overflowHandler: new OverflowHandler({ baseDir: root }),
      defaultWorkingDirectory: root,
    });

    const result = await tool.execute({ commands: [{ cmd: 'pwd' }] });

    expect(result.success).toBe(true);
    const output = JSON.parse(result.output ?? '{}') as { stdout?: string };
    expect(output.stdout?.trim()).toBe(root);
  });

  test('the result honestly states the resolved (defaulted) cwd in verbose verbosity', async () => {
    const root = tempRoot('gv-exec-default-verbose-');
    const tool = createExecTool(new ProcessManager(), {
      overflowHandler: new OverflowHandler({ baseDir: root }),
      defaultWorkingDirectory: root,
    });

    const result = await tool.execute({ verbosity: 'verbose', commands: [{ cmd: 'true' }] });

    expect(result.success).toBe(true);
    const output = JSON.parse(result.output ?? '{}') as { cwd?: string };
    expect(output.cwd).toBe(root);
  });

  test('an explicit top-level working_dir still overrides the default', async () => {
    const defaultRoot = tempRoot('gv-exec-default-unused-');
    const explicitRoot = tempRoot('gv-exec-explicit-wins-');
    const tool = createExecTool(new ProcessManager(), {
      overflowHandler: new OverflowHandler({ baseDir: defaultRoot }),
      defaultWorkingDirectory: defaultRoot,
    });

    const result = await tool.execute({ working_dir: explicitRoot, commands: [{ cmd: 'pwd' }] });

    expect(result.success).toBe(true);
    const output = JSON.parse(result.output ?? '{}') as { stdout?: string };
    expect(output.stdout?.trim()).toBe(explicitRoot);
  });

  test('an explicit per-command working_dir on a single-command call still overrides the default', async () => {
    const defaultRoot = tempRoot('gv-exec-default-unused2-');
    const explicitRoot = tempRoot('gv-exec-cmd-level-wins-');
    const tool = createExecTool(new ProcessManager(), {
      overflowHandler: new OverflowHandler({ baseDir: defaultRoot }),
      defaultWorkingDirectory: defaultRoot,
    });

    const result = await tool.execute({ commands: [{ cmd: 'pwd', working_dir: explicitRoot }] });

    expect(result.success).toBe(true);
    const output = JSON.parse(result.output ?? '{}') as { stdout?: string };
    expect(output.stdout?.trim()).toBe(explicitRoot);
  });

  test('without a default and without an explicit working_dir, the call still fails closed with the same honest error', async () => {
    const root = tempRoot('gv-exec-no-default-');
    const tool = createExecTool(new ProcessManager(), { overflowHandler: new OverflowHandler({ baseDir: root }) });

    const result = await tool.execute({ commands: [{ cmd: 'true' }] });

    expect(result.success).toBe(false);
    expect(result.error).toContain('exec requires an explicit working_dir');
  });
});
