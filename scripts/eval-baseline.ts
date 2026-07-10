#!/usr/bin/env bun
/**
 * eval-baseline.ts
 *
 * Regenerate (or drift-check) the checked-in eval baseline the standing gate
 * (scripts/eval-gate.ts) compares against. Baselines change ONLY through this
 * explicit script — never silently:
 *
 *   bun run eval:baseline           # regenerate eval/baseline.json from a fresh run
 *   bun run eval:baseline --check   # exit 1 if the checked-in baseline has drifted
 *
 * The built-in suite scores are deterministic (see runtime/eval/suites.ts — each
 * scenario's own wall-clock runtime is far under the 500 ms latency-excellent
 * threshold, and every other input is a fixed fixture), so a fresh capture must
 * reproduce the checked-in per-scenario scores exactly. When it does not, the
 * suites or the scorer changed and the gate's regression baseline is stale — the
 * --check mode fails CI and names the drift so a human regenerates deliberately.
 *
 * The baseline `label` is a fixed sentinel, NOT the build version: the gate must
 * not couple to VERSION (a post-bump run would otherwise spuriously "drift").
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EvalRunner,
  GATE_SUITES,
  captureBaseline,
  serialiseBaseline,
  loadBaseline,
  writeBaseline,
} from '../packages/sdk/src/platform/runtime/eval/index.ts';
import type { EvalSuiteResult, EvalBaseline } from '../packages/sdk/src/platform/runtime/eval/index.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const BASELINE_PATH = resolve(PROJECT_ROOT, 'eval/baseline.json');

/** Fixed sentinel — deliberately NOT the SDK version (the gate must not couple to VERSION). */
const BASELINE_LABEL = 'standing-gate';

const CHECK_ONLY = process.argv.includes('--check');

async function runAllSuites(): Promise<EvalSuiteResult[]> {
  const runner = new EvalRunner();
  const results: EvalSuiteResult[] = [];
  for (const [suite, scenarios] of Object.entries(GATE_SUITES)) {
    results.push(await runner.runSuite(suite, scenarios));
  }
  return results;
}

/** Compare only the score-bearing structure (label + per-suite scenario scores); capturedAt is expected to differ. */
function baselineScoresEqual(a: EvalBaseline, b: EvalBaseline): string[] {
  const drift: string[] = [];
  if (a.label !== b.label) drift.push(`label: "${a.label}" vs "${b.label}"`);
  const suites = new Set([...Object.keys(a.suites), ...Object.keys(b.suites)]);
  for (const suite of suites) {
    const sa = a.suites[suite];
    const sb = b.suites[suite];
    if (!sa || !sb) {
      drift.push(`suite "${suite}" present in only one baseline`);
      continue;
    }
    const ids = new Set([...Object.keys(sa.scenarioScores), ...Object.keys(sb.scenarioScores)]);
    for (const id of ids) {
      const va = sa.scenarioScores[id];
      const vb = sb.scenarioScores[id];
      if (va !== vb) drift.push(`${suite}/${id}: ${va ?? '<absent>'} vs ${vb ?? '<absent>'}`);
    }
  }
  return drift;
}

const fresh = captureBaseline(BASELINE_LABEL, await runAllSuites());

if (CHECK_ONLY) {
  const committed = await loadBaseline(BASELINE_PATH, PROJECT_ROOT);
  if (!committed) {
    console.error(`[eval-baseline] FAIL: no checked-in baseline at eval/baseline.json. Run: bun run eval:baseline`);
    process.exit(1);
  }
  const drift = baselineScoresEqual(committed, fresh);
  if (drift.length > 0) {
    console.error('[eval-baseline] FAIL: the checked-in baseline has drifted from a fresh capture:');
    for (const d of drift) console.error(`  - ${d}`);
    console.error('\nRegenerate deliberately with: bun run eval:baseline');
    process.exit(1);
  }
  console.log('[eval-baseline] OK — checked-in baseline matches a fresh capture (no drift).');
} else {
  await writeBaseline(BASELINE_PATH, fresh, PROJECT_ROOT);
  console.log(`[eval-baseline] wrote ${BASELINE_PATH}`);
  console.log(serialiseBaseline(fresh));
}
