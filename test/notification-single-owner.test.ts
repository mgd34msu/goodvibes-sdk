/**
 * One notice per turn, and every channel names the work (owner rulings
 * 2026-09-29).
 *
 * 1. A host that shows its own end-of-turn popup (the TUI's long-task
 *    notifier) hands the Orchestrator's popup off, so a long turn produces one
 *    desktop popup, not two. A host that never hands it off (the agent, a
 *    daemon-hosted session) keeps the Orchestrator's popup as its only one.
 * 2. The Slack and Discord notifier names the agent's or workstream's task and
 *    follows behavior.notificationsMetadataOnly, read at send time, the same
 *    words the webhook channel uses.
 *
 * Imports only modules that existed before the change, so each test here
 * fails on the old code by assertion.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Orchestrator } from '../packages/sdk/src/platform/core/orchestrator.js';
import { TurnEndNotice } from '../packages/sdk/src/platform/core/turn-end-notice.js';
import { Notifier } from '../packages/sdk/src/platform/integrations/notifier.js';
import { SlackIntegration } from '../packages/sdk/src/platform/integrations/slack.js';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.js';

type Notify = (title: string, body: string, durationMs: number) => void;

describe('the Orchestrator end-of-turn popup can be handed to the host (orchestrator.turnEndNotice.handOff)', () => {
  const proto = Orchestrator.prototype as unknown as {
    finalizeTurn(this: unknown, start: number, key: string, turnId: string, config: unknown, text: string): void;
  };
  type HandOff = { handOff?: () => () => void };

  function fakeOrchestrator() {
    const calls: Array<[string, string]> = [];
    const turnEnd = new TurnEndNotice();
    turnEnd.notify = ((title, body) => { calls.push([title, body]); }) as Notify as typeof turnEnd.notify;
    const self = {
      _pendingToolCalls: [],
      currentSubmissionKey: null,
      _turnFailed: false,
      // Both names, so the code from before this change (field `turnEnd`)
      // runs and fails by assertion rather than by a missing field.
      turnEnd,
      turnEndNotice: turnEnd,
      sessionId: 'abcdef1234567890',
      conversation: { title: 'first message', getTitleSource: () => 'system' as const },
      stopThinking: () => {},
      replayQueue: { onTurnComplete: () => [] },
      followUpRuntime: { scheduleFlush: () => {} },
    };
    const config = { get: (key: string) => (key === 'behavior.notifyOnComplete' ? true : undefined) };
    return { self, config, calls };
  }

  test('a host that never hands it off keeps the popup (agent, daemon-hosted sessions)', () => {
    const { self, config, calls } = fakeOrchestrator();
    proto.finalizeTurn.call(self, Date.now() - 42_000, 'k', 't1', config, 'Rename the config loader');
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe('Rename the config loader');
  });

  test('after the host hands it off, a long turn sends no Orchestrator popup', () => {
    const { self, config, calls } = fakeOrchestrator();
    const notice = self.turnEndNotice as HandOff;
    expect(typeof notice.handOff).toBe('function');
    notice.handOff!();
    proto.finalizeTurn.call(self, Date.now() - 42_000, 'k', 't1', config, 'Rename the config loader');
    expect(calls).toHaveLength(0);
  });

  test('the returned release gives the popup back, and a failure recorded while handed off does not leak into the next turn', () => {
    const { self, config, calls } = fakeOrchestrator();
    const notice = self.turnEndNotice as HandOff;
    expect(typeof notice.handOff).toBe('function');
    const release = notice.handOff!();
    self.turnEndNotice.markFailed('provider returned 502');
    proto.finalizeTurn.call(self, Date.now() - 42_000, 'k', 't1', config, 'First ask');
    release();
    proto.finalizeTurn.call(self, Date.now() - 42_000, 'k', 't2', config, 'Second ask');
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe('Second ask');
    expect(calls[0]![1]).toMatch(/^Done in 4[23]s$/);
  });
});

describe('the Slack and Discord notifier names the work and follows the privacy setting', () => {
  const ctx = { sessionId: 's1', traceId: 't', source: 'test' };
  function run(bus: RuntimeEventBus): void {
    bus.emit('agents', { type: 'AGENT_SPAWNING', payload: { type: 'AGENT_SPAWNING', agentId: 'agent-1', task: 'Audit the retry backoff' }, ...ctx } as never);
    bus.emit('agents', { type: 'AGENT_COMPLETED', payload: { type: 'AGENT_COMPLETED', agentId: 'agent-1', durationMs: 5, output: 'secret model output about the code' }, ...ctx } as never);
    bus.emit('workflows', { type: 'WORKFLOW_CHAIN_CREATED', payload: { type: 'WORKFLOW_CHAIN_CREATED', chainId: 'chain-1', task: 'Rewrite the retry backoff' }, ...ctx } as never);
    bus.emit('workflows', { type: 'WORKFLOW_CHAIN_PASSED', payload: { type: 'WORKFLOW_CHAIN_PASSED', chainId: 'chain-1' }, ...ctx } as never);
    bus.emit('workflows', { type: 'WORKFLOW_CHAIN_CREATED', payload: { type: 'WORKFLOW_CHAIN_CREATED', chainId: 'chain-2', task: 'Split the parser module' }, ...ctx } as never);
    bus.emit('workflows', { type: 'WORKFLOW_CHAIN_FAILED', payload: { type: 'WORKFLOW_CHAIN_FAILED', chainId: 'chain-2', reason: 'review score 4/10' }, ...ctx } as never);
  }

  async function capture(metadataOnly: () => boolean, emit: (bus: RuntimeEventBus) => void | Promise<void> = run) {
    const slackSent: string[] = [];
    const discordSent: string[] = [];
    const slack = { postWebhook: async (text: string) => { slackSent.push(text); } };
    const discord = { postWebhook: async (text: string) => { discordSent.push(text); } };
    const notifier = new Notifier({ slack: slack as never, discord: discord as never, metadataOnly } as ConstructorParameters<typeof Notifier>[0]);
    const bus = new RuntimeEventBus();
    try {
      notifier.attachToRuntimeBus(bus);
      await emit(bus);
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { slackSent, discordSent };
    } finally {
      notifier.detach();
      notifier.dispose();
    }
  }

  test('privacy off: the task names the work; model output is never the name', async () => {
    const { slackSent, discordSent } = await capture(() => false);
    const expected = [
      'Agent finished: Audit the retry backoff',
      'Workstream passed all its checks: Rewrite the retry backoff',
      'Workstream could not be finished: Split the parser module\nreview score 4/10',
    ];
    expect(slackSent).toEqual(expected);
    expect(discordSent).toEqual(expected);
  });

  test('privacy on: ids and outcomes only, no task, no reason, no output', async () => {
    const { slackSent, discordSent } = await capture(() => true);
    const expected = [
      'Agent completed: agent-1',
      'A workstream passed all its checks.',
      'A workstream could not be finished.',
    ];
    expect(slackSent).toEqual(expected);
    expect(discordSent).toEqual(expected);
  });

  test('the setting is read at send time, so a change applies without a restart', async () => {
    let metadataOnly = true;
    const { slackSent } = await capture(() => metadataOnly, async (bus) => {
      bus.emit('agents', { type: 'AGENT_SPAWNING', payload: { type: 'AGENT_SPAWNING', agentId: 'agent-1', task: 'Audit the retry backoff' }, ...ctx } as never);
      bus.emit('agents', { type: 'AGENT_COMPLETED', payload: { type: 'AGENT_COMPLETED', agentId: 'agent-1', durationMs: 5 }, ...ctx } as never);
      await new Promise((resolve) => setTimeout(resolve, 10));
      metadataOnly = false;
      bus.emit('agents', { type: 'AGENT_SPAWNING', payload: { type: 'AGENT_SPAWNING', agentId: 'agent-2', task: 'Check the lockfile' }, ...ctx } as never);
      bus.emit('agents', { type: 'AGENT_COMPLETED', payload: { type: 'AGENT_COMPLETED', agentId: 'agent-2', durationMs: 5 }, ...ctx } as never);
    });
    expect(slackSent).toEqual(['Agent completed: agent-1', 'Agent finished: Check the lockfile']);
  });

  test('a reader that throws fails toward metadata only', async () => {
    const { slackSent } = await capture(() => { throw new Error('config not ready'); });
    expect(slackSent[0]).toBe('Agent completed: agent-1');
  });

  describe('fromConfig takes the reader', () => {
    let spy: ReturnType<typeof spyOn> | null = null;
    afterEach(() => { spy?.mockRestore(); spy = null; });

    test('Notifier.fromConfig passes metadataOnly through', async () => {
      const sent: string[] = [];
      spy = spyOn(SlackIntegration.prototype, 'postWebhook').mockImplementation(async (text: string) => { sent.push(text); });
      const registry = { resolveSecret: async (service: string, key: string) => (service === 'slack' && key === 'webhookUrl' ? 'https://hooks.slack.example/x' : null) };
      const fromConfig = Notifier.fromConfig as unknown as (r: unknown, o: { metadataOnly: () => boolean }) => Promise<Notifier>;
      const notifier = await fromConfig(registry, { metadataOnly: () => true });
      const bus = new RuntimeEventBus();
      notifier.attachToRuntimeBus(bus);
      bus.emit('workflows', { type: 'WORKFLOW_CHAIN_CREATED', payload: { type: 'WORKFLOW_CHAIN_CREATED', chainId: 'chain-9', task: 'Private task name' }, ...ctx } as never);
      bus.emit('workflows', { type: 'WORKFLOW_CHAIN_FAILED', payload: { type: 'WORKFLOW_CHAIN_FAILED', chainId: 'chain-9', reason: 'private reason' }, ...ctx } as never);
      await new Promise((resolve) => setTimeout(resolve, 10));
      notifier.detach();
      notifier.dispose();
      expect(sent).toEqual(['A workstream could not be finished.']);
    });
  });
});
