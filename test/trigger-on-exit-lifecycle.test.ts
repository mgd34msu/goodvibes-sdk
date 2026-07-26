/**
 * trigger-on-exit-lifecycle.test.ts — the one-shot on-exit process trigger, end
 * to end through the TriggerManager, plus the ProcessManager live-output fix
 * the on-exit payload depends on.
 *
 * The claims under test:
 *   - exactly one payload per supervised process, ever
 *   - the payload carries real termination metadata and the prompt makes the
 *     agent inspect it rather than assume success
 *   - a max-duration kill fires with an explicit timed-out state
 *   - a daemon restart fires once with an explicit unknown/daemon-restart state
 *     instead of the trigger silently evaporating
 *   - `bg_output` returns output for a process that is still RUNNING
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessManager } from '../packages/sdk/src/platform/tools/shared/process-manager.ts';
import {
  buildDaemonRestartTermination,
  buildTermination,
  computeGrantDigest,
  createActionGrant,
  decideOnExitRecovery,
  renderOnExitPrompt,
  StreamLineProcessor,
  TriggerManager,
  verifyGrant,
  type ObservedTermination,
  type TrackedProcessRef,
  type TriggerActionExecutor,
  type TriggerProcessHost,
} from '../packages/sdk/src/platform/triggers/index.ts';

const roots: string[] = [];

function tempStore(): string {
  const root = join(tmpdir(), `gv-onexit-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return join(root, 'triggers.json');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A scripted process host — no real subprocess anywhere in these tests. */
class FakeProcessHost implements TriggerProcessHost {
  readonly launched: Array<{ command: string; args: readonly string[]; stdin: string; maxDurationMs: number }> = [];
  readonly cancelled: string[] = [];
  private state: ObservedTermination | null = null;
  private alive = true;
  private counter = 0;

  launch(spec: { command: string; args: readonly string[]; stdin: 'none' | 'empty'; maxDurationMs: number }) {
    this.launched.push({ command: spec.command, args: spec.args, stdin: spec.stdin, maxDurationMs: spec.maxDurationMs });
    this.counter += 1;
    this.state = { running: true, exitCode: null, signal: null, timedOut: false, stdoutTail: '', stderrTail: '' };
    return Promise.resolve({ processId: `proc-${this.counter}`, pid: 1000 + this.counter, startedAt: 1_000 });
  }

  observe(): ObservedTermination | null {
    return this.state;
  }

  cancel(processId: string): void {
    this.cancelled.push(processId);
  }

  isSameProcessAlive(): boolean {
    return this.alive;
  }

  finish(termination: Partial<ObservedTermination>): void {
    this.state = {
      running: false,
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdoutTail: '',
      stderrTail: '',
      endedAt: 5_000,
      ...termination,
    };
  }

  setAlive(alive: boolean): void {
    this.alive = alive;
  }
}

class RecordingExecutor implements TriggerActionExecutor {
  readonly turns: Array<{ triggerId: string; prompt: string }> = [];
  readonly grants: string[] = [];
  runAgentTurn(input: { triggerId: string; prompt: string }): Promise<string> {
    this.turns.push({ triggerId: input.triggerId, prompt: input.prompt });
    return Promise.resolve('ok');
  }
  runGrant(input: { triggerId: string; grant: { id: string } }): Promise<string> {
    this.grants.push(input.grant.id);
    return Promise.resolve('granted');
  }
}

function managerWith(host: FakeProcessHost, executor: RecordingExecutor, storePath: string, bootId: string, clock = { t: 1_000 }) {
  return new TriggerManager({
    storePath,
    config: { enabled: true, onExitMaxDurationMs: 60_000, outputTailBytes: 64 },
    actions: executor,
    processHost: host,
    daemonBootId: bootId,
    now: () => clock.t,
  });
}

const onExitDefinition = {
  id: 'nightly-build',
  label: 'Nightly build',
  spec: { kind: 'on-exit', command: 'make', args: ['all'] },
  action: { kind: 'agent-turn', prompt: '' },
  createdAt: 0,
};

