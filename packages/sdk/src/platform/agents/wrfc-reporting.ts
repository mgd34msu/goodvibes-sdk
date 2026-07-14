import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import type { CompletionReport, Constraint, ConstraintFinding, EngineerReport, ReviewerReport } from './completion-report.js';
import { parseCompletionReport } from './completion-report.js';
import { buildFixerConstraintAddendum, buildReviewerConstraintAddendum } from './wrfc-prompt-addenda.js';
import type { QualityGateResult } from './wrfc-types.js';
import { logger } from '../utils/logger.js';

const REVIEW_BRIEF_ITEM_LIMIT = 6;
const REVIEW_BRIEF_FILE_LIMIT = 8;
const REVIEW_BRIEF_TEXT_LIMIT = 220;
const REVIEWABLE_OUTPUT_LIMIT = 16_000;

type ReviewableCompletionReport = CompletionReport & {
  reviewableOutput?: string | undefined;
};

export function extractScoreFromText(text: string): number | null {
  const scorePattern = /\*{0,2}(?:overall\s+)?score\s*:?\s*\*{0,2}\s*(\d+(?:\.\d+)?)\s*\/\s*10/i;
  const matchScore = text.match(scorePattern);
  if (matchScore) {
    const value = parseFloat(matchScore[1]!);
    if (value <= 10) return value;
  }

  const slashPattern = /(\d+(?:\.\d+)?)\s*\/\s*10/;
  const matchSlash = text.match(slashPattern);
  if (matchSlash) {
    const value = parseFloat(matchSlash[1]!);
    if (value <= 10) return value;
  }

  const ratedPattern = /\b(?:rated|scored|rating)\s*:?\s*(\d+(?:\.\d+)?)/i;
  const matchRated = text.match(ratedPattern);
  if (matchRated) {
    const value = parseFloat(matchRated[1]!);
    if (value <= 10) return value;
  }

  return null;
}

/**
 * Determines whether a review verdict passes.
 *
 * Score >= threshold is a NECESSARY condition. Prose language ("passed",
 * "approved") is treated as confirmation only — it can never elevate a
 * sub-threshold score to a pass verdict.
 *
 * This is intentionally fail-closed: if the score is below threshold,
 * the result is always false regardless of what the reviewer wrote.
 */
export function extractPassedFromText(text: string, score: number, threshold: number): boolean {
  // Score must meet or exceed threshold — no exceptions.
  if (score < threshold) return false;
  // Score meets threshold: treat prose as optional confirmation (ignored either way).
  // We check for explicit fail language as a safety override even when score >= threshold.
  if (/\bfail(ed|s|ing)?\b/i.test(text) && !/\bpassed?\b/i.test(text)) return false;
  return true;
}

export function extractIssuesFromText(text: string): ReviewerReport['issues'] {
  const issues: ReviewerReport['issues'] = [];
  const issuePattern = /(?:^|\n)\s*(?:\d+\.\s*|-\s*|\*\s*)?(?:\*{1,2})?\[?\(?(critical|major|minor|suggestion)\)?\]?(?:\*{1,2})?[\s:*]*(.+)/gi;
  let match: RegExpExecArray | null;
  while ((match = issuePattern.exec(text)) !== null) {
    const severity = (match[1]?.toLowerCase() ?? 'suggestion') as 'critical' | 'major' | 'minor' | 'suggestion';
    issues.push({
      severity,
      description: match[2]?.trim() ?? '',
      pointValue: severity === 'critical' ? 3 : severity === 'major' ? 2 : 1,
    });
  }
  return issues;
}

export function parseEngineerCompletionReport(rawOutput: string, _template?: string): ReviewableCompletionReport {
  const report = parseCompletionReport(rawOutput);
  if (report) return { ...report, reviewableOutput: rawOutput };
  return {
    version: 1,
    archetype: 'engineer',
    summary: rawOutput.slice(0, 500) || '(no output)',
    reviewableOutput: rawOutput,
    gatheredContext: [],
    plannedActions: [],
    appliedChanges: [],
    filesCreated: [],
    filesModified: [],
    filesDeleted: [],
    decisions: [],
    issues: [],
    uncertainties: [],
  } as EngineerReport;
}

