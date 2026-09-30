/**
 * Notifications name the work (owner ruling 2026-09-29), the delivery side:
 * the config schema default, the webhook runtime messages and the
 * orchestrator's own end-of-turn popup. Imports only modules that existed
 * before the change, so each test here fails on the old code by assertion.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { CONFIG_SCHEMA, DEFAULT_CONFIG } from '../packages/sdk/src/platform/config/schema.js';
import { WebhookNotifier } from '../packages/sdk/src/platform/integrations/webhooks.js';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.js';
import { Orchestrator } from '../packages/sdk/src/platform/core/orchestrator.js';

describe('the privacy setting', () => {
  test('behavior.notificationsMetadataOnly is in the config schema, boolean, default off', () => {
    const entry = CONFIG_SCHEMA.find((setting) => setting.key === 'behavior.notificationsMetadataOnly');
    expect(entry?.type).toBe('boolean');
    expect(entry?.default).toBe(false);
    expect(entry?.description).toContain('metadata only');
    expect((DEFAULT_CONFIG.behavior as Record<string, unknown>)['notificationsMetadataOnly']).toBe(false);
  });
});

describe('WebhookNotifier runtime notifications name the task', () => {
  async function capture(metadataOnly: boolean, emit: (bus: RuntimeEventBus) => void): Promise<string[]> {
    const sent: string[] = [];
    const bus = new RuntimeEventBus();
    const notifier = new WebhookNotifier(['https://example.com/hook'], { metadataOnly: () => metadataOnly });
    const spy = spyOn(notifier, 'send').mockImplementation(async (text: string) => {
      sent.push(text);
      return { attempted: 1, delivered: 1, failed: 0, results: [] };
    });
    try {
      notifier.attachToRuntimeBus(bus);
      emit(bus);
      await new Promise((resolve) => setTimeout(resolve, 10));
      return sent;
    } finally {
      spy.mockRestore();
      notifier.detach();
    }
  }

  const ctx = { sessionId: 's1', traceId: 't', source: 'test' };
  function agentRun(bus: RuntimeEventBus): void {
    bus.emit('agents', { type: 'AGENT_SPAWNING', payload: { type: 'AGENT_SPAWNING', agentId: 'agent-1', task: 'Audit the retry backoff' }, ...ctx } as never);
    bus.emit('agents', { type: 'AGENT_FAILED', payload: { type: 'AGENT_FAILED', agentId: 'agent-1', error: 'ran out of turns', durationMs: 5 }, ...ctx } as never);
    bus.emit('workflows', { type: 'WORKFLOW_CHAIN_CREATED', payload: { type: 'WORKFLOW_CHAIN_CREATED', chainId: 'chain-1', task: 'Rewrite the retry backoff' }, ...ctx } as never);
    bus.emit('workflows', { type: 'WORKFLOW_CHAIN_FAILED', payload: { type: 'WORKFLOW_CHAIN_FAILED', chainId: 'chain-1', reason: 'review score 4/10' }, ...ctx } as never);
  }

  test('privacy off: agent and workstream bodies carry the task and reason', async () => {
    const sent = await capture(false, agentRun);
    expect(sent).toEqual([
      'Agent failed: Audit the retry backoff\nran out of turns',
      'Workstream could not be finished: Rewrite the retry backoff\nreview score 4/10',
    ]);
  });

  test('privacy on: ids and outcomes only', async () => {
    const sent = await capture(true, agentRun);
    expect(sent).toEqual(['Agent failed: agent-1', 'A workstream could not be finished.']);
  });
});

describe('the orchestrator end-of-turn popup names the turn and its outcome', () => {
  type Notify = (title: string, body: string, durationMs: number) => void;
  const proto = Orchestrator.prototype as unknown as {
    finalizeTurn(this: unknown, start: number, key: string, turnId: string, config: unknown, text: string): void;
    handleTurnError(this: unknown, err: unknown, turnId: string, config: unknown, registry: unknown): void;
  };

  /**
   * The real TurnEndNotice, loaded dynamically so this file still runs (and
   * fails by assertion) against code from before the module existed.
   */
  async function realTurnEnd(notify: Notify): Promise<unknown> {
    const mod = await import('../packages/sdk/src/platform/core/turn-end-notice.js').catch(() => null);
    if (!mod) return undefined;
    const turnEnd = new mod.TurnEndNotice();
    turnEnd.notify = notify;
    return turnEnd;
  }

  async function fakeOrchestrator(title: string, metadataOnly: boolean, aborted: boolean) {
    const calls: Array<[string, string]> = [];
    const notify: Notify = (t, b) => { calls.push([t, b]); };
    const config = { get: (key: string) => (key === 'behavior.notificationsMetadataOnly' ? metadataOnly : key === 'behavior.notifyOnComplete' ? true : undefined) };
    const turnEnd = await realTurnEnd(notify);
    const self = {
      _pendingToolCalls: [],
      currentSubmissionKey: null,
      _turnFailed: false,
      turnEndNotice: turnEnd,
      sessionId: 'abcdef1234567890',
      abortController: { signal: { aborted } },
      isStreaming: false,
      turnStartMessageCount: 0,
      runtimeBus: null,
      conversation: {
        title,
        getTitleSource: () => 'system' as const,
        addSystemMessage: () => {},
        removeMessagesAfter: () => {},
        markLastUserMessageCancelled: () => {},
      },
      requestRender: () => {},
      stopThinking: () => {},
      replayQueue: { onTurnComplete: () => [] },
      followUpRuntime: { scheduleFlush: () => {} },
    };
    const registry = { getCurrentModel: () => ({ provider: 'p' }), findAlternativeModel: () => null };
    return { self, config, registry, calls };
  }

  const ASK = 'Run the migration checks and summarize what changed in the schema\nwith details';

  test('completed', async () => {
    const { self, config, calls } = await fakeOrchestrator('first message', false, false);
    proto.finalizeTurn.call(self, Date.now() - 42_000, 'k', 't1', config, ASK);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe('Run the migration checks and summarize what changed…');
    expect(calls[0]![1]).toMatch(/^Done in 4[23]s$/);
  });

  test('failed carries the reason', async () => {
    const { self, config, registry, calls } = await fakeOrchestrator('first message', false, false);
    proto.handleTurnError.call(self, new Error('Provider returned HTTP 502'), 't1', { get: () => false }, registry);
    proto.finalizeTurn.call(self, Date.now() - 42_000, 'k', 't1', config, ASK);
    expect(calls[0]![0]).toBe('Run the migration checks and summarize what changed…');
    expect(calls[0]![1]).toMatch(/^Failed after 4[23]s: .*Provider returned HTTP 502/);
  });

  test('cancelled', async () => {
    const { self, config, registry, calls } = await fakeOrchestrator('first message', false, true);
    proto.handleTurnError.call(self, new Error('aborted'), 't1', { get: () => false }, registry);
    proto.finalizeTurn.call(self, Date.now() - 42_000, 'k', 't1', config, ASK);
    expect(calls[0]![1]).toMatch(/^Cancelled after 4[23]s$/);
  });

  test('metadata only', async () => {
    const { self, config, registry, calls } = await fakeOrchestrator('first message', true, false);
    proto.handleTurnError.call(self, new Error('Provider returned HTTP 502'), 't1', { get: () => false }, registry);
    proto.finalizeTurn.call(self, Date.now() - 42_000, 'k', 't1', config, ASK);
    expect(calls[0]![0]).toBe('GoodVibes: turn failed');
    expect(calls[0]![1]).toMatch(/^Failed after 4[23]s, session abcdef12$/);
  });
});
