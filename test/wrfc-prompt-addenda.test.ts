/**
 * String-shape tests for the three WRFC prompt addendum builders.
 *
 * Verifies each builder:
 * - Returns a stable, complete string with required substrings.
 * - Is memoized (two calls return the same reference).
 * - Accepts zero arguments and returns a string.
 *
 * These are NOT semantic LLM tests — they only verify the shape of the text.
 */

import { describe, expect, test } from 'bun:test';
import {
  buildEngineerConstraintAddendum,
  buildReviewerConstraintAddendum,
  buildFixerConstraintAddendum,
} from '../packages/sdk/src/platform/agents/wrfc-prompt-addenda.js';

describe('buildEngineerConstraintAddendum', () => {
  test('contains non-build / unconstrained language', () => {
    const result = buildEngineerConstraintAddendum();
    expect(result).toContain('## Constraint enumeration');
    expect(result).toContain('non-build or unconstrained');
  });

  test('contains all four calibration examples', () => {
    const result = buildEngineerConstraintAddendum();
    // First example — no constraints
    expect(result).toContain('Write a function that adds two numbers');
    // Second example — three constraints
    expect(result).toContain('must be pure, no external deps, under 20 lines');
    // Third example — not a build task
    expect(result).toContain('What does this code do?');
    // Fourth example — two constraints (hooks + keep public exports)
    expect(result).toContain('Refactor this file to use hooks, keep public exports identical');
  });

  test('contains constraints:[] guidance', () => {
    const result = buildEngineerConstraintAddendum();
    expect(result).toContain('"constraints": []');
  });

  test('contains hard-cap language (~16 cap)', () => {
    const result = buildEngineerConstraintAddendum();
    expect(result).toContain('16');
  });

  test('contains issues[] unsatisfied-constraint clause', () => {
    const result = buildEngineerConstraintAddendum();
    expect(result).toContain('issues[]');
  });

  test('memoized — two calls return the same string reference', () => {
    const a = buildEngineerConstraintAddendum();
    const b = buildEngineerConstraintAddendum();
    expect(a === b).toBe(true);
  });

  test('accepts zero arguments and returns string', () => {
    const result = buildEngineerConstraintAddendum();
    expect(typeof result).toBe('string');
  });
});

describe('buildReviewerConstraintAddendum', () => {
  test('contains rubric-independence clause', () => {
    const result = buildReviewerConstraintAddendum();
    expect(result).toContain('## Constraint verification');
    expect(result).toContain('runs alongside the 10-dimension rubric, NOT instead of it');
  });

  test('contains the three numbered verification steps', () => {
    const result = buildReviewerConstraintAddendum();
    expect(result).toContain('1.');
    expect(result).toContain('2.');
    expect(result).toContain('3.');
  });

  test('contains severity rules', () => {
    const result = buildReviewerConstraintAddendum();
    expect(result).toContain('critical');
    expect(result).toContain('major');
    expect(result).toContain('minor');
  });

  test('contains the "constraint ambiguous, cannot verify" string', () => {
    const result = buildReviewerConstraintAddendum();
    expect(result).toContain('constraint ambiguous, cannot verify');
  });

  test('contains rubric-independence clause at the end', () => {
    const result = buildReviewerConstraintAddendum();
    // The clause about findings being independent of rubric dimensions
    expect(result).toContain('INDEPENDENT of the rubric dimensions');
  });

  test('memoized — two calls return the same string reference', () => {
    const a = buildReviewerConstraintAddendum();
    const b = buildReviewerConstraintAddendum();
    expect(a === b).toBe(true);
  });

  test('accepts zero arguments and returns string', () => {
    const result = buildReviewerConstraintAddendum();
    expect(typeof result).toBe('string');
  });
});

describe('buildFixerConstraintAddendum', () => {
  test('contains constraint preservation heading', () => {
    const result = buildFixerConstraintAddendum();
    expect(result).toContain('## Constraint preservation');
    expect(result).toContain('Constraint preservation during fix');
  });

  test('contains preserve-if-satisfied / satisfy-if-unsatisfied rule', () => {
    const result = buildFixerConstraintAddendum();
    expect(result).toContain('satisfied: true');
    expect(result).toContain('satisfied: false');
  });

  test('contains STOP-on-conflict clause', () => {
    const result = buildFixerConstraintAddendum();
    expect(result).toContain('STOP');
  });

  test('contains same-ids-same-text-same-order return protocol', () => {
    const result = buildFixerConstraintAddendum();
    expect(result).toContain('same ids, same text, same order');
  });

  test('memoized — two calls return the same string reference', () => {
    const a = buildFixerConstraintAddendum();
    const b = buildFixerConstraintAddendum();
    expect(a === b).toBe(true);
  });

  test('accepts zero arguments and returns string', () => {
    const result = buildFixerConstraintAddendum();
    expect(typeof result).toBe('string');
  });
});
