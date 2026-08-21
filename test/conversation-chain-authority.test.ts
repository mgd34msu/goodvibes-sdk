/**
 * The owner pasted a flight itinerary into Telegram and got an engineering
 * workflow.
 *
 * Three separate defects produced that, and each has its own describe block
 * below:
 *
 * 1. The conversation gate correctly decided "this is conversation" and spawned
 *    with `dangerously_disable_wrfc: true` + `replyStyle: 'conversational'`. The
 *    root-spawn normalization then read the CONTINUATION PROMPT, which embeds
 *    the chat transcript, found an earlier assistant sentence ("I'll review the
 *    route, timing, stops"), and forced the chain back on. It then fed itself:
 *    the chain's own reply mentioned "review", so every later turn matched too.
 * 2. What the person received was the chain's bookkeeping, "WRFC chain
 *    wrfc-490aee53 passed (review 10/10); commit skipped: not a git repository"
 *   , instead of an answer.
 * 3. Every assistant message appeared TWICE in the continuation prompt, because
 *    two different reporters each wrote the same agent's completion into the
 *    shared session.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WrfcController } from '../packages/sdk/src/platform/agents/wrfc-controller.js';
import { SharedSessionBroker } from '../packages/sdk/src/platform/control-plane/session-broker.js';
import { trackDisposables } from './_helpers/disposables.ts';
import { AgentMessageBus } from '../packages/sdk/src/platform/agents/message-bus.js';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.js';
import { createEventEnvelope } from '../packages/sdk/src/platform/runtime/event-envelope.js';
import { AgentManager, type AgentRecord } from '../packages/sdk/src/platform/tools/agent/manager.js';
import { createAgentTool } from '../packages/sdk/src/platform/tools/agent/index.js';
import { renderAgentCompletionAnswer } from '../packages/sdk/src/platform/agents/completion-answer.js';
import {
  appendSharedSessionMessage,
  buildSharedSessionContinuationTask,
  findAgentCompletionMessage,
  type SharedSessionMessageStore,
} from '../packages/sdk/src/platform/control-plane/session-broker-messages.js';
import type { SharedSessionMessage, SharedSessionRecord } from '../packages/sdk/src/platform/control-plane/session-types.js';
import type { ConfigManager } from '../packages/sdk/src/platform/config/index.js';

const disposables = trackDisposables();

/** The exact prompt shape that hijacked the live conversation. */
const ITINERARY_CONTINUATION_TASK = [
  'Continue the shared control-plane session "8546431428".',
  '',
  'Preserve continuity with the recent transcript and answer the newest user message directly.',
  '',
  'Recent transcript:',
  'Avery: I\'m traveling from Dallas to Picayune MS on Thursday to see my parents.',
  '',
  'Assistant: I don’t see the itinerary screenshots attached here. Please upload or resend '
    + 'them, and I’ll review the route, timing, stops, and any potential travel issues for Thursday.',
  '',
  'Avery: Confirmation #: B79YKY. Departing Thu, Aug 06 2026, 07:55 AM DAL, arrives 09:20 AM MSY.',
].join('\n');

function createConfigManager(): Pick<ConfigManager, 'get' | 'getCategory'> {
  const get = ((key: string): unknown => {
    if (key === 'wrfc.scoreThreshold') return 9.9;
    if (key === 'wrfc.maxFixAttempts') return 3;
    if (key === 'wrfc.autoCommit') return false;
    if (key === 'agents.maxActive') return 20;
    return undefined;
  }) as ConfigManager['get'];
  const getCategory = ((category: string): unknown => {
    if (category === 'wrfc') {
      return { scoreThreshold: 9.9, maxFixAttempts: 3, autoCommit: false, gates: [] };
    }
    return undefined;
  }) as ConfigManager['getCategory'];
  return { get, getCategory };
}

interface Harness {
  readonly bus: RuntimeEventBus;
  readonly manager: AgentManager;
  readonly controller: WrfcController;
  readonly tool: ReturnType<typeof createAgentTool>;
  readonly runRecords: AgentRecord[];
}