/**
 * Discriminator for claim verification outcome:
 * - 'files_verified': claims present and all found on disk.
 * - 'git_corroborated': claims present, some missing on disk, but git diff shows changes.
 * - 'verified_empty': no claims made but git diff shows changes (engineer did real work without listing files).
 * - 'unverifiable_no_claims': no claims AND no git diff — suspicious; treated as phantom work.
 * - 'unverified': claims present but not found on disk and git shows no changes.
 */
export type ClaimVerificationKind =
  | 'files_verified'
  | 'git_corroborated'
  | 'verified_empty'
  | 'unverifiable_no_claims'
  | 'unverified';

/** Per-file result for claim verification. */
export interface ClaimVerificationResult {
  /** All paths claimed as created, modified, or deleted. */
  claimedPaths: string[];
  /** Paths that exist on disk (for created/modified claims). */
  foundPaths: string[];
  /** Paths that were claimed but not found on disk. */
  missingPaths: string[];
  /** Whether git diff/status shows any changes since the engineer started. */
  gitDiffDetected: boolean | null;
  /**
   * Tri-state discriminator. Use this instead of the bare `verified` boolean
   * to distinguish 'unverifiable_no_claims' (suspicious) from 'verified_empty'
   * (legit no-file work with a git diff). Controllers must treat 'unverifiable_no_claims'
   * as phantom work and inject a synthetic issue.
   */
  kind: ClaimVerificationKind;
  /**
   * Convenience: true iff kind is NOT 'unverified' or 'unverifiable_no_claims'.
   * NOTE: Callers should use `kind` directly when deciding whether to set `chain.claimsVerified`.
   * In particular, `unverifiable_no_claims` returns `verified: false` here but the controller
   * intentionally leaves `chain.claimsVerified` as `undefined` (not `false`) because suspicion
   * cannot be confirmed. Do NOT blindly propagate `result.verified` into chain state.
   */
  verified: boolean;
  /** Human-readable summary of what was and wasn't found. */
  summary: string;
}

/**
 * Verifies that an engineer's self-reported work actually materialised on disk.
 *
 * Strategy:
 * 1. Stat every path claimed in filesCreated/filesModified.
 * 2. If any claimed paths are missing, check git diff/status as a fallback
 *    (the engineer may have written to a path not literally listed).
 * 3. If no paths were claimed at all, fall through to git as the sole signal.
 *
 * This is intentionally lenient about the git check — a non-empty diff is
 * treated as corroborating evidence even when individual file stats fail.
 */
