/**
 * per-job-green — the by-reference validation primitive.
 *
 * Given a commit SHA, find that commit's push-CI run for a named workflow, wait
 * for it to complete, and assert EVERY job concluded `success` (per-job green,
 * never the rollup). Generalizes the agent repo's bespoke poll, which asserted
 * only the rollup plus one hard-coded job name.
 *
 * The GitHub Actions API is the primary source; when it returns 503 (its known
 * flaky mode under load) the Checks API (`check-suites` / `check-runs` on the
 * commit) is the fallback so a transient 503 never fails a release.
 */

import type { HttpGetJson, HttpResponse, Logger, Sleep } from './effects.js';
import type { PerJobGreenConfig } from '../config.js';

export interface PerJobGreenResult {
  readonly ok: boolean;
  /** The resolved Actions run id, when one was found. */
  readonly runId: number | null;
  /** Head SHA the resolved run actually built (for the artifact-integrity handoff). */
  readonly headSha: string | null;
  /** Names of jobs/checks that did not conclude `success`. */
  readonly failures: readonly string[];
  /** Which source produced the verdict. */
  readonly source: 'actions' | 'check-suites' | 'none';
  readonly reason: string;
}

export interface PerJobGreenDeps {
  readonly http: HttpGetJson;
  readonly sleep: Sleep;
  readonly logger: Logger;
  /** Milliseconds since epoch; injectable so the deadline is deterministic in tests. */
  readonly now: () => number;
  /** GitHub API origin. Defaults to https://api.github.com. */
  readonly apiBase?: string;
  /** Bearer token for the API. */
  readonly token?: string;
}

interface WorkflowRun {
  readonly id: number;
  readonly path?: string;
  readonly name?: string;
  readonly status?: string;
  readonly conclusion?: string | null;
  readonly head_sha?: string;
  readonly created_at?: string;
}

interface JobEntry {
  readonly name: string;
  readonly status?: string;
  readonly conclusion?: string | null;
}

function headers(token: string | undefined): Record<string, string> {
  const base: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'goodvibes-toolchain-per-job-green',
  };
  if (token) base.Authorization = `Bearer ${token}`;
  return base;
}

function asArray<T>(value: unknown, key: string): readonly T[] {
  if (value && typeof value === 'object') {
    const field = (value as Record<string, unknown>)[key];
    if (Array.isArray(field)) return field as readonly T[];
  }
  return [];
}

/** Find the newest push run of the configured workflow for `sha`. Returns null if none exists yet. */
async function resolveRun(
  deps: PerJobGreenDeps,
  config: PerJobGreenConfig,
  sha: string,
): Promise<{ run: WorkflowRun | null; status: number }> {
  const base = deps.apiBase ?? 'https://api.github.com';
  const url = `${base}/repos/${config.owner}/${config.repo}/actions/runs?head_sha=${sha}&event=${config.event}&per_page=50`;
  const res = await deps.http(url, headers(deps.token));
  if (res.status !== 200) return { run: null, status: res.status };
  const runs = asArray<WorkflowRun>(res.body, 'workflow_runs')
    .filter((r) => r.path?.endsWith(`/${config.workflow}`) || r.name === config.workflow);
  if (runs.length === 0) return { run: null, status: res.status };
  const newest = [...runs].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))[0] ?? null;
  return { run: newest, status: res.status };
}

/** Enumerate every job of a completed run and collect the ones that are not `success`. */
async function evaluateRunJobs(deps: PerJobGreenDeps, config: PerJobGreenConfig, runId: number): Promise<string[]> {
  const base = deps.apiBase ?? 'https://api.github.com';
  const url = `${base}/repos/${config.owner}/${config.repo}/actions/runs/${runId}/jobs?per_page=100`;
  const res = await deps.http(url, headers(deps.token));
  if (res.status !== 200) {
    return [`jobs-fetch-status-${res.status}`];
  }
  const jobs = asArray<JobEntry>(res.body, 'jobs');
  if (jobs.length === 0) return ['no-jobs-reported'];
  return jobs.filter((j) => j.conclusion !== 'success').map((j) => `${j.name} (${j.conclusion ?? j.status ?? 'unknown'})`);
}

/**
 * Extract the Actions run id from a check-run's details_url. Actions-created
 * check runs point at `https://github.com/{owner}/{repo}/actions/runs/{run_id}/job/{job_id}`.
 */
export function runIdFromDetailsUrl(detailsUrl: string | undefined): number | null {
  if (!detailsUrl) return null;
  const match = /\/actions\/runs\/(\d+)(?:\/|$)/.exec(detailsUrl);
  return match?.[1] ? Number.parseInt(match[1], 10) : null;
}

