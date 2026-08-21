/**
 * trigger-dsl-rules.test.ts, the declarative trigger DSL and its predicate set.
 *
 * Two things are under test here. First, that the DSL really is declarative:
 * every shape a caller might use to smuggle executable code into an unattended
 * watcher is refused at validation, not defended against later. Second, that
 * all nine v1 rules behave as their names claim over the persisted ring buffer.
 */
import { describe, expect, test } from 'bun:test';
import {
  evaluateRule,
  runExtract,
  toObservation,
  TriggerDefinitionError,
  validateAction,
  validateDefinition,
  validateExtract,
  validateProbe,
  validateRule,
  type TriggerEventLogEntry,
  type TriggerObservation,
  type TriggerRule,
  type TriggerRuleState,
} from '../packages/sdk/src/platform/triggers/index.ts';

function observations(samples: ReadonlyArray<[number, unknown]>): TriggerObservation[] {
  return samples.map(([at, value]) => toObservation(value as never, at));
}

function decide(
  rule: TriggerRule,
  obs: TriggerObservation[],
  ruleState: TriggerRuleState = {},
  now = 10_000,
  eventLog: TriggerEventLogEntry[] = [],
) {
  return evaluateRule(rule, { observations: obs, ruleState, now, eventLog, selfTriggerId: 'self' });
}

describe('the trigger DSL refuses arbitrary code', () => {
  test('a function anywhere in a definition is refused, not coerced', () => {
    expect(() => validateProbe({ kind: 'command', command: 'echo', args: ['hi'], cwd: () => '/tmp' }))
      .toThrow(/must not be a function/);
    expect(() => validateRule({ kind: 'value', operator: 'eq', operand: () => 1 }))
      .toThrow(/must not be a function/);
  });

  test('js / eval / script / shell probe kinds are named and refused', () => {
    for (const kind of ['js', 'javascript', 'eval', 'expression', 'script', 'shell', 'function']) {
      expect(() => validateProbe({ kind, source: 'return 1' })).toThrow(TriggerDefinitionError);
    }
    expect(() => validateProbe({ kind: 'js', source: '1+1' })).toThrow(/declarative/);
    expect(() => validateProbe({ kind: 'shell', source: 'ls | wc -l' })).toThrow(/argv and no shell/);
  });

  test('a fire action may not compose a command at fire time', () => {
    for (const kind of ['shell', 'command', 'exec', 'js', 'eval']) {
      expect(() => validateAction({ kind, command: 'rm -rf /tmp/x' })).toThrow(TriggerDefinitionError);
    }
    expect(() => validateAction({ kind: 'shell', command: 'true' }))
      .toThrow(/Pre-register an action grant instead/);
    expect(() => validateAction({ kind: 'wat' }))
      .toThrow(/never a newly composed command/);
  });

  test('the two permitted fire actions are accepted', () => {
    expect(validateAction({ kind: 'agent-turn', prompt: 'look at this' }).kind).toBe('agent-turn');
    expect(validateAction({ kind: 'action-grant', grantId: 'g1', digest: 'abc' }).kind).toBe('action-grant');
  });

  test('a command probe is argv-only — no shell string smuggling', () => {
    // The shape is command + args; there is no field that becomes a shell line.
    const probe = validateProbe({ kind: 'command', command: 'git', args: ['status', '--porcelain'] });
    expect(probe.kind).toBe('command');
    expect(() => validateProbe({ kind: 'command', command: 'echo\nrm -rf /' })).toThrow(/newlines/);
    expect(() => validateProbe({ kind: 'command', command: 'echo', args: [42] })).toThrow(/must be a string/);
  });

  test('regex extracts refuse stateful g/y flags and invalid sources', () => {
    expect(() => validateExtract({ kind: 'regex', pattern: 'a', flags: 'g' })).toThrow(/lastIndex state/);
    expect(() => validateExtract({ kind: 'regex', pattern: 'a', flags: 'y' })).toThrow(/lastIndex state/);
    expect(() => validateExtract({ kind: 'regex', pattern: '([' })).toThrow(/not a valid regular expression/);
    expect(validateExtract({ kind: 'regex', pattern: 'ERROR', flags: 'i' }).kind).toBe('regex');
  });

  test('jsonpath and jq-subset accept only their documented grammars', () => {
    expect(validateExtract({ kind: 'jsonpath', path: '$.a.b[0]' }).kind).toBe('jsonpath');
    expect(() => validateExtract({ kind: 'jsonpath', path: '$..a' })).toThrow(/supported JSONPath subset/);
    expect(() => validateExtract({ kind: 'jsonpath', path: '$[?(@.a>1)]' })).toThrow(/supported JSONPath subset/);
    expect(validateExtract({ kind: 'jq-subset', expression: '.items | length' }).kind).toBe('jq-subset');
    expect(() => validateExtract({ kind: 'jq-subset', expression: '.a | map(.b) | add' })).toThrow(/supported jq subset/);
  });

  test('an on-exit trigger has no interactive stdin option', () => {
    expect(() => validateDefinition({
      id: 'build',
      label: 'Build',
      spec: { kind: 'on-exit', command: 'make', stdin: 'inherit' },
      action: { kind: 'agent-turn', prompt: 'x' },
    })).toThrow(/nobody is at the keyboard/);
  });

  test('a threshold without a re-arm band is refused at definition time', () => {
    expect(() => validateRule({ kind: 'threshold', direction: 'above', enter: 10, exit: 20 }))
      .toThrow(/hysteresis needs a re-arm band/);
    expect(validateRule({ kind: 'threshold', direction: 'above', enter: 90, exit: 80 }).kind).toBe('threshold');
  });
});