export function verifyEngineerClaims(
  report: CompletionReport,
  projectRoot: string,
): ClaimVerificationResult {
  const isEngineerShape = (r: CompletionReport): r is EngineerReport => r.archetype === 'engineer';
  if (!isEngineerShape(report)) {
    return {
      claimedPaths: [],
      foundPaths: [],
      missingPaths: [],
      gitDiffDetected: null,
      kind: 'verified_empty',
      verified: true,
      summary: 'Non-engineer report; claim verification skipped.',
    };
  }

  const claimedPaths = [
    ...report.filesCreated,
    ...report.filesModified,
    // Note: filesDeleted are intentionally excluded — we expect them to be gone.
  ];

  const foundPaths: string[] = [];
  const missingPaths: string[] = [];

  for (const p of claimedPaths) {
    const absolute = isAbsolute(p) ? p : resolve(projectRoot, p);
    if (existsSync(absolute)) {
      foundPaths.push(p);
    } else {
      missingPaths.push(p);
    }
  }

  // Fall through to git when paths are missing or none were claimed.
  let gitDiffDetected: boolean | null = null;
  if (missingPaths.length > 0 || claimedPaths.length === 0) {
    try {
      const result = execSync('git diff --stat HEAD', {
        cwd: projectRoot,
        timeout: 10_000,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      gitDiffDetected = result.length > 0;
    } catch {
      // git not available or not a git repo — treat as inconclusive
      gitDiffDetected = null;
    }
  }

  const allClaimedFound = claimedPaths.length > 0 && missingPaths.length === 0;
  const gitCorroborates = gitDiffDetected === true;

  // Determine the tri-state kind:
  // - files_verified: had claims and all found on disk.
  // - git_corroborated: had claims but some missing; git diff shows work happened.
  // - verified_empty: no claims at all but git diff shows changes (legit no-list work).
  // - unverifiable_no_claims: no claims AND no git diff — suspicious phantom work.
  // - unverified: had claims, some missing, and git shows nothing.
  let kind: ClaimVerificationKind;
  if (allClaimedFound) {
    kind = 'files_verified';
  } else if (claimedPaths.length > 0 && gitCorroborates) {
    kind = 'git_corroborated';
  } else if (claimedPaths.length === 0 && gitCorroborates) {
    kind = 'verified_empty';
  } else if (claimedPaths.length === 0 && !gitCorroborates) {
    // Either git showed no changes (gitDiffDetected === false) or git was unavailable (null).
    // Both cases are treated as unverifiable — we cannot confirm any work was done.
    kind = 'unverifiable_no_claims';
  } else {
    // claimedPaths.length > 0 && missingPaths.length > 0 && !gitCorroborates
    kind = 'unverified';
  }

  const verified = kind === 'files_verified' || kind === 'git_corroborated' || kind === 'verified_empty';

  const summaryParts: string[] = [];
  if (claimedPaths.length > 0) {
    summaryParts.push(`${foundPaths.length}/${claimedPaths.length} claimed paths found on disk`);
    if (missingPaths.length > 0) {
      summaryParts.push(`missing: ${missingPaths.slice(0, 5).join(', ')}${missingPaths.length > 5 ? ` (+${missingPaths.length - 5} more)` : ''}`);
    }
  } else {
    summaryParts.push('no file paths claimed');
  }
  if (gitDiffDetected !== null) {
    summaryParts.push(`git diff: ${gitDiffDetected ? 'changes detected' : 'no changes detected'}`);
  }
  summaryParts.push(`kind: ${kind}`);

  return {
    claimedPaths,
    foundPaths,
    missingPaths,
    gitDiffDetected,
    kind,
    verified,
    summary: summaryParts.join('; '),
  };
}

export function parseReviewerCompletionReport(
  chainId: string,
  rawOutput: string,
  threshold: number,
): ReviewerReport {
  const reviewerReport = parseCompletionReport(rawOutput);
  if (reviewerReport && reviewerReport.archetype === 'reviewer') {
    return reviewerReport as ReviewerReport;
  }

  const extractedScore = extractScoreFromText(rawOutput);
  const extractedPassed = extractedScore !== null
    ? extractPassedFromText(rawOutput, extractedScore, threshold)
    : false;
  const extractedIssues = extractIssuesFromText(rawOutput);

  logger.warn('WrfcController: no structured ReviewerReport found, extracting from text', {
    chainId,
    extractedScore,
  });
  if (extractedScore === null) {
    logger.warn('WrfcController: score extraction returned null, defaulting to 0', { chainId });
  }

  return {
    version: 1,
    archetype: 'reviewer',
    summary: rawOutput.slice(0, 500) || '(no reviewer output)',
    score: extractedScore ?? 0,
    passed: extractedPassed,
    dimensions: [],
    issues: extractedIssues,
  };
}

const CONSTRAINTS_TASK_LIMIT = 20;

export function buildReviewTask(
  chainId: string,
  originalTask: string,
  report: ReviewableCompletionReport,
  threshold: number,
  constraints: Constraint[] = [],
): string {
  const lines = buildReviewBrief(report);
  const base = [
    `WRFC Review Request`,
    `Chain ID: ${chainId}`,
    ``,
    `Original WRFC ask (authoritative full review scope):`,
    originalTask,
    ``,
    `Engineer report digest:`,
    ...lines,
    ``,
    `Engineer reviewable output (authoritative for non-file deliverables and no-write tasks):`,
    formatReviewableOutput(report),
    ``,
    `Instructions:`,
    `Verify that the work that was done is the work that SHOULD have been done and that it is correct — not merely that some work happened. Review the complete current result against the original WRFC ask above. Do not narrow the review to the latest fix, files touched in the last child turn, or functions mentioned in the digest.`,
    `1. DERIVE AN EXPLICIT ACCEPTANCE CHECKLIST from the original task BEFORE examining the work: what was asked, the documented public interface, argument names / count / order, formats, required paths, cardinality (how many inputs/outputs/rows), thresholds, exit behavior, and side effects. Each becomes a checklist item you will score against.`,
    `2. INDEPENDENTLY EXERCISE THE DELIVERABLE exactly as documented — invoke the real CLI / function / service through your OWN path, never just re-running the engineer's tests — and check the outputs SEMANTICALLY end to end (units, ordering, and the whole source-to-output path for any derived, numeric, or tabular artifact). Work that is internally self-consistent but wrong (wrong axis domain, wrong units, positional args where named flags were required, a one-input test where the contract required two, missing result rows, out-of-threshold numerics) must FAIL.`,
    `3. Compilation, loadability, hashes, diffs, file existence, and the engineer's own report and tests are SUPPORTING evidence only — never proof of behavior. Never pass work on structural/partial evidence alone.`,
    `4. Independently RESOLVE every material uncertainty the engineer reported — reconstruct or re-derive it yourself; do not inherit the engineer's claim.`,
    `5. If the original ask requested a non-file deliverable or explicitly said not to write files, review the Engineer reviewable output as the deliverable. Do not fail only because no files exist. Read referenced files directly when files were created or modified.`,
    `6. SCORE AGAINST THE CHECKLIST: work that is correct but is NOT what was asked cannot pass. After any fix cycle, re-run the COMPLETE original contract, not just the fixed slice — a fix must not regress any other checklist item.`,
    `7. ANTI-GAMING: verify strictly against the STATED task contract and the documented interface. Never seek out, infer, reconstruct, or rely on any hidden verifier, grader, oracle, expected-output fixture, or grading key; if you notice such data, ignore it. Your judgement comes only from the task contract and the deliverable you exercised.`,
    `8. Score the implementation using the 10-dimension review rubric. The passing score threshold is ${threshold}/10. Return a structured ReviewerReport JSON block in your final response.`,
    ``,
    `The ReviewerReport must include:`,
    `- version: 1`,
    `- archetype: "reviewer"`,
    `- score: <number 0-10>`,
    `- passed: <boolean>`,
    `- dimensions: array of { name, score, maxScore, issues[] }`,
    `- issues: array of { severity, description, file?, line?, pointValue }`,
    `- acceptanceChecklist: array of { item: string (a requirement derived from the original task), verified: boolean, evidence: string, howExercised?: string (how you INDEPENDENTLY exercised it) } — the record of what was checked and how, so a consumer can render what was verified. A false item on any interface / cardinality / format / threshold requirement means the work does not meet the contract.`,
    `- constraintFindings: array of exactly { constraintId: string, satisfied: boolean, evidence: string, severity?: "critical" | "major" | "minor" }`,
  ];

  if (constraints.length === 0) {
    return base.join('\n');
  }

  const visible = constraints.slice(0, CONSTRAINTS_TASK_LIMIT);
  const overflow = constraints.length - visible.length;
  const constraintLines = visible.map((c) => `- ${c.id}: ${c.text}`);
  if (overflow > 0) {
    constraintLines.push(`(+${overflow} more)`);
  }

  const constraintSection = [
    `## Constraints to verify`,
    ``,
    `The engineer enumerated the following user-declared constraints from the task prompt. Verify each one in your review. Unsatisfied constraints are independent of the quality rubric and will force chain failure regardless of score.`,
    ``,
    ...constraintLines,
  ].join('\n');

  return base.join('\n') + '\n\n---\n\n' + constraintSection + '\n\n---\n\n' + buildReviewerConstraintAddendum();
}

function truncateReviewText(text: string, max = REVIEW_BRIEF_TEXT_LIMIT): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 3)}...`;
}

function formatReviewableOutput(report: ReviewableCompletionReport): string {
  const output = typeof report.reviewableOutput === 'string' ? report.reviewableOutput.trim() : '';
  if (output.length === 0) return '(no reviewable output recorded)';
  if (output.length <= REVIEWABLE_OUTPUT_LIMIT) return output;
  return `${output.slice(0, REVIEWABLE_OUTPUT_LIMIT)}\n\n[truncated from ${output.length} characters; inspect agent fullOutput directly if more detail is required]`;
}

function formatInlineList(items: readonly string[], limit: number): string {
  if (items.length === 0) return 'none';
  const visible = items.slice(0, limit).map((item) => truncateReviewText(item, 120));
  if (items.length <= limit) return visible.join(', ');
  return `${visible.join(', ')} (+${items.length - limit} more)`;
}

function appendListSection(
  lines: string[],
  title: string,
  items: readonly string[],
  limit = REVIEW_BRIEF_ITEM_LIMIT,
): void {
  if (items.length === 0) return;
  lines.push(`${title}:`);
  for (const item of items.slice(0, limit)) {
    lines.push(`- ${truncateReviewText(item)}`);
  }
  if (items.length > limit) {
    lines.push(`- (+${items.length - limit} more)`);
  }
}

function appendDecisionSection(
  lines: string[],
  decisions: EngineerReport['decisions'],
  limit = 4,
): void {
  if (decisions.length === 0) return;
  lines.push('Decisions:');
  for (const decision of decisions.slice(0, limit)) {
    lines.push(`- ${truncateReviewText(decision.what, 120)} | why: ${truncateReviewText(decision.why, 120)}`);
  }
  if (decisions.length > limit) {
    lines.push(`- (+${decisions.length - limit} more)`);
  }
}

function normalizeEngineerReport(report: CompletionReport): EngineerReport {
  const candidate = report as Partial<EngineerReport>;
  return {
    version: 1,
    archetype: 'engineer',
    summary: typeof candidate.summary === 'string' ? candidate.summary : '(no summary)',
    ...(typeof candidate.wrfcId === 'string' ? { wrfcId: candidate.wrfcId } : {}),
    gatheredContext: Array.isArray(candidate.gatheredContext) ? candidate.gatheredContext.filter((item): item is string => typeof item === 'string') : [],
    plannedActions: Array.isArray(candidate.plannedActions) ? candidate.plannedActions.filter((item): item is string => typeof item === 'string') : [],
    appliedChanges: Array.isArray(candidate.appliedChanges) ? candidate.appliedChanges.filter((item): item is string => typeof item === 'string') : [],
    filesCreated: Array.isArray(candidate.filesCreated) ? candidate.filesCreated.filter((item): item is string => typeof item === 'string') : [],
    filesModified: Array.isArray(candidate.filesModified) ? candidate.filesModified.filter((item): item is string => typeof item === 'string') : [],
    filesDeleted: Array.isArray(candidate.filesDeleted) ? candidate.filesDeleted.filter((item): item is string => typeof item === 'string') : [],
    decisions: Array.isArray(candidate.decisions)
      ? candidate.decisions.filter((decision): decision is { what: string; why: string } =>
        Boolean(decision) &&
        typeof decision === 'object' &&
        typeof decision.what === 'string' &&
        typeof decision.why === 'string')
      : [],
    issues: Array.isArray(candidate.issues) ? candidate.issues.filter((item): item is string => typeof item === 'string') : [],
    uncertainties: Array.isArray(candidate.uncertainties) ? candidate.uncertainties.filter((item): item is string => typeof item === 'string') : [],
  };
}

function buildReviewBrief(report: CompletionReport): string[] {
  const engineer = normalizeEngineerReport(report);
  const lines = [
    `- Summary: ${truncateReviewText(engineer.summary)}`,
    `- Files created (${engineer.filesCreated.length}): ${formatInlineList(engineer.filesCreated, REVIEW_BRIEF_FILE_LIMIT)}`,
    `- Files modified (${engineer.filesModified.length}): ${formatInlineList(engineer.filesModified, REVIEW_BRIEF_FILE_LIMIT)}`,
    `- Files deleted (${engineer.filesDeleted.length}): ${formatInlineList(engineer.filesDeleted, REVIEW_BRIEF_FILE_LIMIT)}`,
  ];

  appendListSection(lines, 'Gathered context', engineer.gatheredContext);
  appendListSection(lines, 'Planned actions', engineer.plannedActions);
  appendListSection(lines, 'Applied changes', engineer.appliedChanges);
  appendDecisionSection(lines, engineer.decisions);
  appendListSection(lines, 'Known issues', engineer.issues, 4);
  appendListSection(lines, 'Uncertainties', engineer.uncertainties, 4);

  return lines;
}

export function buildFixTask(
  chainId: string,
  originalTask: string,
  review: ReviewerReport,
  threshold: number,
  fixAttempts: number,
  constraints: Constraint[] = [],
  constraintFindings: ConstraintFinding[] = [],
): string {
  const issueList = review.issues
    .map((issue) => {
      const location = issue.file ? ` (${issue.file}${issue.line ? `:${issue.line}` : ''})` : '';
      return `- [${issue.severity.toUpperCase()}] ${issue.description}${location} (-${issue.pointValue} pts)`;
    })
    .join('\n');
  const base = [
    `WRFC Fix Request`,
    `Chain ID: ${chainId}`,
    ``,
    `Original WRFC ask (authoritative scope for every fix loop):`,
    originalTask,
    ``,
    `Review score: ${review.score}/10 (threshold: ${threshold}/10)`,
    `Fix attempt: ${fixAttempts}`,
    ``,
    `Issues to address:`,
    issueList || '(no structured issues — see review summary)',
    ``,
    `Review summary: ${review.summary}`,
    ``,
    `Instructions:`,
    `1. Address ALL issues listed above, prioritizing critical and major items.`,
    `2. Keep the original WRFC ask in scope. Do not limit the fix to only the files/functions named by the latest review if the original ask requires broader correction.`,
    `3. Fix each issue completely — partial fixes will reduce your score.`,
    `4. Re-run Gather, Plan, Apply explicitly before writing your final answer.`,
    `5. Before finalizing, spot-check your complete result against the original ask and record any remaining misses under issues[] or uncertainties[].`,
    `6. Return a structured EngineerReport JSON block including gatheredContext, plannedActions, and appliedChanges in your final response.`,
  ].join('\n');

  if (constraints.length === 0) {
    return [
      base,
      ``,
      `Constraint continuity: the initial engineer declared no user-declared constraints for this chain. Return "constraints": [] in your EngineerReport. Do not invent constraint ids from the review findings, implementation details, or quality rubric.`,
    ].join('\n');
  }

  // Build a finding-lookup map: constraintId -> ConstraintFinding
  const findingMap = new Map<string, ConstraintFinding>();
  for (const finding of constraintFindings) {
    findingMap.set(finding.constraintId, finding);
  }

  const visible = constraints.slice(0, CONSTRAINTS_TASK_LIMIT);
  const overflow = constraints.length - visible.length;
  const constraintLines = visible.map((c) => {
    const finding = findingMap.get(c.id);
    const marker = finding === undefined ? 'UNVERIFIED' : finding.satisfied ? 'SATISFIED' : 'UNSATISFIED';
    return `- ${c.id} [${marker}]: ${c.text}`;
  });
  if (overflow > 0) {
    constraintLines.push(`(+${overflow} more)`);
  }

  const constraintSection = [
    `## Constraints (authoritative — preserve through fix)`,
    ``,
    `These are the user-declared constraints for this chain. They are binding on every fix iteration.`,
    ``,
    ...constraintLines,
  ].join('\n');

  return base + '\n\n---\n\n' + constraintSection + '\n\n---\n\n' + buildFixerConstraintAddendum();
}

