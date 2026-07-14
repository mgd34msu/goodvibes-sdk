/**
 * When an orchestration spawn cap binds, the decision names the documented cap
 * (config key + value) both in its human-readable reason and in a structured
 * boundCap field, so a spawning agent can see exactly which setting refused or
 * queued the work. Defaults are sourced from the config schema, not re-declared
 * literals.
 */
import { describe, expect, test } from 'bun:test';
import {
  evaluateOrchestrationSpawn,
  ORCHESTRATION_CAP_KEYS,
} from '../packages/sdk/src/platform/runtime/orchestration/spawn-policy.js';
import { coreConfigDefaults } from '../packages/sdk/src/platform/config/schema-domain-core.js';
import { fleetConfigDefaults } from '../packages/sdk/src/platform/config/schema-domain-fleet.js';

// Config manager stub that returns null for every key, exercising the
// schema-default fallback path.
const nullConfig = { get: () => null };

describe('spawn policy — bound cap identity', () => {
  test('active-agents cap names fleet.maxSize when it binds (owner-renamed cap)', () => {
    const decision = evaluateOrchestrationSpawn({
      configManager: nullConfig,
      mode: 'manual-batch',
      activeAgents: 5,
      overrides: { maxAgents: 5 },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.availableSlots).toBe(0);
    expect(decision.boundCap).toEqual({ key: ORCHESTRATION_CAP_KEYS.maxActiveAgents, value: 5 });
    expect(decision.reason).toContain('fleet.maxSize=5');
  });

  test('disabled recursion names orchestration.recursionEnabled when it binds', () => {
    const decision = evaluateOrchestrationSpawn({
      configManager: nullConfig,
      mode: 'plan-auto',
      activeAgents: 0,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.boundCap).toEqual({ key: ORCHESTRATION_CAP_KEYS.recursionEnabled, value: false });
    expect(decision.reason).toContain('orchestration.recursionEnabled=false');
  });

  test('depth overflow names orchestration.maxDepth when it binds', () => {
    const decision = evaluateOrchestrationSpawn({
      configManager: nullConfig,
      mode: 'recursive-child',
      activeAgents: 0,
      requestedDepth: 2,
      overrides: { recursionEnabled: true, maxDepth: 1 },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.boundCap).toEqual({ key: ORCHESTRATION_CAP_KEYS.maxDepth, value: 1 });
    expect(decision.reason).toContain('orchestration.maxDepth=1');
  });

  test('an allowed spawn carries no boundCap', () => {
    const decision = evaluateOrchestrationSpawn({
      configManager: nullConfig,
      mode: 'manual-batch',
      activeAgents: 1,
      overrides: { maxAgents: 5 },
    });
    expect(decision.allowed).toBe(true);
    expect(decision.boundCap).toBeUndefined();
  });

  test('the active-agents fallback default comes from the config schema (unchanged value)', () => {
    const decision = evaluateOrchestrationSpawn({
      configManager: nullConfig,
      mode: 'manual-batch',
      activeAgents: 0,
    });
    expect(decision.maxAgents).toBe(fleetConfigDefaults.fleet.maxSize);
    expect(decision.maxAgents).toBe(8);
  });
});
