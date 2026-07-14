/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * fix-workstream-runner.ts — drives ONE planned-fix cycle through the ONE
 * workstream engine and reports a structured outcome to the WRFC controller.
 *
 * This is what replaced the single-fixer prompt path: the review parses into
 * a dependency graph of typed tasks (review-task-source.ts), the engine runs
 * them elastically in isolated worktrees with reviewed-and-merged edge
 * release, and the outcome is STRUCTURED — merged, or a cycle / orphaned /
 * tasks-failed chain outcome — never a prompt an agent "may or may not follow
 * all the way through". Task-level green is telemetry: the CALLER (the
 * controller's terminal contract gate) decides completion by re-reviewing the
 * merged result against the ORIGINAL request.
 */
import type { ReviewerReport } from '../agents/completion-report.js';
import type { WrfcCommitScope } from '../agents/wrfc-config.js';
import type { OrchestrationEngine } from './engine.js';
import { planFixWorkstream, type SemanticEdgePlanner } from './review-task-source.js';
import type { OrchestrationEvent, Workstream } from './types.js';
import { logger } from '../utils/logger.js';

export type FixWorkstreamOutcome =
  | {
    readonly status: 'merged';
    readonly workstreamId: string;
    readonly taskCount: number;
    readonly mergedTitles: readonly string[];
    readonly filesModified: readonly string[];
  }
  | {
    readonly status: 'failed';
    readonly workstreamId?: string | undefined;
    readonly reason: string;
    /** The structured chain outcome class, when one applies. */
    readonly structured?: 'cycle' | 'orphaned' | 'tasks-failed' | 'nothing-to-fix' | 'timeout' | undefined;
  };

export interface FixWorkstreamRunner {
  run(input: {
    readonly chainId: string;
    readonly originalTask: string;
    readonly review: ReviewerReport;
    readonly attempt: number;
    readonly commitScope: WrfcCommitScope;
  }): Promise<FixWorkstreamOutcome>;
}

export interface FixWorkstreamRunnerDeps {
  readonly engine: Pick<OrchestrationEngine, 'createWorkstream' | 'start' | 'getWorkstream' | 'on'>;
  readonly semanticEdges?: SemanticEdgePlanner | undefined;
  /** Hard wall-clock bound on one cycle. Default 2 hours. */
  readonly timeoutMs?: number | undefined;
}

function isDone(workstream: Workstream): 'merged' | 'failed' | null {
  const items = workstream.items;
  if (items.length === 0) return 'failed';
  const allMerged = items.every(
    (item) => item.state === 'passed' && (workstream.isolation !== 'worktree' || item.mergeState === 'merged'),
  );
  if (allMerged) return 'merged';
  // Failed once nothing can move any more: no ready/running work remains and
  // at least one item is hard-failed or orphaned (the engine already consumed
  // its bounded retries).
  const anyLive = items.some(
    (item) => item.state === 'in-phase' || item.state === 'pending' || item.state === 'awaiting-capacity'
      || item.state === 'blocked-budget' || item.state === 'held-merge'
      || (item.state === 'passed' && workstream.isolation === 'worktree' && item.mergeState === 'pending'),
  );
  if (anyLive) return null;
  const anyFailed = items.some((item) => item.state === 'failed' || item.orphaned === true);
  return anyFailed ? 'failed' : null;
}

/** Compose the runner over the one engine. */
export function createFixWorkstreamRunner(deps: FixWorkstreamRunnerDeps): FixWorkstreamRunner {
  const timeoutMs = deps.timeoutMs ?? 2 * 60 * 60 * 1000;
  return {
    run(input) {
      const planned = planFixWorkstream({
        chainId: input.chainId,
        originalTask: input.originalTask,
        review: input.review,
        attempt: input.attempt,
        commitScope: input.commitScope,
        semanticEdges: deps.semanticEdges,
      });
      if (!planned) {
        // A failing review with zero parseable findings/constraints/checklist
        // misses cannot drive a fix cycle — surface that honestly.
        return Promise.resolve({
          status: 'failed',
          reason: 'the review failed but carried no parseable findings, unmet constraints, or unverified acceptance items',
          structured: 'nothing-to-fix',
        });
      }
      const workstream = deps.engine.createWorkstream(planned.workstream);
      return new Promise<FixWorkstreamOutcome>((resolve) => {
        let settled = false;
        let cycleSeen: readonly string[] | null = null;
        let orphanSeen: string | null = null;
        const finish = (outcome: FixWorkstreamOutcome): void => {
          if (settled) return;
          settled = true;
          off();
          clearTimeout(wall);
          resolve(outcome);
        };
        const evaluate = (): void => {
          const live = deps.engine.getWorkstream(workstream.id);
          if (!live) return;
          // Structured outcomes surface IMMEDIATELY — a cycle or an orphaned
          // task fails the cycle the moment it is known, never a silent stall.
          if (cycleSeen) {
            finish({ status: 'failed', workstreamId: workstream.id, structured: 'cycle', reason: `dependency cycle: ${cycleSeen.join(' -> ')}` });
            return;
          }
          if (orphanSeen) {
            finish({ status: 'failed', workstreamId: workstream.id, structured: 'orphaned', reason: orphanSeen });
            return;
          }
          const done = isDone(live);
          if (done === 'merged') {
            finish({
              status: 'merged',
              workstreamId: workstream.id,
              taskCount: live.items.length,
              mergedTitles: live.items.map((item) => item.title),
              filesModified: [...new Set(live.items.flatMap((item) => [...(item.files ?? []), ...item.touchedPaths]))],
            });
          } else if (done === 'failed') {
            const failures = live.items
              .filter((item) => item.state === 'failed' || item.orphaned === true)
              .map((item) => `${item.title}: ${item.failureReason ?? item.blockedReason ?? 'failed'}`);
            finish({ status: 'failed', workstreamId: workstream.id, structured: 'tasks-failed', reason: failures.join('; ') || 'fix tasks failed' });
          }
        };
        const off = deps.engine.on((event: OrchestrationEvent) => {
          if (!('workstreamId' in event) || event.workstreamId !== workstream.id) return;
          if (event.type === 'graph-cycle') cycleSeen = event.cycle;
          if (event.type === 'item-orphaned') orphanSeen = event.reason;
          evaluate();
        });
        const wall = setTimeout(() => {
          logger.warn('[fix-workstream] cycle timed out', { workstreamId: workstream.id });
          finish({ status: 'failed', workstreamId: workstream.id, structured: 'timeout', reason: `fix cycle exceeded ${Math.round(timeoutMs / 60_000)} minutes` });
        }, timeoutMs);
        wall.unref?.();
        deps.engine.start(workstream.id);
        evaluate(); // a zero-task or instantly-terminal workstream settles immediately
      });
    },
  };
}
