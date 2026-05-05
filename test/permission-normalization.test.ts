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
    expect(result.segments[0].command).toBe('ls');
  });

  test('normalizeCommand trims whitespace consistently', () => {
    const withSpaces = normalizeCommand('  git status  ');
    const withoutSpaces = normalizeCommand('git status');
    expect(withSpaces.segments.length).toBe(withoutSpaces.segments.length);
    expect(withSpaces.highestClassification).toBe(withoutSpaces.highestClassification);
  });

  test('normalizeCommand preserves sequence segments for separate classification', () => {
    const result = normalizeCommand('git status && curl https://example.com');
    expect(result.segments.map((segment) => segment.command)).toEqual(['git', 'curl']);
    expect(result.classifications).toEqual(expect.arrayContaining(['read', 'network']));
    expect(result.highestClassification).toBe('network');
  });

  test('normalizeCommandWithVerdicts allows read commands and records the segment reason', () => {
    const result = normalizeCommandWithVerdicts('ls -la /tmp', DEFAULT_ALLOWED_CLASSES);
    expect(result.allowed).toBe(true);
    expect(result.highestClassification).toBe('read');
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]?.command).toBe('ls');
    expect(result.segments[0]?.reason).toContain('permitted');
    expect(result.denialExplanation).toBeUndefined();
  });

  test('normalizeCommandWithVerdicts denies destructive commands with an explanation', () => {
    const result = normalizeCommandWithVerdicts('rm -rf /tmp/goodvibes-test', DEFAULT_ALLOWED_CLASSES);
    expect(result.allowed).toBe(false);
    expect(result.highestClassification).toBe('destructive');
    expect(result.segments.some((segment) => segment.classification === 'destructive')).toBe(true);
    expect(result.denialExplanation).toContain('denied');
  });

  test('normalizeCommandWithVerdicts flags substitution-style obfuscation', () => {
    const result = normalizeCommandWithVerdicts('echo $(whoami)');
    expect(result.allowed).toBe(false);
    expect(result.hasObfuscation).toBe(true);
    expect(result.segments[0]?.obfuscationPatterns.join(' ')).toContain('command substitution');
  });
});