export function buildGateFailureTask(
  chainId: string,
  task: string,
  failedGates: readonly QualityGateResult[],
  constraints: readonly Constraint[] = [],
): string {
  const gateFailureSummary = failedGates
    .map((result) => `- ${result.gate}: ${result.output.slice(0, 300)}`)
    .join('\n');
  const base = [
    `WRFC Gate Failure Fix`,
    `Parent Chain ID: ${chainId}`,
    ``,
    `The following quality gates failed after review passed:`,
    gateFailureSummary,
    ``,
    `Original task: ${task}`,
    ``,
    `Instructions:`,
    `1. Fix all gate failures listed above.`,
    `2. Ensure typecheck, lint, and test gates pass.`,
    `3. Return a structured EngineerReport in your final response.`,
  ].join('\n');

  if (constraints.length === 0) {
    return base;
  }

  const visible = constraints.slice(0, CONSTRAINTS_TASK_LIMIT);
  const overflow = constraints.length - visible.length;
  const constraintLines = visible.map((constraint) => `- ${constraint.id}: ${constraint.text}`);
  if (overflow > 0) {
    constraintLines.push(`(+${overflow} more)`);
  }

  const constraintSection = [
    `## Constraints to preserve`,
    ``,
    `These constraints remain binding while fixing gate failures. Return the same ids and text in your EngineerReport constraints[] with source "prompt". Do not add, rename, or drop constraints while repairing gates.`,
    ``,
    ...constraintLines,
  ].join('\n');

  return base + '\n\n---\n\n' + constraintSection;
}
