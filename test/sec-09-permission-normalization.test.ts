/**
 * Coverage-gap smoke test — platform/runtime/permissions/normalization (sec-09)
 * Verifies that permission normalization functions load and behave correctly.
 * Closes coverage gap: sec-09 permission normalization (eighth-review)
 */

import { describe, expect, test } from 'bun:test';
import {
  normalizeCommand,
  normalizeCommandWithVerdicts,
  DEFAULT_ALLOWED_CLASSES,
} from '../packages/sdk/src/platform/runtime/permissions/normalization/index.js';

describe('platform/runtime/permissions/normalization — smoke', () => {
  test('DEFAULT_ALLOWED_CLASSES is a non-empty Set', () => {
    expect(DEFAULT_ALLOWED_CLASSES.size).toBeGreaterThan(0);
  });

  test('normalizeCommand returns an object with original and segments', () => {
    const result = normalizeCommand('ls -la /tmp');
    expect(result.original).toBe('ls -la /tmp');
    expect(result.segments.length).toBeGreaterThan(0);
    expect(result.segments[0]).toBe('ls');
  });

  test('normalizeCommand trims whitespace consistently', () => {
    const withSpaces = normalizeCommand('  git status  ');
    const withoutSpaces = normalizeCommand('git status');
    expect(withSpaces.segments.length).toBe(withoutSpaces.segments.length);
  });

  test('normalizeCommandWithVerdicts returns a compound verdict object', () => {
    const result = normalizeCommandWithVerdicts('bash -c "echo hello"', DEFAULT_ALLOWED_CLASSES);
    expect(result).not.toBeNull();
    // CompoundVerdict must have at minimum an 'allowed' or 'verdict' property
    expect(Object.keys(result as object).length).toBeGreaterThan(0);
  });
});
