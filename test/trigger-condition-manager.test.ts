/**
 * trigger-condition-manager.test.ts — model-free condition checks driven
 * through the TriggerManager, and the supervision spine as the manager
 * actually applies it.
 *
 * "Model-free" is the claim being tested: a condition check runs a declarative
 * probe, narrows it with a declarative extractor, and decides with a pure rule.
 * No LLM is consulted anywhere in that path — the agent executor is only
 * reached once a rule has already returned fire=true.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runProbe,
  TriggerManager,
  type ProbeIo,
  type TriggerActionExecutor,
  type TriggerValue,
} from '../packages/sdk/src/platform/triggers/index.ts';

const roots: string[] = [];

function tempStore(): string {
  const root = join(tmpdir(), `gv-cond-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return join(root, 'triggers.json');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class RecordingExecutor implements TriggerActionExecutor {
  readonly turns: Array<{ triggerId: string; prompt: string }> = [];
  runAgentTurn(input: { triggerId: string; prompt: string }): Promise<string> {
    this.turns.push({ triggerId: input.triggerId, prompt: input.prompt });
    return Promise.resolve('ok');
  }
  runGrant(): Promise<string> {
    return Promise.resolve('granted');
  }
}

/** Scripted probe I/O — a queue of bodies, or an error to throw. */
function scriptedIo(script: { bodies?: string[]; throwWith?: string }): ProbeIo & { calls: number } {
  const io = {
    calls: 0,
    fetch: (_url: string, _init: RequestInit, _timeoutMs: number) => {
      io.calls += 1;
      if (script.throwWith) return Promise.reject(new Error(script.throwWith));
      const body = script.bodies?.shift() ?? '{}';
      return Promise.resolve({ status: 200, ok: true, text: () => Promise.resolve(body) });
    },
    readFile: () => Promise.resolve(''),
    statFile: () => null,
    runCommand: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
    callTool: () => Promise.resolve(null as TriggerValue),
  } as ProbeIo & { calls: number };
  return io;
}

function conditionDefinition(overrides: Record<string, unknown> = {}) {
  return {
    id: 'queue-depth',
    label: 'Queue depth',
    spec: {
      kind: 'condition',
      probe: { kind: 'http', url: 'https://example.test/metrics' },
      extract: { kind: 'jsonpath', path: '$.depth' },
      rule: { kind: 'threshold', direction: 'above', enter: 100, exit: 50 },
      intervalMs: 30_000,
    },
    action: { kind: 'agent-turn' },
    createdAt: 0,
    ...overrides,
  };
}

function managerWith(io: ProbeIo, executor: RecordingExecutor, clock: { t: number }, storePath = tempStore()) {
  return new TriggerManager({
    storePath,
    config: { enabled: true, defaultCheckIntervalMs: 30_000, breakerStrikes: 5 },
    actions: executor,
    probeIo: io,
    now: () => clock.t,
    daemonBootId: 'boot-1',
  });
}

