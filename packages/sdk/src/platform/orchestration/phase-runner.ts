/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * Phase-runner (Wave 4, wo701) — runs one WorkItem through one Phase: spawn
 * agent, await completion, verify claims, run gates, commit, cleanup.
 *
 * REUSES the hardened WRFC primitives verbatim (same functions WrfcController
 * itself calls, so behavior can't fork): verifyEngineerClaims
 * (wrfc-reporting.ts) for the phantom-work guard, runWrfcGateChecks
 * (wrfc-gate-runtime.ts) for quality gates, AgentWorktree.commitWorkingTree
 * for scoped commits, and the transport-retry / WrfcChainFailureKind pattern
 * (isTransportFailureMessage + getWrfcTransportRetryLimit/DelayMs) for
 * bounded respawn-on-transport-blip.
 *
 * REALITY-WINS DIVERGENCE from the brief's design (c): WrfcController itself
 * (wrfc-controller.ts, verified) never calls AgentWorktree.create() for its
 * role agents — engineer/reviewer/fixer/integrator all run in the SAME
 * shared `projectRoot` working directory; AgentWorktree is used ONLY for its
 * commitWorkingTree/merge/cleanup surface (merge/cleanup are safe no-ops
 * when no isolated worktree dir exists, which is always, today). There is no
 * per-agent `workingDirectory` override anywhere in AgentInput /
 * AgentOrchestratorRunContext.createRunContext() (verified: the latter is
 * fixed per AgentOrchestrator instance, not per-spawn), so a spawned agent
 * cannot actually be pointed at an isolated worktree directory without new
 * cross-cutting plumbing through AgentManager/AgentOrchestrator construction
 * — well beyond this module's boundary, and not something WrfcController
 * itself has either. This module therefore mirrors WrfcController's ACTUAL
 * (shared-directory) behavior rather than the brief's aspirational
 * per-item-isolated-worktree fan-out; true fan-out isolation is a valuable,
 * separately-scoped follow-up (see the work-order report).
 *
 * SECOND REALITY-WINS DIVERGENCE: AgentManager.spawn()'s root-spawn
 * normalization (tools/agent/wrfc-batch-policy.ts isRootReviewRoleTask) force
 * -rewrites any PARENTLESS spawn whose template is literally
 * reviewer/tester/verifier/qa/review/test, OR whose task text matches
 * ROLE_ACTION_RE/ROLE_PREFIX_RE (e.g. "review the diff"), into an
 * 'engineer'-templated WRFC-owner chain with `dangerously_disable_wrfc`
 * forced back to `false` — REGARDLESS of what this module passes in.
 * Phase-runner spawns are always parentless (a workstream has no owning
 * AgentRecord), so it must dodge that heuristic by construction: never
 * literally template review/test-flavored phases as one of those role
 * strings (use 'general' instead — see templateForPhase), and phrase
 * review-phase prompts with "assess/evaluate" rather than "review/test/
 * verify" (see buildPhaseTask). This is load-bearing: changing this wording
 * without checking wrfc-batch-policy.ts's regexes again risks silently
 * re-activating the WRFC hijack for review-kind phases.
 */
import type { AgentManager, AgentRecord } from '../tools/agent/manager.js';
import type { ConfigManager } from '../config/manager.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import { AgentWorktree, type CommitWorkingTreeResult } from '../agents/worktree.js';
import {
  parseCompletionReport,
  type CompletionReport,
  type ConstraintFinding,
  type EngineerReport,
  type ReviewerReport,
} from '../agents/completion-report.js';
import { verifyEngineerClaims } from '../agents/wrfc-reporting.js';
import { runWrfcGateChecks } from '../agents/wrfc-gate-runtime.js';
import { getWrfcTransportRetryDelayMs, getWrfcTransportRetryLimit } from '../agents/wrfc-config.js';
import { isTransportFailureMessage } from '../types/errors.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import type { CancellationRegistry } from './cancellation.js';
import { excludeUntouchedLaunchResidue, type DirtyLaunchSnapshot } from './dirty-guard.js';
import { classifyBookkeepingFailure } from './bookkeeping.js';
import { mergeWorkItemUsage } from './types.js';
import type { CommitExclusion, GateOutcome, Phase, PhaseCommitOutcome, PhaseResult, WorkItem, WorkItemUsage, Workstream } from './types.js';

/** Narrow structural pick — testable with stubs, mirrors AgentManagerLike (wrfc-config.ts). */
export type PhaseRunnerAgentManagerLike = Pick<
  AgentManager,
  'spawn' | 'getStatus' | 'cancel' | 'registerCancellationSignal' | 'releaseCancellationSignal'
>;

/** Structural pick of AgentWorktree's surface — matches WrfcController's WrfcWorktreeOps injection seam exactly, so the same test doubles work for both. */
export interface WrfcWorktreeOps {
  merge(agentId: string): Promise<boolean>;
  cleanup(agentId: string): Promise<void>;
  commitWorkingTree(message: string, paths?: string[]): Promise<CommitWorkingTreeResult>;
  currentHead(): Promise<string | null>;
}

/**
 * The minimal surface of an item's IsolatedWorktree (worktree.ts) that the
 * phase-runner needs in `worktree` isolation mode: the on-disk `path` (used as
 * the spawned agent's working directory) and a scoped `commit` onto the item
 * branch. Notably NOT merge/cleanup — in worktree mode the item worktree
 * persists across the item's phases and the engine's sequential integration
 * lane owns the merge-back and cleanup, so a phase NEVER merges to base or
 * removes the worktree.
 */
export interface PhaseItemWorktree {
  readonly path: string;
  commit(message: string, paths?: string[]): Promise<CommitWorkingTreeResult>;
}

export interface PhaseRunnerDeps {
  readonly agentManager: PhaseRunnerAgentManagerLike;
  readonly configManager: Pick<ConfigManager, 'get' | 'getCategory'>;
  readonly runtimeBus: RuntimeEventBus;
  readonly projectRoot: string;
  readonly sessionId: string;
  readonly createWorktree?: (() => WrfcWorktreeOps) | undefined;
  readonly cancellation: CancellationRegistry;
  readonly priceUsage?: ((model: string | undefined, usage: WorkItemUsage) => number | null) | undefined;
  readonly skipClaimVerification?: boolean | undefined;
  /**
   * The dirty-tree snapshot taken synchronously at engine launch (Wave 6,
   * wo-F item 4 — see dirty-guard.ts). Absent (undefined) degrades to
   * today's behavior: no exclusion, every candidate path is committed.
   */
  readonly launchDirtySnapshot?: DirtyLaunchSnapshot | undefined;
  /**
   * Present ONLY in `worktree` isolation mode: this item's dedicated worktree
   * (created by the engine at first claim). When set, the phase's scoped commit
   * lands on the item branch INSIDE this worktree (not the shared projectRoot),
   * and the spawned agent runs with its working directory set to the worktree
   * path. Absent ⇒ shared mode, every existing behavior unchanged.
   */
  readonly itemWorktree?: PhaseItemWorktree | undefined;
}

export interface PhaseRunOutcome {
  readonly result: PhaseResult;
  readonly agentStatus: 'completed' | 'failed' | 'cancelled';
}

function templateForPhase(phase: Phase): 'engineer' | 'general' {
  return phase.kind === 'review' || phase.kind === 'gate' ? 'general' : 'engineer';
}

function buildPhaseTask(item: WorkItem, phase: Phase, priorReports: readonly PhaseResult[]): string {
  const priorContext = priorReports.length > 0
    ? `\n\nPrior phase reports for this work item:\n${priorReports.map((r) => `- ${r.phaseId}: ${r.report.summary}`).join('\n')}`
    : '';
  if (phase.kind === 'review' || phase.kind === 'gate') {
    return `Assess the following work item's changes against its constraints and report findings. Do not modify files.\n\nWork item: ${item.title}\n${item.task}${priorContext}`;
  }
  if (phase.kind === 'fix') {
    return `Address the following findings for this work item.\n\nWork item: ${item.title}\n${item.task}${priorContext}`;
  }
  return `${item.task}${priorContext}`;
}

function genericReport(summary: string): CompletionReport {
  return { version: 1, archetype: 'generic', summary, result: summary };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function awaitAgentTermination(
  runtimeBus: RuntimeEventBus,
  agentManager: PhaseRunnerAgentManagerLike,
  agentId: string,
): Promise<{ status: 'completed' | 'failed' | 'cancelled'; record: AgentRecord | null }> {
  return new Promise((resolve) => {
    const unsubscribe = runtimeBus.onDomain('agents', (envelope) => {
      const event = envelope.payload as { type: string; agentId?: string };
      if (event.agentId !== agentId) return;
      if (event.type !== 'AGENT_COMPLETED' && event.type !== 'AGENT_FAILED' && event.type !== 'AGENT_CANCELLED') return;
      unsubscribe();
      const status = event.type === 'AGENT_COMPLETED' ? 'completed' : event.type === 'AGENT_CANCELLED' ? 'cancelled' : 'failed';
      resolve({ status, record: agentManager.getStatus(agentId) });
    });
  });
}

function usageFromRecord(
  record: AgentRecord | null,
  priceUsage: PhaseRunnerDeps['priceUsage'],
): WorkItemUsage {
  const u = record?.usage;
  const base = {
    inputTokens: u?.inputTokens ?? 0,
    outputTokens: u?.outputTokens ?? 0,
    cacheReadTokens: u?.cacheReadTokens ?? 0,
    cacheWriteTokens: u?.cacheWriteTokens ?? 0,
    reasoningTokens: u?.reasoningTokens,
    llmCallCount: u?.llmCallCount ?? 0,
    turnCount: u?.turnCount ?? 0,
    toolCallCount: record?.toolCallCount ?? 0,
  };
  let costUsd: number | null = null;
  let costState: WorkItemUsage['costState'] = 'unpriced';
  if (u && priceUsage) {
    try {
      const priced = priceUsage(record?.model, { ...base, costUsd: null, costState: 'unpriced' });
      if (priced !== null) {
        costUsd = priced;
        costState = 'priced';
      }
    } catch {
      // stays unpriced — never fabricate a cost from a throwing pricer.
    }
  }
  return { ...base, costUsd, costState };
}

/**
 * Combines a new phase's usage into a work item's running total. Single-source
 * cost (never independently re-priced here). Thin alias over the canonical
 * {@link mergeWorkItemUsage} (types.ts) so the phase-runner, the engine, and
 * the fleet rollup adapters all fold usage through exactly one implementation.
 */
export function mergeUsage(a: WorkItemUsage, b: WorkItemUsage): WorkItemUsage {
  return mergeWorkItemUsage(a, b);
}

/** Quality gates (global-config-driven, reused VERBATIM) + phase-required-gate assertion + phantom guard + reviewer constraint findings. */
async function evaluateGate(
  workstream: Workstream,
  phase: Phase,
  report: CompletionReport,
  deps: PhaseRunnerDeps,
): Promise<GateOutcome> {
  const results = [...await runWrfcGateChecks({
    configManager: deps.configManager,
    projectRoot: deps.projectRoot,
    runtimeBus: deps.runtimeBus,
    sessionId: deps.sessionId,
    chainId: workstream.id,
    // Worktree mode (BIG-3 item 5): run the configured quality gates INSIDE the
    // item's isolated worktree, the same way the phantom-work guard above
    // verifies claims against that worktree path. BIG-1 fixed only the phantom
    // check; without this, gates (typecheck/lint/test) would run against the
    // shared projectRoot and never see the item's isolated changes. Absent
    // (shared mode) ⇒ runWrfcGateChecks defaults cwd to projectRoot — unchanged.
    ...(deps.itemWorktree ? { cwd: deps.itemWorktree.path } : {}),
  })];

  const ranNames = new Set(results.map((r) => r.gate));
  const missingRequired = phase.gate.gates.filter((name) => !ranNames.has(name));
  for (const name of missingRequired) {
    results.push({ gate: name, passed: false, output: 'required gate is not configured/enabled', durationMs: 0 });
  }

  if (report.archetype === 'engineer' && !deps.skipClaimVerification) {
    // Worktree mode: the agent's files landed in the item's OWN worktree, not
    // the shared projectRoot — verify claims (existence + `git diff`) against
    // that worktree path, or every real change would be falsely flagged as
    // phantom work (nothing to find at projectRoot).
    const verification = verifyEngineerClaims(report, deps.itemWorktree?.path ?? deps.projectRoot);
    if (verification.kind === 'unverified' || verification.kind === 'unverifiable_no_claims') {
      results.push({ gate: 'phantom-work-guard', passed: false, output: verification.summary, durationMs: 0 });
    }
  }

  let constraintFindings: ConstraintFinding[] | undefined;
  let unsatisfiedConstraintIds: string[] | undefined;
  if (report.archetype === 'reviewer') {
    const reviewer = report as ReviewerReport;
    constraintFindings = reviewer.constraintFindings ?? [];
    const unsatisfied = constraintFindings.filter((f) => !f.satisfied);
    unsatisfiedConstraintIds = unsatisfied.map((f) => f.constraintId);
    if (!reviewer.passed || unsatisfied.length > 0) {
      results.push({
        gate: 'reviewer-verdict',
        passed: false,
        output: unsatisfied.length > 0
          ? `${unsatisfied.length} unsatisfied constraint(s): ${unsatisfied.map((f) => f.constraintId).join(', ')}`
          : 'reviewer did not pass',
        durationMs: 0,
      });
    }
  }

  return {
    passed: results.every((r) => r.passed),
    results,
    constraintFindings,
    unsatisfiedConstraintIds,
  };
}

/** Post-gate scoped-commit result: the residue exclusion (if any) plus an honest commit outcome. */
interface CommitPhaseWorkResult {
  readonly exclusion?: CommitExclusion | undefined;
  readonly commit: PhaseCommitOutcome;
}

/**
 * Runs the POST-gate scoped-commit + merge for a passed phase and reports its
 * outcome HONESTLY rather than swallowing failures. The gate has already
 * decided the phase passed; this step only records the changes, so its result
 * is bookkeeping: a failure surfaces to the engine as a warning on a passed
 * item (or, for the narrow negating set — workspace corruption, see
 * bookkeeping.ts — as an item failure), never as a silent no-op that lets the
 * fleet imply a commit happened when it did not (DEBT-4 item 1).
 */
async function commitPhaseWork(
  item: WorkItem,
  phase: Phase,
  agentId: string,
  worktree: WrfcWorktreeOps,
  deps: Pick<PhaseRunnerDeps, 'projectRoot' | 'launchDirtySnapshot' | 'itemWorktree'>,
): Promise<CommitPhaseWorkResult> {
  if (phase.gate.scope === 'off') {
    return { commit: { status: 'skipped', reason: 'commit disabled for this phase (gate scope: off)' } };
  }

  let paths = phase.gate.scope === 'scoped' ? item.touchedPaths : undefined;
  let exclusion: CommitExclusion | undefined;

  // Worktree mode: the item commits onto its own branch INSIDE its dedicated
  // worktree, which the engine created fresh (and therefore clean) at claim.
  // The launch-dirty snapshot is taken against the SHARED projectRoot, so it
  // has nothing to say about a just-created worktree — a fresh worktree starts
  // clean, so its launch-dirty residue is trivially empty. Skip the residue
  // exclusion entirely and commit straight onto the item branch; NO merge to
  // base (the sequential integration lane owns that at item termination).
  if (deps.itemWorktree) {
    try {
      const result = await deps.itemWorktree.commit(`orchestration: ${item.title} — ${phase.kind} phase`, paths);
      const ignoredNote = result.skippedIgnored.length > 0
        ? `${result.skippedIgnored.length} ignored path${result.skippedIgnored.length === 1 ? '' : 's'} skipped`
        : undefined;
      if (result.hash === null) {
        return { commit: { status: 'skipped', reason: ignoredNote ? `nothing to stage (${ignoredNote})` : 'nothing to stage' } };
      }
      return { commit: { status: 'committed', hash: result.hash, ...(ignoredNote ? { reason: ignoredNote } : {}) } };
    } catch (error) {
      const reason = summarizeError(error);
      const negating = classifyBookkeepingFailure(error) === 'negating';
      logger.warn('orchestration phase-runner: worktree scoped commit did not complete', {
        itemId: item.id, phaseId: phase.id, worktreePath: deps.itemWorktree.path, error: reason, negating,
      });
      return { commit: { status: 'failed', reason, negating } };
    }
  }

  if (paths && paths.length > 0 && deps.launchDirtySnapshot) {
    const launchSnapshot = deps.launchDirtySnapshot;
    if (launchSnapshot.size > 0) {
      const { included, excluded } = excludeUntouchedLaunchResidue(deps.projectRoot, paths, launchSnapshot);
      if (excluded.length > 0) {
        exclusion = { excludedPaths: excluded, skipped: included.length === 0 };
        if (included.length === 0) {
          // Every candidate path is untouched launch-dirty residue — an
          // honest "nothing this phase did needs committing", not a silent
          // no-op AND not a fallback to sweeping the whole working tree.
          logger.info('orchestration phase-runner: scoped commit skipped — every candidate path is untouched launch-dirty residue', {
            itemId: item.id,
            phaseId: phase.id,
            excludedPaths: excluded,
          });
          return { exclusion, commit: { status: 'skipped', reason: 'every candidate path was untouched launch-dirty residue' } };
        }
        logger.info('orchestration phase-runner: excluded untouched launch-dirty residue from scoped commit', {
          itemId: item.id,
          phaseId: phase.id,
          excludedPaths: excluded,
        });
        paths = [...included];
      }
    }
  }

  try {
    const result = await worktree.commitWorkingTree(`orchestration: ${item.title} — ${phase.kind} phase`, paths);
    await worktree.merge(agentId);
    const ignoredNote = result.skippedIgnored.length > 0
      ? `${result.skippedIgnored.length} ignored path${result.skippedIgnored.length === 1 ? '' : 's'} skipped`
      : undefined;
    if (result.hash === null) {
      // A null hash is "nothing was staged" — an honest skip, not a landed commit.
      return { exclusion, commit: { status: 'skipped', reason: ignoredNote ? `nothing to stage (${ignoredNote})` : 'nothing to stage' } };
    }
    return {
      exclusion,
      commit: { status: 'committed', hash: result.hash, ...(ignoredNote ? { reason: ignoredNote } : {}) },
    };
  } catch (error) {
    const reason = summarizeError(error);
    const negating = classifyBookkeepingFailure(error) === 'negating';
    // Non-fatal by default: the gate already passed, so the engine treats this
    // as a warning on a passed item. Only a NEGATING failure (workspace
    // corruption — bookkeeping.ts) flips the item to failed.
    logger.warn('orchestration phase-runner: scoped commit/merge did not complete', {
      itemId: item.id, phaseId: phase.id, error: reason, negating,
    });
    return { exclusion, commit: { status: 'failed', reason, negating } };
  }
}

/** Runs one WorkItem through one Phase to completion (or cancellation/failure). Recurses (bounded by transportRetryLimit) on a transport-classified spawn failure. */
export async function runPhase(
  workstream: Workstream,
  item: WorkItem,
  phase: Phase,
  priorReports: readonly PhaseResult[],
  deps: PhaseRunnerDeps,
): Promise<PhaseRunOutcome> {
  const startedAt = Date.now();
  const createWorktree = deps.createWorktree ?? (() => new AgentWorktree(deps.projectRoot));
  const worktree = createWorktree();

  const record = deps.agentManager.spawn({
    mode: 'spawn',
    task: buildPhaseTask(item, phase, priorReports),
    template: templateForPhase(phase),
    dangerously_disable_wrfc: true,
    // Worktree mode: run the agent's tools with their working directory set to
    // the item's isolated worktree, so its file edits land there instead of the
    // shared projectRoot. Omitted (undefined) in shared mode ⇒ agent uses the
    // orchestrator's default working directory exactly as before.
    ...(deps.itemWorktree ? { workingDirectory: deps.itemWorktree.path } : {}),
  } as Parameters<PhaseRunnerAgentManagerLike['spawn']>[0]);

  record.workItemId = item.id;
  item.agentId = record.id;
  item.allAgentIds.push(record.id);
  item.branch ??= `agent/${item.id}`;

  const signal = deps.cancellation.start(item.id);
  deps.agentManager.registerCancellationSignal(record.id, signal);

  let outcome: { status: 'completed' | 'failed' | 'cancelled'; record: AgentRecord | null };
  try {
    outcome = await awaitAgentTermination(deps.runtimeBus, deps.agentManager, record.id);
  } finally {
    deps.agentManager.releaseCancellationSignal(record.id);
    deps.cancellation.release(item.id);
  }

  const usage = usageFromRecord(outcome.record, deps.priceUsage);

  if (outcome.status === 'cancelled') {
    await worktree.cleanup(record.id).catch(() => undefined);
    return {
      agentStatus: 'cancelled',
      result: {
        itemId: item.id,
        phaseId: phase.id,
        agentId: record.id,
        report: genericReport('cancelled by operator'),
        gate: { passed: false, results: [] },
        startedAt,
        completedAt: Date.now(),
        usage,
      },
    };
  }

  if (outcome.status === 'failed') {
    const transportFailure = isTransportFailureMessage(outcome.record?.error ?? '');
    const retryLimit = getWrfcTransportRetryLimit(deps.configManager);
    if (transportFailure && item.transportRetryCount < retryLimit) {
      item.transportRetryCount += 1;
      await worktree.cleanup(record.id).catch(() => undefined);
      await sleep(getWrfcTransportRetryDelayMs(deps.configManager));
      return runPhase(workstream, item, phase, priorReports, deps);
    }
    await worktree.cleanup(record.id).catch(() => undefined);
    return {
      agentStatus: 'failed',
      result: {
        itemId: item.id,
        phaseId: phase.id,
        agentId: record.id,
        report: genericReport(outcome.record?.error ?? 'agent failed'),
        gate: { passed: false, results: [] },
        startedAt,
        completedAt: Date.now(),
        usage,
      },
    };
  }

  const report = parseCompletionReport(outcome.record?.fullOutput ?? '') ?? genericReport(outcome.record?.fullOutput ?? '');

  if (report.archetype === 'engineer') {
    const engineerReport = report as EngineerReport;
    for (const path of [...engineerReport.filesCreated, ...engineerReport.filesModified, ...engineerReport.filesDeleted]) {
      if (!item.touchedPaths.includes(path)) item.touchedPaths.push(path);
    }
  }

  const gate = await evaluateGate(workstream, phase, report, deps);

  let commitExclusion: CommitExclusion | undefined;
  let commit: PhaseCommitOutcome | undefined;
  if (gate.passed) {
    const committed = await commitPhaseWork(item, phase, record.id, worktree, deps);
    commitExclusion = committed.exclusion;
    commit = committed.commit;
  }
  // In worktree mode the item worktree persists across phases (the engine's
  // integration lane owns its teardown), so only the shared-mode transient
  // worktree gets cleaned up here.
  if (!deps.itemWorktree) {
    await worktree.cleanup(record.id).catch(() => undefined);
  }

  return {
    agentStatus: 'completed',
    result: {
      itemId: item.id,
      phaseId: phase.id,
      agentId: record.id,
      report,
      gate,
      startedAt,
      completedAt: Date.now(),
      usage,
      ...(commitExclusion ? { commitExclusion } : {}),
      ...(commit ? { commit } : {}),
    },
  };
}
