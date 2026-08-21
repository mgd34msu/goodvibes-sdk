import { describe, expect, test } from 'bun:test';
import {
  compareVersions,
  decideLatestAlignment,
  parseDistTagLatestResponse,
  parseVersion,
  parseVersionsResponse,
} from '../scripts/align-dist-tags.ts';

const cmp = (a: string, b: string): number => compareVersions(parseVersion(a)!, parseVersion(b)!);

describe('semver ordering', () => {
  test('orders by major, then minor, then patch', () => {
    expect(cmp('2.0.19', '2.0.18')).toBeGreaterThan(0);
    expect(cmp('2.1.0', '2.0.99')).toBeGreaterThan(0);
    expect(cmp('3.0.0', '2.99.99')).toBeGreaterThan(0);
    expect(cmp('2.0.18', '2.0.18')).toBe(0);
  });

  test('numeric version parts compare numerically, not as strings', () => {
    // The bug a lexical sort produces: "2.0.9" > "2.0.10".
    expect(cmp('2.0.10', '2.0.9')).toBeGreaterThan(0);
    expect(cmp('2.10.0', '2.9.0')).toBeGreaterThan(0);
  });

  test('a prerelease ranks below the release it precedes', () => {
    expect(cmp('2.0.1', '2.0.1-rc.1')).toBeGreaterThan(0);
    expect(cmp('2.0.1-rc.2', '2.0.1-rc.1')).toBeGreaterThan(0);
    expect(cmp('2.0.1-rc.10', '2.0.1-rc.9')).toBeGreaterThan(0);
    expect(cmp('2.0.1-beta', '2.0.1-alpha')).toBeGreaterThan(0);
    // Numeric identifiers rank below alphanumeric ones (semver 11.4.3).
    expect(cmp('2.0.1-alpha', '2.0.1-1')).toBeGreaterThan(0);
    // A larger set of prerelease fields ranks higher when the prefix matches.
    expect(cmp('2.0.1-rc.1.1', '2.0.1-rc.1')).toBeGreaterThan(0);
  });

  test('parseVersion accepts build metadata and rejects non-semver', () => {
    expect(parseVersion('2.0.1+build.5')?.patch).toBe(1);
    expect(parseVersion('2.0')).toBeNull();
    expect(parseVersion('v2.0.1')).toBeNull();
    expect(parseVersion('latest')).toBeNull();
  });
});

describe('npm view response parsing', () => {
  test('dist-tags.latest arrives WRAPPED in an array, which must not read as unset', () => {
    // The real shape, captured from `npm view @pellux/goodvibes-sdk
    // dist-tags.latest --json`. Reading it as a bare string made all 11
    // packages look untagged and would have rewritten every latest tag.
    expect(parseDistTagLatestResponse('[\n  "2.0.17"\n]')).toBe('2.0.17');
  });

  test('a bare string latest is still accepted', () => {
    expect(parseDistTagLatestResponse('"2.0.17"')).toBe('2.0.17');
  });

  test('an empty or non-string latest response reads as unset', () => {
    expect(parseDistTagLatestResponse('')).toBeNull();
    expect(parseDistTagLatestResponse('[]')).toBeNull();
    expect(parseDistTagLatestResponse('{}')).toBeNull();
  });

  test('versions arrives as a flat array of strings', () => {
    expect(parseVersionsResponse('["2.0.16","2.0.17"]')).toEqual(['2.0.16', '2.0.17']);
  });

  test('a single-version package answers with a bare string', () => {
    expect(parseVersionsResponse('"1.0.0"')).toEqual(['1.0.0']);
  });

  test('an empty versions response is an empty list, not a crash', () => {
    expect(parseVersionsResponse('')).toEqual([]);
  });
});

describe('decideLatestAlignment', () => {
  test('a backward latest is corrected to the highest version', () => {
    // The interleaving this repair exists for: an older release run published
    // last for this package, so latest went backward.
    const decision = decideLatestAlignment(['2.0.17', '2.0.18', '2.0.19'], '2.0.18');
    expect(decision.correct).toBe(true);
    expect(decision.target).toBe('2.0.19');
    expect(decision.reason).toContain('points at 2.0.18');
    expect(decision.reason).toContain('2.0.19');
  });

  test('a correct latest is a no-op', () => {
    const decision = decideLatestAlignment(['2.0.17', '2.0.18', '2.0.19'], '2.0.19');
    expect(decision.correct).toBe(false);
    expect(decision.target).toBe('2.0.19');
    expect(decision.reason).toContain('already points at 2.0.19');
  });

  test('running twice is idempotent (the second pass finds nothing to do)', () => {
    const first = decideLatestAlignment(['2.0.18', '2.0.19'], '2.0.18');
    expect(first.correct).toBe(true);
    const second = decideLatestAlignment(['2.0.18', '2.0.19'], first.target);
    expect(second.correct).toBe(false);
  });

  test('version order in the registry response does not matter', () => {
    const decision = decideLatestAlignment(['2.0.19', '2.0.9', '2.0.10'], '2.0.9');
    expect(decision.target).toBe('2.0.19');
  });

  test('an unset latest is corrected to the highest version', () => {
    const decision = decideLatestAlignment(['1.0.0', '1.0.1'], null);
    expect(decision.correct).toBe(true);
    expect(decision.target).toBe('1.0.1');
    expect(decision.reason).toContain('unset');
  });

  test('a stable release wins over a higher prerelease', () => {
    // Stable-preferred: latest must not be dragged onto an RC.
    const decision = decideLatestAlignment(['2.0.18', '2.0.19-rc.1'], '2.0.18');
    expect(decision.correct).toBe(false);
    expect(decision.target).toBe('2.0.18');
  });

  test('a prerelease is chosen only when nothing stable exists', () => {
    const decision = decideLatestAlignment(['1.0.0-rc.1', '1.0.0-rc.2'], '1.0.0-rc.1');
    expect(decision.correct).toBe(true);
    expect(decision.target).toBe('1.0.0-rc.2');
  });

  test('a package with no versions yields no target and no correction', () => {
    const decision = decideLatestAlignment([], null);
    expect(decision.correct).toBe(false);
    expect(decision.target).toBeNull();
    expect(decision.reason).toContain('no versions');
  });

  test('unparseable versions are reported and never chosen', () => {
    const decision = decideLatestAlignment(['2.0.18', 'garbage', '2.0.19'], '2.0.18');
    expect(decision.target).toBe('2.0.19');
    expect(decision.unparseable).toEqual(['garbage']);
  });

  test('a registry answering only unparseable versions produces no target', () => {
    const decision = decideLatestAlignment(['garbage'], null);
    expect(decision.target).toBeNull();
    expect(decision.reason).toContain('parseable');
  });
});
