/**
 * per-job-green — the by-reference validation primitive.
 *
 * Given a commit SHA, find that commit's push-CI run for a named workflow, wait
 * for it to complete, and assert EVERY job concluded `success` (per-job green,
 * never the rollup). Generalizes the agent repo's bespoke poll, which asserted
 * only the rollup plus one hard-coded job name.
 *
 * Transient-error posture: EVERY GitHub API call (runs listing, per-run jobs,
 * check-suites, check-runs) goes through a bounded retry loop (default 8
 * attempts with 7s sleeps, configurable) before its status is treated as
 * final — the API's known flaky mode makes single-shot calls fail a meaningful
 * fraction of the time. When the runs listing stays unavailable after retries,
 * the Checks API (`check-suites` / `check-runs` on the commit) is the fallback.
 * "No run found yet" is never a failure — it waits and polls. Only an exhausted
 * retry budget on a needed endpoint, a non-green job, or the deadline produces
 * a failure, and each names its source honestly.
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

/** Statuses worth retrying: server errors, rate limiting, and transport failures. */
function isTransientStatus(status: number): boolean {
  return status === 0 || status === 429 || status >= 500;
}

/**
 * GET with the tool's bounded transient-error retry. Every API call in this
 * module goes through here; a thrown transport error counts as status 0 and is
 * retried like a 5xx. Returns the last response once a definitive (non-
 * transient) status arrives or the retry budget is exhausted.
 */
async function getWithRetry(deps: PerJobGreenDeps, config: PerJobGreenConfig, url: string, label: string): Promise<HttpResponse> {
  let last: HttpResponse = { status: 0, body: null };
  for (let attempt = 1; attempt <= config.retryAttempts; attempt++) {
    try {
      last = await deps.http(url, headers(deps.token));
    } catch (error) {
      last = { status: 0, body: error instanceof Error ? error.message : String(error) };
    }
    if (!isTransientStatus(last.status)) return last;
    if (attempt < config.retryAttempts) {
      deps.logger.warn(`[per-job-green] ${label}: transient ${last.status} (attempt ${attempt}/${config.retryAttempts}); retrying in ${config.retryDelayMs}ms`);
      await deps.sleep(config.retryDelayMs);
    }
  }
  deps.logger.warn(`[per-job-green] ${label}: still ${last.status} after ${config.retryAttempts} attempt(s)`);
  return last;
}