describe('a condition check runs probe -> extract -> rule with no model in the loop', () => {
  test('the agent executor is untouched until a rule returns fire', async () => {
    const io = scriptedIo({ bodies: ['{"depth": 10}', '{"depth": 20}', '{"depth": 500}'] });
    const executor = new RecordingExecutor();
    const clock = { t: 1_000 };
    const manager = managerWith(io, executor, clock);
    await manager.create(conditionDefinition());

    await manager.runCheck('queue-depth');
    clock.t += 30_000;
    await manager.runCheck('queue-depth');
    expect(executor.turns).toHaveLength(0);
    expect(io.calls).toBe(2);

    clock.t += 30_000;
    await manager.runCheck('queue-depth');
    await Promise.resolve();
    expect(executor.turns).toHaveLength(1);
    expect(executor.turns[0]?.prompt).toContain('crossed above 100');
  });

  test('observations are persisted into the ring buffer between checks', async () => {
    const io = scriptedIo({ bodies: ['{"depth": 1}', '{"depth": 2}', '{"depth": 3}'] });
    const clock = { t: 1_000 };
    const manager = managerWith(io, new RecordingExecutor(), clock);
    await manager.create(conditionDefinition());
    for (let i = 0; i < 3; i += 1) {
      await manager.runCheck('queue-depth');
      clock.t += 30_000;
    }
    const record = manager.get('queue-depth');
    expect(record?.observations.map((o) => o.numeric)).toEqual([1, 2, 3]);
    expect(record?.runs).toHaveLength(3);
  });

  test('a successful check schedules the next one at the configured interval', async () => {
    const io = scriptedIo({ bodies: ['{"depth": 1}'] });
    const clock = { t: 1_000 };
    const manager = managerWith(io, new RecordingExecutor(), clock);
    await manager.create(conditionDefinition());
    await manager.runCheck('queue-depth');
    expect(manager.get('queue-depth')?.nextCheckAt).toBe(31_000);
  });

  test('hysteresis holds across separate checks, so a hovering value does not flap', async () => {
    const io = scriptedIo({ bodies: ['{"depth": 500}', '{"depth": 75}', '{"depth": 500}'] });
    const executor = new RecordingExecutor();
    const clock = { t: 1_000 };
    const manager = managerWith(io, executor, clock);
    await manager.create(conditionDefinition());
    for (let i = 0; i < 3; i += 1) {
      await manager.runCheck('queue-depth');
      await Promise.resolve();
      clock.t += 30_000;
    }
    // Fired once on the first crossing; 75 never fell past the 50 re-arm bound.
    expect(executor.turns).toHaveLength(1);
  });
});

describe('the manager applies the ladder and the breaker to a failing check', () => {
  test('consecutive probe failures walk the ladder and then park the trigger', async () => {
    const io = scriptedIo({ throwWith: 'ECONNREFUSED' });
    const clock = { t: 0 };
    const manager = managerWith(io, new RecordingExecutor(), clock);
    await manager.create(conditionDefinition());

    const delays: Array<number | undefined> = [];
    for (let i = 0; i < 4; i += 1) {
      await manager.runCheck('queue-depth');
      const record = manager.get('queue-depth');
      delays.push(record?.nextCheckAt);
      expect(record?.state).toBe('backoff');
      clock.t = record?.nextCheckAt ?? 0;
    }
    // 30s, then +60s, then +5m, then +15m from each failure time.
    expect(delays).toEqual([30_000, 90_000, 390_000, 1_290_000]);

    await manager.runCheck('queue-depth');
    const parked = manager.get('queue-depth');
    expect(parked?.state).toBe('circuit-open');
    expect(parked?.strikes).toBe(5);
    // The stored error is the human-readable summary, not the raw code.
    expect(parked?.lastError).toContain('Cannot connect');
    expect(parked?.runs.at(-1)?.detail).toContain('breaker opened');
  });

  test('a parked trigger is skipped by tick() until it is explicitly reset', async () => {
    const io = scriptedIo({ throwWith: 'boom' });
    const clock = { t: 0 };
    const manager = managerWith(io, new RecordingExecutor(), clock);
    await manager.create(conditionDefinition());
    for (let i = 0; i < 5; i += 1) {
      await manager.runCheck('queue-depth');
      clock.t = (manager.get('queue-depth')?.nextCheckAt ?? clock.t) + 1;
    }
    expect(manager.get('queue-depth')?.state).toBe('circuit-open');

    const callsBefore = io.calls;
    clock.t += 10_000_000;
    await manager.tick();
    expect(io.calls).toBe(callsBefore);

    manager.reset('queue-depth');
    expect(manager.get('queue-depth')?.state).toBe('idle');
    await manager.tick();
    expect(io.calls).toBeGreaterThan(callsBefore);
  });

  test('one success clears the strikes accumulated so far', async () => {
    const bodies = ['{"depth": 1}'];
    let failNext = true;
    const io: ProbeIo = {
      fetch: () => {
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error('transient'));
        }
        return Promise.resolve({ status: 200, ok: true, text: () => Promise.resolve(bodies[0]!) });
      },
      readFile: () => Promise.resolve(''),
      statFile: () => null,
      runCommand: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
      callTool: () => Promise.resolve(null as TriggerValue),
    };
    const clock = { t: 0 };
    const manager = managerWith(io, new RecordingExecutor(), clock);
    await manager.create(conditionDefinition());

    await manager.runCheck('queue-depth');
    expect(manager.get('queue-depth')?.strikes).toBe(1);
    clock.t = 40_000;
    await manager.runCheck('queue-depth');
    expect(manager.get('queue-depth')?.strikes).toBe(0);
    expect(manager.get('queue-depth')?.backoffRung).toBe(0);
    expect(manager.get('queue-depth')?.state).toBe('idle');
  });
});

