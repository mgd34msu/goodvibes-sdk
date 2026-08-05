/**
 * The flow executor.
 *
 * Walks the steps of one path in order, reporting honestly as it goes: what it
 * is about to do, what it just achieved, and — when Google requires a real
 * person — exactly what to click. It never grinds silently, never loops on a
 * sign-in wall, and never reports success it did not verify.
 *
 * This module is deliberately free of Google specifics. It knows how to
 * sequence steps, honour dependencies, stop cleanly on a human handoff and
 * assemble a report. The concrete work lives in the runners injected by
 * `google-setup-actions.ts`, which keeps this testable with no browser, no
 * network and no account.
 */

import { runbookAnchor, stepsForPath } from './setup-plan.js';
import type {
  GoogleProgressPort,
  GoogleSetupPath,
  GoogleSetupReport,
  GoogleSetupStepSpec,
  GoogleStepId,
  GoogleStepOutcome,
  GoogleStepResult,
} from './types.js';

/**
 * What a runner returns. The executor supplies `id` and `elapsedMs`, so a
 * runner only describes the outcome.
 */
export interface GoogleStepRunnerResult {
  readonly outcome: GoogleStepOutcome;
  readonly detail: string;
  readonly problem?: string;
  readonly fix?: string;
  /** Non-fatal things the owner must still be told. */
  readonly warnings?: readonly string[];
}

/** Performs one step. Must not throw for expected failures. */
export type GoogleStepRunner = (spec: GoogleSetupStepSpec) => Promise<GoogleStepRunnerResult>;

export interface GoogleSetupFlowDeps {
  readonly progress: GoogleProgressPort;
  /** One runner per step id in the path being run. */
  readonly runners: ReadonlyMap<GoogleStepId, GoogleStepRunner>;
  readonly now?: () => number;
}

/** Outcomes that count as "this step is satisfied" for dependency purposes. */
function satisfied(outcome: GoogleStepOutcome): boolean {
  return outcome === 'done' || outcome === 'already-done';
}

/**
 * Turn an unexpected throw into a reported failure rather than letting it
 * escape. A runner that throws is a bug, but the owner should still get a
 * usable report and a pointer to the written instructions.
 */
function failureFromThrow(spec: GoogleSetupStepSpec, error: unknown): GoogleStepRunnerResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    outcome: 'failed',
    detail: `${spec.title} did not complete.`,
    problem: `This step stopped unexpectedly: ${message}`,
    fix: `Say the word and I will lay out the written steps for "${spec.title}" and pick up where this left off — completed work is detected and skipped.`,
  };
}

