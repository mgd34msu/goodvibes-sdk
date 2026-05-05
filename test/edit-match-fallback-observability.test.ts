import { describe, expect, test } from 'bun:test';
import {
  computeAstEdit,
  computeAstPatternEdit,
} from '../packages/sdk/src/platform/tools/edit/match.ts';

describe('edit match fallback observability', () => {
  test('ast mode reports exact fallback when tree-sitter is unavailable for the file type', async () => {
    const result = await computeAstEdit(
      'alpha = 1\n',
      { path: 'notes.txt', find: 'alpha = 1', replace: 'alpha = 2' },
      'notes.txt',
    );

    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.newContent).toBe('alpha = 2\n');
    expect(result.warning).toMatch(/used exact match instead/i);
  });

  test('ast_pattern mode reports exact fallback when ast-grep has no parser for the file type', async () => {
    const result = await computeAstPatternEdit(
      'alpha = 1\n',
      { path: 'notes.txt', find: 'alpha = 1', replace: 'alpha = 2' },
      'notes.txt',
    );

    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.newContent).toBe('alpha = 2\n');
    expect(result.warning).toMatch(/used exact match instead/i);
  });
});
