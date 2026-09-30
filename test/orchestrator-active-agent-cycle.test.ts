/**
 * Regression guard for the tool-loop circuit-breaker infinite-loop bug
 * (introduced in 0.34.1, fixed in 0.34.2).
 *
 * `isActiveAgent` used to live in `compaction-sections.ts`. The orchestrator
 * turn-loop modules (`orchestrator-context-runtime`, `orchestrator-tool-runtime`)
 * and `context-compaction` imported it from there, which pulled the heavy
 * `compaction-sections` module into the turn-loop import graph and created a
 * circular dependency. The cycle left the tool-loop circuit-breaker threshold
 * constant in its temporal dead zone (undefined) at runtime, so the breaker
 * never tripped and all-failed tool turns looped forever (the TUI
 * `runtime-substrate-gate` integration test hung).
 *
 * The predicate now lives in the dependency-free leaf
 * `tools/agent/predicates.ts`. These tests assert (a) the predicate behaves
 * correctly and (b) the orchestrator turn-loop modules never re-import it from
 * `compaction-sections`, which would re-create the cycle.
 */
import { describe, expect, test } from 'bun:test';
import { isActiveAgent } from '../packages/sdk/src/platform/tools/agent/predicates.ts';

describe('isActiveAgent (tools/agent/predicates leaf)', () => {
  test('is true only for running and pending agents', () => {
    expect(isActiveAgent({ status: 'running' })).toBe(true);
    expect(isActiveAgent({ status: 'pending' })).toBe(true);
    expect(isActiveAgent({ status: 'completed' })).toBe(false);
    expect(isActiveAgent({ status: 'failed' })).toBe(false);
    expect(isActiveAgent({ status: 'cancelled' })).toBe(false);
  });
});