describe('extractors', () => {
  test('jsonpath walks objects, arrays and wildcards', () => {
    const body = JSON.stringify({ status: { code: 503 }, items: [{ n: 1 }, { n: 2 }] });
    expect(runExtract({ kind: 'jsonpath', path: '$.status.code' }, body)).toBe(503);
    expect(runExtract({ kind: 'jsonpath', path: '$.items[1]' }, body)).toEqual({ n: 2 });
    expect(runExtract({ kind: 'jsonpath', path: '$.missing.deep' }, body)).toBeNull();
  });

  test('jq-subset selectors and terminal filters', () => {
    const body = JSON.stringify({ items: [1, 2, 3], meta: { a: 1, b: 2 } });
    expect(runExtract({ kind: 'jq-subset', expression: '.items | length' }, body)).toBe(3);
    expect(runExtract({ kind: 'jq-subset', expression: '.meta | keys' }, body)).toEqual(['a', 'b']);
    expect(runExtract({ kind: 'jq-subset', expression: '.items[0]' }, body)).toBe(1);
  });

  test('regex extract returns a capture group or null on a miss', () => {
    expect(runExtract({ kind: 'regex', pattern: 'load=(\\d+)', group: 1 }, 'x load=42 y')).toBe('42');
    expect(runExtract({ kind: 'regex', pattern: 'load=(\\d+)', group: 1 }, 'nothing')).toBeNull();
  });
});

describe('rule: change', () => {
  test('fires only when the value differs from the previous observation', () => {
    const first = decide({ kind: 'change' }, observations([[1, 'a']]));
    expect(first.fire).toBe(false);

    const same = decide({ kind: 'change' }, observations([[1, 'a'], [2, 'a']]));
    expect(same.fire).toBe(false);

    const changed = decide({ kind: 'change' }, observations([[1, 'a'], [2, 'b']]));
    expect(changed.fire).toBe(true);
    expect(changed.reason).toContain('a -> b');
  });

  test('fireOnFirst opts into firing on the very first observation', () => {
    expect(decide({ kind: 'change', fireOnFirst: true }, observations([[1, 'a']])).fire).toBe(true);
  });
});

