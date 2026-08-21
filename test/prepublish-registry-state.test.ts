import { describe, expect, test } from 'bun:test';
import { classifyPrepublishRegistryState, type PublishedState } from '../scripts/verify-published-packages.ts';

const REGISTRY = 'https://registry.npmjs.org';
const VERSION = '2.4.0';
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const OTHER_SHA = 'ffffffffffffffffffffffffffffffffffffffff';

/** `[publishedVersion, gitHead]` per package; null publishedVersion means absent. */
function state(entries: Record<string, [string | null, string | null]>): PublishedState[] {
  return Object.entries(entries).map(([packageName, [publishedVersion, gitHead]]) => ({
    packageName,
    publishedVersion,
    gitHead,
  }));
}

describe('classifyPrepublishRegistryState', () => {
  test('an empty registry proceeds', () => {
    const decision = classifyPrepublishRegistryState(
      state({ '@pellux/goodvibes-sdk': [null, null], '@pellux/goodvibes-toolchain': [null, null] }),
      VERSION,
      REGISTRY,
      SHA,
    );
    expect(decision.kind).toBe('empty');
    expect(decision.message).toContain('empty for 2.4.0');
    expect(decision.warnings).toEqual([]);
  });

  test('no packages at all reads as empty rather than complete', () => {
    expect(classifyPrepublishRegistryState([], VERSION, REGISTRY, SHA).kind).toBe('empty');
  });

  test('a fully published version from THIS commit proceeds with no warnings', () => {
    const decision = classifyPrepublishRegistryState(
      state({ '@pellux/goodvibes-sdk': [VERSION, SHA], '@pellux/goodvibes-toolchain': [VERSION, SHA] }),
      VERSION,
      REGISTRY,
      SHA,
    );
    expect(decision.kind).toBe('complete');
    expect(decision.warnings).toEqual([]);
  });

  test('a partial from THIS commit RESUMES instead of wedging the release', () => {
    // The mid-loop publish failure this check used to make permanent: 2 of 4 up,
    // and the only way forward was cutting a new version by hand.
    const decision = classifyPrepublishRegistryState(
      state({
        '@pellux/goodvibes-sdk': [VERSION, SHA],
        '@pellux/goodvibes-toolchain': [VERSION, SHA],
        '@pellux/goodvibes-daemon': [null, null],
        '@pellux/goodvibes-tui': [null, null],
      }),
      VERSION,
      REGISTRY,
      SHA,
    );
    expect(decision.kind).toBe('resume');
    expect(decision.warnings).toEqual([]);
  });

  test('the resume message names which packages are skipped and which still publish', () => {
    const decision = classifyPrepublishRegistryState(
      state({ '@pellux/goodvibes-sdk': [VERSION, SHA], '@pellux/goodvibes-daemon': [null, null] }),
      VERSION,
      REGISTRY,
      SHA,
    );
    expect(decision.message).toContain('will skip these): @pellux/goodvibes-sdk@2.4.0');
    expect(decision.message).toContain('Still to publish: @pellux/goodvibes-daemon@2.4.0');
  });

  test('a published package from a DIFFERENT commit is refused, naming both SHAs', () => {
    // Another release run, or a force-moved tag, already published this version
    // from another tree. Finishing the rest would ship a split-tree version.
    const decision = classifyPrepublishRegistryState(
      state({ '@pellux/goodvibes-sdk': [VERSION, OTHER_SHA], '@pellux/goodvibes-daemon': [null, null] }),
      VERSION,
      REGISTRY,
      SHA,
    );
    expect(decision.kind).toBe('refuse');
    expect(decision.message).toContain('@pellux/goodvibes-sdk@2.4.0');
    expect(decision.message).toContain(OTHER_SHA);
    expect(decision.message).toContain(SHA);
    expect(decision.message).toContain('two different trees');
  });

  test('a foreign commit is refused even when every package is published (complete state)', () => {
    const decision = classifyPrepublishRegistryState(
      state({ '@pellux/goodvibes-sdk': [VERSION, SHA], '@pellux/goodvibes-daemon': [VERSION, OTHER_SHA] }),
      VERSION,
      REGISTRY,
      SHA,
    );
    expect(decision.kind).toBe('refuse');
    expect(decision.message).toContain('@pellux/goodvibes-daemon@2.4.0');
  });

  test('one matching gitHead does not excuse another package published from a foreign commit', () => {
    const decision = classifyPrepublishRegistryState(
      state({
        '@pellux/goodvibes-sdk': [VERSION, SHA],
        '@pellux/goodvibes-toolchain': [VERSION, OTHER_SHA],
        '@pellux/goodvibes-daemon': [null, null],
      }),
      VERSION,
      REGISTRY,
      SHA,
    );
    expect(decision.kind).toBe('refuse');
  });

  test('an ABSENT gitHead warns loudly by name and still resumes', () => {
    // npm omits gitHead when the packed directory is not a git checkout, which
    // is the normal case here (publishing from a staged temp copy). A check
    // that cannot see the commit must not manufacture a refusal.
    const decision = classifyPrepublishRegistryState(
      state({ '@pellux/goodvibes-sdk': [VERSION, null], '@pellux/goodvibes-daemon': [null, null] }),
      VERSION,
      REGISTRY,
      SHA,
    );
    expect(decision.kind).toBe('resume');
    expect(decision.warnings.length).toBe(1);
    expect(decision.warnings[0]).toContain('@pellux/goodvibes-sdk@2.4.0');
    expect(decision.warnings[0]).toContain('no gitHead');
  });

  test('an absent gitHead warns on the complete path too', () => {
    const decision = classifyPrepublishRegistryState(
      state({ '@pellux/goodvibes-sdk': [VERSION, null], '@pellux/goodvibes-daemon': [VERSION, null] }),
      VERSION,
      REGISTRY,
      SHA,
    );
    expect(decision.kind).toBe('complete');
    expect(decision.warnings[0]).toContain('@pellux/goodvibes-sdk@2.4.0');
    expect(decision.warnings[0]).toContain('@pellux/goodvibes-daemon@2.4.0');
  });

  test('a present-and-matching gitHead alongside an absent one warns only about the absent one', () => {
    const decision = classifyPrepublishRegistryState(
      state({
        '@pellux/goodvibes-sdk': [VERSION, SHA],
        '@pellux/goodvibes-toolchain': [VERSION, null],
        '@pellux/goodvibes-daemon': [null, null],
      }),
      VERSION,
      REGISTRY,
      SHA,
    );
    expect(decision.kind).toBe('resume');
    expect(decision.warnings[0]).toContain('@pellux/goodvibes-toolchain@2.4.0');
    expect(decision.warnings[0]).not.toContain('@pellux/goodvibes-sdk@2.4.0');
  });

  test('no release SHA warns and resumes rather than refusing on an unknowable comparison', () => {
    const decision = classifyPrepublishRegistryState(
      state({ '@pellux/goodvibes-sdk': [VERSION, OTHER_SHA], '@pellux/goodvibes-daemon': [null, null] }),
      VERSION,
      REGISTRY,
      null,
    );
    expect(decision.kind).toBe('resume');
    expect(decision.warnings[0]).toContain('No release SHA available');
  });

  test('an empty registry with no release SHA stays clean (nothing to compare)', () => {
    const decision = classifyPrepublishRegistryState(
      state({ '@pellux/goodvibes-sdk': [null, null] }),
      VERSION,
      REGISTRY,
      null,
    );
    expect(decision.kind).toBe('empty');
    expect(decision.warnings).toEqual([]);
  });
});
