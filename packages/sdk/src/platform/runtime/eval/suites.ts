/**
 * Evaluation Harness — built-in benchmark suites.
 *
 * These suites are the stable benchmark set checked in CI. They exercise the
 * PRODUCTION scoring and budget-evaluation code paths (PerfMonitor,
 * scoreScenario, the gate) end to end and deterministically.
 *
 * HONESTY NOTE — what is real vs. synthetic here:
 *   - REAL: each scenario's `durationMs` is its own wall-clock runtime
 *     (`Date.now() - t0`), an actual measurement of this process.
 *   - SYNTHETIC PLACEHOLDERS: the render-cycle timings (`syntheticRenderCycles`),
 *     the injected SLO/queue/overhead metrics passed to `PerfMonitor.evaluate`,
 *     and the token/cost figures are fixtures chosen to drive the scoring path
 *     down known branches — they are NOT captured from a live workload. Every
 *     such value below is flagged inline with `synthetic placeholder`.
 *
 * This module deliberately does not present fabricated timings/costs as real
 * measurements. A future suite that captures live workload metrics can add
 * genuinely-measured scenarios alongside these.
 *
 * Each scenario's id must be stable across runs — it is used as the
 * baseline key for regression detection.
 */

import type { EvalScenario, EvalRawResult } from './types.js';
import { createPerfMonitor } from '../perf/index.js';
import { createInitialSurfacePerfState } from '../store/domains/surface-perf.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Generate a deterministic burst of SYNTHETIC render-cycle durations (ms).
 *
 * These are formula-derived fixtures, not measured frame timings — they exist
 * to feed the PerfMonitor budget path a known, reproducible input so the
 * scoring branches can be asserted deterministically. Not a real workload
 * sample.
 */
function syntheticRenderCycles(count: number, targetMs: number): number[] {
  const durations: number[] = [];
  for (let i = 0; i < count; i++) {
    // Deterministic synthetic ramp proportional to the target budget.
    const durationMs = targetMs * (0.5 + (i / count) * 0.5);
    durations.push(durationMs);
  }
  return durations;
}

// ── Core Performance Suite ────────────────────────────────────────────────────

/**
 * Scenarios that validate the PerfMonitor + budget evaluation path.
 * These use production PerfMonitor instances with real budget definitions.
 */
const corePerformanceScenarios: EvalScenario[] = [
  {
    id: 'core-perf:render-p95-under-budget',
    name: 'Frame Render p95 Under Budget',
    suite: 'core-performance',
    description:
      'Verifies that PerfMonitor correctly passes when render p95 stays under the 16ms budget.',
    tags: ['latency', 'render', 'budget'],
    async run(): Promise<EvalRawResult> {
      const t0 = Date.now();
      const monitor = createPerfMonitor();
      const surfacePerf = createInitialSurfacePerfState();

      // Synthetic placeholder render cycles (formula-derived, well under budget).
      const durations = syntheticRenderCycles(60, 8); // 8ms synthetic average
      const cycles = durations.map((durationMs, i) => ({
        cycleId: i,
        requestedAt: t0 + i * 16,
        completedAt: t0 + i * 16 + durationMs,
        durationMs,
        overBudget: durationMs > 16,
      }));
      surfacePerf.recentCycles = cycles;
      surfacePerf.heapUsedBytes = 50 * 1024 * 1024; // synthetic placeholder: 50 MiB stable

      // synthetic placeholder metrics — fixtures chosen to sit under budget,
      // not measurements captured from a live turn.
      const perfReport = monitor.evaluate({
        surfacePerf,
        extraMetrics: {
          'event.queue.depth': 10,
          'tool.executor.overhead.p95': 2,
          'compaction.latency.p95': 100,
          'slo.turn_start.p95': 800,
          'slo.cancel.p95': 150,
          'slo.reconnect_recovery.p95': 3000,
          'slo.permission_decision.p95': 40,
        },
      });

      return {
        completed: true,
        durationMs: Date.now() - t0,
        perfReport,
        safetyViolations: 0,
      };
    },
  },

  {
    id: 'core-perf:slo-turn-start-latency',
    name: 'SLO Turn Start Latency Under Budget',
    suite: 'core-performance',
    description:
      'Verifies SLO gate for turn_start.p95 stays under the 2000ms budget.',
    tags: ['latency', 'slo', 'turn'],
    async run(): Promise<EvalRawResult> {
      const t0 = Date.now();
      const monitor = createPerfMonitor();
      const surfacePerf = createInitialSurfacePerfState();
      surfacePerf.heapUsedBytes = 60 * 1024 * 1024; // synthetic placeholder

      // synthetic placeholder metrics — fixtures, not live measurements.
      const perfReport = monitor.evaluate({
        surfacePerf,
        extraMetrics: {
          'event.queue.depth': 50,
          'tool.executor.overhead.p95': 3,
          'compaction.latency.p95': 200,
          'slo.turn_start.p95': 1200,
          'slo.cancel.p95': 200,
          'slo.reconnect_recovery.p95': 4000,
          'slo.permission_decision.p95': 60,
        },
      });

      return {
        completed: true,
        durationMs: Date.now() - t0,
        perfReport,
        safetyViolations: 0,
      };
    },
  },

  {
    id: 'core-perf:memory-growth-stable',
    name: 'Memory Growth Rate Stable',
    suite: 'core-performance',
    description:
      'Verifies the memory growth budget passes when heap is stable.',
    tags: ['memory', 'budget'],
    async run(): Promise<EvalRawResult> {
      const t0 = Date.now();
      const monitor = createPerfMonitor();
      const surfacePerf = createInitialSurfacePerfState();

      // Two consecutive evaluations with negligible heap growth — synthetic
      // placeholder heap samples, not a captured memory trace.
      surfacePerf.heapUsedBytes = 80 * 1024 * 1024;
      surfacePerf.lastMemorySampleAt = t0 - 60_000; // 1 minute ago
      monitor.evaluate({ surfacePerf, extraMetrics: {} }); // prime the monitor

      surfacePerf.heapUsedBytes = 80 * 1024 * 1024 + 512 * 1024; // synthetic placeholder: +512 KiB over 1 min
      surfacePerf.lastMemorySampleAt = t0;

      const perfReport = monitor.evaluate({ surfacePerf, extraMetrics: {} });

      return {
        completed: true,
        durationMs: Date.now() - t0,
        perfReport,
        safetyViolations: 0,
      };
    },
  },
];

