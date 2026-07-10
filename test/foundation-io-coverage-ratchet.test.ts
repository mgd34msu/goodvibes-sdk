/**
 * foundation-io-coverage-ratchet.test.ts
 *
 * Behaviour coverage for the typed-IO coverage ratchet's pure rule functions
 * (scripts/foundation-io-coverage-rule.ts) plus a live-source assertion that
 * the checked-in baseline matches reality — so a future contract change that
 * moves the untyped count without updating the baseline fails here too, not
 * only under `contracts:check`.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  evaluateRatchet,
  parseMapKeys,
  parseMethodIds,
  untypedMethodIds,
} from '../scripts/foundation-io-coverage-rule.ts';
import { FOUNDATION_IO_COVERAGE_BASELINE } from '../scripts/foundation-io-coverage-baseline.ts';

const ROOT = resolve(import.meta.dir, '..');

describe('foundation-io coverage ratchet — pure rule', () => {
  const idsFixture = [
    'export const OPERATOR_METHOD_IDS = [',
    '  "a.create",',
    '  "a.list",',
    '  "b.get",',
    '  "c.snapshot",',
    '] as const;',
  ].join('\n');

  const typesFixture = [
    'export interface OperatorMethodInputMap {',
    '  "a.create": { x: string; };',
    '  "a.list": {  };',
    '  "b.get": { id: string; };',
    '}',
    '',
    'export interface OperatorMethodOutputMap {',
    '  "a.create": { ok: boolean; };',
    '  "a.list": { items: readonly string[]; };',
    '  "b.get": { id: string; };',
    '}',
  ].join('\n');

  test('parseMethodIds pulls every dotted id', () => {
    expect(parseMethodIds(idsFixture)).toEqual(['a.create', 'a.list', 'b.get', 'c.snapshot']);
  });

  test('parseMapKeys pulls only the named map block', () => {
    expect([...parseMapKeys(typesFixture, 'OperatorMethodInputMap')].sort()).toEqual(['a.create', 'a.list', 'b.get']);
    expect([...parseMapKeys(typesFixture, 'OperatorMethodOutputMap')].sort()).toEqual(['a.create', 'a.list', 'b.get']);
  });

  test('untypedMethodIds flags ids missing from either map (c.snapshot has neither)', () => {
    const ids = parseMethodIds(idsFixture);
    const input = parseMapKeys(typesFixture, 'OperatorMethodInputMap');
    const output = parseMapKeys(typesFixture, 'OperatorMethodOutputMap');
    expect(untypedMethodIds(ids, input, output)).toEqual(['c.snapshot']);
  });

  test('a method present in only ONE map still counts as untyped', () => {
    const ids = ['x.only-input'];
    const input = new Set(['x.only-input']);
    const output = new Set<string>();
    expect(untypedMethodIds(ids, input, output)).toEqual(['x.only-input']);
  });

  test('evaluateRatchet: equal passes, increase and decrease both fail', () => {
    expect(evaluateRatchet(97, 97)).toEqual({ direction: 'ok', current: 97, baseline: 97, ok: true });
    expect(evaluateRatchet(98, 97).direction).toBe('increased');
    expect(evaluateRatchet(98, 97).ok).toBe(false);
    expect(evaluateRatchet(96, 97).direction).toBe('decreased');
    expect(evaluateRatchet(96, 97).ok).toBe(false);
  });
});

describe('foundation-io coverage ratchet — live source', () => {
  test('the checked-in baseline equals the real untyped count', () => {
    const idsText = readFileSync(resolve(ROOT, 'packages/contracts/src/generated/operator-method-ids.ts'), 'utf8');
    const typesText = readFileSync(resolve(ROOT, 'packages/contracts/src/generated/foundation-client-types.ts'), 'utf8');
    const ids = parseMethodIds(idsText);
    const input = parseMapKeys(typesText, 'OperatorMethodInputMap');
    const output = parseMapKeys(typesText, 'OperatorMethodOutputMap');
    const untyped = untypedMethodIds(ids, input, output);
    // If this fails, either add typed IO entries (count rose) or update the
    // baseline (count fell) — the ratchet's own message says which.
    expect(untyped.length).toBe(FOUNDATION_IO_COVERAGE_BASELINE);
    expect(evaluateRatchet(untyped.length, FOUNDATION_IO_COVERAGE_BASELINE).ok).toBe(true);
  });

  test('the covered restore verbs are among the fully-typed set (Item 1 regression net)', () => {
    const idsText = readFileSync(resolve(ROOT, 'packages/contracts/src/generated/operator-method-ids.ts'), 'utf8');
    const typesText = readFileSync(resolve(ROOT, 'packages/contracts/src/generated/foundation-client-types.ts'), 'utf8');
    const ids = parseMethodIds(idsText);
    const input = parseMapKeys(typesText, 'OperatorMethodInputMap');
    const output = parseMapKeys(typesText, 'OperatorMethodOutputMap');
    const untyped = new Set(untypedMethodIds(ids, input, output));
    expect(ids).toContain('checkpoints.restorePreview');
    expect(untyped.has('checkpoints.restore')).toBe(false);
    expect(untyped.has('checkpoints.restorePreview')).toBe(false);
  });
});
