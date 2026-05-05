import { afterEach, describe, expect, it, spyOn, type Mock } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPromptFile } from '../packages/sdk/src/platform/utils/prompt-loader.js';
import { walkDir } from '../packages/sdk/src/platform/utils/walk-dir.js';
import { logger } from '../packages/sdk/src/platform/utils/logger.js';

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'gv-prompt-file-utils-'));
  tempRoots.push(root);
  return root;
}

function captureDebugLogs(): {
  readonly calls: Array<{ message: string; data: Record<string, unknown> | undefined }>;
  readonly restore: () => void;
} {
  const calls: Array<{ message: string; data: Record<string, unknown> | undefined }> = [];
  const debugSpy = spyOn(logger, 'debug') as Mock<typeof logger.debug>;
  debugSpy.mockImplementation((message: string, data?: Record<string, unknown>) => {
    calls.push({ message, data });
  });
  return {
    calls,
    restore: () => debugSpy.mockRestore(),
  };
}

function captureWarnLogs(): {
  readonly calls: Array<{ message: string; data: Record<string, unknown> | undefined }>;
  readonly restore: () => void;
} {
  const calls: Array<{ message: string; data: Record<string, unknown> | undefined }> = [];
  const warnSpy = spyOn(logger, 'warn') as Mock<typeof logger.warn>;
  warnSpy.mockImplementation((message: string, data?: Record<string, unknown>) => {
    calls.push({ message, data });
  });
  return {
    calls,
    restore: () => warnSpy.mockRestore(),
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('readPromptFile', () => {
  it('preserves explicit include and escaped at-sign semantics', () => {
    const root = makeTempRoot();
    writeFileSync(join(root, 'include.md'), 'included');
    writeFileSync(
      join(root, 'main.md'),
      'start\n@include.md\n@@literal\n  @@indented\nliteral @ not include',
    );

    expect(readPromptFile(join(root, 'main.md'))).toBe(
      'start\nincluded\n@literal\n  @indented\nliteral @ not include',
    );
  });

  it('logs and skips circular includes without duplicating content', () => {
    const root = makeTempRoot();
    writeFileSync(join(root, 'a.md'), 'A1\n@b.md\nA2');
    writeFileSync(join(root, 'b.md'), 'B1\n@a.md\nB2');
    const debug = captureDebugLogs();

    try {
      expect(readPromptFile(join(root, 'a.md'))).toBe('A1\nB1\nB2\nA2');
      expect(debug.calls.some((call) => call.message.includes('already visited'))).toBe(true);
    } finally {
      debug.restore();
    }
  });
});

describe('walkDir', () => {
  it('logs and skips an unreadable or missing root directory', async () => {
    const root = makeTempRoot();
    const missingDir = join(root, 'missing');
    const warn = captureWarnLogs();
    const files: string[] = [];

    try {
      for await (const file of walkDir(missingDir)) {
        files.push(file);
      }
      expect(files).toEqual([]);
      expect(warn.calls.some((call) => call.message === 'walkDir skipped unreadable directory')).toBe(true);
    } finally {
      warn.restore();
    }
  });

  it('keeps yielding readable files while skipping hidden entries', async () => {
    const root = makeTempRoot();
    mkdirSync(join(root, '.hidden'));
    writeFileSync(join(root, 'visible.txt'), 'visible');
    writeFileSync(join(root, '.hidden', 'hidden.txt'), 'hidden');
    const files: string[] = [];

    for await (const file of walkDir(root)) {
      files.push(file);
    }

    expect(files).toEqual([join(root, 'visible.txt')]);
  });
});
