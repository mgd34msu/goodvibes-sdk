/**
 * wrfc-planned-fix.ts — shared helpers for the planned-fix path, used
 * by both the chain-level and compound-subtask fix cycles in WrfcController.
 * The single-fixer prompt path is gone; these helpers keep the controller
 * under its line budget while both cycles share one honest shape.
 */
import type { Constraint, EngineerReport, ReviewerReport } from './completion-report.js';
import type { FixWorkstreamOutcome } from '../orchestration/fix-workstream-runner.js';

/**
 * A known constraint with NO reviewer finding is unmet-by-silence: synthesize
 * an unsatisfied finding so the planned graph always births a task for it.
 */
export function augmentReviewWithMissingConstraintFindings(
  review: ReviewerReport,
  unsatisfiedConstraintIds: readonly string[],
): ReviewerReport {
  const reported = new Set((review.constraintFindings ?? []).map((finding) => finding.constraintId));
  const synthesized = unsatisfiedConstraintIds
    .filter((id) => !reported.has(id))
    .map((id) => ({
      constraintId: id,
      satisfied: false,
      evidence: 'no reviewer finding was returned for this constraint (unverified is unmet)',
      severity: 'major' as const,
    }));
  if (synthesized.length === 0) return review;
  return { ...review, constraintFindings: [...(review.constraintFindings ?? []), ...synthesized] };
}

/**
 * The merged workstream outcome as an EngineerReport: what the terminal
 * contract gate reviews (against the ORIGINAL request) and what integration
 * summarizes. Constraints are ALWAYS the authoritative list — never anything
 * a task agent echoed, which is what makes constraint-continuity violations
 * structurally impossible on this path.
 */
export function buildMergedFixReport(
  outcome: Extract<FixWorkstreamOutcome, { status: 'merged' }>,
  authoritativeConstraints: Constraint[],
  scopeLabel: string,
): EngineerReport {
  return {
    version: 1,
    archetype: 'engineer',
    summary: `Planned fix workstream ${outcome.workstreamId} merged ${outcome.taskCount} tasks${scopeLabel}: ${outcome.mergedTitles.join('; ')}`,
    gatheredContext: [],
    plannedActions: [],
    appliedChanges: [...outcome.mergedTitles],
    filesCreated: [],
    filesModified: [...outcome.filesModified],
    filesDeleted: [],
    decisions: [],
    issues: [],
    uncertainties: [],
    constraints: authoritativeConstraints,
  };
}
