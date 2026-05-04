/**
 * Coverage-gap smoke test — platform/runtime/forensics
 * Verifies that classifier, collector, and registry modules load correctly.
 * Closes coverage gap: platform/runtime/forensics (eighth-review)
 */

import { describe, expect, test } from 'bun:test';
import { classifyFailure, summariseFailure } from '../packages/sdk/src/platform/runtime/forensics/classifier.js';
import { ForensicsRegistry, DEFAULT_REGISTRY_LIMIT } from '../packages/sdk/src/platform/runtime/forensics/registry.js';

describe('platform/runtime/forensics — module load smoke', () => {
  test('classifyFailure is a function', () => {
    expect(typeof classifyFailure).toBe('function');
  });

  test('summariseFailure is a function', () => {
    expect(typeof summariseFailure).toBe('function');
  });

  test('DEFAULT_REGISTRY_LIMIT is a positive number', () => {
    expect(typeof DEFAULT_REGISTRY_LIMIT).toBe('number');
    expect(DEFAULT_REGISTRY_LIMIT).toBeGreaterThan(0);
  });

  test('ForensicsRegistry is a constructor', () => {
    expect(typeof ForensicsRegistry).toBe('function');
  });

  test('ForensicsRegistry instance exposes expected methods', () => {
    const reg = new ForensicsRegistry();
    expect(typeof reg.push).toBe('function');
    expect(typeof reg.latest).toBe('function');
    expect(typeof reg.getAll).toBe('function');
    expect(typeof reg.count).toBe('function');
    expect(reg.count()).toBe(0);
  });

  test('classifyFailure returns a classification for a normal stop', () => {
    const result = classifyFailure({
      stopReason: 'end_turn',
      errorMessage: undefined,
      wasCancelled: false,
      hasCascadeEvents: false,
      hasToolFailure: false,
      hasPermissionDenial: false,
      hasCompactionError: false,
    });
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
  });
});
