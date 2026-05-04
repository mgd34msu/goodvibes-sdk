/**
 * Coverage-gap smoke test — platform/runtime/inspection/state-inspector
 * Verifies that the state inspector module loads and exports createStateInspector.
 * Closes coverage gap: platform/runtime/inspection/state-inspector (eighth-review)
 */

import { describe, expect, test } from 'bun:test';
import { createStateInspector } from '../packages/sdk/src/platform/runtime/inspection/state-inspector.js';

describe('platform/runtime/inspection/state-inspector — module load smoke', () => {
  test('createStateInspector is a function', () => {
    expect(typeof createStateInspector).toBe('function');
  });

  test('createStateInspector returns an object when called with minimal config', () => {
    const inspector = createStateInspector({ domains: [] });
    expect(inspector).toBeDefined();
    expect(typeof inspector).toBe('object');
  });
});