describe('rule: value', () => {
  test('edge-triggered by default — fires on entry, not on every matching check', () => {
    const entering = decide({ kind: 'value', operator: 'gt', operand: 10 }, observations([[1, 20]]));
    expect(entering.fire).toBe(true);
    const stillHigh = decide(
      { kind: 'value', operator: 'gt', operand: 10 },
      observations([[1, 20], [2, 30]]),
      entering.ruleState,
    );
    expect(stillHigh.fire).toBe(false);
    expect(stillHigh.reason).toContain('edge already consumed');
  });

  test('level: true fires on every matching check', () => {
    const rule: TriggerRule = { kind: 'value', operator: 'gt', operand: 10, level: true };
    const first = decide(rule, observations([[1, 20]]));
    expect(first.fire).toBe(true);
    expect(decide(rule, observations([[1, 20], [2, 30]]), first.ruleState).fire).toBe(true);
  });

  test('string operators work on non-numeric values', () => {
    expect(decide({ kind: 'value', operator: 'contains', operand: 'FAIL' }, observations([[1, 'job FAILED']])).fire).toBe(true);
    expect(decide({ kind: 'value', operator: 'matches', operand: '^ok$' }, observations([[1, 'ok']])).fire).toBe(true);
    expect(decide({ kind: 'value', operator: 'not-contains', operand: 'ok' }, observations([[1, 'bad']])).fire).toBe(true);
  });
});

describe('rule: transition', () => {
  test('fires only on the exact previous -> current pair', () => {
    const rule: TriggerRule = { kind: 'transition', from: 'green', to: 'red' };
    expect(decide(rule, observations([[1, 'green'], [2, 'red']])).fire).toBe(true);
    expect(decide(rule, observations([[1, 'red'], [2, 'green']])).fire).toBe(false);
    expect(decide(rule, observations([[1, 'green'], [2, 'yellow']])).fire).toBe(false);
    expect(decide(rule, observations([[1, 'green']])).fire).toBe(false);
  });
});

describe('rule: threshold with hysteresis', () => {
  const rule: TriggerRule = { kind: 'threshold', direction: 'above', enter: 90, exit: 80 };

  test('fires on crossing up, then will not re-fire until it falls past the exit bound', () => {
    const crossed = decide(rule, observations([[1, 95]]));
    expect(crossed.fire).toBe(true);
    expect(crossed.ruleState.armed).toBe(true);

    // 85 is inside the band: still above `exit`, so no re-arm and no re-fire.
    const inBand = decide(rule, observations([[1, 95], [2, 85]]), crossed.ruleState);
    expect(inBand.fire).toBe(false);
    expect(inBand.ruleState.armed).toBe(true);

    // Cross back up without ever leaving the band, must not fire again.
    const flap = decide(rule, observations([[1, 95], [2, 85], [3, 96]]), inBand.ruleState);
    expect(flap.fire).toBe(false);

    // Falling past `exit` re-arms.
    const released = decide(rule, observations([[3, 96], [4, 70]]), flap.ruleState);
    expect(released.fire).toBe(false);
    expect(released.ruleState.armed).toBe(false);

    const refired = decide(rule, observations([[4, 70], [5, 99]]), released.ruleState);
    expect(refired.fire).toBe(true);
  });

  test('the below direction mirrors it', () => {
    const below: TriggerRule = { kind: 'threshold', direction: 'below', enter: 10, exit: 20 };
    const crossed = decide(below, observations([[1, 5]]));
    expect(crossed.fire).toBe(true);
    expect(decide(below, observations([[1, 5], [2, 15]]), crossed.ruleState).ruleState.armed).toBe(true);
    const released = decide(below, observations([[2, 15], [3, 25]]), crossed.ruleState);
    expect(released.ruleState.armed).toBe(false);
  });
});

