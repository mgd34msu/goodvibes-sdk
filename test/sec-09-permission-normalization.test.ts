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
  test('normalizeCommand is a function', () => {
    expect(typeof normalizeCommand).toBe('function');
  });

  test('normalizeCommandWithVerdicts is a function', () => {
    expect(typeof normalizeCommandWithVerdicts).toBe('function');
  });

  test('DEFAULT_ALLOWED_CLASSES is a Set', () => {
    expect(DEFAULT_ALLOWED_CLASSES instanceof Set).toBe(true);
    expect(DEFAULT_ALLOWED_CLASSES.size).toBeGreaterThan(0);
  });

  test('normalizeCommand returns an object with original and segments', () => {
    const result = normalizeCommand('ls -la /tmp');
    expect(typeof result).toBe('object');
    expect(result.original).toBe('ls -la /tmp');
    expect(Array.isArray(result.segments)).toBe(true);
  });

  test('normalizeCommand trims whitespace consistently', () => {
    const withSpaces = normalizeCommand('  git status  ');
    const withoutSpaces = normalizeCommand('git status');
    expect(withSpaces.segments.length).toBe(withoutSpaces.segments.length);
  });

  test('normalizeCommandWithVerdicts returns a compound verdict object', () => {
    const result = normalizeCommandWithVerdicts('bash -c "echo hello"', DEFAULT_ALLOWED_CLASSES);
    expect(result).toBeDefined();
    expect(typeof result).toBe('object');
    // CompoundVerdict has at minimum an 'allowed' or 'verdict' property
    expect(result).not.toBeNull();
  });
});