describe('on-exit trigger fires exactly once', () => {
  test('one payload when the process ends, and no second payload on repeated polls', async () => {
    const host = new FakeProcessHost();
    const executor = new RecordingExecutor();
    const clock = { t: 1_000 };
    const manager = managerWith(host, executor, tempStore(), 'boot-1', clock);

    await manager.create(onExitDefinition);
    expect(host.launched).toHaveLength(1);

    // Still running: nothing fires.
    await manager.pollProcesses();
    expect(executor.turns).toHaveLength(0);

    host.finish({ exitCode: 0, stdoutTail: 'build ok' });
    clock.t = 5_000;
    await manager.pollProcesses();
    expect(executor.turns).toHaveLength(1);

    // Poll three more times — the record is already claimed.
    await manager.pollProcesses();
    await manager.pollProcesses();
    await manager.pollProcesses();
    expect(executor.turns).toHaveLength(1);
    expect(manager.get('nightly-build')?.firedCount).toBe(1);
    expect(manager.get('nightly-build')?.state).toBe('fired');
  });

  test('stdin is closed by default so a prompting process gets EOF', async () => {
    const host = new FakeProcessHost();
    const manager = managerWith(host, new RecordingExecutor(), tempStore(), 'boot-1');
    await manager.create(onExitDefinition);
    expect(host.launched[0]?.stdin).toBe('none');
  });

  test('the configured max-duration cap is handed to the process host', async () => {
    const host = new FakeProcessHost();
    const manager = managerWith(host, new RecordingExecutor(), tempStore(), 'boot-1');
    await manager.create(onExitDefinition);
    expect(host.launched[0]?.maxDurationMs).toBe(60_000);
  });

  test('a nonzero exit still fires — exit is not success, and neither is failure silent', async () => {
    const host = new FakeProcessHost();
    const executor = new RecordingExecutor();
    const clock = { t: 1_000 };
    const manager = managerWith(host, executor, tempStore(), 'boot-1', clock);
    await manager.create(onExitDefinition);
    host.finish({ exitCode: 1, stderrTail: 'make: *** [all] Error 1' });
    clock.t = 9_000;
    await manager.pollProcesses();
    expect(executor.turns).toHaveLength(1);
    expect(executor.turns[0]?.prompt).toContain('Exit code: 1');
    expect(executor.turns[0]?.prompt).toContain('nonzero-exit');
  });

  test('cancellation terminates the child and stops it from firing', async () => {
    const host = new FakeProcessHost();
    const executor = new RecordingExecutor();
    const manager = managerWith(host, executor, tempStore(), 'boot-1');
    await manager.create(onExitDefinition);
    const cancelled = manager.cancel('nightly-build');
    expect(cancelled?.state).toBe('cancelled');
    expect(host.cancelled).toEqual(['proc-1']);

    host.finish({ exitCode: 0 });
    await manager.pollProcesses();
    expect(executor.turns).toHaveLength(0);
  });

  test('run history and event metadata are recorded for the fire', async () => {
    const host = new FakeProcessHost();
    const clock = { t: 1_000 };
    const manager = managerWith(host, new RecordingExecutor(), tempStore(), 'boot-1', clock);
    await manager.create(onExitDefinition);
    host.finish({ exitCode: 0, stdoutTail: 'done' });
    clock.t = 4_000;
    await manager.pollProcesses();

    const history = manager.history('nightly-build');
    const fired = history.find((run) => run.outcome === 'fired');
    expect(fired).toBeDefined();
    expect(fired?.termination?.state).toBe('exited');
    expect(fired?.termination?.durationMs).toBe(4_000);
    expect(fired?.termination?.command).toBe('make');
    expect(fired?.termination?.args).toEqual(['all']);
    expect(fired?.actionResult).toBe('ok');
  });
});

