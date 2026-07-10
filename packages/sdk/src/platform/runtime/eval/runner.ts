/**
 * Evaluation Harness — EvalRunner.
 *
 * Runs eval suites using production runtime paths:
 * - PerfMonitor for budget evaluation
 * - SloCollector for SLO p95 measurements
 * - scoreScenario() for dimension scoring
 *
 * The runner exercises the production code paths that gate CI.
 */

import type { EvalScenario, EvalRawResult, EvalResult, EvalSuiteResult, EvalGateResult, EvalBaseline, RegressionEntry, FloorFailureEntry, UnbaselinedScenario } from './types.js';
import { scoreScenario } from './scorecard.js';
import { createPerfMonitor } from '../perf/index.js';
import { summarizeError } from '../../utils/error-display.js';

// ── EvalRunner ────────────────────────────────────────────────────────────────

export interface EvalRunnerOptions {
  /**
   * Regression threshold for gate comparisons.
   * A scenario regresses if its composite score drops by more than this amount.
   * Default: 5 (5-point drop).
   */
  regressionThreshold?: number | undefined;
}

/**
 * Runs eval suites and produces structured results.
 *
 * @example
 * ```ts
 * const runner = new EvalRunner();
 * const result = await runner.runSuite(mySuite);
 * if (!result.passed) process.exit(1);
 * ```
 */
export class EvalRunner {
  private readonly regressionThreshold: number;

  constructor(options: EvalRunnerOptions = {}) {
    this.regressionThreshold = options.regressionThreshold ?? 5;
  }

  /**
   * Run all scenarios in a suite sequentially.
   *
   * Each scenario:
   * 1. Calls scenario.run() via the production code path
   * 2. Evaluates the raw result through PerfMonitor (if perfReport is absent)
   * 3. Scores the result via scoreScenario()
   *
   * @param suite - Suite name (used for logging and baseline matching).
   * @param scenarios - Scenarios to run.
   * @returns Aggregated EvalSuiteResult.
   */
  async runSuite(suite: string, scenarios: EvalScenario[]): Promise<EvalSuiteResult> {
    const startedAt = Date.now();
    const results: EvalResult[] = [];

    for (const scenario of scenarios) {
      const result = await this._runScenario(scenario);
      results.push(result);
    }

    const finishedAt = Date.now();
    const meanScore =
      results.length > 0
        ? results.reduce((acc, r) => acc + r.scorecard.compositeScore, 0) / results.length
        : 0;

    const passed = results.every((r) => r.scorecard.passed);

    return { suite, startedAt, finishedAt, results, meanScore, passed };
  }

  /**
   * Compare a fresh suite result against a stored baseline and enforce the
   * absolute per-dimension floors.
   *
   * The gate fails when EITHER of these holds for any scenario:
   *   1. The scenario is below its absolute floor (`scorecard.passed === false`)
   *      — checked for every fresh scenario, independently of the baseline.
   *   2. The scenario regressed more than `regressionThreshold` points versus
   *      its baseline score.
   *
   * Scenarios present in the fresh run but absent from the baseline are NOT
   * silently skipped: they are still floor-checked (rule 1) and surfaced in
   * `unbaselined`. They simply cannot be regression-checked (rule 2) this run
   * because there is nothing to compare against — they seed the next baseline.
   *
   * @param fresh - Result from a freshly-run suite.
   * @param baseline - Previously stored baseline (may be undefined).
   * @returns Gate result with regression, floor-failure, and unbaselined entries.
   */
  evaluateGate(fresh: EvalSuiteResult, baseline: EvalBaseline | undefined): EvalGateResult {
    const regressions: RegressionEntry[] = [];
    const floorFailures: FloorFailureEntry[] = [];
    const unbaselined: UnbaselinedScenario[] = [];

    const baselineSuite = baseline?.suites[fresh.suite];

    for (const result of fresh.results) {
      const freshScore = result.scorecard.compositeScore;
      const floorPassed = result.scorecard.passed;

      // Rule 1 — absolute floor, enforced regardless of baseline presence.
      if (!floorPassed) {
        floorFailures.push({
          scenarioId: result.scenario.id,
          scenarioName: result.scenario.name,
          freshScore,
          failingDimensions: result.scorecard.notes ?? [],
        });
      }

      // Rule 2 — regression, only when this scenario has a baseline score.
      const baselineScore = baselineSuite?.scenarioScores[result.scenario.id];
      if (baselineScore === undefined) {
        unbaselined.push({
          scenarioId: result.scenario.id,
          scenarioName: result.scenario.name,
          freshScore,
          floorPassed,
        });
        continue;
      }
      const delta = freshScore - baselineScore;
      if (delta < -this.regressionThreshold) {
        regressions.push({
          scenarioId: result.scenario.id,
          scenarioName: result.scenario.name,
          baselineScore,
          freshScore,
          delta,
        });
      }
    }

    return {
      suite: fresh.suite,
      passed: regressions.length === 0 && floorFailures.length === 0,
      regressionThreshold: this.regressionThreshold,
      fresh,
      baseline,
      regressions,
      floorFailures,
      unbaselined,
    };
  }

  private async _runScenario(scenario: EvalScenario): Promise<EvalResult> {
    const startedAt = Date.now();
    let raw = await this._executeScenario(scenario);

    // If the scenario did not include a perfReport, run a minimal PerfMonitor
    // evaluation against an empty snapshot to at least populate the field.
    if (!raw.perfReport) {
      const monitor = createPerfMonitor();
      const { createInitialSurfacePerfState } = await import('../store/domains/surface-perf.js');
      raw = {
        ...raw,
        perfReport: monitor.evaluate({
          surfacePerf: createInitialSurfacePerfState(),
          extraMetrics: {},
        }),
      };
    }

    const scorecard = scoreScenario(scenario.id, scenario.name, raw);
    const finishedAt = Date.now();

    return { scenario, raw, scorecard, startedAt, finishedAt };
  }

  /** Execute a scenario's run() function, catching and normalising errors. */
  private async _executeScenario(scenario: EvalScenario): Promise<EvalRawResult> {
    const t0 = Date.now();
    try {
      const raw = await scenario.run();
      return raw;
    } catch (err) {
      const durationMs = Date.now() - t0;
      const errorMessage = summarizeError(err);
      return {
        completed: false,
        durationMs,
        errorMessage,
        safetyViolations: 0,
      };
    }
  }
}
