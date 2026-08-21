/**
 * rules.ts, the v1 predicate set, evaluated as pure functions over the state
 * ring buffer each trigger already persists.
 *
 * Every rule takes (observations, ruleState, now) and returns a decision plus
 * the next rule state. Nothing here does I/O, nothing here holds a timer, and
 * nothing here mutates its input, which is what makes the whole set testable
 * without a running daemon and safe to re-evaluate after a restart.
 *
 * The nine rules:
 *   change              value differs from the previous observation
 *   value               comparison against a fixed operand (edge or level)
 *   transition          one specific previous -> current pair
 *   threshold           enter/exit band, so a value hovering on the line
 *                       cannot flap the trigger (hysteresis)
 *   debounce-n          inner rule must match N consecutive checks
 *   dedup-ttl           inner rule fires at most once per fingerprint per TTL
 *   rate-of-change      delta across a time window, per second or per minute
 *   windowed-aggregate  min/max/mean/sum/count/stddev over a time window
 *   correlation         other triggers' fires inside a window, read from the
 *                       bounded shared event log
 */

import { stableText } from './extract.js';
import type {
  ComparisonOperator,
  CorrelationRule,
  TriggerEventLogEntry,
  TriggerObservation,
  TriggerRule,
  TriggerRuleState,
  TriggerValue,
} from './types.js';
import { validateRegexSource } from './validation.js';

export interface RuleEvaluationContext {
  /** Newest last. The rule reads whatever depth the ring buffer retains. */
  readonly observations: readonly TriggerObservation[];
  readonly ruleState: TriggerRuleState;
  readonly now: number;
  /** Bounded shared event log, the only channel correlation can read. */
  readonly eventLog: readonly TriggerEventLogEntry[];
  /** Excluded from its own correlation window. */
  readonly selfTriggerId: string;
}

export interface RuleDecision {
  readonly fire: boolean;
  readonly ruleState: TriggerRuleState;
  /** Human-readable why, recorded on the run record either way. */
  readonly reason: string;
  /** Identity used by dedup-ttl and by the shared event log. */
  readonly fingerprint: string;
}

function latest(context: RuleEvaluationContext): TriggerObservation | undefined {
  return context.observations[context.observations.length - 1];
}

function previous(context: RuleEvaluationContext): TriggerObservation | undefined {
  return context.observations[context.observations.length - 2];
}

export function compare(operator: ComparisonOperator, left: TriggerValue, right: TriggerValue): boolean {
  const leftText = stableText(left);
  const rightText = stableText(right);
  const leftNum = typeof left === 'number' ? left : Number(leftText);
  const rightNum = typeof right === 'number' ? right : Number(rightText);
  const numeric = Number.isFinite(leftNum) && Number.isFinite(rightNum);

  switch (operator) {
    case 'eq':
      return numeric ? leftNum === rightNum : leftText === rightText;
    case 'ne':
      return numeric ? leftNum !== rightNum : leftText !== rightText;
    case 'lt':
      return numeric && leftNum < rightNum;
    case 'lte':
      return numeric && leftNum <= rightNum;
    case 'gt':
      return numeric && leftNum > rightNum;
    case 'gte':
      return numeric && leftNum >= rightNum;
    case 'contains':
      return leftText.includes(rightText);
    case 'not-contains':
      return !leftText.includes(rightText);
    case 'matches':
      return validateRegexSource(rightText, 'rule.operand').test(leftText);
    default:
      return false;
  }
}

function windowSlice(context: RuleEvaluationContext, windowMs: number): TriggerObservation[] {
  const cutoff = context.now - windowMs;
  return context.observations.filter((entry) => entry.at >= cutoff);
}

function aggregate(kind: string, samples: readonly number[]): number | null {
  if (samples.length === 0) return kind === 'count' ? 0 : null;
  switch (kind) {
    case 'count':
      return samples.length;
    case 'min':
      return Math.min(...samples);
    case 'max':
      return Math.max(...samples);
    case 'sum':
      return samples.reduce((total, value) => total + value, 0);
    case 'mean':
      return samples.reduce((total, value) => total + value, 0) / samples.length;
    case 'stddev': {
      const mean = samples.reduce((total, value) => total + value, 0) / samples.length;
      const variance = samples.reduce((total, value) => total + (value - mean) ** 2, 0) / samples.length;
      return Math.sqrt(variance);
    }
    default:
      return null;
  }
}

function pruneDedupMarks(
  marks: Readonly<Record<string, number>> | undefined,
  now: number,
  ttlMs: number,
): Record<string, number> {
  const next: Record<string, number> = {};
  for (const [key, at] of Object.entries(marks ?? {})) {
    if (now - at < ttlMs) next[key] = at;
  }
  return next;
}

