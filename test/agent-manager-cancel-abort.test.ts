/**
 * agent-manager-cancel-abort.test.ts
 *
 * The mid-run abort seam: AgentManager owns an abort controller per agent, so
 * cancel()/kill genuinely aborts the agent's in-flight provider call (the signal
 * the runner threads into provider.chat) rather than only cooperatively at the
 * next boundary. An engine-registered external signal keeps precedence.
 */
import { describe, expect, test } from 'bun:test';
import { AgentManager, type AgentExecutor } from '../packages/sdk/src/platform/tools/agent/manager.ts';

/** An executor that marks the agent running and keeps it running until released. */
function hangingExecutor(): AgentExecutor & { release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return {
    runAgent: async (record) => { record.status = 'running'; await gate; },
    release,
  };
}

function makeManager(executor: AgentExecutor): AgentManager {
  return new AgentManager({
    configManager: { get: () => null } as never,
    messageBus: { registerAgent() {} },
    archetypeLoader: { loadArchetype: () => null },
    executor,
  });
}

describe('AgentManager cancellation abort seam', () => {
  test('getCancellationSignal returns a stable, non-aborted owned signal, tripped by cancel()', () => {
    const executor = hangingExecutor();
    const manager = makeManager(executor);
    const record = manager.spawn({ mode: 'spawn', task: 'do work', dangerously_disable_wrfc: true });

    const signal = manager.getCancellationSignal(record.id);
    expect(signal).toBeDefined();
    expect(signal!.aborted).toBe(false);
    expect(manager.getCancellationSignal(record.id)).toBe(signal); // stable owned controller

    expect(manager.cancel(record.id)).toBe(true);
    expect(signal!.aborted).toBe(true);
    executor.release();
  });

  test('cancel() before the runner reads the signal still yields an aborted signal (no dropped cancel)', () => {
    const executor = hangingExecutor();
    const manager = makeManager(executor);
    const record = manager.spawn({ mode: 'spawn', task: 'do work', dangerously_disable_wrfc: true });

    expect(manager.cancel(record.id)).toBe(true);
    const signal = manager.getCancellationSignal(record.id);
    expect(signal!.aborted).toBe(true);
    executor.release();
  });

  test('an engine-registered external signal takes precedence over the owned controller', () => {
    const executor = hangingExecutor();
    const manager = makeManager(executor);
    const record = manager.spawn({ mode: 'spawn', task: 'do work', dangerously_disable_wrfc: true });

    const external = new AbortController();
    manager.registerCancellationSignal(record.id, external.signal);
    expect(manager.getCancellationSignal(record.id)).toBe(external.signal);
    executor.release();
  });
});