describe('rule: debounce-n', () => {
  test('requires N consecutive inner matches and resets on a miss', () => {
    const rule: TriggerRule = {
      kind: 'debounce-n',
      count: 3,
      inner: { kind: 'value', operator: 'gt', operand: 10, level: true },
    };
    let state: TriggerRuleState = {};
    const first = decide(rule, observations([[1, 20]]), state);
    expect(first.fire).toBe(false);
    state = first.ruleState;

    const second = decide(rule, observations([[1, 20], [2, 21]]), state);
    expect(second.fire).toBe(false);
    state = second.ruleState;

    const third = decide(rule, observations([[2, 21], [3, 22]]), state);
    expect(third.fire).toBe(true);
    state = third.ruleState;

    // Streak resets after a fire, and a non-matching sample zeroes it too.
    const miss = decide(rule, observations([[3, 22], [4, 1]]), state);
    expect(miss.fire).toBe(false);
    expect(miss.ruleState.streak).toBe(0);
  });
});

describe('rule: dedup-ttl', () => {
  test('suppresses a repeat fire for the same fingerprint inside the TTL', () => {
    const rule: TriggerRule = {
      kind: 'dedup-ttl',
      ttlMs: 60_000,
      inner: { kind: 'value', operator: 'eq', operand: 'down', level: true },
    };
    const first = decide(rule, observations([[1_000, 'down']]), {}, 1_000);
    expect(first.fire).toBe(true);

    const repeat = decide(rule, observations([[2_000, 'down']]), first.ruleState, 2_000);
    expect(repeat.fire).toBe(false);
    expect(repeat.reason).toContain('suppressed');

    const afterTtl = decide(rule, observations([[70_000, 'down']]), first.ruleState, 70_000);
    expect(afterTtl.fire).toBe(true);
  });
});

describe('rule: rate-of-change', () => {
  test('compares the per-second delta across the window', () => {
    const rule: TriggerRule = { kind: 'rate-of-change', windowMs: 10_000, operator: 'gt', operand: 1 };
    // 0 -> 100 across 10s = 10/s, which is > 1.
    expect(decide(rule, observations([[0, 0], [10_000, 100]]), {}, 10_000).fire).toBe(true);
    // 0 -> 5 across 10s = 0.5/s, which is not.
    expect(decide(rule, observations([[0, 0], [10_000, 5]]), {}, 10_000).fire).toBe(false);
  });

  test('per: minute scales the same delta', () => {
    const rule: TriggerRule = { kind: 'rate-of-change', windowMs: 60_000, operator: 'gt', operand: 30, per: 'minute' };
    expect(decide(rule, observations([[0, 0], [60_000, 60]]), {}, 60_000).fire).toBe(true);
  });

  test('needs two numeric samples inside the window', () => {
    const rule: TriggerRule = { kind: 'rate-of-change', windowMs: 1_000, operator: 'gt', operand: 0 };
    const result = decide(rule, observations([[0, 0], [10_000, 100]]), {}, 10_000);
    expect(result.fire).toBe(false);
    expect(result.reason).toContain('two numeric samples');
  });
});

describe('rule: windowed-aggregate', () => {
  const inWindow = observations([[1_000, 10], [2_000, 20], [3_000, 60]]);

  test('mean / max / min / sum / count over the window', () => {
    const at = 3_000;
    expect(decide({ kind: 'windowed-aggregate', windowMs: 5_000, aggregate: 'mean', operator: 'eq', operand: 30 }, inWindow, {}, at).fire).toBe(true);
    expect(decide({ kind: 'windowed-aggregate', windowMs: 5_000, aggregate: 'max', operator: 'eq', operand: 60 }, inWindow, {}, at).fire).toBe(true);
    expect(decide({ kind: 'windowed-aggregate', windowMs: 5_000, aggregate: 'min', operator: 'eq', operand: 10 }, inWindow, {}, at).fire).toBe(true);
    expect(decide({ kind: 'windowed-aggregate', windowMs: 5_000, aggregate: 'sum', operator: 'eq', operand: 90 }, inWindow, {}, at).fire).toBe(true);
    expect(decide({ kind: 'windowed-aggregate', windowMs: 5_000, aggregate: 'count', operator: 'eq', operand: 3 }, inWindow, {}, at).fire).toBe(true);
  });

  test('stddev is computed over the window', () => {
    const flat = observations([[1_000, 5], [2_000, 5], [3_000, 5]]);
    expect(decide({ kind: 'windowed-aggregate', windowMs: 5_000, aggregate: 'stddev', operator: 'eq', operand: 0 }, flat, {}, 3_000).fire).toBe(true);
  });

  test('samples outside the window are excluded', () => {
    const straddling = observations([[0, 1000], [9_000, 10], [10_000, 20]]);
    const result = decide(
      { kind: 'windowed-aggregate', windowMs: 5_000, aggregate: 'max', operator: 'eq', operand: 20 },
      straddling,
      {},
      10_000,
    );
    expect(result.fire).toBe(true);
  });

  test('minSamples holds the rule off until the window is populated', () => {
    const result = decide(
      { kind: 'windowed-aggregate', windowMs: 5_000, aggregate: 'mean', operator: 'gt', operand: 0, minSamples: 5 },
      inWindow,
      {},
      3_000,
    );
    expect(result.fire).toBe(false);
    expect(result.reason).toContain('3/5 numeric samples');
  });
});

