/**
 * Evaluation Harness — the STANDING-GATE suite set.
 *
 * BUILTIN_SUITES (suites.ts) deliberately include branch-exercising scenarios
 * that fail their floors on purpose (e.g. safety:recovery-failure-score reports
 * a failed recovery to prove the gate flags it). Those belong to the harness's
 * own unit tests, NOT to a CI gate — a gate whose fixtures fail by design can
 * never be honestly green.
 *
 * GATE_SUITES is the separate, all-floors-passing set the standing gate
 * (scripts/eval-gate.ts) runs. Each scenario drives the SAME production paths
 * (createPerfMonitor → PerfMonitor.evaluate → scoreScenario → the gate) with
 * healthy inputs, so the gate proves the scoring path holds every absolute floor
 * for a known-good run, and its checked-in baseline catches score regressions.
 *
 * HONESTY NOTE (identical to suites.ts): a scenario's own `durationMs` is a real
 * wall-clock measurement; the render cycles and injected SLO/queue metrics are
 * synthetic fixtures chosen to sit comfortably under budget, flagged inline.
 */

import type { EvalScenario, EvalRawResult } from './types.js';
import { createPerfMonitor } from '../perf/index.js';
import { createInitialSurfacePerfState } from '../store/domains/surface-perf.js';

/** A healthy PerfMonitor report: every injected metric sits under its budget (synthetic fixtures). */
function healthyPerfReport(t0: number, heapMiB: number): EvalRawResult['perfReport'] {
  const monitor = createPerfMonitor();
  const surfacePerf = createInitialSurfacePerfState();
  surfacePerf.heapUsedBytes = heapMiB * 1024 * 1024; // synthetic placeholder, stable heap
  // synthetic placeholder cycles: 40 frames at 6ms, all under the 16ms budget.
  surfacePerf.recentCycles = Array.from({ length: 40 }, (_, i) => ({
    cycleId: i,
    requestedAt: t0 + i * 16,
    completedAt: t0 + i * 16 + 6,
    durationMs: 6,
    overBudget: false,
  }));
  return monitor.evaluate({
    surfacePerf,
    extraMetrics: {
      // synthetic placeholder metrics — fixtures under budget, not live measurements.
      'event.queue.depth': 5,
      'tool.executor.overhead.p95': 2,
      'compaction.latency.p95': 80,
      'slo.turn_start.p95': 700,
      'slo.cancel.p95': 120,
      'slo.reconnect_recovery.p95': 2500,
      'slo.permission_decision.p95': 30,
    },
  });
}

const gateScenarios: EvalScenario[] = [
  {
    id: 'gate:clean-turn-holds-all-floors',
    name: 'Clean Turn — Holds Every Floor',
    suite: 'standing-gate',
    description:
      'A clean, completed run with a healthy PerfMonitor report and no safety violations must clear every absolute per-dimension floor.',
    tags: ['gate', 'safety', 'latency', 'quality'],
    async run(): Promise<EvalRawResult> {
      const t0 = Date.now();
      return {
        completed: true,
        durationMs: Date.now() - t0,
        perfReport: healthyPerfReport(t0, 50),
        safetyViolations: 0,
      };
    },
  },
  {
    id: 'gate:recovery-success-holds-floor',
    name: 'Recovery Succeeded — Holds Recovery Floor',
    suite: 'standing-gate',
    description:
      'A run whose recovery path was exercised and succeeded scores full recovery and clears every floor.',
    tags: ['gate', 'recovery'],
    async run(): Promise<EvalRawResult> {
      const t0 = Date.now();
      return {
        completed: true,
        durationMs: Date.now() - t0,
        perfReport: healthyPerfReport(t0, 55),
        safetyViolations: 0,
        recoverySucceeded: true,
      };
    },
  },
  {
    id: 'gate:cost-within-budget-holds-floor',
    name: 'Cost Within Budget — Holds Cost Floor',
    suite: 'standing-gate',
    description:
      'A run with token usage whose estimated cost sits under the per-scenario target clears the cost floor (and every other floor).',
    tags: ['gate', 'cost'],
    async run(): Promise<EvalRawResult> {
      const t0 = Date.now();
      return {
        completed: true,
        durationMs: Date.now() - t0,
        perfReport: healthyPerfReport(t0, 45),
        safetyViolations: 0,
        // synthetic placeholder token/cost fixture — under the $0.001 target.
        tokens: { input: 400, output: 80 },
        costUsd: 0.0004,
      };
    },
  },
];

/** The all-floors-passing suite set the standing gate runs. Suite names are stable (baseline keys). */
export const GATE_SUITES: Record<string, EvalScenario[]> = {
  'standing-gate': gateScenarios,
};