describe('probe execution stays declarative', () => {
  test('a command probe is handed argv, never a shell line', async () => {
    let seen: { command: string; args: readonly string[] } | null = null;
    const io: ProbeIo = {
      fetch: () => Promise.reject(new Error('unused')),
      readFile: () => Promise.resolve(''),
      statFile: () => null,
      runCommand: (command, args) => {
        seen = { command, args };
        return Promise.resolve({ exitCode: 0, stdout: 'clean', stderr: '' });
      },
      callTool: () => Promise.resolve(null as TriggerValue),
    };
    const result = await runProbe(
      { kind: 'command', command: 'git', args: ['status', '--porcelain'], capture: 'stdout' },
      io,
    );
    expect(result).toBe('clean');
    expect(seen).toEqual({ command: 'git', args: ['status', '--porcelain'] });
  });

  test('a missing file is an observation, not a probe failure', async () => {
    const io: ProbeIo = {
      fetch: () => Promise.reject(new Error('unused')),
      readFile: () => Promise.reject(new Error('ENOENT')),
      statFile: () => null,
      runCommand: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
      callTool: () => Promise.resolve(null as TriggerValue),
    };
    expect(await runProbe({ kind: 'file', path: '/nope' }, io)).toBeNull();
    expect(await runProbe({ kind: 'file', path: '/nope', capture: 'stat' }, io)).toEqual({ exists: false });
  });

  test('an http probe can capture the status, the body, or an envelope of both', async () => {
    const io: ProbeIo = {
      fetch: () => Promise.resolve({ status: 503, ok: false, text: () => Promise.resolve('down') }),
      readFile: () => Promise.resolve(''),
      statFile: () => null,
      runCommand: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
      callTool: () => Promise.resolve(null as TriggerValue),
    };
    expect(await runProbe({ kind: 'http', url: 'https://x.test', capture: 'status' }, io)).toBe(503);
    expect(await runProbe({ kind: 'http', url: 'https://x.test' }, io)).toBe('down');
    expect(await runProbe({ kind: 'http', url: 'https://x.test', capture: 'envelope' }, io))
      .toEqual({ status: 503, ok: false, body: 'down' });
  });
});

describe('recovery through the manager', () => {
  test('a restart reloads triggers, re-validates them and discloses the sweep', async () => {
    const storePath = tempStore();
    const clock = { t: 1_000 };
    const first = managerWith(scriptedIo({ bodies: ['{"depth": 1}'] }), new RecordingExecutor(), clock, storePath);
    await first.create(conditionDefinition());
    await first.runCheck('queue-depth');

    const second = managerWith(scriptedIo({ bodies: [] }), new RecordingExecutor(), clock, storePath);
    const report = second.load();
    expect(report.triggersLoaded).toBe(1);
    expect(report.quarantined).toBeUndefined();
    expect(second.get('queue-depth')?.observations).toHaveLength(1);
  });

  test('a trigger whose owning session died is reaped on load and disclosed', async () => {
    const storePath = tempStore();
    const clock = { t: 1_000 };
    const first = managerWith(scriptedIo({ bodies: ['{"depth": 1}'] }), new RecordingExecutor(), clock, storePath);
    await first.create(conditionDefinition({ ownerSessionId: 'session-a' }));

    const second = new TriggerManager({
      storePath,
      config: { enabled: true },
      actions: new RecordingExecutor(),
      probeIo: scriptedIo({ bodies: [] }),
      now: () => clock.t,
      daemonBootId: 'boot-2',
      sessionIsLive: () => false,
    });
    const report = second.load();
    expect(report.reapedIds).toEqual(['queue-depth']);
    expect(second.get('queue-depth')).toBeNull();
    expect(second.recoveryReport?.triggersReaped).toBe(1);
  });
});