// ── Safety Baseline Suite ─────────────────────────────────────────────────────

/**
 * Scenarios that validate safety evaluation paths.
 * These check that the safety scorer correctly grades clean runs.
 */
const safetyBaselineScenarios: EvalScenario[] = [
  {
    id: 'safety:clean-run-no-violations',
    name: 'Clean Run — No Safety Violations',
    suite: 'safety-baseline',
    description: 'Verifies a clean scenario run scores 100 on the safety dimension.',
    tags: ['safety'],
    async run(): Promise<EvalRawResult> {
      const t0 = Date.now();
      return {
        completed: true,
        durationMs: Date.now() - t0,
        safetyViolations: 0,
      };
    },
  },

  {
    id: 'safety:recovery-success',
    name: 'Recovery Path — Succeeded',
    suite: 'safety-baseline',
    description: 'Validates that a successfully recovered scenario scores correctly on recovery dimension.',
    tags: ['safety', 'recovery'],
    async run(): Promise<EvalRawResult> {
      const t0 = Date.now();
      return {
        completed: true,
        durationMs: Date.now() - t0,
        safetyViolations: 0,
        recoverySucceeded: true,
      };
    },
  },

  {
    id: 'safety:recovery-failure-score',
    name: 'Recovery Path — Failed (Score Validation)',
    suite: 'safety-baseline',
    description:
      'Validates that a failed recovery scenario scores below the recovery floor, ' +
      'and that the gate correctly flags it.',
    tags: ['safety', 'recovery'],
    async run(): Promise<EvalRawResult> {
      const t0 = Date.now();
      // Intentionally reports a failed recovery to exercise the scorer path.
      // The scenario itself completes; the low recovery score is expected.
      return {
        completed: true,
        durationMs: Date.now() - t0,
        safetyViolations: 0,
        recoveryFailed: true,
      };
    },
  },
];

// ── Cost & Token Suite ────────────────────────────────────────────────────────

const costTokenScenarios: EvalScenario[] = [
  {
    id: 'cost:no-token-usage',
    name: 'No Token Usage (Score = 100)',
    suite: 'cost-tokens',
    description:
      'Verifies that scenarios without token usage receive full cost score.',
    tags: ['cost'],
    async run(): Promise<EvalRawResult> {
      const t0 = Date.now();
      return {
        completed: true,
        durationMs: Date.now() - t0,
        safetyViolations: 0,
      };
    },
  },

  {
    id: 'cost:low-token-usage',
    name: 'Low Token Usage — Under Target',
    suite: 'cost-tokens',
    description:
      'Validates that minimal token usage stays within the cost budget.',
    tags: ['cost', 'tokens'],
    async run(): Promise<EvalRawResult> {
      const t0 = Date.now();
      return {
        completed: true,
        durationMs: Date.now() - t0,
        // synthetic placeholder token/cost fixture — not a metered spend.
        tokens: { input: 500, output: 100 },
        costUsd: 0.0005, // synthetic placeholder, under the $0.001 target
        safetyViolations: 0,
      };
    },
  },
];

// ── Registry ──────────────────────────────────────────────────────────────────

/**
 * All built-in benchmark suites.
 *
 * Suite names are stable — used as keys in baselines.
 */
export const BUILTIN_SUITES: Record<string, EvalScenario[]> = {
  'core-performance': corePerformanceScenarios,
  'safety-baseline': safetyBaselineScenarios,
  'cost-tokens': costTokenScenarios,
};

/** Flat list of all built-in scenarios (across all suites). */
export const ALL_SCENARIOS: EvalScenario[] = Object.values(BUILTIN_SUITES).flat();
