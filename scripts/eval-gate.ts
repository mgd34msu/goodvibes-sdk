#!/usr/bin/env bun
/**
 * eval-gate.ts — the standing eval gate (CI-runnable).
 *
 *   bun run eval:gate
 *
 * Runs the built-in eval suite set through the SAME production paths the harness
 * uses (EvalRunner → scoreScenario → the gate), compares each suite against the
 * checked-in baseline (eval/baseline.json), prints per-scenario results, and
 * exits NON-ZERO when ANY scenario fails its absolute per-dimension floor OR
 * regresses beyond the threshold versus the baseline. A clean run exits 0.
 *
 * Per-job honesty: every scenario's PASS/FAIL and score is printed, and the
 * final summary states floor failures and regressions explicitly — no silent
 * green. A missing baseline is a hard failure (the gate cannot do its
 * regression job without one), pointing at `bun run eval:baseline`.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EvalRunner,
  GATE_SUITES,
  loadBaseline,
  formatSuiteResult,
  formatGateResult,
} from '../packages/sdk/src/platform/runtime/eval/index.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const BASELINE_PATH = resolve(PROJECT_ROOT, 'eval/baseline.json');

const baseline = await loadBaseline(BASELINE_PATH, PROJECT_ROOT);
if (!baseline) {
  console.error(
    '[eval-gate] FAIL: no checked-in baseline at eval/baseline.json. ' +
      'The gate needs a baseline to detect regressions — generate one with: bun run eval:baseline',
  );
  process.exit(1);
}

const runner = new EvalRunner();
let floorFailures = 0;
let regressions = 0;

for (const [suite, scenarios] of Object.entries(GATE_SUITES)) {
  const result = await runner.runSuite(suite, scenarios);
  const gate = runner.evaluateGate(result, baseline);

  console.log(formatSuiteResult(result));
  console.log(formatGateResult(gate));

  floorFailures += gate.floorFailures.length;
  regressions += gate.regressions.length;
}

console.log('-'.repeat(72));
if (floorFailures > 0 || regressions > 0) {
  console.error(
    `[eval-gate] FAIL: ${floorFailures} floor failure(s), ${regressions} regression(s) ` +
      `against baseline "${baseline.label}".`,
  );
  process.exit(1);
}
console.log(`[eval-gate] PASS: all scenarios cleared their floors with no regressions against "${baseline.label}".`);
