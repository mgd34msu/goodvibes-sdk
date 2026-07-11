/**
 * feature-flags-exports.test.ts
 *
 * Proves the feature-flag barrel is reachable from its public package
 * subpath — the gap this closes: FEATURE_FLAG_CONFIG / getFeatureFlagConfig /
 * FEATURE_FLAGS / FeatureFlagManager live in dist/platform/runtime/feature-flags/index.js
 * but no `./platform/runtime/feature-flags` entry existed in the sdk
 * package's exports map, so consumers (webui) resorted to build-time deep
 * imports into dist paths instead of the public specifier. This import
 * resolves through the package `exports` map against the built dist, so a
 * broken/absent subpath fails the import.
 */
import { describe, expect, test } from 'bun:test';
import {
  createFeatureFlagManager,
  FEATURE_FLAGS,
  FEATURE_FLAG_CONFIG,
  getFeatureFlagConfig,
} from '@pellux/goodvibes-sdk/platform/runtime/feature-flags';

describe('feature-flags public subpath', () => {
  test('FEATURE_FLAGS is exported and non-empty', () => {
    expect(Array.isArray(FEATURE_FLAGS)).toBe(true);
    expect(FEATURE_FLAGS.length).toBeGreaterThan(0);
  });

  test('FEATURE_FLAG_CONFIG covers every flag id from the same barrel', () => {
    const missing = FEATURE_FLAGS.filter((f) => !(f.id in FEATURE_FLAG_CONFIG)).map((f) => f.id);
    expect(missing).toEqual([]);
  });

  test('getFeatureFlagConfig is exported and returns empty arrays for an unknown flag', () => {
    const assoc = getFeatureFlagConfig('not-a-real-flag');
    expect(assoc).toEqual({ configCategories: [], configKeys: [] });
  });

  test('createFeatureFlagManager is exported and constructs a working manager', () => {
    const manager = createFeatureFlagManager();
    const knownFlag = FEATURE_FLAGS[0]!;
    expect(manager.getState(knownFlag.id)).toBe(knownFlag.defaultState);
  });
});