describe('termination metadata', () => {
  const ref: TrackedProcessRef = {
    processId: 'p1', pid: 99, startedAt: 1_000, command: 'make', args: ['all'], daemonBootId: 'boot-1',
  };

  test('a clean exit is exited/normal with the real duration and tail', () => {
    const termination = buildTermination({
      process: ref,
      observed: { running: false, exitCode: 0, signal: null, timedOut: false, stdoutTail: 'ok', stderrTail: '', endedAt: 4_000 },
      now: 4_000,
    });
    expect(termination).toMatchObject({
      state: 'exited', reason: 'normal', exitCode: 0, signal: null, timedOut: false, durationMs: 3_000, observed: true,
    });
  });

  test('a timed-out kill reports timed-out/max-duration, not a clean exit', () => {
    const termination = buildTermination({
      process: ref,
      observed: { running: false, exitCode: null, signal: 'SIGKILL', timedOut: true, stdoutTail: '', stderrTail: '', endedAt: 9_000 },
      now: 9_000,
    });
    expect(termination.state).toBe('timed-out');
    expect(termination.reason).toBe('max-duration');
    expect(termination.timedOut).toBe(true);
    expect(termination.exitCode).toBeNull();
    expect(termination.signal).toBe('SIGKILL');
  });

  test('a signal without a timeout reports signalled', () => {
    const termination = buildTermination({
      process: ref,
      observed: { running: false, exitCode: null, signal: 'SIGSEGV', timedOut: false, stdoutTail: '', stderrTail: '', endedAt: 2_000 },
      now: 2_000,
    });
    expect(termination.state).toBe('signalled');
    expect(termination.reason).toBe('signal');
  });

  test('the output tail is bounded to the configured byte budget', () => {
    const termination = buildTermination({
      process: ref,
      observed: { running: false, exitCode: 0, signal: null, timedOut: false, stdoutTail: 'x'.repeat(5_000), stderrTail: '', endedAt: 2_000 },
      now: 2_000,
      outputTailBytes: 100,
    });
    expect(termination.stdoutTail).toHaveLength(100);
  });

  test('the default prompt makes the agent inspect the state instead of assuming success', () => {
    const failed = renderOnExitPrompt(buildTermination({
      process: ref,
      observed: { running: false, exitCode: 2, signal: null, timedOut: false, stdoutTail: '', stderrTail: 'boom', endedAt: 2_000 },
      now: 2_000,
    }), 'Nightly build');
    expect(failed).toContain('Do not assume it succeeded');
    expect(failed).toContain('Termination state: exited (nonzero-exit)');
    expect(failed).toContain('Exit code: 2');
    expect(failed).toContain('Timed out: no');
    expect(failed).toContain('Outcome observed: yes');
    // The stderr the process actually produced reaches the agent.
    expect(failed).toContain('boom');
  });

  test('the timed-out prompt says so in words, not only in a flag', () => {
    const prompt = renderOnExitPrompt(buildTermination({
      process: ref,
      observed: { running: false, exitCode: null, signal: 'SIGKILL', timedOut: true, stdoutTail: '', stderrTail: '', endedAt: 2_000 },
      now: 2_000,
    }), 'Nightly build');
    expect(prompt).toContain('hit its max-duration cap');
  });
});

describe('daemon restart', () => {
  test('a record from a previous boot is never re-adopted', () => {
    const ref: TrackedProcessRef = {
      processId: 'p1', pid: 99, startedAt: 1_000, command: 'make', args: [], daemonBootId: 'boot-1',
    };
    expect(decideOnExitRecovery({ process: ref, currentBootId: 'boot-1' }).action).toBe('resume');
    expect(decideOnExitRecovery({ process: ref, currentBootId: 'boot-2' }).action).toBe('fire-unknown');
  });

  test('the unknown payload admits it did not observe the outcome', () => {
    const termination = buildDaemonRestartTermination({
      process: { processId: 'p1', pid: 99, startedAt: 1_000, command: 'make', args: [], daemonBootId: 'boot-1' },
      now: 9_000,
    });
    expect(termination.state).toBe('unknown');
    expect(termination.reason).toBe('daemon-restart');
    expect(termination.exitCode).toBeNull();
    expect(termination.observed).toBe(false);

    const prompt = renderOnExitPrompt(termination, 'Nightly build');
    expect(prompt).toContain('UNKNOWN');
    expect(prompt).toContain('Outcome observed: no');
    expect(prompt).toContain('Do not assume success or failure');
  });

  test('a trigger that survives a daemon restart fires once with the unknown state', async () => {
    const storePath = tempStore();
    const clock = { t: 1_000 };
    const firstHost = new FakeProcessHost();
    const firstManager = managerWith(firstHost, new RecordingExecutor(), storePath, 'boot-1', clock);
    await firstManager.create(onExitDefinition);
    expect(firstManager.get('nightly-build')?.state).toBe('running');

    // A new daemon comes up against the same store with a different boot id.
    clock.t = 100_000;
    const secondHost = new FakeProcessHost();
    secondHost.setAlive(false);
    const secondExecutor = new RecordingExecutor();
    const secondManager = managerWith(secondHost, secondExecutor, storePath, 'boot-2', clock);
    secondManager.load();
    await Promise.resolve();
    await Promise.resolve();

    expect(secondExecutor.turns).toHaveLength(1);
    expect(secondExecutor.turns[0]?.prompt).toContain('UNKNOWN');
    expect(secondManager.get('nightly-build')?.state).toBe('fired');

    // A third boot must not fire it again — the fired one-shot is retired.
    const thirdExecutor = new RecordingExecutor();
    const thirdManager = managerWith(new FakeProcessHost(), thirdExecutor, storePath, 'boot-3', clock);
    thirdManager.load();
    await Promise.resolve();
    expect(thirdExecutor.turns).toHaveLength(0);
    expect(thirdManager.get('nightly-build')).toBeNull();
  });
});