describe('rule: cross-watcher correlation', () => {
  const log: TriggerEventLogEntry[] = [
    { at: 1_000, triggerId: 'disk-full', kind: 'condition', event: 'fired', fingerprint: 'a' },
    { at: 2_000, triggerId: 'build-failed', kind: 'on-exit', event: 'fired', fingerprint: 'b' },
    { at: 2_500, triggerId: 'noise', kind: 'stream', event: 'observed', fingerprint: 'c' },
  ];

  test('any fires when one named trigger fired in the window', () => {
    const rule: TriggerRule = { kind: 'correlation', triggerIds: ['disk-full', 'nope'], withinMs: 10_000, require: 'any' };
    expect(decide(rule, [], {}, 3_000, log).fire).toBe(true);
  });

  test('all requires every named trigger and names what is missing', () => {
    const rule: TriggerRule = { kind: 'correlation', triggerIds: ['disk-full', 'build-failed'], withinMs: 10_000, require: 'all' };
    expect(decide(rule, [], {}, 3_000, log).fire).toBe(true);

    const withMissing: TriggerRule = { kind: 'correlation', triggerIds: ['disk-full', 'absent'], withinMs: 10_000, require: 'all' };
    const result = decide(withMissing, [], {}, 3_000, log);
    expect(result.fire).toBe(false);
    expect(result.reason).toContain('absent');
  });

  test('sequence requires the listed order', () => {
    const forward: TriggerRule = { kind: 'correlation', triggerIds: ['disk-full', 'build-failed'], withinMs: 10_000, require: 'sequence' };
    expect(decide(forward, [], {}, 3_000, log).fire).toBe(true);

    const backward: TriggerRule = { kind: 'correlation', triggerIds: ['build-failed', 'disk-full'], withinMs: 10_000, require: 'sequence' };
    expect(decide(backward, [], {}, 3_000, log).fire).toBe(false);
  });

  test('the window bounds what correlation can see', () => {
    const rule: TriggerRule = { kind: 'correlation', triggerIds: ['disk-full'], withinMs: 500, require: 'any' };
    expect(decide(rule, [], {}, 3_000, log).fire).toBe(false);
  });

  test('a trigger is excluded from its own correlation window', () => {
    const selfLog: TriggerEventLogEntry[] = [
      { at: 1_000, triggerId: 'self', kind: 'condition', event: 'fired', fingerprint: 'x' },
    ];
    const rule: TriggerRule = { kind: 'correlation', triggerIds: ['self'], withinMs: 10_000, require: 'any' };
    expect(decide(rule, [], {}, 2_000, selfLog).fire).toBe(false);
  });

  test('only fired events count, not observed ones', () => {
    const rule: TriggerRule = { kind: 'correlation', triggerIds: ['noise'], withinMs: 10_000, require: 'any' };
    expect(decide(rule, [], {}, 3_000, log).fire).toBe(false);
  });
});
