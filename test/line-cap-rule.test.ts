import { describe, expect, test } from 'bun:test';
import { checkLineCap, MAX_SOURCE_LINES, type GrandfatherEntry } from '../scripts/line-cap-rule.ts';

const grandfather = (
  entries: Record<string, GrandfatherEntry>,
): Readonly<Record<string, GrandfatherEntry>> => entries;

describe('checkLineCap', () => {
  test('a new file (no grandfather entry) under the cap passes', () => {
    const violations = checkLineCap(
      [{ relPath: 'packages/sdk/src/new-file.ts', lineCount: 799 }],
      grandfather({}),
    );
    expect(violations).toEqual([]);
  });

  test('a new file (no grandfather entry) at exactly the cap passes', () => {
    const violations = checkLineCap(
      [{ relPath: 'packages/sdk/src/new-file.ts', lineCount: MAX_SOURCE_LINES }],
      grandfather({}),
    );
    expect(violations).toEqual([]);
  });

  test('a new file (no grandfather entry) over the cap fails', () => {
    const violations = checkLineCap(
      [{ relPath: 'packages/sdk/src/new-file.ts', lineCount: 801 }],
      grandfather({}),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('packages/sdk/src/new-file.ts');
    expect(violations[0]).toContain('exceeds the 800-line cap');
    expect(violations[0]).toContain('801');
  });

  test('a grandfathered file sitting exactly at its ceiling passes', () => {
    const violations = checkLineCap(
      [{ relPath: 'packages/sdk/src/big.ts', lineCount: 1200 }],
      grandfather({
        'packages/sdk/src/big.ts': { ceiling: 1200, justification: 'pre-split monolith, shrink-only' },
      }),
    );
    expect(violations).toEqual([]);
  });

  test('a grandfathered file that shrank (but is still over 800) passes', () => {
    const violations = checkLineCap(
      [{ relPath: 'packages/sdk/src/big.ts', lineCount: 900 }],
      grandfather({
        'packages/sdk/src/big.ts': { ceiling: 1200, justification: 'pre-split monolith, shrink-only' },
      }),
    );
    expect(violations).toEqual([]);
  });

  test('a grandfathered file that grew past its ceiling fails', () => {
    const violations = checkLineCap(
      [{ relPath: 'packages/sdk/src/big.ts', lineCount: 1201 }],
      grandfather({
        'packages/sdk/src/big.ts': { ceiling: 1200, justification: 'pre-split monolith, shrink-only' },
      }),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('packages/sdk/src/big.ts');
    expect(violations[0]).toContain('grew past its grandfathered ceiling of 1200');
    expect(violations[0]).toContain('1201');
  });

  test('a grandfathered file shrunk under 800 but still listed fails with the stale-entry message', () => {
    const violations = checkLineCap(
      [{ relPath: 'packages/sdk/src/big.ts', lineCount: 750 }],
      grandfather({
        'packages/sdk/src/big.ts': { ceiling: 1200, justification: 'pre-split monolith, shrink-only' },
      }),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('packages/sdk/src/big.ts');
    expect(violations[0]).toContain('under the 800-line cap');
    expect(violations[0]).toContain('remove the entry from line-cap-grandfather.ts');
  });

  test('a grandfathered file at exactly 800 lines is neither stale nor violating', () => {
    const violations = checkLineCap(
      [{ relPath: 'packages/sdk/src/big.ts', lineCount: MAX_SOURCE_LINES }],
      grandfather({
        'packages/sdk/src/big.ts': { ceiling: 1200, justification: 'pre-split monolith, shrink-only' },
      }),
    );
    expect(violations).toEqual([]);
  });

  test('a grandfather entry for a file that no longer exists in the scan fails as orphaned', () => {
    const violations = checkLineCap(
      [{ relPath: 'packages/sdk/src/unrelated.ts', lineCount: 10 }],
      grandfather({
        'packages/sdk/src/deleted.ts': { ceiling: 1200, justification: 'pre-split monolith, shrink-only' },
      }),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('packages/sdk/src/deleted.ts');
    expect(violations[0]).toContain('not found among scanned source files');
    expect(violations[0]).toContain('remove the entry from line-cap-grandfather.ts');
  });

  test('multiple independent violations are all reported', () => {
    const violations = checkLineCap(
      [
        { relPath: 'packages/sdk/src/new-file.ts', lineCount: 900 },
        { relPath: 'packages/sdk/src/big.ts', lineCount: 1300 },
        { relPath: 'packages/sdk/src/shrunk.ts', lineCount: 500 },
      ],
      grandfather({
        'packages/sdk/src/big.ts': { ceiling: 1200, justification: 'pre-split monolith, shrink-only' },
        'packages/sdk/src/shrunk.ts': { ceiling: 900, justification: 'pre-split, shrink-only' },
      }),
    );
    expect(violations).toHaveLength(3);
  });
});
