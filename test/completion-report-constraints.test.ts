/**
 * Parser tolerance tests for `applyConstraintDefaults` via `parseCompletionReport`.
 *
 * Verifies:
 * - Missing constraint fields default to [].
 * - Malformed entries are filtered, well-formed entries pass through, and drops are reported.
 * - Parser is pure: does not mutate the caller's object.
 */

import { describe, expect, test } from 'bun:test';
import { parseCompletionReport } from '../packages/sdk/src/platform/agents/completion-report.js';
import type { EngineerReport, ReviewerReport, Constraint, ConstraintFinding } from '../packages/sdk/src/platform/agents/completion-report.js';

/** Encode a plain object as a ```json block for parseCompletionReport to extract. */
function asJsonBlock(obj: Record<string, unknown>): string {
  return '```json\n' + JSON.stringify(obj) + '\n```';
}

/** Minimal valid EngineerReport fields (excluding constraints). */
const BASE_ENGINEER: Record<string, unknown> = {
  version: 1,
  archetype: 'engineer',
  summary: 'test',
  gatheredContext: [],
  plannedActions: [],
  appliedChanges: [],
  filesCreated: [],
  filesModified: [],
  filesDeleted: [],
  decisions: [],
  issues: [],
  uncertainties: [],
};

/** Minimal valid ReviewerReport fields (excluding constraintFindings). */
const BASE_REVIEWER: Record<string, unknown> = {
  version: 1,
  archetype: 'reviewer',
  summary: 'test',
  score: 10,
  passed: true,
  dimensions: [],
  issues: [],
};

describe('Engineer report: missing constraints field', () => {
  test('missing constraints defaults to []', () => {
    const raw = asJsonBlock({ ...BASE_ENGINEER }); // no constraints field
    const result = parseCompletionReport(raw);
    expect(result).not.toBeNull();
    expect(result!.archetype).toBe('engineer');
    const report = result as EngineerReport;
    expect(report.constraints).toEqual([]);
  });
});

describe('Engineer report: malformed constraints not an array', () => {
  test('constraints: string defaults to []', () => {
    const raw = asJsonBlock({ ...BASE_ENGINEER, constraints: 'not-an-array' });
    const result = parseCompletionReport(raw) as EngineerReport;
    expect(result).not.toBeNull();
    expect(result.constraints).toEqual([]);
  });

  test('constraints: number defaults to []', () => {
    const raw = asJsonBlock({ ...BASE_ENGINEER, constraints: 42 });
    const result = parseCompletionReport(raw) as EngineerReport;
    expect(result.constraints).toEqual([]);
  });

  test('constraints: null defaults to []', () => {
    const raw = asJsonBlock({ ...BASE_ENGINEER, constraints: null });
    const result = parseCompletionReport(raw) as EngineerReport;
    expect(result.constraints).toEqual([]);
  });
});

describe('Engineer report: mixed well-formed and malformed constraint entries', () => {
  test('well-formed entries pass through, malformed are filtered out', () => {
    const wellFormed: Constraint = { id: 'c1', text: 'must be pure', source: 'prompt' };
    const malformedCases: unknown[] = [
      { text: 'missing id', source: 'prompt' },          // missing id
      { id: 'c3', source: 'prompt' },                    // missing text (empty string edge: text field absent)
      { id: 'c4', text: 'bad source', source: 'unknown' }, // invalid source value
      { id: 99, text: 'non-string id', source: 'prompt' }, // non-string id
      { id: 'c6', text: 42, source: 'prompt' },          // non-string text
      'just-a-string',                                    // non-object entry
      null,                                               // null entry
    ];
    const raw = asJsonBlock({
      ...BASE_ENGINEER,
      constraints: [wellFormed, ...malformedCases],
    });
    const result = parseCompletionReport(raw) as EngineerReport;
    expect(result).not.toBeNull();
    expect(result.constraints).toHaveLength(1);
    expect(result.constraints![0]?.id).toBe('c1');
    expect(result.constraints![0]?.text).toBe('must be pure');
    expect(result.constraints![0]?.source).toBe('prompt');
    expect(result.issues).toContain('Malformed constraints ignored: 7 entries.');
  });

  test('empty text string is filtered out', () => {
    const raw = asJsonBlock({
      ...BASE_ENGINEER,
      constraints: [{ id: 'c1', text: '', source: 'prompt' }],
    });
    const result = parseCompletionReport(raw) as EngineerReport;
    expect(result.constraints).toEqual([]);
    expect(result.issues).toContain('Malformed constraints ignored: 1 entry.');
  });

  test('empty id string is filtered out', () => {
    const raw = asJsonBlock({
      ...BASE_ENGINEER,
      constraints: [{ id: '', text: 'valid text', source: 'prompt' }],
    });
    const result = parseCompletionReport(raw) as EngineerReport;
    expect(result.constraints).toEqual([]);
  });

  test('inherited source is rejected as obsolete', () => {
    const raw = asJsonBlock({
      ...BASE_ENGINEER,
      constraints: [{ id: 'c1', text: 'inherited constraint', source: 'inherited' }],
    });
    const result = parseCompletionReport(raw) as EngineerReport;
    expect(result.constraints).toEqual([]);
    expect(result.issues).toContain('Malformed constraints ignored: 1 entry.');
  });
});

