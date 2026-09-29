/**
 * Notices carry their full text. Live run 7 showed
 * "[Agents] ✗ engineer … failed in 51s: planned-fix execution is not wired in
 * this composition (setFixWorkstreamRunner w": the producer cut the failure
 * reason at 80 characters, mid-word, with no ellipsis. The surface that draws
 * a notice wraps it; the producer never shortens it.
 *
 * Also covers the model-only channel: an instruction written for the model is
 * never a conversation message and reaches the model once, in the next
 * system prompt.
 */
import { describe, expect, test } from 'bun:test';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.js';
import { createEventEnvelope } from '../packages/sdk/src/platform/runtime/event-envelope.js';
import { registerHostRuntimeEvents, type HostRuntimeMessageRouter } from '../packages/sdk/src/platform/runtime/bootstrap-runtime-events.js';
import { ConversationManager } from '../packages/sdk/src/platform/core/conversation.js';
import { withModelInstructions } from '../packages/sdk/src/platform/core/orchestrator-turn-loop.js';

const LONG_REASON = 'planned-fix execution is not wired in this composition (setFixWorkstreamRunner was never called) and the chain could not continue past its review';

function harness() {
  const lines: string[] = [];
  const router: HostRuntimeMessageRouter = {
    low: (m) => lines.push(m),
    high: (m) => lines.push(m),
    wrfc: (m) => lines.push(m),
  };
  const bus = new RuntimeEventBus();
  const record = { id: 'agent-b6834750', template: 'engineer', task: 'Review the backoff logic', status: 'failed', startedAt: 0, completedAt: 51_000, toolCallCount: 3 };
  const domainDispatch = new Proxy({}, { get: () => () => {} });
  registerHostRuntimeEvents({
    runtimeBus: bus,
    domainDispatch: domainDispatch as never,
    getSystemMessageRouter: () => router,
    requestRender: () => {},
    configManager: { get: () => 9 } as never,
    agentManager: { getStatus: () => record, listByCohort: () => [], list: () => [] } as never,
    wrfcController: { getChain: () => null, listChains: () => [] } as never,
  });
  return { bus, lines };
}

describe('runtime notices keep their full text', () => {
  test('an agent failure notice carries the whole error', async () => {
    const { bus, lines } = harness();
    bus.emit('agents', createEventEnvelope('AGENT_FAILED', { type: 'AGENT_FAILED', agentId: 'agent-b6834750', error: LONG_REASON, durationMs: 51_000 }, { sessionId: 't', traceId: 't', source: 't' }));
    await Promise.resolve(); // the bus dispatches on a microtask
    const line = lines.find((l) => l.startsWith('[Agents] ✗'));
    expect(line).toBeDefined();
    expect(line!.endsWith(LONG_REASON)).toBe(true);
  });

  test('a chain failure notice carries the whole reason', async () => {
    const { bus, lines } = harness();
    bus.emit('workflows', createEventEnvelope('WORKFLOW_CHAIN_FAILED', { type: 'WORKFLOW_CHAIN_FAILED', chainId: 'wrfc-e9823b88', reason: LONG_REASON }, { sessionId: 't', traceId: 't', source: 't' }));
    await Promise.resolve(); // the bus dispatches on a microtask
    const line = lines.find((l) => l.startsWith('[WRFC] ✗ Chain'));
    expect(line).toBeDefined();
    expect(line!.endsWith(LONG_REASON)).toBe(true);
  });
});

describe('model-only instructions', () => {
  test('are not conversation messages and are delivered exactly once', () => {
    const conversation = new ConversationManager();
    conversation.addModelInstruction('You spawned an agent for part of the task. If there are remaining tasks, continue spawning agents now.');
    expect(conversation.getMessageSnapshot()).toHaveLength(0);
    const taken = conversation.takeModelInstructions();
    expect(taken).toEqual(['You spawned an agent for part of the task. If there are remaining tasks, continue spawning agents now.']);
    expect(conversation.takeModelInstructions()).toEqual([]);
  });

  test('ride the system prompt of the model call', () => {
    expect(withModelInstructions('base', [])).toBe('base');
    expect(withModelInstructions('base', ['continue spawning agents now'])).toBe('base\n\n## Orchestration notes\n- continue spawning agents now');
  });
});

describe('a turn that ends by spawning agents', () => {
  test('completes, and reaches the model-only channel instead of the transcript', async () => {
    const { handleToolResponseOutcome } = await import('../packages/sdk/src/platform/core/orchestrator-turn-helpers.js');
    const bus = new RuntimeEventBus();
    const stops: string[] = [];
    bus.on('TURN_COMPLETED', ({ payload }) => { stops.push((payload as { stopReason: string }).stopReason); });
    const conversation = new ConversationManager();
    conversation.addUserMessage('Spawn one agent to review retry.ts');
    await handleToolResponseOutcome({
      conversation,
      agentManager: { list: () => [], spawn: () => { throw new Error('unused'); } } as never,
      planManager: null,
      configManager: { get: () => undefined } as never,
      providerRegistry: { getCurrentModel: () => ({ displayName: 'm', provider: 'p', registryKey: 'p:m', capabilities: { multimodal: false } }) } as never,
      runtimeBus: bus,
      emitterContext: () => ({ sessionId: 't', traceId: 't', source: 't' }),
      turnId: 'turn-1',
      response: { content: '', toolCalls: [{ id: 'c1', name: 'agent', arguments: { mode: 'spawn', task: 'review retry.ts' } }] } as never,
      userText: 'Spawn one agent to review retry.ts',
      executeToolCalls: async () => [{ callId: 'c1', success: true, output: '{"status":"spawned"}' }],
      setPendingToolCalls: () => {},
      messageQueueLength: 0,
      requestRender: () => {},
    });
    await Promise.resolve();
    expect(stops).toEqual(['completed']);
    expect(conversation.getMessageSnapshot().some((m) => m.role === 'system')).toBe(false);
    expect(conversation.takeModelInstructions()).toEqual(['You spawned an agent for part of the task. If there are remaining tasks, continue spawning agents now.']);
  });
});
