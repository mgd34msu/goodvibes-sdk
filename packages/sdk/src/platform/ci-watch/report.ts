/**
 * ci-watch/report.ts
 *
 * Derives the overall CI verdict from the PER-JOB conclusions — the whole point
 * of the doctrine. It never trusts a single rollup status. continue-on-error
 * jobs are recorded as violations and, because they are banned, force the verdict
 * off "passed" even if every visible conclusion is success (a continue-on-error
 * job can be green while having masked a real failure).
 */
import {
  FAILING_CONCLUSIONS,
  PASSING_CONCLUSIONS,
  type CiJob,
  type CiOverall,
  type CiReport,
} from './types.js';

export interface DeriveCiReportInput {
  readonly repo: string;
  readonly ref?: string | undefined;
  readonly prNumber?: number | undefined;
  readonly jobs: readonly CiJob[];
  readonly now?: number | undefined;
}

/** Build the per-job report + derived verdict. */
export function deriveCiReport(input: DeriveCiReportInput): CiReport {
  const jobs = input.jobs;
  const violations: string[] = [];

  for (const job of jobs) {
    if (job.continueOnError) {
      violations.push(`job "${job.name}" is continue-on-error, which is banned — it can mask a failure`);
    }
    if (job.status === 'completed' && job.conclusion !== null
      && !FAILING_CONCLUSIONS.has(job.conclusion) && !PASSING_CONCLUSIONS.has(job.conclusion)) {
      violations.push(`job "${job.name}" has an unrecognized conclusion "${job.conclusion}" — treated as not-passed`);
    }
  }

  const overall = deriveOverall(jobs, violations.length > 0);
  return {
    repo: input.repo,
    ...(input.ref ? { ref: input.ref } : {}),
    ...(input.prNumber !== undefined ? { prNumber: input.prNumber } : {}),
    overall,
    jobs,
    violations,
    checkedAt: input.now ?? Date.now(),
  };
}

/**
 * The verdict, per-job:
 *  - no jobs at all -> unknown (never silently "passed").
 *  - any job not yet completed -> pending.
 *  - any completed job whose conclusion is not an explicit pass -> failed.
 *  - a continue-on-error/unknown-conclusion violation -> never "passed".
 *  - otherwise (every job completed and explicitly passing) -> passed.
 */
export function deriveOverall(jobs: readonly CiJob[], hasBlockingViolation: boolean): CiOverall {
  if (jobs.length === 0) return 'unknown';
  if (jobs.some((j) => j.status !== 'completed' || j.conclusion === null)) return 'pending';
  const anyFailing = jobs.some((j) => !PASSING_CONCLUSIONS.has(j.conclusion ?? ''));
  if (anyFailing) return 'failed';
  if (hasBlockingViolation) return 'failed';
  return 'passed';
}

/** The names of the jobs that did not pass (for notifications and fix-session briefs). */
export function failingJobNames(report: CiReport): string[] {
  return report.jobs
    .filter((j) => j.status === 'completed' && !PASSING_CONCLUSIONS.has(j.conclusion ?? ''))
    .map((j) => j.name);
}

/** A compact one-line-per-job rendering for a channel notification. */
export function renderCiReportLines(report: CiReport): string {
  const header = `CI ${report.overall.toUpperCase()} for ${report.repo}${report.ref ? `@${report.ref}` : ''}${report.prNumber ? ` (PR #${report.prNumber})` : ''}`;
  const jobLines = report.jobs.map((j) => `- ${j.name}: ${j.status === 'completed' ? (j.conclusion ?? 'no-conclusion') : j.status}`);
  const violationLines = report.violations.map((v) => `! ${v}`);
  return [header, ...jobLines, ...violationLines].join('\n');
}
