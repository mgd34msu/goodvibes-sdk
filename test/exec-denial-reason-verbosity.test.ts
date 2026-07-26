/**
 * A denied exec command reports its reason at every verbosity.
 *
 * Nothing runs when the guard refuses a command, so the reason IS the result.
 * Verbosity is an output-volume control and used to be applied to it anyway:
 * `minimal` cut the reason to its first line and `count_only` dropped it
 * entirely, so a caller was told only that something failed. A model cannot
 * correct what it cannot see.
 *
 * The command below is on the frozen catastrophic list, which is what makes it
 * a stable denial to assert against. Nothing here widens that list.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecTool } from '../packages/sdk/src/platform/tools/exec/runtime.ts';
import { ProcessManager } from '../packages/sdk/src/platform/tools/shared/process-manager.ts';
import { OverflowHandler } from '../packages/sdk/src/platform/tools/shared/overflow.ts';

const DENIED = 'rm -rf /';

interface DenialOutput {
  denied?: boolean;
  denial_reason?: string;
  segments?: Array<{ command: string; classification: string; reason: string }>;
}

function makeTool() {
  const root = mkdtempSync(join(tmpdir(), 'gv-exec-denial-'));
  return { root, tool: createExecTool(new ProcessManager(), { overflowHandler: new OverflowHandler({ baseDir: root }) }) };
}

async function denialAt(verbosity: string): Promise<DenialOutput> {
  const { root, tool } = makeTool();
  const result = await tool.execute({ working_dir: root, commands: [{ cmd: DENIED }], verbosity });
  return JSON.parse(result.output ?? '{}') as DenialOutput;
}

describe('exec — a denial keeps its reason at every verbosity', () => {
  for (const verbosity of ['count_only', 'minimal', 'standard', 'verbose']) {
    test(`${verbosity} names the denial and why`, async () => {
      const output = await denialAt(verbosity);

      expect(output.denied).toBe(true);
      expect(typeof output.denial_reason).toBe('string');
      expect(output.denial_reason).toContain('denied');
      // The reason must actually explain, not just restate the outcome.
      expect((output.denial_reason ?? '').length).toBeGreaterThan(
        'Command denied by policy'.length,
      );
    });
  }

  test('minimal no longer truncates the reason to its first line', async () => {
    const output = await denialAt('minimal');
    expect((output.denial_reason ?? '').split('\n').length).toBeGreaterThan(1);
  });

  test('count_only still carries the reason instead of dropping it', async () => {
    const output = await denialAt('count_only');
    expect(output.denial_reason).toBeDefined();
    expect(output.denial_reason).not.toBe('');
  });
});

describe('exec — a denied multi-line command still explains itself', () => {
  test("a heredoc-bearing denial names the command on one readable line", async () => {
    const { root, tool } = makeTool();
    const cmd = "cat <<'EOF'\nplaceholder\nEOF\n; rm -rf /";
    const result = await tool.execute({ working_dir: root, commands: [{ cmd }], verbosity: 'minimal' });
    const output = JSON.parse(result.output ?? '{}') as DenialOutput;

    expect(output.denied).toBe(true);
    const firstLine = (output.denial_reason ?? '').split('\n')[0] ?? '';
    expect(firstLine).toContain('Command denied');
    expect(firstLine.endsWith('"')).toBe(true);
  });
});
