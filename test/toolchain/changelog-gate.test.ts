import { describe, expect, test } from 'bun:test';
import { hasChangelogSection, runChangelogGate } from '@pellux/goodvibes-toolchain';

describe('changelog-gate', () => {
  test('detects a bracketed section', () => {
    expect(hasChangelogSection('## [1.2.3] - 2026-07-16\n\n- x', '1.2.3', 'bracket')).toBe(true);
  });
  test('detects a plain section', () => {
    expect(hasChangelogSection('## 1.2.3 - 2026-07-16\n', '1.2.3', 'plain')).toBe(true);
  });
  test('either matches both conventions', () => {
    expect(hasChangelogSection('## [1.2.3]\n', '1.2.3', 'either')).toBe(true);
    expect(hasChangelogSection('## 1.2.3\n', '1.2.3', 'either')).toBe(true);
  });
  test('does not match a different version or a prefix collision', () => {
    expect(hasChangelogSection('## [1.2.30]\n', '1.2.3', 'bracket')).toBe(false);
    expect(hasChangelogSection('## 1.2.31\n', '1.2.3', 'plain')).toBe(false);
  });
  test('gate result carries an actionable message on miss', () => {
    const result = runChangelogGate('# Changelog\n', '9.9.9');
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('9.9.9');
  });
});
