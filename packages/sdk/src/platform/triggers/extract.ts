/**
 * extract.ts, turning a probe result into one observation.
 *
 * Three extractors, all bounded and all pure:
 *   jsonpath , `$`, `.key`, `["key"]`, `[0]`, `[*]` against parsed JSON
 *   regex    , one match, optionally a capture group
 *   jq-subset, a `.path[…]` selector optionally piped into length/keys/first/last
 *
 * None of them evaluates an expression. `jq-subset` is a hand-written walker
 * over a validated selector grammar, not a jq interpreter, precisely so there
 * is no expression language to escape from.
 */

import type { TriggerExtract, TriggerObservation, TriggerValue } from './types.js';
import { validateRegexSource } from './validation.js';

/** Deterministic string form used by change / transition / dedup comparisons. */
export function stableText(value: TriggerValue): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(stableText).join(',')}]`;
  const entries = Object.entries(value as Record<string, TriggerValue>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, entry]) => `${key}:${stableText(entry)}`).join(',')}}`;
}

/** Numeric coercion, or null when the value simply is not a number. */
export function numericOf(value: TriggerValue): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (Array.isArray(value)) return value.length;
  return null;
}

export function toObservation(value: TriggerValue, at: number): TriggerObservation {
  return { at, value, text: stableText(value), numeric: numericOf(value) };
}

function parseJsonIfPossible(input: TriggerValue): TriggerValue {
  if (typeof input !== 'string') return input;
  const trimmed = input.trim();
  if (trimmed.length === 0) return input;
  const first = trimmed[0];
  if (first !== '{' && first !== '[' && first !== '"' && !/^-?\d/.test(trimmed) && trimmed !== 'true' && trimmed !== 'false' && trimmed !== 'null') {
    return input;
  }
  try {
    return JSON.parse(trimmed) as TriggerValue;
  } catch {
    return input;
  }
}

interface PathStep {
  readonly kind: 'key' | 'index' | 'wildcard';
  readonly key?: string;
  readonly index?: number;
}

/** Parses the validated JSONPath subset into steps. Never sees untrusted syntax. */
function parseJsonPath(path: string): PathStep[] {
  const steps: PathStep[] = [];
  let cursor = 1; // skip the leading `$`
  while (cursor < path.length) {
    const char = path[cursor];
    if (char === '.') {
      const end = findNext(path, cursor + 1);
      steps.push({ kind: 'key', key: path.slice(cursor + 1, end) });
      cursor = end;
      continue;
    }
    if (char === '[') {
      const close = path.indexOf(']', cursor);
      if (close === -1) break;
      const inner = path.slice(cursor + 1, close);
      if (inner === '*') {
        steps.push({ kind: 'wildcard' });
      } else if (inner.startsWith('"')) {
        steps.push({ kind: 'key', key: inner.slice(1, -1) });
      } else {
        steps.push({ kind: 'index', index: Number(inner) });
      }
      cursor = close + 1;
      continue;
    }
    cursor += 1;
  }
  return steps;
}

function findNext(path: string, from: number): number {
  for (let index = from; index < path.length; index += 1) {
    const char = path[index];
    if (char === '.' || char === '[') return index;
  }
  return path.length;
}

function applySteps(input: TriggerValue, steps: readonly PathStep[]): TriggerValue {
  let current: TriggerValue = input;
  for (const step of steps) {
    if (current === null || current === undefined) return null;
    if (step.kind === 'wildcard') {
      if (Array.isArray(current)) return current as TriggerValue;
      if (typeof current === 'object') return Object.values(current as Record<string, TriggerValue>);
      return null;
    }
    if (step.kind === 'index') {
      if (!Array.isArray(current)) return null;
      const entry = current[step.index ?? 0];
      current = entry === undefined ? null : entry;
      continue;
    }
    if (typeof current !== 'object' || Array.isArray(current)) return null;
    const entry = (current as Record<string, TriggerValue>)[step.key ?? ''];
    current = entry === undefined ? null : entry;
  }
  return current;
}

/**
 * Parses the validated jq subset into the same step list plus an optional
 * terminal filter. `.a.b[0] | length` becomes steps + 'length'.
 */
function parseJqSubset(expression: string): { steps: PathStep[]; filter: string | null } {
  const [selectorPart, filterPart] = expression.split('|');
  const selector = (selectorPart ?? '').trim();
  const filter = filterPart ? filterPart.trim() : null;
  const steps: PathStep[] = [];
  let cursor = 0;
  while (cursor < selector.length) {
    const char = selector[cursor];
    if (char === '.') {
      const end = findNext(selector, cursor + 1);
      const key = selector.slice(cursor + 1, end);
      if (key.length > 0) steps.push({ kind: 'key', key });
      cursor = end;
      continue;
    }
    if (char === '[') {
      const close = selector.indexOf(']', cursor);
      if (close === -1) break;
      const inner = selector.slice(cursor + 1, close);
      steps.push(inner.length === 0 ? { kind: 'wildcard' } : { kind: 'index', index: Number(inner) });
      cursor = close + 1;
      continue;
    }
    cursor += 1;
  }
  return { steps, filter };
}

function applyJqFilter(value: TriggerValue, filter: string): TriggerValue {
  switch (filter) {
    case 'length':
      if (Array.isArray(value)) return value.length;
      if (typeof value === 'string') return value.length;
      if (value !== null && typeof value === 'object') return Object.keys(value as Record<string, TriggerValue>).length;
      return 0;
    case 'keys':
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        return Object.keys(value as Record<string, TriggerValue>).sort();
      }
      return [];
    case 'first':
      return Array.isArray(value) ? (value[0] ?? null) : value;
    case 'last':
      return Array.isArray(value) ? (value[value.length - 1] ?? null) : value;
    default:
      return value;
  }
}

/**
 * Runs one extractor over a probe result. Throws nothing on a miss, a miss is
 * `null`, which is a perfectly good observation for a `change` rule to see.
 */
export function runExtract(extract: TriggerExtract, input: TriggerValue): TriggerValue {
  switch (extract.kind) {
    case 'raw':
      return input;
    case 'jsonpath': {
      const parsed = parseJsonIfPossible(input);
      return applySteps(parsed, parseJsonPath(extract.path));
    }
    case 'jq-subset': {
      const parsed = parseJsonIfPossible(input);
      const { steps, filter } = parseJqSubset(extract.expression);
      const selected = applySteps(parsed, steps);
      return filter ? applyJqFilter(selected, filter) : selected;
    }
    case 'regex': {
      const source = typeof input === 'string' ? input : stableText(input);
      const regex = validateRegexSource(extract.pattern, 'extract', extract.flags);
      const match = regex.exec(source);
      if (!match) return null;
      const group = extract.group ?? 0;
      return match[group] ?? null;
    }
    default:
      return null;
  }
}
