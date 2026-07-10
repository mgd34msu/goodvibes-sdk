/**
 * Evaluation Harness — core type definitions.
 *
 * Defines the contracts for eval scenarios, scorecards, run results,
 * baselines, and CI gate outcomes.
 */

import type { PerfReport } from '../perf/types.js';

// ── Scenario ────────────────────────────────────────────────────────────────

/**
 * An eval scenario describes a single test case.
 * Scenarios are grouped into suites and run by EvalRunner.
 */
export interface EvalScenario {
  /** Unique, stable identifier for this scenario (used in baselines). */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Which suite this scenario belongs to. */
  suite: string;
  /** Description of what is being evaluated. */
  description: string;
  /**
   * Optional tags for filtering (e.g. 'safety', 'latency', 'recovery').
   */
  tags: string[];
  /**
   * The scenario function. Returns a raw result bag that the scorecard
   * scorer converts into dimension scores.
   *
   * The function should use production runtime paths (PerfMonitor, SloCollector,
   * RuntimeTracer, etc.) — not mocks — so results reflect real behaviour.
   */
  run(): Promise<EvalRawResult>;
}

// ── Raw result from a scenario run ──────────────────────────────────────────

/**
 * Raw measurement bag returned by a scenario's `run()` function.
 * The scorecard scorer converts these into 0–100 dimension scores.
 */
export interface EvalRawResult {
  /** Whether the run completed without throwing. */
  completed: boolean;
  /** Elapsed wall-clock time in milliseconds. */
  durationMs: number;
  /** Token counts consumed during the run (if applicable). */
  tokens?: { input: number; output: number };
  /** Estimated cost in USD (if applicable). */
  costUsd?: number | undefined;
  /** PerfReport from a PerfMonitor.evaluate() call during the run. */
  perfReport?: PerfReport | undefined;
  /** Safety violations detected (0 = clean). */
  safetyViolations?: number | undefined;
  /** Recovery was attempted and succeeded. */
  recoverySucceeded?: boolean | undefined;
  /** Recovery was attempted and failed. */
  recoveryFailed?: boolean | undefined;
  /** Custom key-value observations from the scenario. */
  observations?: Record<string, number | string | boolean> | undefined;
  /** Error message if the run threw or did not complete. */
  errorMessage?: string | undefined;
}

// ── Scorecard ────────────────────────────────────────────────────────────────

/** The five eval dimensions. */
export type EvalDimension = 'safety' | 'quality' | 'latency' | 'cost' | 'recovery';

/** Score for a single dimension (0–100, higher is better). */
export interface DimensionScore {
  /** Which dimension this covers. */
  dimension: EvalDimension;
  /** Numeric score 0–100. */
  score: number;
  /** Weight used in the composite score (0–1). */
  weight: number;
  /** Human-readable explanation of how the score was derived. */
  rationale: string;
}

/**
 * Scorecard produced for a single scenario run.
 */
export interface EvalScorecard {
  /** The scenario that was evaluated. */
  scenarioId: string;
  scenarioName: string;
  /** Per-dimension scores. */
  dimensions: DimensionScore[];
  /** Weighted composite score (0–100). */
  compositeScore: number;
  /** Whether all dimensions cleared their minimum thresholds. */
  passed: boolean;
  /** Optional notes or warnings from the scorer. */
  notes?: string[] | undefined;
}

// ── Run result ───────────────────────────────────────────────────────────────

/** Result of a single scenario execution. */
export interface EvalResult {
  scenario: EvalScenario;
  raw: EvalRawResult;
  scorecard: EvalScorecard;
  /** Unix epoch ms when the run started. */
  startedAt: number;
  /** Unix epoch ms when the run finished. */
  finishedAt: number;
}

/** Aggregated result for a full suite run. */
export interface EvalSuiteResult {
  /** Suite name. */
  suite: string;
  /** Unix epoch ms when the suite run started. */
  startedAt: number;
  /** Unix epoch ms when the suite run finished. */
  finishedAt: number;
  /** Individual scenario results. */
  results: EvalResult[];
  /** Mean composite score across all scenarios in this suite. */
  meanScore: number;
  /** True if every scenario passed. */
  passed: boolean;
}

// ── Baseline ─────────────────────────────────────────────────────────────────

/** A persisted baseline snapshot used for regression comparisons. */
export interface EvalBaseline {
  /** Baseline label (e.g. 'main', 'v0.12.0'). */
  label: string;
  /** Unix epoch ms when the baseline was captured. */
  capturedAt: number;
  /** Suite-level summaries keyed by suite name. */
  suites: Record<string, BaselineSuiteSummary>;
}

export interface BaselineSuiteSummary {
  meanScore: number;
  /** Per-scenario composite scores. */
  scenarioScores: Record<string, number>;
}

// ── Gate result ──────────────────────────────────────────────────────────────

/**
 * Result of a CI gate evaluation.
 * A gate compares a fresh suite run against a stored baseline.
 */
export interface EvalGateResult {
  suite: string;
  /**
   * Whether the gate passed. A gate passes only when NO scenario failed its
   * absolute per-dimension floor AND no scenario regressed beyond the
   * threshold versus the baseline. The absolute floor is enforced
   * independently of the baseline, so a fresh scenario with no baseline entry
   * still fails the gate if it is below floor.
   */
  passed: boolean;
  /** The regression threshold applied (e.g. 5 = 5-point drop). */
  regressionThreshold: number;
  /** Fresh suite result. */
  fresh: EvalSuiteResult;
  /** Baseline used for comparison (undefined if no baseline exists yet). */
  baseline?: EvalBaseline | undefined;
  /** Per-scenario regression entries where the score dropped. */
  regressions: RegressionEntry[];
  /**
   * Per-scenario absolute-floor failures (scorecard.passed === false). These
   * fail the gate on their own, independently of any baseline comparison.
   */
  floorFailures: FloorFailureEntry[];
  /**
   * Scenarios present in the fresh run but absent from the baseline. Surfaced
   * explicitly rather than silently skipped: each is still floor-checked (a
   * below-floor unbaselined scenario appears in `floorFailures` too and fails
   * the gate), but its absence of a baseline score means it cannot be
   * regression-checked this run — it becomes the baseline for next time.
   */
  unbaselined: UnbaselinedScenario[];
}

export interface RegressionEntry {
  scenarioId: string;
  scenarioName: string;
  baselineScore: number;
  freshScore: number;
  /** Positive value = improvement, negative = regression. */
  delta: number;
}

/** A scenario that failed its absolute per-dimension floor in the fresh run. */
export interface FloorFailureEntry {
  scenarioId: string;
  scenarioName: string;
  /** Fresh composite score. */
  freshScore: number;
  /**
   * Human-readable per-dimension floor breaches (from the scorecard's notes),
   * e.g. `safety: score 20 below floor 80`.
   */
  failingDimensions: string[];
}

/** A fresh scenario with no matching baseline entry. */
export interface UnbaselinedScenario {
  scenarioId: string;
  scenarioName: string;
  /** Fresh composite score (recorded so it can seed the next baseline). */
  freshScore: number;
  /** Whether this scenario cleared its absolute floor. */
  floorPassed: boolean;
}
