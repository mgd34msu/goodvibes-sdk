/**
 * How a finished chain describes itself: its answer, its review outcome, and
 * its commit outcome.
 *
 * The answer is the part that reaches a person, and it is NOT the same thing as
 * the other two.
 *
 * The owner agent runs no turn of its own, so before this existed its
 * `fullOutput` was the chain status line, and that line is what every reader of
 * a finished agent gets, including a person on a chat surface. Somebody who
 * asked about their flights was answered with "WRFC chain wrfc-490aee53 passed
 * (review 10/10); commit skipped: not a git repository".
 *
 * The answer belongs to the last agent that actually did the work: the
 * integrator for a compound chain, otherwise the fixer that produced the final
 * revision, otherwise the engineer. A structured completion report is stripped
 * down to its prose summary, the JSON envelope is written for the reviewer, not
 * for a person.
 */
import { parseCompletionReport } from './completion-report.js';
import type { WrfcChain } from './wrfc-types.js';

/** Said when a chain passed but produced no text of its own to show. */
export const WRFC_CHAIN_PASSED_WITHOUT_OUTPUT =
  'The work is finished. The full-scope review and the quality gates passed.';

/** The record fields this rule reads. Any agent register satisfies it. */
export interface WrfcAnswerRecordView {
  readonly fullOutput?: string | undefined;
  readonly streamingContent?: string | undefined;
}

/** The chain's answer, or an empty string when no work phase produced one. */
export function renderWrfcChainAnswer(
  chain: Pick<WrfcChain, 'engineerAgentId' | 'fixerAgentId' | 'integratorAgentId'>,
  getStatus: (agentId: string) => WrfcAnswerRecordView | null | undefined,
): string {
  const answerAgentId = chain.integratorAgentId ?? chain.fixerAgentId ?? chain.engineerAgentId;
  if (!answerAgentId) return '';
  const record = getStatus(answerAgentId);
  const raw = (record?.fullOutput ?? record?.streamingContent ?? '').trim();
  if (!raw) return '';
  const summary = parseCompletionReport(raw)?.summary?.trim();
  return summary && summary.length > 0 ? summary : raw;
}

/**
 * The review outcome for the chain status line, the last recorded review score
 * out of 10, or a plain "review passed" for a chain with no numeric score on
 * record.
 */
export function describeReviewOutcome(chain: Pick<WrfcChain, 'reviewScores'>): string {
  const lastScore = chain.reviewScores.at(-1);
  return typeof lastScore === 'number' ? `review ${lastScore}/10` : 'review passed';
}

/**
 * The commit outcome as an honest, single-line note for the chain status line.
 * Distinguishes a real commit (with any gitignored paths that were skipped) from
 * the several "nothing was committed" cases, so the status states the commit
 * result plainly instead of implying a commit happened when it did not.
 */
export function describeCommitOutcome(
  headHash: string | null,
  skippedIgnored: readonly string[],
  ledgerEmpty: boolean,
): string {
  const ignoredNote = skippedIgnored.length > 0
    ? `${skippedIgnored.length} ignored path${skippedIgnored.length === 1 ? '' : 's'} skipped`
    : null;
  if (headHash) {
    const shortHash = headHash.slice(0, 8);
    return ignoredNote ? `committed ${shortHash} (${ignoredNote})` : `committed ${shortHash}`;
  }
  if (ignoredNote) return `commit skipped: ${ignoredNote}`;
  if (ledgerEmpty) return 'commit skipped: chain edit ledger empty';
  return 'commit skipped: nothing to stage';
}
