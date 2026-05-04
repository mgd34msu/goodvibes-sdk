/**
 * perf-07: setInterval .unref() regression guard.
 *
 * Enumerates all setInterval call sites in the SDK platform source and
 * verifies the interval reference is passed to .unref?.() so that Node.js /
 * Bun processes can exit cleanly without dangling intervals keeping the event
 * loop alive.
 *
 * N7: This test guards against silent regression where new setInterval sites
 * are added without the corresponding .unref?.(). The seventh review confirmed
 * all 18/18 setInterval sites are .unref'd; this test pins that invariant.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import { resolve } from 'node:path';

const SDK_SRC = resolve(import.meta.dir, '../packages/sdk/src/platform');

/** Read a file and return all lines containing setInterval call expressions. */
function findSetIntervalLines(content: string): string[] {
  return content
    .split('\n')
    .filter((line) => /setInterval\s*\(/.test(line));
}

/**
 * Number of lines to look ahead when searching for a `.unref?.()` call
 * following a `setInterval` assignment. Configurable for test environments
 * with unusual formatting conventions.
 */
const UNREF_LOOK_AHEAD_LINES = Number(process.env['UNREF_LOOK_AHEAD_LINES'] ?? 20);

/**
 * For a given setInterval call, check if the result is assigned to a variable
 * that has `.unref?.()` called on it within a reasonable window.
 *
 * Patterns accepted:
 *   const timer = setInterval(...);
 *   timer.unref?.();
 *
 *   const x = setInterval(...).unref?.();  // inline unref
 *
 *   setInterval(...)  // captured inline as class property with .unref
 */
function hasUnrefInWindow(lines: string[], lineIndex: number): boolean {
  const line = lines[lineIndex]!;
  // Inline .unref chain: setInterval(...).unref?.()
  if (/setInterval[^)]*\).*\.unref\??\.\(\)/.test(line)) return true;

  // Assignment: look for the assigned variable name and find .unref in the window
  const assignMatch = line.match(/(?:const|let|var|this\.[\w.]+)\s+(?:=\s+)?setInterval|([\w.]+)\s*=\s*setInterval/);
  if (assignMatch) {
    // Extract variable name from left-hand side
    const varMatch = line.match(/(?:const|let|var)\s+([\w.]+)\s*=|([\w.]+)\s*=\s*setInterval/);
    const varName = varMatch?.[1] ?? varMatch?.[2];
    if (varName) {
      // Scan next UNREF_LOOK_AHEAD_LINES lines for varName.unref
      const window = lines.slice(lineIndex + 1, lineIndex + UNREF_LOOK_AHEAD_LINES + 1);
      const unrefPattern = new RegExp(`${varName.replace('.', '\\.')}\\s*\.\\s*unref\\??\\.\\(\\)`);
      if (window.some((l) => unrefPattern.test(l))) return true;
    }
  }

  // Class field or complex pattern: scan window for any .unref call
  const window = lines.slice(lineIndex, lineIndex + UNREF_LOOK_AHEAD_LINES + 5);
  return window.some((l) => /\.unref\??\.\(\)/.test(l));
}

describe('perf-07: setInterval .unref() coverage', () => {
  test('all setInterval sites in platform/ have .unref?.()', async () => {
    const files: string[] = [];
    for await (const entry of glob('**/*.ts', { cwd: SDK_SRC })) {
      files.push(resolve(SDK_SRC, entry));
    }

    const violations: { file: string; line: number; content: string }[] = [];

    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      const lines = content.split('\n');
      lines.forEach((line, index) => {
        if (!/setInterval\s*\(/.test(line)) return;
        // Skip type-only / comment lines
        if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return;
        if (!hasUnrefInWindow(lines, index)) {
          violations.push({ file: file.replace(SDK_SRC + '/', ''), line: index + 1, content: line.trim() });
        }
      });
    }

    if (violations.length > 0) {
      const details = violations
        .map((v) => `  ${v.file}:${v.line}: ${v.content}`)
        .join('\n');
      throw new Error(
        `perf-07: ${violations.length} setInterval site(s) missing .unref?.() — add .unref?.() to keep process exit clean:\n${details}`,
      );
    }

    expect(violations.length).toBe(0);
  });
});
