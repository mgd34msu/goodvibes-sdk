/**
 * eval-standing-gate.test.ts
 *
 * Locks the standing-gate suite (GATE_SUITES) as an all-floors-passing set — the
 * property that lets `bun run eval:gate` be honestly green — and proves the gate
 * still flags a real floor failure and a real regression. Unlike BUILTIN_SUITES
 * (which deliberately contain floor-failing branch-exercising fixtures),
 * GATE_SUITES must clear every absolute floor on a clean run.
 *
 * Deterministic: gate scenarios run in well under the 500 ms latency-excellent
 * threshold, so scores are reproducible (no coupling to wall-clock or VERSION).
 */
import { describe, expect, test } from 'bun:test';
import {
  EvalRunner,
  GATE_SUITES,
  captureBaseline,
} from '../packages/sdk/src/platform/runtime/eval/index.ts';

describe('standing-gate eval suite', () => {
  test('every gate scenario clears its absolute per-dimension floor', async () => {
    const runner = new EvalRunner();
    for (const [suite, scenarios] of Object.entries(GATE_SUITES)) {
      const result = await runner.runSuite(suite, scenarios);
      const failed = result.results.filter((r) => !r.scorecard.passed);
      expect(
        failed.map((r) => `${r.scenario.id}: ${(r.scorecard.notes ?? []).join('; ')}`),
        'gate scenarios must all pass their floors',
      ).toEqual([]);
    }
  });

  test('the gate passes a suite against its own fresh capture (no regression)', async () => {
    const runner = new EvalRunner();
    const scenarios = GATE_SUITES['standing-gate']!;
    const result = await runner.runSuite('standing-gate', scenarios);
    const baseline = captureBaseline('standing-gate', [result]);
    const gate = runner.evaluateGate(result, baseline);
    expect(gate.passed).toBe(true);
    expect(gate.floorFailures).toEqual([]);
    expect(gate.regressions).toEqual([]);
  });

  test('the gate flags a regression when a scenario drops below its baseline score', async () => {
    const runner = new EvalRunner({ regressionThreshold: 5 });
    const scenarios = GATE_SUITES['standing-gate']!;
    const result = await runner.runSuite('standing-gate', scenarios);
    // Baseline the scenarios far above their real scores → the fresh run regresses.
    const inflated = captureBaseline('inflated', [result]);
    const firstId = result.results[0]!.scenario.id;
    inflated.suites['standing-gate']!.scenarioScores[firstId] = 100;
    // Re-run and gate against the inflated baseline; the real ~93 vs 100 is a >5pt drop.
    const fresh = await runner.runSuite('standing-gate', scenarios);
    const gate = runner.evaluateGate(fresh, inflated);
    expect(gate.regressions.some((r) => r.scenarioId === firstId)).toBe(true);
    expect(gate.passed).toBe(false);
  });
});
