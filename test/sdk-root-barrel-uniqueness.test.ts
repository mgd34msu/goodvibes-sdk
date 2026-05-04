/**
 * Root-barrel symbol uniqueness guard.
 *
 * Regression test for api-extractor `_2`-suffix collisions.
 * If two packages export the same name and the bundler silently deduplicates
 * with a numeric suffix (e.g. `foo_2`), this test catches it immediately.
 *
 * The check is intentionally forward-looking: JS cannot have duplicate keys in
 * a namespace import object, but api-extractor can emit `_2`-suffixed aliases
 * that appear as real keys here. If any `/_\d+$/` key appears, a collision has
 * been reintroduced and must be resolved at the source.
 */

import { describe, expect, test } from 'bun:test';
import * as Root from '../packages/sdk/src/index.js';

describe('root barrel symbol uniqueness', () => {
  test('no _2-suffixed keys (api-extractor collision guard)', () => {
    const collisions = Object.keys(Root).filter((k) => /_\d+$/.test(k));
    expect(collisions).toEqual([]);
  });

  test('root barrel exports at least one symbol', () => {
    // Sanity-check that the import resolved and is non-empty.
    expect(Object.keys(Root).length).toBeGreaterThan(0);
  });
});