/** Run one path end to end. */
export async function runGoogleSetupFlow(
  path: GoogleSetupPath,
  deps: GoogleSetupFlowDeps,
): Promise<GoogleSetupReport> {
  const now = deps.now ?? ((): number => Date.now());
  const specs = stepsForPath(path);
  const results: GoogleStepResult[] = [];
  const warnings: string[] = [];
  const outcomes = new Map<GoogleStepId, GoogleStepOutcome>();

  let waitingOn: GoogleStepId | null = null;
  let halted = false;

  for (const [index, spec] of specs.entries()) {
    // Once the flow has handed off to the human or hit a failure, the rest of
    // the path is recorded as skipped rather than attempted — running steps
    // whose prerequisites are missing produces confusing errors.
    if (halted) {
      const skipped: GoogleStepResult = {
        id: spec.id,
        outcome: 'skipped',
        detail: 'Not attempted yet — an earlier step is still outstanding.',
        elapsedMs: 0,
      };
      outcomes.set(spec.id, 'skipped');
      results.push(skipped);
      continue;
    }

    const unmet = (spec.requires ?? []).filter((id) => !satisfied(outcomes.get(id) ?? 'skipped'));
    if (unmet.length > 0) {
      const skipped: GoogleStepResult = {
        id: spec.id,
        outcome: 'skipped',
        detail: `Skipped because it depends on ${unmet.join(', ')}.`,
        elapsedMs: 0,
      };
      outcomes.set(spec.id, 'skipped');
      results.push(skipped);
      continue;
    }

    const runner = deps.runners.get(spec.id);
    if (runner === undefined) {
      // A missing runner is a wiring bug, not a user-facing condition.
      throw new Error(`No runner registered for Google setup step "${spec.id}"`);
    }

    deps.progress.stepStarted(spec, index + 1, specs.length);
    const startedAt = now();

    let outcome: GoogleStepRunnerResult;
    try {
      outcome = await runner(spec);
    } catch (error) {
      outcome = failureFromThrow(spec, error);
    }

    const result: GoogleStepResult = {
      id: spec.id,
      outcome: outcome.outcome,
      detail: outcome.detail,
      ...(outcome.problem === undefined ? {} : { problem: outcome.problem }),
      ...(outcome.fix === undefined ? {} : { fix: outcome.fix }),
      ...(outcome.outcome === 'failed' || outcome.outcome === 'needs-human'
        ? { runbookAnchor: runbookAnchor(spec.id) }
        : {}),
      elapsedMs: Math.max(0, now() - startedAt),
    };

    outcomes.set(spec.id, result.outcome);
    results.push(result);
    warnings.push(...(outcome.warnings ?? []));
    deps.progress.stepFinished(spec, result);

    if (result.outcome === 'needs-human') {
      waitingOn = spec.id;
      halted = true;
      deps.progress.humanActionNeeded(spec, outcome.fix ?? outcome.problem ?? spec.manualSteps.join(' '));
    } else if (result.outcome === 'failed') {
      halted = true;
    }
  }

  const ok = results.every((result) => satisfied(result.outcome));
  return {
    path,
    ok,
    steps: results,
    waitingOn,
    warnings,
    summary: summarize(path, results, waitingOn, ok),
  };
}

function summarize(
  path: GoogleSetupPath,
  results: readonly GoogleStepResult[],
  waitingOn: GoogleStepId | null,
  ok: boolean,
): string {
  const label = path === 'app-password' ? 'Gmail and calendar' : 'the Gmail and Calendar APIs';
  const changed = results.filter((result) => result.outcome === 'done').length;
  const skipped = results.filter((result) => result.outcome === 'already-done').length;

  if (ok) {
    if (changed === 0) {
      return `Nothing to do — ${label} were already connected.`;
    }
    return `Connected ${label}. ${changed} step${changed === 1 ? '' : 's'} completed${skipped > 0 ? `, ${skipped} already done` : ''}.`;
  }

  if (waitingOn !== null) {
    return `Paused — one thing needs you. Do it, then re-run; the ${changed + skipped} completed step${changed + skipped === 1 ? '' : 's'} will be skipped.`;
  }

  const failed = results.find((result) => result.outcome === 'failed');
  return failed
    ? `Stopped at "${failed.id}". ${failed.problem ?? 'The step did not complete.'}`
    : 'Stopped before finishing.';
}

/**
 * Render a report as text for the CLI. Kept here so the CLI command, the TUI
 * command and tests all produce identical wording.
 */
export function renderGoogleSetupReport(report: GoogleSetupReport): string {
  const lines: string[] = [];
  lines.push(report.summary);
  lines.push('');

  for (const step of report.steps) {
    const marker =
      step.outcome === 'done'
        ? '  ok  '
        : step.outcome === 'already-done'
          ? ' skip '
          : step.outcome === 'needs-human'
            ? ' you  '
            : step.outcome === 'failed'
              ? ' fail '
              : '  --  ';
    lines.push(`[${marker}] ${step.id} — ${step.detail}`);
    if (step.problem !== undefined) {
      lines.push(`          ${step.problem}`);
    }
    if (step.fix !== undefined) {
      lines.push(`          Do this: ${step.fix}`);
    }
  }

  if (report.warnings.length > 0) {
    lines.push('');
    for (const warning of report.warnings) {
      lines.push(`WARNING: ${warning}`);
    }
  }

  if (!report.ok) {
    lines.push('');
    // Not a repo path. A packaged install has no checkout, so naming the source
    // file sends the owner looking for something that is not on their disk. The
    // same text is generated from the step plan and printed by /google runbook.
    lines.push('Ask for the written steps at any point and I will lay them out.');
  }

  return lines.join('\n');
}