function createHarness(): Harness {
  const runRecords: AgentRecord[] = [];
  const bus = new RuntimeEventBus();
  const messageBus = new AgentMessageBus();
  const configManager = createConfigManager();
  const manager = new AgentManager({
    archetypeLoader: { loadArchetype: () => null },
    messageBus,
    configManager,
    executor: {
      async runAgent(record) {
        record.status = 'running';
        runRecords.push(record);
      },
    },
  });
  manager.setRuntimeBus(bus);
  const controller = new WrfcController(bus, messageBus, {
    agentManager: manager,
    configManager,
    projectRoot: '/tmp/conversation-chain-authority-test',
    createWorktree: () => ({ merge: async () => true, cleanup: async () => {} }),
  });
  manager.setWrfcController(controller);
  const tool = createAgentTool({
    manager,
    messageBus,
    wrfcController: controller,
    archetypeLoader: { loadArchetype: () => null },
    configManager,
  });
  return { bus, manager, controller, tool, runRecords };
}

async function flushMicrotasks(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

function emitAgentCompleted(bus: RuntimeEventBus, agentId: string): void {
  bus.emit(
    'agents',
    createEventEnvelope(
      'AGENT_COMPLETED',
      { type: 'AGENT_COMPLETED', agentId, durationMs: 0 },
      { sessionId: 'test', traceId: `test:${agentId}:completed`, source: 'test' },
    ),
  );
}

describe('an explicit no-chain decision outranks a review/test wording match', () => {
  test('a conversational continuation whose transcript says "review the route" starts no chain', () => {
    const { manager, controller } = createHarness();

    const record = manager.spawn({
      mode: 'spawn',
      task: ITINERARY_CONTINUATION_TASK,
      dangerously_disable_wrfc: true,
      replyStyle: 'conversational',
    });

    expect(controller.listChains()).toHaveLength(0);
    expect(record.wrfcId).toBeUndefined();
    expect(record.wrfcRole).toBeUndefined();
    expect(record.wrfcRouteReason).toBeUndefined();
    // The whole decision survives, not just half of it: the reply must still
    // read as a reply to a person, and the task must not be rewritten into an
    // authoritative engineering ask.
    expect(record.replyStyle).toBe('conversational');
    expect(record.dangerously_disable_wrfc).toBe(true);
    expect(record.reviewMode).toBe('none');
    expect(record.template).not.toBe('engineer');
    expect(record.task).toBe(ITINERARY_CONTINUATION_TASK);
    expect(record.context ?? '').not.toContain('WRFC topology enforcement');
  });

  test('the same wording still starts a chain when nobody suppressed it', () => {
    const { manager, controller } = createHarness();

    const record = manager.spawn({ mode: 'spawn', task: ITINERARY_CONTINUATION_TASK });

    expect(controller.listChains()).toHaveLength(1);
    expect(record.wrfcRole).toBe('owner');
    expect(record.wrfcRouteReason).toBe('root-review-role-normalized');
  });

  test('a DECLARED reviewer template is still normalized despite the suppression flag', () => {
    const { manager, controller } = createHarness();

    // Asking for a root reviewer agent and asking for no chain at the same time
    // is the role fragmentation the normalization exists to correct. Naming the
    // role is the caller stating what the agent IS, not a guess about wording.
    const record = manager.spawn({
      mode: 'spawn',
      task: 'Review the implementation for correctness.',
      template: 'reviewer',
      dangerously_disable_wrfc: true,
    });

    expect(controller.listChains()).toHaveLength(1);
    expect(record.wrfcRole).toBe('owner');
    expect(record.template).toBe('engineer');
    expect(record.dangerously_disable_wrfc).toBe(false);
  });

  test('the orchestration-batch role collapse still fires for a root review task', async () => {
    const { controller, manager, tool } = createHarness();

    const result = await tool.execute({
      mode: 'batch-spawn',
      tasks: [
        { task: 'Build a simple rate limiter.', template: 'engineer' },
        { task: 'Review the implementation for correctness.', template: 'general' },
      ],
    });

    expect(result.success).toBe(true);
    const output = JSON.parse(result.output!) as { collapsedToWrfc?: boolean; agents: Array<{ id: string }> };
    expect(output.collapsedToWrfc).toBe(true);
    expect(controller.listChains()).toHaveLength(1);
    expect(manager.list().filter((agent) => !agent.parentAgentId)).toHaveLength(1);
  });
});

describe('a finished chain reports its work, not its bookkeeping', () => {
  test('the reply a surface would send is the answer, and the status line stays operator-only', async () => {
    const { bus, manager, controller } = createHarness();

    const owner = manager.spawn({ mode: 'spawn', task: 'add a slugify helper' });
    const chain = controller.listChains()[0]!;
    expect(chain.ownerAgentId).toBe(owner.id);

    const engineer = manager.getStatus(chain.engineerAgentId!)!;
    engineer.fullOutput = 'Added the slugify helper and wired it into the exports.';
    emitAgentCompleted(bus, engineer.id);
    await flushMicrotasks();

    const reviewer = manager.list().find((record) => record.wrfcRole === 'reviewer')!;
    reviewer.fullOutput = ['```json', JSON.stringify({
      version: 1,
      archetype: 'reviewer',
      summary: 'Review passed.',
      score: 10,
      passed: true,
      dimensions: [],
      issues: [],
      constraintFindings: [],
      acceptanceChecklist: [{ item: 'deliverable meets the task ask', verified: true, evidence: 'exercised in test fixture' }],
    }), '```'].join('\n');
    emitAgentCompleted(bus, reviewer.id);
    await flushMicrotasks(40);

    expect(chain.state).toBe('passed');
    expect(owner.status).toBe('completed');

    // renderAgentCompletionAnswer is the single rule every surface reply path
    // runs (daemon/surface-delivery.ts and the client session-dispatch seam both
    // call it), so asserting it is asserting what the person receives.
    const reply = renderAgentCompletionAnswer(owner);
    expect(reply).toBe('Added the slugify helper and wired it into the exports.');
    expect(reply).not.toContain('WRFC chain');
    expect(reply).not.toContain('commit skipped');
    expect(reply).not.toContain('review 10/10');

    // The status line is not lost, it is on the operator-audience progress
    // field, which the channel delivery path never forwards to a person.
    expect(owner.progress).toContain(`WRFC chain ${chain.id} passed`);
    expect(owner.progressAudience).toBe('operator');
  });

  test('a chain with nothing to show says so in plain words, never in chain identifiers', async () => {
    const { bus, manager, controller } = createHarness();

    const owner = manager.spawn({ mode: 'spawn', task: 'confirm the deployment is healthy' });
    const chain = controller.listChains()[0]!;
    const engineer = manager.getStatus(chain.engineerAgentId!)!;
    // No output at all from the work phase.
    engineer.fullOutput = '';
    emitAgentCompleted(bus, engineer.id);
    await flushMicrotasks();

    const reviewer = manager.list().find((record) => record.wrfcRole === 'reviewer')!;
    reviewer.fullOutput = ['```json', JSON.stringify({
      version: 1,
      archetype: 'reviewer',
      summary: 'Review passed.',
      score: 10,
      passed: true,
      dimensions: [],
      issues: [],
      constraintFindings: [],
      acceptanceChecklist: [{ item: 'deliverable meets the task ask', verified: true, evidence: 'exercised in test fixture' }],
    }), '```'].join('\n');
    emitAgentCompleted(bus, reviewer.id);
    await flushMicrotasks(40);

    expect(chain.state).toBe('passed');
    const reply = renderAgentCompletionAnswer(owner);
    expect(reply).toBe('The work is finished. The full-scope review and the quality gates passed.');
    expect(reply).not.toContain(chain.id);
  });
});

describe('an agent contributes one message to the transcript, not two', () => {
  function createStore(sessionId: string): SharedSessionMessageStore {
    const now = Date.now();
    const session: SharedSessionRecord = {
      id: sessionId,
      title: 'Telegram 8546431428',
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
      messageCount: 0,
      participants: [],
      routeIds: [],
    } as unknown as SharedSessionRecord;
    return {
      sessions: new Map([[sessionId, session]]),
      messages: new Map<string, SharedSessionMessage[]>(),
    };
  }

  test('findAgentCompletionMessage recognizes an agent that already reported', () => {
    const store = createStore('session-1');
    expect(findAgentCompletionMessage(store, 'session-1', 'agent-a')).toBeUndefined();

    appendSharedSessionMessage(store, {
      sessionId: 'session-1',
      role: 'assistant',
      body: 'sunny and 74 degrees',
      agentId: 'agent-a',
      metadata: { status: 'completed' },
    }, 100);

    expect(findAgentCompletionMessage(store, 'session-1', 'agent-a')?.body).toBe('sunny and 74 degrees');
    // A message from the same agent WITHOUT a terminal status (a progress note)
    // is not a completion and must not suppress the real one.
    expect(findAgentCompletionMessage(store, 'session-1', 'agent-b')).toBeUndefined();
  });

  test('the continuation prompt carries each assistant answer once', () => {
    const store = createStore('session-2');
    const append = (input: Parameters<typeof appendSharedSessionMessage>[1]): void => {
      // Exactly what the broker does now: the second reporter for an agent that
      // already reported is not stored again.
      if (input.agentId && findAgentCompletionMessage(store, input.sessionId, input.agentId)) return;
      appendSharedSessionMessage(store, input, 100);
    };

    append({ sessionId: 'session-2', role: 'user', body: 'How’s the weather', displayName: 'Avery' });
    // The runtime event bus reports the finished agent...
    append({ sessionId: 'session-2', role: 'assistant', body: 'Sunny and 74.', agentId: 'agent-w', metadata: { status: 'completed' } });
    // ...and the pending-surface-reply poller reports the same one.
    append({ sessionId: 'session-2', role: 'assistant', body: 'Sunny and 74.', agentId: 'agent-w', metadata: { status: 'completed' } });

    const messages = store.messages.get('session-2') ?? [];
    expect(messages.filter((message) => message.role === 'assistant')).toHaveLength(1);

    const prompt = buildSharedSessionContinuationTask({
      session: store.sessions.get('session-2') ?? null,
      messages,
      fallbackSessionId: 'session-2',
    });
    expect(prompt.split('Assistant: Sunny and 74.').length - 1).toBe(1);
  });

  test('the real broker stores one message when both reporters call completeAgent', async () => {
    const storePath = join(mkdtempSync(join(tmpdir(), 'gv-chain-authority-')), 'sessions.json');
    const broker = disposables.add(new SharedSessionBroker({
      storePath,
      routeBindings: {
        start: async () => {},
        stop: async () => {},
        list: () => [],
        getBinding: () => null,
        resolve: () => null,
        patchBinding: async () => null,
      },
      agentStatusProvider: { getStatus: () => null },
      messageSender: { send: () => false },
    } as unknown as ConstructorParameters<typeof SharedSessionBroker>[0]));

    await broker.createSession({ id: 'session-both' });

    // The runtime event bus fires first with the agent's own output...
    await broker.completeAgent('session-both', 'agent-both', 'Your flight leaves DAL at 07:55.', { status: 'completed', durationMs: 12 });
    // ...then the daemon's pending-surface-reply poller reports the same agent.
    await broker.completeAgent('session-both', 'agent-both', 'Your flight leaves DAL at 07:55.', { status: 'completed', routeId: 'route-telegram-1' });

    const stored = broker.getMessages('session-both', 100)
      .filter((message) => message.agentId === 'agent-both');
    expect(stored).toHaveLength(1);
    expect(stored[0]?.body).toBe('Your flight leaves DAL at 07:55.');
    expect(stored[0]?.role).toBe('assistant');
  });
});
