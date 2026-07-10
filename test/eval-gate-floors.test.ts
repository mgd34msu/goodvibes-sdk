/**
 * EvalRunner.evaluateGate — floor enforcement + unbaselined surfacing.
 *
 * Pins the corrected gate contract:
 *   - an absolute per-dimension floor failure fails the gate even with NO
 *     regression against the baseline;
 *   - a scenario absent from the baseline is still floor-checked and reported
 *     in `unbaselined`, never silently skipped;
 *   - a genuine regression beyond threshold still fails the gate.
 */

import { describe, expect, test } from 'bun:test';
import { EvalRunner } from '../packages/sdk/src/platform/runtime/eval/runner.js';
import type {
  EvalResult,
  EvalScenario,
  EvalScorecard,
  EvalSuiteResult,
  EvalBaseline,
} from '../packages/sdk/src/platform/runtime/eval/types.js';

const SUITE = 'gate-test-suite';

function mkResult(
  id: string,
  compositeScore: number,
  passed: boolean,
  notes?: string[],
): EvalResult {
  const scenario: EvalScenario = {
    id,
    name: `Scenario ${id}`,
    suite: SUITE,
    description: 'fixture',
    tags: [],
    run: async () => ({ completed: true, durationMs: 0 }),
  };
  const scorecard: EvalScorecard = {
    scenarioId: id,
    scenarioName: scenario.name,
    dimensions: [],
    compositeScore,
    passed,
    notes,
  };
  return { scenario, raw: { completed: true, durationMs: 0 }, scorecard, startedAt: 0, finishedAt: 0 };
}

function mkSuite(results: EvalResult[]): EvalSuiteResult {
  const meanScore = results.length
    ? results.reduce((a, r) => a + r.scorecard.compositeScore, 0) / results.length
    : 0;
  return {
    suite: SUITE,
    startedAt: 0,
    finishedAt: 0,
    results,
    meanScore,
    passed: results.every((r) => r.scorecard.passed),
  };
}

function mkBaseline(scores: Record<string, number>): EvalBaseline {
  return {
    label: 'test-baseline',
    capturedAt: 0,
    suites: { [SUITE]: { meanScore: 0, scenarioScores: scores } },
  };
}

describe('evaluateGate — absolute floor enforcement', () => {
  test('a floor failure fails the gate even when there is NO regression', () => {
    const runner = new EvalRunner({ regressionThreshold: 5 });
    // Fresh score equals baseline score -> delta 0, no regression at all.
    const fresh = mkSuite([mkResult('s1', 40, false, ['recovery: score 20 below floor 60'])]);
    const baseline = mkBaseline({ s1: 40 });

    const gate = runner.evaluateGate(fresh, baseline);

    expect(gate.regressions).toHaveLength(0); // proves the failure is NOT a regression
    expect(gate.floorFailures).toHaveLength(1);
    expect(gate.floorFailures[0]!.scenarioId).toBe('s1');
    expect(gate.floorFailures[0]!.failingDimensions).toContain('recovery: score 20 below floor 60');
    expect(gate.passed).toBe(false);
  });

  test('an unbaselined scenario is floor-checked and reported, not silently skipped', () => {
    const runner = new EvalRunner({ regressionThreshold: 5 });
    // s_new has no baseline entry AND is below floor.
    const fresh = mkSuite([
      mkResult('s_known', 98, true),
      mkResult('s_new', 30, false, ['safety: score 20 below floor 80']),
    ]);
    const baseline = mkBaseline({ s_known: 98 });

    const gate = runner.evaluateGate(fresh, baseline);

    // Surfaced explicitly as unbaselined...
    expect(gate.unbaselined.map((u) => u.scenarioId)).toEqual(['s_new']);
    expect(gate.unbaselined[0]!.floorPassed).toBe(false);
    // ...and its floor breach is caught, failing the gate.
    expect(gate.floorFailures.map((f) => f.scenarioId)).toEqual(['s_new']);
    expect(gate.regressions).toHaveLength(0);
    expect(gate.passed).toBe(false);
  });

  test('an unbaselined scenario that clears its floor is reported but does NOT fail the gate', () => {
    const runner = new EvalRunner({ regressionThreshold: 5 });
    const fresh = mkSuite([mkResult('s_new', 97, true)]);
    const baseline = mkBaseline({}); // empty — s_new is unbaselined

    const gate = runner.evaluateGate(fresh, baseline);

    expect(gate.unbaselined.map((u) => u.scenarioId)).toEqual(['s_new']);
    expect(gate.unbaselined[0]!.floorPassed).toBe(true);
    expect(gate.floorFailures).toHaveLength(0);
    expect(gate.passed).toBe(true);
  });

  test('a regression beyond threshold still fails the gate (floor passing)', () => {
    const runner = new EvalRunner({ regressionThreshold: 5 });
    // Floor passes, but fresh dropped 12 points vs baseline -> regression.
    const fresh = mkSuite([mkResult('s1', 86, true)]);
    const baseline = mkBaseline({ s1: 98 });

    const gate = runner.evaluateGate(fresh, baseline);

    expect(gate.floorFailures).toHaveLength(0);
    expect(gate.regressions).toHaveLength(1);
    expect(gate.regressions[0]!.delta).toBeCloseTo(-12, 5);
    expect(gate.passed).toBe(false);
  });

  test('all-clean, fully-baselined run passes with no findings', () => {
    const runner = new EvalRunner({ regressionThreshold: 5 });
    const fresh = mkSuite([mkResult('s1', 98, true), mkResult('s2', 95, true)]);
    const baseline = mkBaseline({ s1: 98, s2: 95 });

    const gate = runner.evaluateGate(fresh, baseline);

    expect(gate.passed).toBe(true);
    expect(gate.floorFailures).toHaveLength(0);
    expect(gate.regressions).toHaveLength(0);
    expect(gate.unbaselined).toHaveLength(0);
  });
});