/** Find the newest push run of the configured workflow for `sha`. Returns null if none exists yet. */
async function resolveRun(
  deps: PerJobGreenDeps,
  config: PerJobGreenConfig,
  sha: string,
): Promise<{ run: WorkflowRun | null; status: number }> {
  const base = deps.apiBase ?? 'https://api.github.com';
  const url = `${base}/repos/${config.owner}/${config.repo}/actions/runs?head_sha=${sha}&event=${config.event}&per_page=50`;
  const res = await getWithRetry(deps, config, url, 'actions runs listing');
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
  const res = await getWithRetry(deps, config, url, `actions run ${runId} jobs`);
  if (res.status !== 200) {
    // Honest failure naming the endpoint: the retry budget is exhausted (or the
    // status is definitively non-200), so the per-job conclusions are unknowable.
    return [`actions run ${runId} jobs endpoint returned ${res.status} after ${config.retryAttempts} attempt(s)`];
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

/**
 * Resolve the fallback run id to the TARGET workflow's run.
 *
 * Discriminator: neither the check-run nor the check-suite REST payload carries
 * a workflow-file field, so each candidate run id (parsed from Actions
 * details_urls) is confirmed against the single-run endpoint
 * `GET /actions/runs/{id}`, whose `path` names the workflow file. A candidate
 * is accepted only when its confirmed path matches `config.workflow`.
 *
 * Availability compromise: when the commit carries exactly ONE distinct
 * candidate and its confirmation is UNAVAILABLE (any non-200 — i.e. not a
 * CONFIRMED mismatch), the sole candidate is accepted: no ambiguity exists on
 * the commit, and demanding confirmation during the very Actions-API outage the
 * fallback exists for would gut it. With MULTIPLE candidates, confirmation is
 * required — an unconfirmable set resolves to null (UNRESOLVED), never a guess.
 */
async function resolveFallbackRunId(deps: PerJobGreenDeps, config: PerJobGreenConfig, candidateIds: readonly number[]): Promise<number | null> {
  const distinct = [...new Set(candidateIds)];
  if (distinct.length === 0) return null;
  const base = deps.apiBase ?? 'https://api.github.com';
  let unavailable = 0;
  for (const id of distinct) {
    const res = await getWithRetry(deps, config, `${base}/repos/${config.owner}/${config.repo}/actions/runs/${id}`, `actions run ${id} workflow confirmation`);
    if (res.status !== 200) {
      unavailable += 1;
      continue;
    }
    const path = (res.body as { path?: string } | null)?.path;
    if (typeof path === 'string' && (path === config.workflow || path.endsWith(`/${config.workflow}`))) {
      return id;
    }
  }
  if (distinct.length === 1 && unavailable === 1) {
    deps.logger.warn(`[per-job-green] sole fallback run candidate ${distinct[0]} accepted without workflow confirmation (confirmation endpoint unavailable; no ambiguity on this commit)`);
    return distinct[0] ?? null;
  }
  return null;
}

/** Checks-API fallback: assess per-check conclusions for the commit when the Actions API is 503-ing. */
async function evaluateCheckSuites(deps: PerJobGreenDeps, config: PerJobGreenConfig, sha: string): Promise<PerJobGreenResult | null> {
  const base = deps.apiBase ?? 'https://api.github.com';
  const suitesUrl = `${base}/repos/${config.owner}/${config.repo}/commits/${sha}/check-suites`;
  const suitesRes = await getWithRetry(deps, config, suitesUrl, 'check-suites');
  if (suitesRes.status !== 200) return null;
  const suites = asArray<{ status?: string; conclusion?: string | null }>(suitesRes.body, 'check_suites');
  if (suites.length === 0) return null;
  if (suites.some((s) => s.status !== 'completed')) return null; // still running — let the caller keep polling
  const runsUrl = `${base}/repos/${config.owner}/${config.repo}/commits/${sha}/check-runs?per_page=100`;
  const runsRes = await getWithRetry(deps, config, runsUrl, 'check-runs');
  if (runsRes.status !== 200) return null;
  const checks = asArray<{ name: string; conclusion?: string | null; details_url?: string }>(runsRes.body, 'check_runs');
  const failures = checks
    .filter((c) => c.conclusion !== 'success' && c.conclusion !== 'neutral' && c.conclusion !== 'skipped')
    .map((c) => `${c.name} (${c.conclusion ?? 'unknown'})`);
  // Downstream artifact restores need the Actions run id even on this path.
  // Actions-created check runs carry it in details_url. Resolution must be
  // workflow-filtered (a commit can carry check runs from several push
  // workflows); see resolveFallbackRunId for the exact discriminator. When no
  // candidate resolves to the target workflow, runId stays null and the caller
  // must treat the handoff as unresolved (the bin surfaces run_id= empty;
  // release pipelines hard-fail their artifact restore honestly instead of
  // misdirecting it).
  const candidates = checks.map((c) => runIdFromDetailsUrl(c.details_url)).filter((id): id is number => id !== null);
  const runId = await resolveFallbackRunId(deps, config, candidates);
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

    if (isTransientStatus(status)) {
      // The runs listing stayed unavailable through its whole retry budget —
      // try the Checks API before falling back to another poll cycle.
      deps.logger.warn(`[per-job-green] Actions API unavailable (${status}) after retries — trying check-suites fallback for ${sha}`);
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
