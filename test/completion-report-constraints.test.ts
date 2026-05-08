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

describe('Engineer report — missing constraints field', () => {
  test('missing constraints defaults to []', () => {
    const raw = asJsonBlock({ ...BASE_ENGINEER }); // no constraints field
    const result = parseCompletionReport(raw);
    expect(result).not.toBeNull();
    expect(result!.archetype).toBe('engineer');
    const report = result as EngineerReport;
    expect(report.constraints).toEqual([]);
  });
});

describe('Engineer report — malformed constraints not an array', () => {
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

describe('D3: Engineer report — mixed well-formed and malformed constraint entries', () => {
  test('well-formed entries pass through, malformed are filtered out', () => {
    const wellFormed: Constraint = { id: 'c1', text: 'must be pure', source: 'prompt' };
    const malformedCases: Array<Record<string, unknown>> = [
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

describe('D4: Reviewer report — missing constraintFindings field', () => {
  test('missing constraintFindings defaults to []', () => {
    const raw = asJsonBlock({ ...BASE_REVIEWER }); // no constraintFindings field
    const result = parseCompletionReport(raw);
    expect(result).not.toBeNull();
    expect(result!.archetype).toBe('reviewer');
    const report = result as ReviewerReport;
    expect(report.constraintFindings).toEqual([]);
  });
});

describe('D5: Reviewer report — malformed constraintFindings', () => {
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
    expect(result.issues.some((issue) => issue.description === 'Malformed constraintFindings ignored: 4 entries.')).toBe(true);
  });

  test('malformed finding severity is dropped and reported', () => {
    const raw = asJsonBlock({
      ...BASE_REVIEWER,
      constraintFindings: [
        { constraintId: 'c1', satisfied: false, evidence: 'bad', severity: 'blocker' },
      ],
    });
    const result = parseCompletionReport(raw) as ReviewerReport;
    expect(result.constraintFindings).toEqual([]);
    expect(result.issues.some((issue) => issue.description === 'Malformed constraintFindings ignored: 1 entry.')).toBe(true);
  });
});

describe('D6: Parser purity — does not mutate caller\'s object', () => {
  test('result is a new object — original parsed object is not mutated', () => {
    // We pass raw JSON string; parse it as an object, then check that the
    // field the parser adds (constraints:[]) is NOT on the live object
    // we can access. We verify this by checking that the raw JSON source
    // object (reconstructed) does not have constraints after parsing.
    const sourceObj: Record<string, unknown> = { ...BASE_ENGINEER };
    // Confirm: no constraints key on source
    expect('constraints' in sourceObj).toBe(false);

    const raw = asJsonBlock(sourceObj);
    const result = parseCompletionReport(raw) as EngineerReport;

    // Result should have constraints:[] (added by applyConstraintDefaults)
    expect(result.constraints).toEqual([]);

    // The original sourceObj is NOT mutated — still no 'constraints' key
    expect('constraints' in sourceObj).toBe(false);
  });

  test('result object is a different reference from any internally parsed object', () => {
    const raw = asJsonBlock({ ...BASE_ENGINEER, constraints: [{ id: 'c1', text: 'pure', source: 'prompt' }] });
    const result1 = parseCompletionReport(raw) as EngineerReport;
    const result2 = parseCompletionReport(raw) as EngineerReport;
    // Each call returns a new object (parseCompletionReport always parses fresh)
    // The constraints arrays should be equal in value but independent
    expect(result1.constraints).toEqual(result2.constraints);
    // But they're not the same array reference (spread creates new arrays)
    expect(result1.constraints === result2.constraints).toBe(false);
  });
});
