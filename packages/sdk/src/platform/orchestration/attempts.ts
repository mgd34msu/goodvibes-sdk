/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * attempts.ts — best-of-N sibling attempts for the orchestration engine.
 *
 * A work item declared with `attempts: N` is expanded into N sibling items that
 * run the SAME pipeline INDEPENDENTLY, each in its own isolated worktree. When a
 * sibling passes, the engine does NOT auto-merge it: it parks the sibling in the
 * 'held-merge' state (worktree kept, diff inspectable) and, once EVERY sibling in
 * the group is terminal, exposes the group's candidates for a winner pick. A
 * winner is accepted explicitly (fleet.attempts.pick) — or PROPOSED by an
 * optional judge model (fleet.attempts.judge), which only auto-picks when the
 * source item opted into `autoAcceptWinner`. Picking merges the winner's branch
 * through the existing sequential integration lane and cleans the losers'
 * worktrees.
 *
 * This coordinator owns the group registry and the pick/judge orchestration; the
 * engine keeps only thin hooks (expand at create, hold-vs-merge at terminal-pass,
 * a readiness nudge at terminal-fail) and delegates its public best-of-N methods
 * here, so engine.ts stays small.
 */
import {
  MAX_ATTEMPTS,
  type AttemptCandidate,
  type AttemptJudge,
  type AttemptJudgment,
  type AttemptPickResult,
  type HeldMergeGroup,
  type OrchestrationEvent,
  type WorkItem,
  type WorkItemSpec,
  type Workstream,
  type WorkstreamIsolation,
} from './types.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

/** Thrown for an honest caller error against the best-of-N surface (unknown group, not-ready, bad winner). */
export class AttemptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttemptError';
  }
}

export interface AttemptsCoordinatorDeps {
  readonly emit: (event: OrchestrationEvent) => void;
  readonly getWorkstream: (id: string) => Workstream | null;
  /** Route a (non-attempt terminal-passed item, or a picked winner) onto the sequential integration lane. */
  readonly enqueueIntegration: (workstream: Workstream, item: WorkItem) => void;
  /** Remove a loser's worktree (clean → removed; dirty → kept — the existing cleanup rule). Never throws. */
  readonly cleanupWorktree: (workstream: Workstream, item: WorkItem) => Promise<void>;
  /** The diff a candidate's worktree branch introduced over base, or null if it has no live worktree. */
  readonly diffItem: (item: WorkItem) => Promise<{ files: string[]; unifiedDiff: string; stat: string } | null>;
  /** Optional model judge. Absent → fleet.attempts.judge honestly reports no judge is configured. */
  readonly judge?: AttemptJudge | undefined;
}

export interface AttemptsCoordinator {
  /** Expand any `attempts:N` spec into N sibling items (worktree isolation only); pass others through unchanged. */
  expandItems(
    workstreamId: string,
    isolation: WorkstreamIsolation | undefined,
    specs: readonly WorkItemSpec[],
    build: (spec: WorkItemSpec) => WorkItem,
  ): WorkItem[];
  /** Rebuild the in-memory group registry from an imported workstream's items (resume path). */
  reconcileGroups(workstream: Workstream): void;
  /** At an item's terminal PASS: hold it as a best-of-N candidate, or (non-attempt) enqueue its integration. */
  onItemPassedTerminal(workstream: Workstream, item: WorkItem): void;
  /** At an attempt sibling's terminal FAIL: re-check whether its group is now fully resolved. No-op for non-attempt items. */
  onItemFailedTerminal(workstream: Workstream, item: WorkItem): void;
  /** The held-merge groups (optionally filtered by workstream), each with its candidates' diffs. */
  listGroups(workstreamId?: string): Promise<HeldMergeGroup[]>;
  /** Accept a winner: merge it through the integration lane, clean the losers. */
  pickWinner(groupId: string, winnerItemId: string): Promise<AttemptPickResult>;
  /** Run the judge over a group's candidates and PROPOSE a winner (never auto-picks here). */
  proposeWinner(groupId: string): Promise<AttemptJudgment>;
}

interface GroupEntry {
  workstreamId: string;
  readonly sourceTitle: string;
  readonly sourceTask: string;
  readonly siblingItemIds: string[];
  readonly autoAccept: boolean;
  judgment: AttemptJudgment | null;
  readyEmitted: boolean;
}

function clampAttempts(n: number | undefined): number {
  if (!n || !Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), MAX_ATTEMPTS);
}

function siblingId(spec: WorkItemSpec, index: number): string {
  return spec.id ? `${spec.id}#a${index}` : `item-${crypto.randomUUID().slice(0, 8)}`;
}

