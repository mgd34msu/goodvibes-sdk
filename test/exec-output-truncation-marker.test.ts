/**
 * Exec output shaping never hides that it dropped content.
 *
 * `minimal` verbosity returned `stdout.split('\n')[0]` with nothing to say the
 * rest existed. A 42-line `pactl list short sources` therefore arrived as a
 * single line that read exactly like a complete device list, and the reader
 * concluded, and repeated to the user, that a device that was plugged in and
 * set as the default did not exist. One line of output and one line of truth
 * are indistinguishable unless the shaping says which it is.
 *
 * These tests pin the marker: every drop carries an explicit count, at every
 * verbosity, for stdout and stderr both.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecTool } from '../packages/sdk/src/platform/tools/exec/runtime.ts';
import { formatResult, shapeStream } from '../packages/sdk/src/platform/tools/exec/result-format.ts';
import { ProcessManager } from '../packages/sdk/src/platform/tools/shared/process-manager.ts';
import { OverflowHandler } from '../packages/sdk/src/platform/tools/shared/overflow.ts';
import type { ExecCommandResult } from '../packages/sdk/src/platform/tools/exec/schema.ts';

interface Output {
  stdout?: string;
  stderr?: string;
  stdout_dropped_lines?: number;
  stderr_dropped_lines?: number;
  stdout_truncated?: boolean;
}

/** Runs `cmd` through the real exec tool at `verbosity` and parses the result. */
async function runAt(cmd: string, verbosity: string): Promise<Output> {
  const root = mkdtempSync(join(tmpdir(), 'gv-exec-marker-'));
  const tool = createExecTool(new ProcessManager(), {
    overflowHandler: new OverflowHandler({ baseDir: root }),
  });
  const result = await tool.execute({ working_dir: root, commands: [{ cmd }], verbosity });
  return JSON.parse(result.output ?? '{}') as Output;
}

/** A result carrying `lines` lines of stdout, as the runtime would hand it over. */
function resultWith(stdout: string, stderr = ''): ExecCommandResult {
  return {
    cmd: 'probe',
    exit_code: 0,
    success: true,
    stdout,
    stderr,
  } as ExecCommandResult;
}

describe('exec — minimal verbosity marks what it dropped', () => {
  test('a 42-line stdout at minimal keeps one line and names the other 41', async () => {
    const out = await runAt('seq 1 42', 'minimal');

    // The line that was kept is still there …
    expect(out.stdout).toContain('1');
    // … and the 41 that were not are stated, with the count, in the output
    // itself, not only in a sibling field a reader can skip.
    expect(out.stdout).toContain('+41 more stdout lines');
    expect(out.stdout).toContain('raise verbosity');
    expect(out.stdout_dropped_lines).toBe(41);
  });

  test('the marker is absent when nothing was dropped', async () => {
    const out = await runAt('echo only-one-line', 'minimal');

    expect(out.stdout).toBe('only-one-line');
    expect(out.stdout).not.toContain('more stdout lines');
    expect(out.stdout_dropped_lines).toBeUndefined();
  });

  test('stderr is marked too, not just stdout', async () => {
    const out = await runAt('seq 1 12 1>&2', 'minimal');

    expect(out.stderr).toContain('+11 more stderr lines');
    expect(out.stderr_dropped_lines).toBe(11);
  });

  test('count_only still discloses the dropped line counts', async () => {
    const out = await runAt('seq 1 42', 'count_only');

    expect(out.stdout_dropped_lines).toBe(42);
    expect(out.stdout).toContain('42 stdout lines omitted');
  });
});

describe('exec — an overflow cut is disclosed at every verbosity', () => {
  for (const verbosity of ['count_only', 'minimal', 'standard', 'verbose'] as const) {
    test(`${verbosity} says the stream was cut at the size limit`, () => {
      const result = { ...resultWith('kept\n'), stdout_truncated: true } as ExecCommandResult;
      const shaped = formatResult(result, verbosity) as Output;

      expect(shaped.stdout ?? '').toContain('cut at the output size limit');
      // The pre-existing flag stays, so consumers reading it keep working.
      expect(shaped.stdout_truncated).toBe(true);
    });
  }
});

describe('shapeStream — the counted marker is truthful', () => {
  test('a trailing newline is not counted as a dropped line', () => {
    const { text, droppedLines } = shapeStream('a\nb\n', 'stdout', 1, false);

    expect(droppedLines).toBe(1);
    // Singular, because exactly one real line is hidden, the trailing newline
    // is not a line, and a marker that miscounts is the defect it exists to fix.
    expect(text).toContain('+1 more stdout line,');
    expect(text).not.toContain('lines');
  });

  test('empty output produces no marker at all', () => {
    expect(shapeStream('', 'stdout', 1, false)).toEqual({ text: '', droppedLines: 0 });
  });

  test('keeping every line drops nothing', () => {
    const { text, droppedLines } = shapeStream('a\nb\nc', 'stdout', null, false);

    expect(droppedLines).toBe(0);
    expect(text).toBe('a\nb\nc');
  });
});
