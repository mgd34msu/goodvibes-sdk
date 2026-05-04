/**
 * Coverage-gap smoke test — platform/runtime/orchestration
 * Verifies that the spawn-policy module loads and exports expected symbols.
 * Closes coverage gap: platform/runtime/orchestration (eighth-review)
 */

import { describe, expect, test } from 'bun:test';
import { evaluateOrchestrationSpawn } from '../packages/sdk/src/platform/runtime/orchestration/spawn-policy.js';

describe('platform/runtime/orchestration — spawn-policy smoke', () => {
  test('evaluateOrchestrationSpawn is a function', () => {
    expect(typeof evaluateOrchestrationSpawn).toBe('function');
  });

  test('evaluateOrchestrationSpawn denies plan-auto when recursion is disabled', () => {
    const configManager = {
      get: (_key: string) => null,
    };
    const result = evaluateOrchestrationSpawn({
      configManager: configManager as never,
      mode: 'plan-auto',
      activeAgents: 0,
      requestedDepth: 0,
      overrides: { recursionEnabled: false },
    });
    expect(result.allowed).toBe(false);
    expect(typeof result.reason).toBe('string');
  });

  test('evaluateOrchestrationSpawn allows sequential mode regardless of recursion flag', () => {
    const configManager = {
      get: (_key: string) => null,
    };
    const result = evaluateOrchestrationSpawn({
      configManager: configManager as never,
      mode: 'sequential',
      activeAgents: 1,
      requestedDepth: 1,
      overrides: { recursionEnabled: false, maxAgents: 5, maxDepth: 3 },
    });
    // sequential bypasses the recursionEnabled guard
    expect(result.allowed).toBe(true);
    expect(result.availableSlots).toBe(4);
  });

  test('evaluateOrchestrationSpawn denies when no capacity', () => {
    const configManager = {
      get: (_key: string) => null,
    };
    const result = evaluateOrchestrationSpawn({
      configManager: configManager as never,
      mode: 'sequential',
      activeAgents: 5,
      overrides: { maxAgents: 5 },
    });
    expect(result.allowed).toBe(false);
    expect(result.availableSlots).toBe(0);
  });
});
