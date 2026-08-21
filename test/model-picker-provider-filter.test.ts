/**
 * model-picker-provider-filter.test.ts, groupProviders / filterProviders.
 *
 * Two properties matter here and neither is obvious from the signatures:
 * grouping is case-insensitive on membership but preserves the caller's
 * casing in the output, and the popular group always precedes the rest
 * regardless of alphabetical order across the two groups. A picker that
 * alphabetized the flattened list instead would scatter the popular entries.
 */
import { describe, expect, test } from 'bun:test';
import {
  POPULAR_PROVIDERS,
  filterProviders,
  groupProviders,
} from '@pellux/goodvibes-terminal-shell';

describe('POPULAR_PROVIDERS', () => {
  test('is a non-empty set of lower-cased ids', () => {
    expect(POPULAR_PROVIDERS.size).toBeGreaterThan(0);
    for (const id of POPULAR_PROVIDERS) {
      expect(id).toBe(id.toLowerCase());
    }
  });
});

describe('groupProviders', () => {
  test('splits into popular and everything else', () => {
    const { popular, all } = groupProviders(['openai', 'zeta-labs', 'anthropic']);
    expect(popular).toEqual(['anthropic', 'openai']);
    expect(all).toEqual(['zeta-labs']);
  });

  test('alphabetizes each group independently', () => {
    const { popular, all } = groupProviders(['openai', 'anthropic', 'zulu', 'alpha']);
    expect(popular).toEqual([...popular].sort((a, b) => a.localeCompare(b)));
    expect(all).toEqual(['alpha', 'zulu']);
  });

  test('membership is case-insensitive but the caller casing survives', () => {
    const { popular, all } = groupProviders(['OpenAI', 'ANTHROPIC']);
    expect(all).toEqual([]);
    expect(popular).toEqual(['ANTHROPIC', 'OpenAI']);
  });

  test('empty input yields two empty groups', () => {
    expect(groupProviders([])).toEqual({ popular: [], all: [] });
  });

  test('never drops or duplicates an entry', () => {
    const input = ['openai', 'zeta', 'anthropic', 'zeta'];
    const { popular, all } = groupProviders(input);
    expect(popular.length + all.length).toBe(input.length);
  });
});

describe('filterProviders', () => {
  test('an empty query returns popular-first order, not plain alphabetical', () => {
    expect(filterProviders(['zeta', 'openai', 'alpha'], '')).toEqual(['openai', 'alpha', 'zeta']);
  });

  test('whitespace-only queries are treated as empty', () => {
    expect(filterProviders(['zeta', 'openai'], '   ')).toEqual(['openai', 'zeta']);
  });

  test('matches on case-insensitive substring, not prefix', () => {
    expect(filterProviders(['openai', 'openrouter', 'zeta'], 'ROUT')).toEqual(['openrouter']);
    expect(filterProviders(['openai', 'openrouter'], 'open')).toEqual(['openai', 'openrouter']);
  });

  test('a query matching nothing returns an empty list', () => {
    expect(filterProviders(['openai', 'zeta'], 'nothing-here')).toEqual([]);
  });

  test('filtering preserves the popular-first ordering of what remains', () => {
    expect(filterProviders(['azeta', 'anthropic', 'abc'], 'a')).toEqual(['anthropic', 'abc', 'azeta']);
  });
});
