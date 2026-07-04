/**
 * DEBT-4 item 3 — RuntimeEventBus dispatch ordering contract.
 *
 * Pins the guarantee documented on the RuntimeEventBus class doc: emit() NEVER
 * invokes a subscriber synchronously — every handler is deferred to its own
 * queueMicrotask. Consequently a component may emit from the MIDDLE of a state
 * mutation and no subscriber can ever observe the half-applied state: by the
 * time a listener runs, the mutating call has already returned and the state
 * has settled. Event-ordering safety across the runtime (e.g. the orchestration
 * zombie-reap path) rests on this — a change to synchronous dispatch would flip
 * these assertions.
 */
import { describe, expect, test } from 'bun:test';
import { RuntimeEventBus, createEventEnvelope } from '../packages/sdk/src/platform/runtime/events/index.js';

async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

function agentEnvelope(agentId: string): ReturnType<typeof createEventEnvelope> {
  return createEventEnvelope(
    'AGENT_COMPLETED',
    { type: 'AGENT_COMPLETED', agentId, durationMs: 0 },
    { sessionId: 'contract', traceId: 'contract', source: 'contract' },
  );
}

describe('RuntimeEventBus dispatch ordering contract (DEBT-4 item 3)', () => {
  test('a subscriber can never observe state mid-mutation — emit dispatches after the mutating call completes', async () => {
    const bus = new RuntimeEventBus();
    const state = { phase: 'initial' as 'initial' | 'mutating' | 'settled' };
    const observed: string[] = [];
    bus.onDomain('agents', () => { observed.push(state.phase); });

    // A state mutation that emits from its MIDDLE — before the synchronous
    // section finishes. If emit dispatched synchronously, the listener would
    // read the transient 'mutating' state.
    function mutateAndEmit(): void {
      state.phase = 'mutating';
      bus.emit('agents', agentEnvelope('a1')); // enqueued, not run synchronously
      state.phase = 'settled';                 // completes before any listener runs
    }
    mutateAndEmit();

    // Same synchronous frame: the listener has NOT run yet.
    expect(observed).toEqual([]);
    expect(state.phase).toBe('settled');

    await flushMicrotasks();

    // The listener ran later and observed ONLY the settled state — never 'mutating'.
    expect(observed).toEqual(['settled']);
  });

  test('both per-type and per-domain subscribers dispatch strictly after the synchronous emit() returns', async () => {
    const bus = new RuntimeEventBus();
    const order: string[] = [];
    bus.on('AGENT_COMPLETED', () => order.push('type-listener'));
    bus.onDomain('agents', () => order.push('domain-listener'));

    order.push('before-emit');
    bus.emit('agents', agentEnvelope('a2'));
    order.push('after-emit');

    // Nothing ran between emit() and the next statement.
    expect(order).toEqual(['before-emit', 'after-emit']);

    await flushMicrotasks();

    expect(order).toContain('type-listener');
    expect(order).toContain('domain-listener');
    // Both listeners ran strictly AFTER the synchronous continuation of emit().
    expect(order.indexOf('after-emit')).toBeLessThan(order.indexOf('type-listener'));
    expect(order.indexOf('after-emit')).toBeLessThan(order.indexOf('domain-listener'));
  });

  test('a throwing subscriber cannot break the mutating caller — emit returns normally', async () => {
    const bus = new RuntimeEventBus();
    let reached = false;
    bus.onDomain('agents', () => { throw new Error('subscriber blew up'); });

    // emit() must not surface the deferred listener's throw to its caller.
    expect(() => {
      bus.emit('agents', agentEnvelope('a3'));
      reached = true;
    }).not.toThrow();
    expect(reached).toBe(true);

    // Draining the microtask queue where the listener actually throws must not
    // reject the flush (the bus catches per-subscriber errors).
    await flushMicrotasks();
  });
});
