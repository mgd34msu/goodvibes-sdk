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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isActiveAgent } from '../packages/sdk/src/platform/tools/agent/predicates.ts';

const CORE = join(import.meta.dir, '..', 'packages', 'sdk', 'src', 'platform', 'core');

describe('isActiveAgent (tools/agent/predicates leaf)', () => {
  test('is true only for running and pending agents', () => {
    expect(isActiveAgent({ status: 'running' })).toBe(true);
    expect(isActiveAgent({ status: 'pending' })).toBe(true);
    expect(isActiveAgent({ status: 'completed' })).toBe(false);
    expect(isActiveAgent({ status: 'failed' })).toBe(false);
    expect(isActiveAgent({ status: 'cancelled' })).toBe(false);
  });
});

describe('orchestrator turn-loop circular-import guard (0.34.2 regression)', () => {
  // These modules participate in the orchestrator turn-loop import graph.
  // Importing isActiveAgent from compaction-sections re-creates the cycle that
  // disabled the tool-loop circuit breaker. They must import it from the
  // dependency-free leaf `tools/agent/predicates` instead.
  const guarded = [
    'orchestrator-context-runtime.ts',
    'orchestrator-tool-runtime.ts',
    'context-compaction.ts',
  ];

  for (const file of guarded) {
    test(`${file} does not import isActiveAgent from compaction-sections`, () => {
      const src = readFileSync(join(CORE, file), 'utf8');
      // `[^}]*` spans multi-line import groups (newlines are not `}`).
      const cyclicImport =
        /import\s*\{[^}]*\bisActiveAgent\b[^}]*\}\s*from\s*['"]\.\/compaction-sections\.js['"]/.test(src);
      expect(cyclicImport).toBe(false);
    });
  }

  test('compaction-sections.ts no longer defines isActiveAgent', () => {
    const src = readFileSync(join(CORE, 'compaction-sections.ts'), 'utf8');
    expect(/export\s+function\s+isActiveAgent\b/.test(src)).toBe(false);
  });
});