function evaluateCorrelation(rule: CorrelationRule, context: RuleEvaluationContext): RuleDecision {
  const cutoff = context.now - rule.withinMs;
  const fires = context.eventLog
    .filter((entry) => entry.event === 'fired' && entry.at >= cutoff && entry.triggerId !== context.selfTriggerId)
    .sort((a, b) => a.at - b.at);
  const seen = new Set(fires.map((entry) => entry.triggerId));
  const fingerprint = `correlation:${rule.require}:${rule.triggerIds.join('+')}`;

  if (rule.require === 'any') {
    const hit = rule.triggerIds.find((id) => seen.has(id));
    return {
      fire: hit !== undefined,
      ruleState: context.ruleState,
      reason: hit ? `correlated trigger ${hit} fired within ${rule.withinMs}ms` : 'no correlated trigger fired in the window',
      fingerprint,
    };
  }

  if (rule.require === 'all') {
    const missing = rule.triggerIds.filter((id) => !seen.has(id));
    return {
      fire: missing.length === 0,
      ruleState: context.ruleState,
      reason: missing.length === 0
        ? `all of ${rule.triggerIds.join(', ')} fired within ${rule.withinMs}ms`
        : `still waiting on ${missing.join(', ')}`,
      fingerprint,
    };
  }

  // sequence, the named triggers must have fired in the listed order.
  let cursor = 0;
  for (const entry of fires) {
    if (entry.triggerId === rule.triggerIds[cursor]) cursor += 1;
    if (cursor === rule.triggerIds.length) break;
  }
  return {
    fire: cursor === rule.triggerIds.length,
    ruleState: context.ruleState,
    reason: cursor === rule.triggerIds.length
      ? `sequence ${rule.triggerIds.join(' -> ')} completed within ${rule.withinMs}ms`
      : `sequence reached ${cursor}/${rule.triggerIds.length} (next: ${rule.triggerIds[cursor] ?? 'n/a'})`,
    fingerprint,
  };
}

