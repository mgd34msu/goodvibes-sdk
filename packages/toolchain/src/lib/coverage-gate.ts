/**
 * coverage-gate — aggregate (single-process) coverage ratchet.
 *
 * Parses Bun's text coverage table ("All files | %Funcs | %Lines") and enforces
 * per-repo floors. Test failures in the single-process run are reported as a
 * note but do not fail the coverage gate (correctness is gated elsewhere).
 */

import type { CoverageConfig } from '../config.js';

const ANSI = /\x1b\[[0-9;]*m/g;

export interface CoverageSummary {
  readonly funcsPct: number;
  readonly linesPct: number;
}

/** Extract the aggregate `All files` row percentages from Bun coverage output. */
export function parseCoverageSummary(output: string): CoverageSummary | null {
  const clean = output.replace(ANSI, '');
  for (const line of clean.split('\n')) {
    if (!line.trimStart().startsWith('All files')) continue;
    const cells = line.split('|').map((c) => c.trim());
    const funcs = Number.parseFloat(cells[1] ?? '');
    const lines = Number.parseFloat(cells[2] ?? '');
    if (Number.isFinite(funcs) && Number.isFinite(lines)) {
      return { funcsPct: funcs, linesPct: lines };
    }
  }
  return null;
}

/** Extract a Bun "N fail" count from the run output, if present. */
export function parseFailCount(output: string): number {
  const match = /^\s*(\d+)\s+fail\s*$/m.exec(output.replace(ANSI, ''));
  return match?.[1] ? Number.parseInt(match[1], 10) : 0;
}

export interface CoverageGateResult {
  readonly ok: boolean;
  readonly summary: CoverageSummary | null;
  readonly failCount: number;
  readonly detail: string;
}

/** Evaluate coverage output against the configured floors. */
export function evaluateCoverageGate(output: string, config: Pick<CoverageConfig, 'funcsFloor' | 'linesFloor'>): CoverageGateResult {
  const summary = parseCoverageSummary(output);
  const failCount = parseFailCount(output);
  if (!summary) {
    return { ok: false, summary: null, failCount, detail: 'no coverage table found in output — did the run crash?' };
  }
  const funcsOk = summary.funcsPct >= config.funcsFloor;
  const linesOk = summary.linesPct >= config.linesFloor;
  const ok = funcsOk && linesOk;
  const parts: string[] = [
    `Funcs ${summary.funcsPct.toFixed(2)}% (floor ${config.funcsFloor}) ${funcsOk ? 'OK' : 'BELOW'}`,
    `Lines ${summary.linesPct.toFixed(2)}% (floor ${config.linesFloor}) ${linesOk ? 'OK' : 'BELOW'}`,
  ];
  if (failCount > 0) parts.push(`note: ${failCount} single-process test failure(s) (cross-file interference debt; gated elsewhere)`);
  return { ok, summary, failCount, detail: parts.join('; ') };
}
