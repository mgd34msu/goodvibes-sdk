import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWriteTool } from '../packages/sdk/src/platform/tools/write/index.ts';
import { executeFileOperations } from '../packages/sdk/src/platform/tools/exec/file-ops.ts';
import { createExecTool } from '../packages/sdk/src/platform/tools/exec/runtime.ts';
import { repairToolCall } from '../packages/sdk/src/platform/tools/auto-repair.ts';
import type { FileStateCache } from '../packages/sdk/src/platform/state/file-cache.ts';
import type { ConfigManager } from '../packages/sdk/src/platform/config/manager.ts';
import { ProcessManager } from '../packages/sdk/src/platform/tools/shared/process-manager.ts';
import { OverflowHandler } from '../packages/sdk/src/platform/tools/shared/overflow.ts';

function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('tool side-effect observability', () => {
  test('write surfaces state integration failures as warnings', async () => {
    const root = tempRoot('gv-write-warnings-');
    const fileCache = {
      update() {
        throw new Error('cache unavailable');
      },
    } as unknown as FileStateCache;
    const tool = createWriteTool({ projectRoot: root, fileCache });

    const result = await tool.execute({
      files: [{ path: 'src/a.ts', content: 'export const a = 1;\n' }],
      verbosity: 'standard',
    });

    expect(result.success).toBe(true);
    expect(result.warnings?.some((warning) => warning.includes('File cache update failed'))).toBe(true);
    const output = JSON.parse(result.output ?? '{}') as {
      warnings?: string[];
      files?: Array<{ warnings?: string[] }>;
    };
    expect(output.warnings?.some((warning) => warning.includes('File cache update failed'))).toBe(true);
    expect(output.files?.[0]?.warnings?.some((warning) => warning.includes('File cache update failed'))).toBe(true);
  });

  test('write preserves failed auto-heal as a warning and leaves requested content on disk', async () => {
    const root = tempRoot('gv-write-auto-heal-');
    const configManager = {
      get(key: string) {
        return key === 'tools.autoHeal';
      },
    } as Pick<ConfigManager, 'get'>;
    const tool = createWriteTool({ projectRoot: root, configManager });
    const badContent = 'export const value = ;\n';

    const result = await tool.execute({
      files: [{ path: 'bad.ts', content: badContent }],
      verbosity: 'standard',
    });

    expect(result.success).toBe(true);
    expect(result.warnings?.some((warning) => warning.includes('Auto-heal skipped'))).toBe(true);
    expect(readFileSync(join(root, 'bad.ts'), 'utf-8')).toBe(badContent);
    const output = JSON.parse(result.output ?? '{}') as {
      files?: Array<{ auto_heal?: { attempted: boolean; healed: boolean } }>;
    };
    expect(output.files?.[0]?.auto_heal).toEqual({ attempted: true, healed: false });
  });

  test('exec file_ops exposes delete preview inspection warnings', async () => {
    const root = tempRoot('gv-file-ops-warnings-');
    const result = await executeFileOperations([
      { op: 'delete', source: 'missing.txt', dry_run: true },
    ], root);

    expect(result.fileOpWarnings?.some((warning) => warning.includes('Could not inspect'))).toBe(true);
    expect(result.fileOpResults[0]?.warnings?.some((warning) => warning.includes('Could not inspect'))).toBe(true);
  });

  test('exec tool carries file_op warnings into the tool result and output metadata', async () => {
    const root = tempRoot('gv-exec-file-op-warnings-');
    const tool = createExecTool(new ProcessManager(), {
      overflowHandler: new OverflowHandler({ baseDir: root }),
    });

    const result = await tool.execute({
      working_dir: root,
      commands: [{ cmd: 'true' }],
      file_ops: [{ op: 'delete', source: 'missing.txt', dry_run: true }],
    });

    expect(result.success).toBe(true);
    expect(result.warnings?.some((warning) => warning.includes('Could not inspect'))).toBe(true);
    const output = JSON.parse(result.output ?? '{}') as { warnings?: string[] };
    expect(output.warnings?.some((warning) => warning.includes('Could not inspect'))).toBe(true);
  });

  test('exec accepts command-level working_dir for a single command', async () => {
    const root = tempRoot('gv-exec-command-working-dir-');
    const tool = createExecTool(new ProcessManager(), {
      overflowHandler: new OverflowHandler({ baseDir: root }),
    });

    const result = await tool.execute({
      commands: [{ cmd: 'pwd', working_dir: root }],
      verbosity: 'verbose',
    });

    expect(result.success).toBe(true);
    const output = JSON.parse(result.output ?? '{}') as { stdout?: string; cwd?: string };
    expect(output.stdout?.trim()).toBe(root);
    expect(output.cwd).toBe(root);
  });

  test('auto-repair returns warning metadata instead of throwing on clone failures', () => {
    const result = repairToolCall(
      'example',
      { callback: () => undefined },
      {
        name: 'example',
        description: 'test tool',
        parameters: { type: 'object', properties: {} },
      },
    );

    expect(result.repaired).toBe(false);
    expect(result.warnings?.[0]).toContain("Auto-repair skipped for tool 'example'");
  });
});
