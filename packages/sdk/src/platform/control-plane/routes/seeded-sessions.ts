/**
 * routes/seeded-sessions.ts
 *
 * The ONE seeded-session recipe (an at-now, delete-after-run automation job
 * pinned to a fresh service session, returning the REAL attachable session id)
 * and its two producers: the CI fix session and the merge-conflict resolution
 * session. Split out of register-gateway-verb-groups.ts, which re-exports
 * startCiFixSession for compatibility.
 */
import { randomUUID } from 'node:crypto';
import type { AutomationManager } from '../../automation/index.js';
import type { FixSessionBrief, FixSessionStartOutcome } from '../../ci-watch/index.js';
import { summarizeError } from '../../utils/error-display.js';

/**
 * Start a one-shot fix-session pre-briefed with the failing CI jobs, and
 * return the REAL spawned session's id — the id session attach/resume
 * resolves. The automation job id ('auto-…') is a scheduling handle no
 * attach can resolve and must never be surfaced as the fix session; this is
 * pinned by test (job-id vs session-id confusion).
 *
 * Mechanics: the job is created DISABLED (the scheduler can never race a
 * second run) and executed immediately via runNow, whose returned run
 * carries the spawned ids. The job targets a pinned FRESH shared session
 * (never the operator's own preferred session), so the fix work lives in a
 * real attachable session with the spawned agent bound to it. A start that
 * produces no attachable session is an honest error outcome, never a dead id.
 */
export async function startCiFixSession(
  automation: Pick<AutomationManager, 'createJob' | 'runNow'>,
  brief: FixSessionBrief,
): Promise<FixSessionStartOutcome> {
  const target = brief.prNumber !== undefined ? `PR #${brief.prNumber}` : (brief.ref ?? 'the default branch');
  const prompt = [
    `CI failed for ${brief.repo} (${target}).`,
    `Failing jobs: ${brief.failingJobs.join(', ') || 'unknown'}.`,
    '',
    brief.logs,
    '',
    'Investigate the failing CI jobs and fix them.',
  ].join('\n');
  try {
    const job = await automation.createJob({
      name: `Fix CI: ${brief.repo}`,
      prompt,
      schedule: { kind: 'at', at: Date.now() },
      target: {
        kind: 'main',
        sessionId: `ci-fix-${randomUUID().slice(0, 10)}`,
        surfaceKind: 'service',
        createIfMissing: true,
      },
      enabled: false,
      deleteAfterRun: true,
    });
    const run = await automation.runNow(job.id);
    if (run.sessionId) return { sessionId: run.sessionId };
    return { error: `the fix run started without an attachable session (run ${run.id}, status ${run.status})` };
  } catch (error) {
    // Automation subsystem disabled, concurrency ceiling, or spawn failure —
    // the honest failure travels instead of a dead id.
    return { error: summarizeError(error) };
  }
}

/**
 * Start a merge-conflict resolution session INSIDE the kept worktree — the
 * same seeded-session machinery as startCiFixSession, seeded with the tree
 * path, item branch, and the STRUCTURED conflict list. Returns the REAL
 * session id plus the job id (the run-completion hook keys on it to
 * re-attempt the merge and reclaim the tree), or an honest error.
 */
export async function startConflictResolutionSession(
  automation: Pick<AutomationManager, 'createJob' | 'runNow'>,
  seed: {
    readonly workstreamId: string;
    readonly itemId: string;
    readonly title: string;
    readonly worktreePath: string;
    readonly branch: string | undefined;
    readonly files: readonly string[];
  },
): Promise<{ sessionId: string; jobId: string } | { error: string }> {
  const prompt = [
    `Merge conflict: "${seed.title}" could not merge into the base branch.`,
    `Kept worktree: ${seed.worktreePath}`,
    ...(seed.branch ? [`Item branch: ${seed.branch}`] : []),
    `Conflicting files:`,
    ...(seed.files.length > 0 ? seed.files.map((file) => `- ${file}`) : ['- (unknown — inspect the tree)']),
    '',
    `Work INSIDE the kept worktree at ${seed.worktreePath}. Resolve the conflicts against the base branch, keep both sides' intent, and commit the resolution onto the item branch. Do not delete the branch or the worktree — once your resolution lands, the merge is re-attempted and the tree is reclaimed automatically.`,
  ].join('\n');
  try {
    const job = await automation.createJob({
      name: `Resolve merge conflict: ${seed.title}`,
      prompt,
      schedule: { kind: 'at', at: Date.now() },
      target: {
        kind: 'main',
        sessionId: `conflict-fix-${randomUUID().slice(0, 10)}`,
        surfaceKind: 'service',
        createIfMissing: true,
      },
      enabled: false,
      deleteAfterRun: true,
    });
    const run = await automation.runNow(job.id);
    if (run.sessionId) return { sessionId: run.sessionId, jobId: job.id };
    return { error: `the resolution run started without an attachable session (run ${run.id}, status ${run.status})` };
  } catch (error) {
    return { error: summarizeError(error) };
  }
}