export function createAttemptsCoordinator(deps: AttemptsCoordinatorDeps): AttemptsCoordinator {
  const groups = new Map<string, GroupEntry>();

  function siblingsOf(workstream: Workstream, entry: GroupEntry): WorkItem[] {
    return entry.siblingItemIds
      .map((id) => workstream.items.find((i) => i.id === id))
      .filter((i): i is WorkItem => i !== undefined);
  }

  function allTerminal(siblings: readonly WorkItem[]): boolean {
    return siblings.length > 0 && siblings.every((s) => s.state === 'held-merge' || s.state === 'failed');
  }

  function expandItems(
    workstreamId: string,
    isolation: WorkstreamIsolation | undefined,
    specs: readonly WorkItemSpec[],
    build: (spec: WorkItemSpec) => WorkItem,
  ): WorkItem[] {
    const items: WorkItem[] = [];
    for (const spec of specs) {
      const n = clampAttempts(spec.attempts);
      // Attempts need isolated worktrees to compare; under shared isolation (or
      // n<=1) this is an ordinary single item.
      if (n <= 1 || isolation !== 'worktree') {
        const item = build(spec);
        if (spec.budget) item.itemBudget = spec.budget;
        items.push(item);
        continue;
      }
      const groupId = `boN-${crypto.randomUUID().slice(0, 8)}`;
      const siblingIds: string[] = [];
      for (let i = 0; i < n; i++) {
        const sib = build({ ...spec, id: siblingId(spec, i), title: `${spec.title} (attempt ${i + 1}/${n})` });
        sib.attemptGroupId = groupId;
        sib.attemptIndex = i;
        sib.attemptTotal = n;
        if (spec.autoAcceptWinner) sib.autoAcceptWinner = true;
        if (spec.budget) sib.itemBudget = spec.budget;
        siblingIds.push(sib.id);
        items.push(sib);
      }
      groups.set(groupId, {
        workstreamId,
        sourceTitle: spec.title,
        sourceTask: spec.task,
        siblingItemIds: siblingIds,
        autoAccept: !!spec.autoAcceptWinner,
        judgment: null,
        readyEmitted: false,
      });
      deps.emit({ type: 'item-attempts-spawned', workstreamId, groupId, itemIds: [...siblingIds], attempts: n });
    }
    return items;
  }

  function reconcileGroups(workstream: Workstream): void {
    const byGroup = new Map<string, WorkItem[]>();
    for (const item of workstream.items) {
      if (!item.attemptGroupId) continue;
      (byGroup.get(item.attemptGroupId) ?? byGroup.set(item.attemptGroupId, []).get(item.attemptGroupId)!).push(item);
    }
    for (const [groupId, siblings] of byGroup) {
      if (groups.has(groupId)) continue;
      const source = siblings[0]!;
      groups.set(groupId, {
        workstreamId: workstream.id,
        sourceTitle: source.title,
        sourceTask: source.task,
        siblingItemIds: siblings.map((s) => s.id),
        autoAccept: !!source.autoAcceptWinner,
        judgment: null,
        // If every sibling is already terminal in the snapshot, treat readiness
        // as already announced (don't re-emit on resume).
        readyEmitted: allTerminal(siblings),
      });
    }
  }

  function maybeReady(workstream: Workstream, groupId: string): void {
    const entry = groups.get(groupId);
    if (!entry) return;
    const siblings = siblingsOf(workstream, entry);
    if (!allTerminal(siblings) || entry.readyEmitted) return;
    entry.readyEmitted = true;
    const candidateItemIds = siblings.filter((s) => s.state === 'held-merge').map((s) => s.id);
    deps.emit({ type: 'attempts-ready', workstreamId: workstream.id, groupId, candidateItemIds });
    if (entry.autoAccept && deps.judge) {
      void autoJudgeAndPick(groupId).catch((error) => {
        logger.warn('attempts: auto judge-and-pick did not complete', { groupId, error: summarizeError(error) });
      });
    }
  }

  function onItemPassedTerminal(workstream: Workstream, item: WorkItem): void {
    if (!item.attemptGroupId) {
      deps.enqueueIntegration(workstream, item);
      return;
    }
    // A best-of-N attempt passed: PARK it (do not merge). Its worktree stays put
    // so its diff can be compared; the winner is chosen later.
    item.state = 'held-merge';
    deps.emit({ type: 'item-attempt-held', workstreamId: workstream.id, groupId: item.attemptGroupId, itemId: item.id });
    maybeReady(workstream, item.attemptGroupId);
  }

  function onItemFailedTerminal(workstream: Workstream, item: WorkItem): void {
    if (!item.attemptGroupId) return;
    maybeReady(workstream, item.attemptGroupId);
  }

  async function buildCandidate(item: WorkItem): Promise<AttemptCandidate> {
    const state = item.state === 'failed' ? 'failed' : 'held-merge';
    return {
      itemId: item.id,
      attemptIndex: item.attemptIndex ?? 0,
      state,
      title: item.title,
      worktreePath: item.worktreePath ?? null,
      branch: item.worktreeBranch ?? null,
      usage: item.usage,
      failureReason: item.failureReason ?? null,
      diff: state === 'held-merge' ? await deps.diffItem(item) : null,
    };
  }

  async function listGroups(workstreamId?: string): Promise<HeldMergeGroup[]> {
    const result: HeldMergeGroup[] = [];
    for (const [groupId, entry] of groups) {
      if (workstreamId && entry.workstreamId !== workstreamId) continue;
      const workstream = deps.getWorkstream(entry.workstreamId);
      if (!workstream) continue;
      const siblings = siblingsOf(workstream, entry);
      const candidates = await Promise.all(siblings.map(buildCandidate));
      result.push({
        groupId,
        workstreamId: entry.workstreamId,
        sourceTitle: entry.sourceTitle,
        ready: allTerminal(siblings),
        candidates,
        autoAccept: entry.autoAccept,
        judgment: entry.judgment,
      });
    }
    return result;
  }

  function resolveReadyGroup(groupId: string): { workstream: Workstream; entry: GroupEntry; siblings: WorkItem[] } {
    const entry = groups.get(groupId);
    if (!entry) throw new AttemptError(`unknown or already-resolved best-of-N group: ${groupId}`);
    const workstream = deps.getWorkstream(entry.workstreamId);
    if (!workstream) throw new AttemptError(`best-of-N group ${groupId} references a workstream that no longer exists`);
    return { workstream, entry, siblings: siblingsOf(workstream, entry) };
  }

  async function pick(groupId: string, winnerItemId: string, auto: boolean): Promise<AttemptPickResult> {
    const { workstream, entry, siblings } = resolveReadyGroup(groupId);
    if (!allTerminal(siblings)) {
      throw new AttemptError(`best-of-N group ${groupId} is not ready: some attempts are still running`);
    }
    const winner = siblings.find((s) => s.id === winnerItemId);
    if (!winner || winner.state !== 'held-merge') {
      throw new AttemptError(`winner must be a held (passed) candidate of group ${groupId}: ${winnerItemId}`);
    }
    const losers = siblings.filter((s) => s.id !== winnerItemId);
    // Winner returns to 'passed' and merges through the existing lane.
    winner.state = 'passed';
    deps.enqueueIntegration(workstream, winner);
    // Losers: discard their work (clean the worktree) and mark terminal. A held
    // loser passed its gates — it is 'passed' with an honest "not selected" note,
    // not a failure; a failed loser is left failed.
    for (const loser of losers) {
      if (loser.state === 'held-merge') {
        loser.state = 'passed';
        (loser.warnings ??= []).push('best-of-N: not selected (loser worktree cleaned)');
      }
      void deps.cleanupWorktree(workstream, loser).catch((error) => {
        logger.warn('attempts: loser worktree cleanup did not complete', { itemId: loser.id, error: summarizeError(error) });
      });
    }
    groups.delete(groupId);
    const loserItemIds = losers.map((l) => l.id);
    deps.emit({ type: 'attempt-winner-picked', workstreamId: entry.workstreamId, groupId, winnerItemId, loserItemIds, auto });
    return { groupId, winnerItemId, loserItemIds, auto };
  }

  function pickWinner(groupId: string, winnerItemId: string): Promise<AttemptPickResult> {
    return pick(groupId, winnerItemId, false);
  }

  async function proposeWinner(groupId: string): Promise<AttemptJudgment> {
    if (!deps.judge) {
      throw new AttemptError('no judge is configured on this engine; pick a best-of-N winner explicitly (fleet.attempts.pick)');
    }
    const { entry, siblings } = resolveReadyGroup(groupId);
    const candidates = await Promise.all(
      siblings.map(async (s) => ({
        itemId: s.id,
        attemptIndex: s.attemptIndex ?? 0,
        state: (s.state === 'failed' ? 'failed' : 'held-merge') as 'held-merge' | 'failed',
        diff: s.state === 'held-merge' ? await deps.diffItem(s) : null,
        usage: s.usage,
      })),
    );
    const verdict = await deps.judge({ task: entry.sourceTask, candidates });
    const judgment: AttemptJudgment = {
      proposedWinnerItemId: verdict.winnerItemId,
      reasons: [...verdict.reasons],
      model: verdict.model ?? null,
      scoredBy: 'model',
    };
    entry.judgment = judgment;
    deps.emit({
      type: 'attempt-judge-proposed',
      workstreamId: entry.workstreamId,
      groupId,
      proposedWinnerItemId: judgment.proposedWinnerItemId,
      reasons: judgment.reasons,
    });
    return judgment;
  }

  async function autoJudgeAndPick(groupId: string): Promise<void> {
    const judgment = await proposeWinner(groupId);
    if (judgment.proposedWinnerItemId) {
      await pick(groupId, judgment.proposedWinnerItemId, true);
    }
  }

  return { expandItems, reconcileGroups, onItemPassedTerminal, onItemFailedTerminal, listGroups, pickWinner, proposeWinner };
}
