/**
 * wrfc-reviewer-contract-verification.test.ts
 *
 * The WRFC reviewer must verify the CONTRACT — that the work that was done is
 * the work that SHOULD have been done and that it is correct — not merely that
 * activity happened. These policy-contract tests pin every requirement in the
 * reviewer's task/policy text, the anti-gaming clause, and the acceptance-
 * checklist review record; a companion controller test proves a valid-but-
 * wrong-interface / wrong-units deliverable is REJECTED even at a perfect score.
 */
import { describe, expect, test } from 'bun:test';
import { buildReviewTask } from '../packages/sdk/src/platform/agents/wrfc-reporting.ts';
import { buildReviewerConstraintAddendum } from '../packages/sdk/src/platform/agents/wrfc-prompt-addenda.ts';
import { parseCompletionReport } from '../packages/sdk/src/platform/agents/completion-report.ts';
import type { ReviewableCompletionReport } from '../packages/sdk/src/platform/agents/wrfc-reporting.ts';

const report: ReviewableCompletionReport = {
  version: 1,
  archetype: 'engineer',
  summary: 'did the thing',
  gatheredContext: [],
  plannedActions: [],
  appliedChanges: [],
  filesCreated: [],
  filesModified: [],
  filesDeleted: [],
  decisions: [],
  issues: [],
  uncertainties: [],
} as unknown as ReviewableCompletionReport;

describe('reviewer task policy — verifies the contract, not the activity', () => {
  const task = buildReviewTask('chain-1', 'Build a CLI that takes --input and --output named flags and writes 2 rows.', report, 8);

  test('1. derives an explicit acceptance checklist from the original task', () => {
    expect(task).toContain('DERIVE AN EXPLICIT ACCEPTANCE CHECKLIST');
    expect(task).toContain('argument names');
    expect(task).toContain('cardinality');
    expect(task).toContain('threshold');
    expect(task).toContain('exit behavior');
  });

  test('2. independently exercises the deliverable through its own path, not the engineer tests', () => {
    expect(task).toContain('INDEPENDENTLY EXERCISE THE DELIVERABLE');
    expect(task).toContain('never just re-running the engineer');
    expect(task).toContain('SEMANTICALLY end to end');
    // The exact failure classes from the benchmark audit are named as must-fail.
    expect(task).toContain('positional args where named flags were required');
    expect(task).toContain('wrong units');
  });

  test('3. compilation/hashes/diffs/report are supporting evidence only', () => {
    expect(task).toContain('SUPPORTING evidence only');
    expect(task).toContain('never proof of behavior');
  });

  test('4. independently resolves reported uncertainties', () => {
    expect(task).toContain('RESOLVE every material uncertainty');
    expect(task).toContain('do not inherit');
  });

  test('5. re-runs the COMPLETE original contract after a fix', () => {
    expect(task).toContain('re-run the COMPLETE original contract');
    expect(task).toContain('not just the fixed slice');
  });

  test('6. scores against the checklist — correct-but-not-asked cannot pass', () => {
    expect(task).toContain('SCORE AGAINST THE CHECKLIST');
    expect(task).toContain('correct but is NOT what was asked cannot pass');
  });

  test('anti-gaming: never seek or infer a hidden verifier / oracle / grading key', () => {
    expect(task).toContain('ANTI-GAMING');
    expect(task).toContain('hidden verifier');
    expect(task).toContain('grading key');
    // The static reviewer addendum carries the clause too.
    expect(buildReviewerConstraintAddendum()).toContain('Anti-gaming (absolute)');
    expect(buildReviewerConstraintAddendum()).toContain('never from matching a discovered answer key');
  });

  test('the review record carries the acceptance checklist (what was checked + how)', () => {
    expect(task).toContain('acceptanceChecklist');
    expect(task).toContain('howExercised');
    expect(task).toContain('the record of what was checked and how');
  });
});

describe('ReviewerReport carries a normalized acceptance checklist', () => {
  test('well-formed acceptanceChecklist entries survive parsing; malformed are dropped', () => {
    const raw = JSON.stringify({
      version: 1,
      archetype: 'reviewer',
      summary: 'reviewed',
      score: 9,
      passed: false,
      dimensions: [],
      issues: [],
      acceptanceChecklist: [
        { item: 'accepts --input/--output named flags', verified: false, evidence: 'ran it with named flags; it errored', howExercised: 'invoked the CLI directly with --input a --output b' },
        { item: 'writes exactly 2 rows', verified: true, evidence: 'counted 2 rows in the output file' },
        { bogus: true },
      ],
    });
    const parsed = parseCompletionReport(raw);
    expect(parsed?.archetype).toBe('reviewer');
    const checklist = (parsed as { acceptanceChecklist?: Array<{ item: string; verified: boolean }> }).acceptanceChecklist ?? [];
    expect(checklist).toHaveLength(2);
    expect(checklist[0]).toMatchObject({ verified: false });
    expect(checklist.map((c) => c.verified)).toEqual([false, true]);
  });
});
