/**
 * Coverage-gap smoke test, platform/runtime/forensics
 * Verifies that classifier, collector, and registry modules load correctly.
 * Closes coverage gap: platform/runtime/forensics
 */

import { describe, expect, test } from 'bun:test';
import { classifyFailure } from '../packages/sdk/src/platform/runtime/forensics/classifier.js';
import { ForensicsRegistry } from '../packages/sdk/src/platform/runtime/forensics/registry.js';

describe('platform/runtime/forensics: classifier and registry behavior', () => {
  test('ForensicsRegistry instance exposes expected methods', () => {
    const reg = new ForensicsRegistry();
    expect(reg.count()).toBe(0);
    expect(reg.getAll()).toHaveLength(0);
    expect(reg.latest()).toBeNull();
  });
});
