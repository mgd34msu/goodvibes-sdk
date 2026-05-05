/**
 * setInterval .unref() invariant.
 *
 * Enumerates all setInterval call sites in the SDK platform source and
 * verifies the interval reference is passed to .unref?.() so that Node.js /
 * Bun processes can exit cleanly without dangling intervals keeping the event
 * loop alive.
 * Uses an AST walk to find setInterval(...) call expressions and verify
 * .unref?.() is chained on the result within the enclosing scope.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Lang, parse } from '@ast-grep/napi';

const SDK_SRC = resolve(import.meta.dir, '../packages/sdk/src/platform');

/**
 * For a given source file, find all `setInterval(...)` call expressions using
 * the AST and check that .unref?.() is called on the result within the same
 * statement or the immediately following statements.
 *
 * Strategy:
 * 1. Parse the file with @ast-grep/napi using the TypeScript language.
 * 2. Find all nodes matching `setInterval($$$ARGS)`.
 * 3. For each match, inspect the parent statement:
 *    - If the call is directly chained: `setInterval(...).unref?.()` — OK.
 *    - If the call is assigned: check the enclosing block for a `.unref?.()` call
 *      on the same variable name within the next 25 lines.
 * 4. Return a list of violations (setInterval sites without .unref).
 */
function findUnrefViolations(
  filePath: string,
  content: string,
): { line: number; snippet: string }[] {
  const violations: { line: number; snippet: string }[] = [];

  const root = parse(Lang.TypeScript, content).root();

  // Find all setInterval call expressions
  // findAll() returns SgNode[] directly — each element IS the node
  const matches = root.findAll({ rule: { pattern: 'setInterval($$$ARGS)' } });

  for (const match of matches) {
    const range = match.range();
    const startLine = range.start.line; // 0-indexed

    // Get the text of the matched setInterval call
    const callText = match.text();

    // Case 1: Inline chain — setInterval(...).unref?.() or .unref()
    const parentText = match.parent()?.text() ?? '';
    if (/\.unref\??\(\)/.test(parentText)) {
      continue; // unref is chained on same expression
    }

    // Case 2: Assignment — find the variable name being assigned
    // Walk up to the variable declarator or expression statement
    let assignTarget: string | null = null;
    let cursor = match.parent();
    while (cursor) {
      const kind = cursor.kind();
      if (kind === 'variable_declarator') {
        // const/let/var x = setInterval(...)
        const nameNode = cursor.field('name');
        if (nameNode) {
          assignTarget = nameNode.text();
        }
        break;
      }
      if (kind === 'assignment_expression') {
        // this.x = setInterval(...) or x = setInterval(...)
        const leftNode = cursor.field('left');
        if (leftNode) {
          assignTarget = leftNode.text();
        }
        break;
      }
      if (kind === 'expression_statement' || kind === 'return_statement') {
        break;
      }
      cursor = cursor.parent();
    }

    if (assignTarget) {
      // Search the remaining file text from this line forward (up to 30 lines)
      const lines = content.split('\n');
      const windowEnd = Math.min(startLine + 30, lines.length);
      const windowLines = lines.slice(startLine, windowEnd);
      const windowText = windowLines.join('\n');

      // Build a pattern matching the assigned variable followed by .unref
      // Escape dots in member expressions (e.g., this.interval)
      const escapedTarget = assignTarget.replace(/\./g, '\\.');
      const unrefPattern = new RegExp(`${escapedTarget}\\s*\\.\\s*unref\\??\\(\\)`);
      if (unrefPattern.test(windowText)) {
        continue; // found .unref call on the assigned variable
      }
    }

    // Case 3: Class field or complex pattern — scan enclosing block for any .unref
    let blockCursor = match.parent();
    while (blockCursor) {
      const kind = blockCursor.kind();
      if (kind === 'statement_block' || kind === 'class_body' || kind === 'program') {
        const blockText = blockCursor.text();
        // Only scan lines at/after the setInterval call
        const afterCall = blockText.slice(blockText.indexOf(callText));
        if (/\.unref\??\(\)/.test(afterCall)) {
          break; // found .unref in the enclosing block
        }
        break;
      }
      if (kind === 'method_definition' || kind === 'function_declaration' || kind === 'arrow_function') {
        const bodyText = blockCursor.text();
        const afterCall = bodyText.slice(bodyText.indexOf(callText));
        if (/\.unref\??\(\)/.test(afterCall)) {
          break; // found .unref in the enclosing function
        }
        // No .unref found in enclosing function scope — this is a violation
        violations.push({
          line: startLine + 1, // convert to 1-indexed
          snippet: callText.slice(0, 120),
        });
        break;
      }
      blockCursor = blockCursor.parent();
    }
  }

  return violations;
}

describe('setInterval .unref() coverage (AST walk)', () => {
  test('all setInterval sites in platform/ have .unref?.() (real AST walk)', async () => {
    const files: string[] = [];
    for await (const entry of glob('**/*.ts', { cwd: SDK_SRC })) {
      files.push(resolve(SDK_SRC, entry));
    }

    const allViolations: { file: string; line: number; snippet: string }[] = [];

    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      // Skip files with no setInterval at all (fast path)
      if (!content.includes('setInterval')) continue;

      const violations = findUnrefViolations(file, content);
      for (const v of violations) {
        allViolations.push({
          file: file.replace(SDK_SRC + '/', ''),
          line: v.line,
          snippet: v.snippet,
        });
      }
    }

    if (allViolations.length > 0) {
      const details = allViolations
        .map((v) => `  ${v.file}:${v.line}: ${v.snippet}`)
        .join('\n');
      throw new Error(
        `${allViolations.length} setInterval site(s) missing .unref?.() — add .unref?.() to keep process exit clean:\n${details}`,
      );
    }

    expect(allViolations.length).toBe(0);
  });
});
