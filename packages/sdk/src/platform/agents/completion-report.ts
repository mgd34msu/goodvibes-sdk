/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';

/**
 * Structured completion reports — per-archetype output contracts.
 * Agents include these in their final output. The WrfcController extracts them.
 */

/** Base fields shared by all completion reports. */
export interface BaseCompletionReport {
  version: 1;
  archetype: string;
  summary: string;
  wrfcId?: string | undefined;
}

/**
 * A single constraint extracted from the task prompt or inherited from a parent chain.
 */
export interface Constraint {
  id: string;                        // e.g. "c1", "c2"
  text: string;                      // quoted/near-quoted user phrasing
  source: 'prompt' | 'inherited';    // 'prompt' = engineer enumerated from this prompt; 'inherited' = from parent chain / gate-retry
}

/**
 * A reviewer's finding about whether a specific constraint was satisfied.
 */
export interface ConstraintFinding {
  constraintId: string;
  satisfied: boolean;
  evidence: string;
  severity?: 'critical' | 'major' | 'minor';  // only when !satisfied
}

/** Engineer agent completion report. */
export interface EngineerReport extends BaseCompletionReport {
  archetype: 'engineer';
  gatheredContext: string[];
  plannedActions: string[];
  appliedChanges: string[];
  filesCreated: string[];
  filesModified: string[];
  filesDeleted: string[];
  decisions: Array<{ what: string; why: string }>;
  issues: string[];
  uncertainties: string[];
  /** Constraints enumerated from the task prompt (or inherited from parent chain). Defaults to [] when absent. */
  constraints?: Constraint[] | undefined;
}

/** Reviewer agent completion report. */
export interface ReviewerReport extends BaseCompletionReport {
  archetype: 'reviewer';
  score: number;
  passed: boolean;
  dimensions: Array<{
    name: string;
    score: number;
    maxScore: number;
    issues: string[];
  }>;
  issues: Array<{
    severity: 'critical' | 'major' | 'minor' | 'suggestion';
    description: string;
    file?: string | undefined;
    line?: number | undefined;
    pointValue: number;
  }>;
  /** Per-constraint satisfaction findings from the reviewer. Defaults to [] when absent. */
  constraintFindings?: ConstraintFinding[] | undefined;
}

/** Tester agent completion report. */
export interface TesterReport extends BaseCompletionReport {
  archetype: 'tester';
  testsWritten: string[];
  testsPassed: number;
  testsFailed: number;
  coverage?: { lines: number; branches: number; functions: number };
  failures: Array<{ test: string; error: string }>;
}

/** Generic completion report for other archetypes. */
export interface GenericReport extends BaseCompletionReport {
  /** Archetype name. For non-standard archetypes (not engineer/reviewer/tester). */
  archetype: string;
  result: string;
}

export type CompletionReport = EngineerReport | ReviewerReport | TesterReport | GenericReport;

/** Returns true if a Constraint entry is well-formed. */
function isWellFormedConstraint(c: unknown): c is Constraint {
  if (typeof c !== 'object' || c === null) return false;
  const obj = c as Record<string, unknown>;
  return (
    typeof obj['id'] === 'string' && obj['id'].length > 0 &&
    typeof obj['text'] === 'string' && obj['text'].length > 0 &&
    (obj['source'] === 'prompt' || obj['source'] === 'inherited')
  );
}

/** Returns true if a ConstraintFinding entry is well-formed. */
function isWellFormedConstraintFinding(f: unknown): f is ConstraintFinding {
  if (typeof f !== 'object' || f === null) return false;
  const obj = f as Record<string, unknown>;
  return (
    typeof obj['constraintId'] === 'string' && obj['constraintId'].length > 0 &&
    typeof obj['satisfied'] === 'boolean' &&
    typeof obj['evidence'] === 'string' && obj['evidence'].length > 0
  );
}

export function parseCompletionReport(rawOutput: string): CompletionReport | null {
  // Strategy 1: Find ```json ... ``` block
  const jsonBlockMatch = rawOutput.match(/```json\s*\n(\{[\s\S]*?\})\s*\n```/);
  if (jsonBlockMatch) {
    try {
      const parsed = JSON.parse(jsonBlockMatch[1]!);
      if (parsed.version === 1 && parsed.archetype) return applyConstraintDefaults(parsed) as unknown as CompletionReport;
    } catch (error) {
      logger.debug('Completion report fenced JSON parse failed', { error: summarizeError(error) });
    }
  }

  // Strategy 2: Brace-counting extraction — find "version": 1, walk backward for opening {,
  // then forward counting braces to find the matching }. Avoids greedy regex over-matching.
  const versionIdx = rawOutput.indexOf('"version"');
  if (versionIdx !== -1) {
    // Walk backward to find opening brace
    let openBrace = -1;
    for (let i = versionIdx - 1; i >= 0; i--) {
      if (rawOutput[i] === '{') { openBrace = i; break; }
    }
    if (openBrace !== -1) {
      // Walk forward with brace counting to find matching close
      let depth = 0;
      let closeBrace = -1;
      for (let i = openBrace; i < rawOutput.length; i++) {
        if (rawOutput[i] === '{') depth++;
        else if (rawOutput[i] === '}') {
          depth--;
          if (depth === 0) { closeBrace = i; break; }
        }
      }
      if (closeBrace !== -1) {
        const candidate = rawOutput.slice(openBrace, closeBrace + 1);
        try {
          const parsed = JSON.parse(candidate);
          if (parsed.version === 1 && parsed.archetype) return applyConstraintDefaults(parsed) as unknown as CompletionReport;
        } catch (error) {
          logger.debug('Completion report brace-count JSON parse failed', { error: summarizeError(error) });
        }
      }
    }
  }

  return null;
}

/**
 * Normalize constraint-related fields on a parsed report:
 * - defaults `constraints` and `constraintFindings` to []
 * - silently filters out malformed entries
 *
 * Pure: returns a new object rather than mutating the input, so callers can
 * share references without surprise writes.
 */
function applyConstraintDefaults(parsed: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...parsed };
  if (next['archetype'] === 'engineer') {
    const raw = next['constraints'];
    next['constraints'] = Array.isArray(raw) ? raw.filter(isWellFormedConstraint) : [];
  }
  if (next['archetype'] === 'reviewer') {
    const raw = next['constraintFindings'];
    next['constraintFindings'] = Array.isArray(raw) ? raw.filter(isWellFormedConstraintFinding) : [];
  }
  return next;
}
