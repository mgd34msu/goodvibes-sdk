/**
 * Glob → RegExp conversion must be built in a single forward pass.
 *
 * The earlier implementations round-tripped through a placeholder sentinel with
 * `String.replace(/…/g, …)`. A `g`-flagged regex literal reused across many
 * calls can carry `lastIndex` state into a later `replace` and skip the
 * sentinel-restore step, leaving a literal sentinel in the pattern so `**`
 * silently stops matching (observed only after tens of thousands of calls, e.g.
 * a full CI suite). These tests pin the corrected single-pass behaviour and the
 * leading globstar-slash prefix expansion the old shared util got wrong even on
 * the first call.
 */
import { describe, expect, test } from 'bun:test';
import { globBodyToRegexSource, globToRegex, buildGlobMatcher } from '../packages/sdk/src/platform/utils/glob-to-regex.js';

describe('globBodyToRegexSource — single-pass glob body', () => {
  test('maps **, *, and ? to the caller-chosen sub-expressions', () => {
    expect(globBodyToRegexSource('a/**', '[^/]*', '.*', '[^/]')).toBe('a/.*');
    expect(globBodyToRegexSource('a/*', '[^/]*', '.*', '[^/]')).toBe('a/[^/]*');
    expect(globBodyToRegexSource('a/?', '[^/]*', '.*', '[^/]')).toBe('a/[^/]');
    // Host flavour: single star stays within a dot segment, no ? handling.
    expect(globBodyToRegexSource('*.example.com', '[^.]*', '.*')).toBe('[^.]*\\.example\\.com');
  });

  test('escapes regex metacharacters and leaves ? literal when unmapped', () => {
    expect(globBodyToRegexSource('a.b+c(d)', '[^/]*', '.*')).toBe('a\\.b\\+c\\(d\\)');
    // question undefined → ? passes through as a literal question mark
    expect(globBodyToRegexSource('a?b', '[^/]*', '.*')).toBe('a?b');
  });

  test('a path-scope ** rule matches every file in the directory subtree', () => {
    const rx = new RegExp(`^${globBodyToRegexSource('/ws/src/**', '[^/]*', '.*', '[^/]')}$`);
    expect(rx.test('/ws/src/b.ts')).toBe(true);
    expect(rx.test('/ws/src/nested/deep.ts')).toBe(true);
    expect(rx.test('/ws/other/c.ts')).toBe(false);
  });

  test('stays correct across tens of thousands of calls (no lastIndex leak)', () => {
    // The exact failure shape: after heavy reuse the ** match must not regress.
    for (let i = 0; i < 50000; i++) {
      const rx = new RegExp(`^${globBodyToRegexSource('/ws/src/**', '[^/]*', '.*', '[^/]')}$`);
      if (!rx.test('/ws/src/b.ts')) throw new Error(`** match regressed on iteration ${i}`);
    }
    expect(true).toBe(true);
  });
});

describe('globToRegex — shared path matcher', () => {
  test('**/ expands to an optional path prefix (previously corrupted by the sentinel)', () => {
    const match = buildGlobMatcher('**/*.ts');
    expect(match('a.ts')).toBe(true);
    expect(match('src/a.ts')).toBe(true);
    expect(match('src/nested/a.ts')).toBe(true);
    expect(match('a.js')).toBe(false);
    // The generated group must be a real non-capturing optional, not corrupted.
    expect(globToRegex('**/*.ts').source).toBe('(^|\\/)(?:.+\\/)?[^/]*\\.ts$');
  });

  test('** crosses separators, * stays within a segment, ? is one non-slash char', () => {
    expect(buildGlobMatcher('src/**')('src/a/b/c.ts')).toBe(true);
    expect(buildGlobMatcher('src/*')('src/a.ts')).toBe(true);
    expect(buildGlobMatcher('src/*')('src/a/b.ts')).toBe(false);
    expect(buildGlobMatcher('a?c')('abc')).toBe(true);
    expect(buildGlobMatcher('a?c')('a/c')).toBe(false);
  });
});
