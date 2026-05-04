/**
 * Coverage-gap smoke test — platform/multimodal
 * Verifies that MultimodalService has the expected prototype shape without
 * requiring full instantiation (constructor requires complex dependencies).
 * Closes coverage gap: platform/multimodal (eighth-review)
 */

import { describe, expect, test } from 'bun:test';
import { MultimodalService } from '../packages/sdk/src/platform/multimodal/service.js';

describe('platform/multimodal — behavior smoke', () => {
  test('MultimodalService is a class with correct name', () => {
    expect(MultimodalService.name).toBe('MultimodalService');
  });

  test('MultimodalService constructor takes 4 arguments', () => {
    expect(MultimodalService.length).toBe(4);
  });

  test('MultimodalService prototype has expected instance methods', () => {
    const proto = MultimodalService.prototype as Record<string, unknown>;
    const expectedMethods = ['analyze', 'buildPacket', 'getStatus', 'listProviders', 'writeBackAnalysis'];
    for (const m of expectedMethods) {
      expect(
        typeof proto[m],
        `MultimodalService.prototype.${m} should be a function`,
      ).toBe('function');
    }
  });
});