describe('action grants', () => {
  test('a grant is digest-pinned and verified at fire time', () => {
    const grant = createActionGrant({
      id: 'restart-svc',
      description: 'Restart the build agent service',
      command: 'systemctl',
      args: ['--user', 'restart', 'builder'],
      confirmedBy: 'mike',
      now: 1_000,
    });
    expect(verifyGrant([grant], 'restart-svc', grant.digest).ok).toBe(true);
    expect(verifyGrant([grant], 'missing', grant.digest).ok).toBe(false);

    const tampered = { ...grant, args: ['--user', 'restart', 'something-else'] };
    const result = verifyGrant([tampered], 'restart-svc', grant.digest);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('modified after it was confirmed');
  });

  test('the digest covers the command, args and cwd — nothing else', () => {
    const a = computeGrantDigest({ command: 'make', args: ['all'], cwd: '/a' });
    expect(computeGrantDigest({ command: 'make', args: ['all'], cwd: '/a' })).toBe(a);
    expect(computeGrantDigest({ command: 'make', args: ['clean'], cwd: '/a' })).not.toBe(a);
    expect(computeGrantDigest({ command: 'make', args: ['all'], cwd: '/b' })).not.toBe(a);
  });

  test('a grant must record who confirmed it and what it does', () => {
    expect(() => createActionGrant({ id: 'g', description: 'x', command: 'ls', confirmedBy: '' })).toThrow(/who confirmed it/);
    expect(() => createActionGrant({ id: 'g', description: '', command: 'ls', confirmedBy: 'mike' })).toThrow(/description/);
  });

  test('a trigger pinned to an unregistered grant is refused at creation, not at fire time', async () => {
    const manager = managerWith(new FakeProcessHost(), new RecordingExecutor(), tempStore(), 'boot-1');
    await expect(manager.create({
      id: 't', label: 'T',
      spec: { kind: 'on-exit', command: 'make' },
      action: { kind: 'action-grant', grantId: 'nope', digest: 'deadbeef' },
      createdAt: 0,
    })).rejects.toThrow(/not registered/);
  });
});

describe('the feature gate is a real off switch', () => {
  test('with watchers.triggers.enabled false, creating a trigger is refused by name', async () => {
    const manager = new TriggerManager({
      storePath: tempStore(),
      config: { enabled: false },
      actions: new RecordingExecutor(),
      processHost: new FakeProcessHost(),
    });
    await expect(manager.create(onExitDefinition)).rejects.toThrow(/watchers\.triggers\.enabled/);
  });
});