describe('Reviewer report: missing constraintFindings field', () => {
  test('missing constraintFindings defaults to []', () => {
    const raw = asJsonBlock({ ...BASE_REVIEWER }); // no constraintFindings field
    const result = parseCompletionReport(raw);
    expect(result).not.toBeNull();
    expect(result!.archetype).toBe('reviewer');
    const report = result as ReviewerReport;
    expect(report.constraintFindings).toEqual([]);
  });
});

describe('Reviewer report: malformed constraintFindings', () => {
  test('constraintFindings: string defaults to []', () => {
    const raw = asJsonBlock({ ...BASE_REVIEWER, constraintFindings: 'bad' });
    const result = parseCompletionReport(raw) as ReviewerReport;
    expect(result.constraintFindings).toEqual([]);
  });

  test('mixed well-formed and malformed findings: only well-formed pass through', () => {
    const wellFormed: ConstraintFinding = { constraintId: 'c1', satisfied: true, evidence: 'solid proof' };
    const malformed: Array<Record<string, unknown>> = [
      { satisfied: true, evidence: 'missing constraintId' },
      { constraintId: 'c2', satisfied: true },              // missing evidence
      { constraintId: 'c3', evidence: 'missing satisfied boolean' }, // missing satisfied
      { constraintId: 'c4', satisfied: 'yes', evidence: 'not a boolean' }, // non-boolean satisfied
    ];
    const raw = asJsonBlock({
      ...BASE_REVIEWER,
      constraintFindings: [wellFormed, ...malformed],
    });
    const result = parseCompletionReport(raw) as ReviewerReport;
    expect(result.constraintFindings).toHaveLength(1);
    expect(result.constraintFindings![0]?.constraintId).toBe('c1');
    expect(result.issues.some((issue) => issue.description === 'Malformed constraintFindings ignored: 4 entries; expected {constraintId:string,satisfied:boolean,evidence:string,severity?:critical|major|minor}.')).toBe(true);
  });

  test('invalid finding severity is omitted without dropping otherwise usable evidence', () => {
    const raw = asJsonBlock({
      ...BASE_REVIEWER,
      constraintFindings: [
        { constraintId: 'c1', satisfied: false, evidence: 'bad', severity: 'blocker' },
      ],
    });
    const result = parseCompletionReport(raw) as ReviewerReport;
    expect(result.constraintFindings).toEqual([
      { constraintId: 'c1', satisfied: false, evidence: 'bad' },
    ]);
    expect(result.issues).toEqual([]);
  });

  test('object and array evidence are normalized to strings', () => {
    const raw = asJsonBlock({
      ...BASE_REVIEWER,
      constraintFindings: [
        { constraintId: 'c1', satisfied: true, evidence: { file: 'src/a.ts', line: 12 } },
        { constraintId: 'c2', satisfied: false, evidence: ['missing assertion', 'no output'], severity: 'major' },
      ],
    });
    const result = parseCompletionReport(raw) as ReviewerReport;
    expect(result.constraintFindings).toEqual([
      { constraintId: 'c1', satisfied: true, evidence: '{"file":"src/a.ts","line":12}' },
      { constraintId: 'c2', satisfied: false, evidence: '["missing assertion","no output"]', severity: 'major' },
    ]);
    expect(result.issues).toEqual([]);
  });
});
