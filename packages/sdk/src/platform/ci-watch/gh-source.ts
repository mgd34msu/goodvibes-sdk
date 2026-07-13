/**
 * ci-watch/gh-source.ts
 *
 * A CiStatusSource backed by the `gh` CLI. It reads PER-JOB check results from
 * the GitHub Checks API (repos/{repo}/commits/{ref}/check-runs), which is the
 * per-job conclusion surface the doctrine requires — never a single rollup.
 *
 * SHELL SAFETY: every `gh` invocation runs through execFile (no shell) with a
 * hard timeout, so a hung or slow gh call cannot wedge the caller.
 *
 * continue-on-error detection: the check-runs API does not expose whether a job
 * was configured continue-on-error (that lives in the workflow YAML). This
 * source therefore leaves `continueOnError` unset; the report's ban still fires
 * for any source that CAN supply the flag. This limitation is stated, not hidden.
 */
import { execFile } from 'node:child_process';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import type { CiJob, CiStatusSource } from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;

interface GhCheckRun {
  readonly id?: number;
  readonly name?: string;
  readonly status?: string;
  readonly conclusion?: string | null;
  readonly html_url?: string;
}

/** Bound the seeded brief: at most this many failing jobs' logs... */
const MAX_LOG_JOBS = 5;
/** ...and at most this many bytes of each job's log, tailed (failures live at the end). */
const MAX_JOB_LOG_BYTES = 16 * 1024;

/** The tail of a job log, bounded and cut on a line boundary. */
function tailLog(raw: string): string {
  const trimmed = raw.trimEnd();
  if (trimmed.length <= MAX_JOB_LOG_BYTES) return trimmed;
  const tail = trimmed.slice(-MAX_JOB_LOG_BYTES);
  const firstNewline = tail.indexOf('\n');
  return `… (truncated to the last ${MAX_JOB_LOG_BYTES} bytes)\n${firstNewline > -1 ? tail.slice(firstNewline + 1) : tail}`;
}

function runGh(args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('gh', [...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(new Error(`gh ${args[0]} failed: ${summarizeError(error)}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function toCiJob(run: GhCheckRun): CiJob {
  const status = run.status === 'completed' || run.status === 'in_progress' || run.status === 'queued'
    ? run.status
    : 'in_progress';
  return {
    name: run.name ?? 'unnamed check',
    status,
    conclusion: run.conclusion ?? null,
    ...(run.html_url ? { url: run.html_url } : {}),
  };
}

export interface GhCliCiSourceOptions {
  readonly timeoutMs?: number | undefined;
}

/** Build a gh-CLI-backed CI status source. */
export function createGhCliCiSource(options: GhCliCiSourceOptions = {}): CiStatusSource {
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  async function resolveRef(repo: string, ref?: string, prNumber?: number): Promise<string> {
    if (prNumber !== undefined) {
      const out = await runGh(['api', `repos/${repo}/pulls/${prNumber}`, '--jq', '.head.sha'], timeoutMs);
      const sha = out.trim();
      if (!sha) throw new Error(`could not resolve head sha for ${repo} PR #${prNumber}`);
      return sha;
    }
    if (ref) return ref;
    throw new Error('a ref or prNumber is required to resolve CI status');
  }

  return {
    fetchJobs: async ({ repo, ref, prNumber }): Promise<readonly CiJob[]> => {
      const resolvedRef = await resolveRef(repo, ref, prNumber);
      const out = await runGh(
        ['api', `repos/${repo}/commits/${resolvedRef}/check-runs`, '--paginate', '--jq', '.check_runs'],
        timeoutMs,
      );
      let runs: GhCheckRun[];
      try {
        // --paginate --jq '.check_runs' may emit several JSON arrays (one per page); join them.
        const chunks = out.trim().split('\n').filter((line) => line.trim().length > 0);
        runs = chunks.flatMap((chunk) => JSON.parse(chunk) as GhCheckRun[]);
      } catch (error) {
        throw new Error(`could not parse gh check-runs output: ${summarizeError(error)}`);
      }
      return runs.map(toCiJob);
    },
    fetchFailureLogs: async ({ repo, ref, prNumber, jobNames }): Promise<string> => {
      // Seed the fix-session with the ACTUAL failing logs, bounded: the
      // check-run id doubles as the Actions job id, whose log endpoint
      // (repos/{repo}/actions/jobs/{id}/logs) serves the raw text. Each log is
      // tailed (failures live at the end) and the job count is capped so the
      // brief stays a brief. Any per-job fetch failure degrades to an honest
      // pointer line for that job — never a fabricated log, never fatal.
      const target = prNumber !== undefined ? `PR #${prNumber}` : (ref ?? 'the ref');
      logger.info('ci-watch: composing failure brief', { repo, target, jobCount: jobNames.length });
      const header = [
        `CI failed for ${repo} (${target}).`,
        `Failing jobs: ${jobNames.join(', ') || 'unknown'}.`,
      ];
      try {
        const resolvedRef = await resolveRef(repo, ref, prNumber);
        const out = await runGh(
          ['api', `repos/${repo}/commits/${resolvedRef}/check-runs`, '--paginate', '--jq', '.check_runs'],
          timeoutMs,
        );
        const chunks = out.trim().split('\n').filter((line) => line.trim().length > 0);
        const runs = chunks.flatMap((chunk) => JSON.parse(chunk) as GhCheckRun[]);
        const wanted = new Set(jobNames);
        const failingRuns = runs.filter((run) => run.id !== undefined && run.name !== undefined && wanted.has(run.name));
        const sections: string[] = [];
        for (const run of failingRuns.slice(0, MAX_LOG_JOBS)) {
          try {
            const raw = await runGh(['api', `repos/${repo}/actions/jobs/${run.id}/logs`], timeoutMs);
            sections.push(`--- ${run.name} (log tail) ---\n${tailLog(raw)}`);
          } catch (error) {
            sections.push(`--- ${run.name}: log fetch failed (${summarizeError(error)}); expand with: gh run view --log-failed (in a clone of ${repo}) ---`);
          }
        }
        if (failingRuns.length > MAX_LOG_JOBS) {
          sections.push(`(+${failingRuns.length - MAX_LOG_JOBS} more failing jobs — logs omitted to keep the brief bounded)`);
        }
        if (sections.length > 0) return [...header, '', ...sections].join('\n');
      } catch (error) {
        logger.warn('ci-watch: failing-job log fetch failed; seeding the pointer brief instead', {
          repo, target, error: summarizeError(error),
        });
      }
      return [
        ...header,
        `Fetch full logs with: gh run view --log-failed (in a clone of ${repo}).`,
      ].join('\n');
    },
  };
}