describe('stream watcher batching, bounding and dedup', () => {
  test('only matching lines enter the queue, and excludes are dropped', () => {
    const processor = new StreamLineProcessor({
      match: { kind: 'regex', pattern: 'ERROR' },
      exclude: { kind: 'regex', pattern: 'ERROR: known-noise' },
      batchLines: 10,
      batchIntervalMs: 1_000,
      queueLimit: 100,
    });
    processor.push('info: fine\nERROR: real\nERROR: known-noise\ndebug\n', 0);
    const batch = processor.takeBatch(0, true);
    expect(batch?.lines).toEqual(['ERROR: real']);
  });

  test('a line split across two chunks is matched once, whole', () => {
    const processor = new StreamLineProcessor({
      match: { kind: 'regex', pattern: 'ERROR' },
      batchLines: 10, batchIntervalMs: 1_000, queueLimit: 100,
    });
    processor.push('ERR', 0);
    processor.push('OR: split line\n', 0);
    expect(processor.takeBatch(0, true)?.lines).toEqual(['ERROR: split line']);
  });

  test('a full batch is emitted without waiting for the interval', () => {
    const processor = new StreamLineProcessor({
      match: { kind: 'regex', pattern: 'x' },
      batchLines: 3, batchIntervalMs: 60_000, queueLimit: 100,
    });
    processor.push('x1\nx2\n', 0);
    expect(processor.takeBatch(0)).toBeNull();
    processor.push('x3\n', 0);
    expect(processor.takeBatch(0)?.lines).toHaveLength(3);
  });

  test('a partial batch flushes once the interval has elapsed', () => {
    const processor = new StreamLineProcessor({
      match: { kind: 'regex', pattern: 'x' },
      batchLines: 10, batchIntervalMs: 1_000, queueLimit: 100,
    });
    processor.push('x1\n', 0);
    expect(processor.takeBatch(500)).toBeNull();
    expect(processor.takeBatch(1_500)?.lines).toEqual(['x1']);
  });

  test('the queue is bounded and every drop is counted, never silent', () => {
    const processor = new StreamLineProcessor({
      match: { kind: 'regex', pattern: 'x' },
      batchLines: 2, batchIntervalMs: 60_000, queueLimit: 3,
    });
    for (let i = 0; i < 10; i += 1) processor.push(`x${i}\n`, 0);
    expect(processor.pending).toBe(3);
    expect(processor.droppedTotal).toBe(7);
    const batch = processor.takeBatch(0, true);
    expect(batch?.dropped).toBe(7);
    expect(batch?.lines).toEqual(['x7', 'x8']);
  });

  test('repeats inside the dedup TTL are suppressed and counted', () => {
    const processor = new StreamLineProcessor({
      match: { kind: 'regex', pattern: 'x' },
      batchLines: 10, batchIntervalMs: 1_000, queueLimit: 100,
      dedupTtlMs: 10_000,
    });
    processor.push('x same\n', 0);
    processor.push('x same\n', 1_000);
    processor.push('x same\n', 2_000);
    const batch = processor.takeBatch(5_000, true);
    expect(batch?.lines).toEqual(['x same']);
    expect(batch?.deduped).toBe(2);

    processor.push('x same\n', 20_000);
    expect(processor.takeBatch(20_000, true)?.lines).toEqual(['x same']);
  });

  test('no match means no batch, so no agent turn', () => {
    const processor = new StreamLineProcessor({
      match: { kind: 'regex', pattern: 'ERROR' },
      batchLines: 1, batchIntervalMs: 0, queueLimit: 10,
    });
    processor.push('all quiet\nstill quiet\n', 0);
    expect(processor.takeBatch(10_000, true)).toBeNull();
  });
});

describe('ProcessManager live output', () => {
  test('bg_output returns output for a process that has NOT exited yet', async () => {
    const manager = new ProcessManager();
    // Prints immediately, then stays alive well past the assertion window.
    const spawned = await manager.spawn(
      'printf "first line\\n"; printf "second line\\n"; sleep 30',
      undefined,
      undefined,
      { timeout_ms: 30_000 },
    );
    const id = spawned.process_id!;
    try {
      let live = '';
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await Bun.sleep(20);
        live = manager.getOutput(id)?.stdout ?? '';
        if (live.includes('second line')) break;
      }
      expect(manager.getStatus(id)?.done).toBe(false);
      expect(live).toContain('first line');
      expect(live).toContain('second line');

      const command = manager.handleCommand(`bg_output ${id}`);
      expect(command?.stdout).toContain('second line');
    } finally {
      manager.stop(id);
    }
  }, 15_000);

  test('bg_status reports signal, timed-out and duration once the process ends', async () => {
    const manager = new ProcessManager();
    const spawned = await manager.spawn('printf "done\\n"; exit 3', undefined, undefined, { timeout_ms: 10_000 });
    const id = spawned.process_id!;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await Bun.sleep(20);
      if (manager.getStatus(id)?.done) break;
    }
    const status = JSON.parse(manager.handleCommand(`bg_status ${id}`)?.stdout ?? '{}') as {
      status: string; exit_code: number; signal: string | null; timed_out: boolean; duration_ms: number;
    };
    expect(status.exit_code).toBe(3);
    expect(status.timed_out).toBe(false);
    expect(status.signal).toBeNull();
    expect(status.status).toBe('done (exit 3)');
    expect(status.duration_ms).toBeGreaterThanOrEqual(0);
    expect(manager.getOutput(id)?.stdout).toContain('done');
  }, 15_000);

  test('a timed-out background process is reported as timed out, not as a clean exit', async () => {
    const manager = new ProcessManager();
    const spawned = await manager.spawn('sleep 30', undefined, undefined, { timeout_ms: 150, sigterm_grace_ms: 50 });
    const id = spawned.process_id!;
    for (let attempt = 0; attempt < 150; attempt += 1) {
      await Bun.sleep(20);
      if (manager.getStatus(id)?.done) break;
    }
    const entry = manager.getStatus(id);
    expect(entry?.done).toBe(true);
    expect(entry?.timedOut).toBe(true);
    const status = JSON.parse(manager.handleCommand(`bg_status ${id}`)?.stdout ?? '{}') as { status: string; timed_out: boolean };
    expect(status.timed_out).toBe(true);
    expect(status.status).toContain('timed out');
  }, 15_000);
});