/** Evaluates one rule. Pure: same inputs, same decision, no side effects. */
export function evaluateRule(rule: TriggerRule, context: RuleEvaluationContext): RuleDecision {
  const current = latest(context);
  const prior = previous(context);
  const state = context.ruleState;

  switch (rule.kind) {
    case 'change': {
      if (!current) {
        return { fire: false, ruleState: state, reason: 'no observation yet', fingerprint: 'change:none' };
      }
      if (!prior) {
        return {
          fire: rule.fireOnFirst === true,
          ruleState: state,
          reason: rule.fireOnFirst === true ? 'first observation (fireOnFirst)' : 'first observation, nothing to compare against',
          fingerprint: `change:${current.text}`,
        };
      }
      const changed = prior.text !== current.text;
      return {
        fire: changed,
        ruleState: state,
        reason: changed ? `value changed ${prior.text} -> ${current.text}` : 'value unchanged',
        fingerprint: `change:${prior.text}->${current.text}`,
      };
    }

    case 'value': {
      if (!current) {
        return { fire: false, ruleState: state, reason: 'no observation yet', fingerprint: 'value:none' };
      }
      const matched = compare(rule.operator, current.value, rule.operand);
      const nextState: TriggerRuleState = { ...state, lastMatched: matched };
      if (rule.level === true) {
        return {
          fire: matched,
          ruleState: nextState,
          reason: matched ? `${current.text} ${rule.operator} ${stableText(rule.operand)}` : 'comparison did not hold',
          fingerprint: `value:${current.text}`,
        };
      }
      const rising = matched && state.lastMatched !== true;
      return {
        fire: rising,
        ruleState: nextState,
        reason: rising
          ? `entered ${rule.operator} ${stableText(rule.operand)} at ${current.text}`
          : matched ? 'still matching (edge already consumed)' : 'comparison did not hold',
        fingerprint: `value:${current.text}`,
      };
    }

    case 'transition': {
      if (!current || !prior) {
        return { fire: false, ruleState: state, reason: 'need two observations for a transition', fingerprint: 'transition:none' };
      }
      const hit = prior.text === rule.from && current.text === rule.to;
      return {
        fire: hit,
        ruleState: state,
        reason: hit ? `transitioned ${rule.from} -> ${rule.to}` : `no ${rule.from} -> ${rule.to} transition (saw ${prior.text} -> ${current.text})`,
        fingerprint: `transition:${rule.from}->${rule.to}`,
      };
    }

    case 'threshold': {
      if (!current || current.numeric === null) {
        return { fire: false, ruleState: state, reason: 'observation is not numeric', fingerprint: 'threshold:none' };
      }
      const value = current.numeric;
      const armed = state.armed === true;
      const entering = rule.direction === 'above' ? value > rule.enter : value < rule.enter;
      const leaving = rule.direction === 'above' ? value < rule.exit : value > rule.exit;
      if (!armed && entering) {
        return {
          fire: true,
          ruleState: { ...state, armed: true },
          reason: `crossed ${rule.direction} ${rule.enter} at ${value}`,
          fingerprint: `threshold:${rule.direction}:${rule.enter}`,
        };
      }
      if (armed && leaving) {
        return {
          fire: false,
          ruleState: { ...state, armed: false },
          reason: `fell back past the ${rule.exit} re-arm bound at ${value}`,
          fingerprint: `threshold:${rule.direction}:${rule.enter}`,
        };
      }
      return {
        fire: false,
        ruleState: state,
        reason: armed ? `still ${rule.direction} the band at ${value}` : `inside the band at ${value}`,
        fingerprint: `threshold:${rule.direction}:${rule.enter}`,
      };
    }

    case 'debounce-n': {
      const inner = evaluateRule(rule.inner, { ...context, ruleState: state });
      const streak = inner.fire ? (state.streak ?? 0) + 1 : 0;
      const ready = streak >= rule.count;
      return {
        fire: ready,
        ruleState: { ...inner.ruleState, streak: ready ? 0 : streak },
        reason: ready
          ? `inner rule matched ${rule.count} consecutive checks (${inner.reason})`
          : `debounce ${streak}/${rule.count} (${inner.reason})`,
        fingerprint: inner.fingerprint,
      };
    }

    case 'dedup-ttl': {
      const inner = evaluateRule(rule.inner, { ...context, ruleState: state });
      const marks = pruneDedupMarks(state.dedupMarks, context.now, rule.ttlMs);
      if (!inner.fire) {
        return { ...inner, ruleState: { ...inner.ruleState, dedupMarks: marks } };
      }
      const lastAt = marks[inner.fingerprint];
      if (lastAt !== undefined && context.now - lastAt < rule.ttlMs) {
        return {
          fire: false,
          ruleState: { ...inner.ruleState, dedupMarks: marks },
          reason: `suppressed: already fired for "${inner.fingerprint}" ${context.now - lastAt}ms ago (TTL ${rule.ttlMs}ms)`,
          fingerprint: inner.fingerprint,
        };
      }
      return {
        fire: true,
        ruleState: { ...inner.ruleState, dedupMarks: { ...marks, [inner.fingerprint]: context.now } },
        reason: inner.reason,
        fingerprint: inner.fingerprint,
      };
    }

    case 'rate-of-change': {
      const window = windowSlice(context, rule.windowMs).filter((entry) => entry.numeric !== null);
      if (window.length < 2) {
        return { fire: false, ruleState: state, reason: 'need two numeric samples in the window', fingerprint: 'rate:none' };
      }
      const first = window[0]!;
      const last = window[window.length - 1]!;
      const elapsedMs = Math.max(1, last.at - first.at);
      const perMs = ((last.numeric ?? 0) - (first.numeric ?? 0)) / elapsedMs;
      const rate = rule.per === 'minute' ? perMs * 60_000 : perMs * 1_000;
      const hit = compare(rule.operator, rate, rule.operand);
      return {
        fire: hit,
        ruleState: state,
        reason: `rate ${rate.toFixed(4)}/${rule.per ?? 'second'} over ${elapsedMs}ms ${hit ? 'satisfied' : 'did not satisfy'} ${rule.operator} ${rule.operand}`,
        fingerprint: `rate:${rule.operator}:${rule.operand}`,
      };
    }

    case 'windowed-aggregate': {
      const window = windowSlice(context, rule.windowMs);
      const samples = window.map((entry) => entry.numeric).filter((value): value is number => value !== null);
      const minSamples = rule.minSamples ?? 1;
      if (rule.aggregate !== 'count' && samples.length < minSamples) {
        return {
          fire: false,
          ruleState: state,
          reason: `only ${samples.length}/${minSamples} numeric samples in the ${rule.windowMs}ms window`,
          fingerprint: `agg:${rule.aggregate}`,
        };
      }
      const computed = aggregate(rule.aggregate, rule.aggregate === 'count' ? window.map(() => 1) : samples);
      if (computed === null) {
        return { fire: false, ruleState: state, reason: 'aggregate is undefined for this window', fingerprint: `agg:${rule.aggregate}` };
      }
      const hit = compare(rule.operator, computed, rule.operand);
      return {
        fire: hit,
        ruleState: state,
        reason: `${rule.aggregate}=${computed} over ${window.length} samples ${hit ? 'satisfied' : 'did not satisfy'} ${rule.operator} ${rule.operand}`,
        fingerprint: `agg:${rule.aggregate}:${rule.operator}:${rule.operand}`,
      };
    }

    case 'correlation':
      return evaluateCorrelation(rule, context);

    default:
      return { fire: false, ruleState: state, reason: 'unknown rule kind', fingerprint: 'unknown' };
  }
}