/** Checks-API fallback: assess per-check conclusions for the commit when the Actions API is 503-ing. */
async function evaluateCheckSuites(deps: PerJobGreenDeps, config: PerJobGreenConfig, sha: string): Promise<PerJobGreenResult | null> {
  const base = deps.apiBase ?? 'https://api.github.com';
  const suitesUrl = `${base}/repos/${config.owner}/${config.repo}/commits/${sha}/check-suites`;
  const suitesRes = await deps.http(suitesUrl, headers(deps.token));
  if (suitesRes.status !== 200) return null;
  const suites = asArray<{ status?: string; conclusion?: string | null }>(suitesRes.body, 'check_suites');
  if (suites.length === 0) return null;
  if (suites.some((s) => s.status !== 'completed')) return null; // still running — let the caller keep polling
  const runsUrl = `${base}/repos/${config.owner}/${config.repo}/commits/${sha}/check-runs?per_page=100`;
  const runsRes = await deps.http(runsUrl, headers(deps.token));
  if (runsRes.status !== 200) return null;
  const checks = asArray<{ name: string; conclusion?: string | null; details_url?: string }>(runsRes.body, 'check_runs');
  const failures = checks
    .filter((c) => c.conclusion !== 'success' && c.conclusion !== 'neutral' && c.conclusion !== 'skipped')
    .map((c) => `${c.name} (${c.conclusion ?? 'unknown'})`);
  // Downstream artifact restores need the Actions run id even on this path.
  // Actions-created check runs carry it in details_url; take the first that
  // parses. If none parses, runId stays null and the caller must treat the
  // handoff as unresolved (the bin surfaces run_id= empty; release pipelines
  // hard-fail their artifact restore honestly instead of misdirecting it).
  const runId = checks.map((c) => runIdFromDetailsUrl(c.details_url)).find((id): id is number => id !== null) ?? null;
  const runIdNote = runId === null ? '; run id UNRESOLVED from check-run details' : `; run id ${runId} resolved from check-run details`;
  return {
    ok: failures.length === 0,
    runId,
    headSha: sha,
    failures,
    source: 'check-suites',
    reason: failures.length === 0
      ? `check-suites fallback: all ${checks.length} checks green for ${sha}${runIdNote}`
      : `check-suites fallback: ${failures.length} check(s) not green`,
  };
}

/**
 * Verify `sha`'s push-CI run is per-job green. Polls until the run completes or
 * the deadline passes. Deterministic under injected `http`/`sleep`/`now`.
 */
export async function verifyPerJobGreen(deps: PerJobGreenDeps, config: PerJobGreenConfig, sha: string): Promise<PerJobGreenResult> {
  const start = deps.now();
  const deadline = start + config.deadlineMs;

  while (true) {
    const { run, status } = await resolveRun(deps, config, sha);

    if (status === 503) {
      deps.logger.warn(`[per-job-green] Actions API 503 — trying check-suites fallback for ${sha}`);
      const fallback = await evaluateCheckSuites(deps, config, sha);
      if (fallback) return fallback;
      deps.logger.warn('[per-job-green] check-suites fallback inconclusive; will retry');
    } else if (run) {
      if (run.status === 'completed') {
        if (run.conclusion !== 'success') {
          // Rollup already failed — still enumerate jobs for an actionable message.
          const failures = await evaluateRunJobs(deps, config, run.id);
          return {
            ok: false,
            runId: run.id,
            headSha: run.head_sha ?? sha,
            failures: failures.length > 0 ? failures : [`run conclusion ${run.conclusion ?? 'unknown'}`],
            source: 'actions',
            reason: `run ${run.id} concluded ${run.conclusion ?? 'unknown'}`,
          };
        }
        const failures = await evaluateRunJobs(deps, config, run.id);
        return {
          ok: failures.length === 0,
          runId: run.id,
          headSha: run.head_sha ?? sha,
          failures,
          source: 'actions',
          reason: failures.length === 0
            ? `run ${run.id} is per-job green for ${run.head_sha ?? sha}`
            : `run ${run.id} has ${failures.length} non-green job(s)`,
        };
      }
      deps.logger.info(`[per-job-green] run ${run.id} is ${run.status ?? 'pending'}; waiting`);
    } else {
      deps.logger.info(`[per-job-green] no ${config.workflow} push run found yet for ${sha}; waiting`);
    }

    if (deps.now() >= deadline) {
      return {
        ok: false,
        runId: run?.id ?? null,
        headSha: run?.head_sha ?? null,
        failures: ['deadline-exceeded'],
        source: run ? 'actions' : 'none',
        reason: `timed out after ${config.deadlineMs}ms waiting for ${config.workflow} to complete on ${sha}`,
      };
    }
    await deps.sleep(config.pollIntervalMs);
  }
}
