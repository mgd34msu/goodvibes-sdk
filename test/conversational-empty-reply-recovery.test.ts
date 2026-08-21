/**
 * An empty answer is a defect in a conversation and an outcome in the background.
 *
 * Owner ruling: "if it is truly worthy of silence then let it be silence.
 * otherwise, i generally expect a conversation to have a response."
 *
 * So a run that owes a person an answer and produces nothing gets one more
 * attempt, and then says plainly that no reply was generated. A background run
 * that produces nothing notifies nobody, no bare "Done.", no "Completed".
 */
import { describe, expect, test } from 'bun:test';
import {
  CONVERSATIONAL_EMPTY_REPLY_NOTICE,
  CONVERSATIONAL_REGENERATION_REQUEST,
  completeOrRegenerate,
  recoverEmptyConversationalReply,
} from '../packages/sdk/src/platform/agents/conversational-reply-recovery.js';
import { ChannelReplyPipeline } from '../packages/sdk/src/platform/channels/reply-pipeline.js';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.js';
import { emitAgentCompleted } from '../packages/sdk/src/platform/runtime/emitters/agents.js';
import type { AgentRecord } from '../packages/sdk/src/platform/tools/agent/manager.js';

function record(replyStyle?: 'conversational'): AgentRecord {
  return {
    id: 'agent-1',
    task: 'Hey, are you there?',
    template: 'general',
    tools: [],
    status: 'running',
    startedAt: 0,
    toolCallCount: 0,
    orchestrationDepth: 0,
    executionProtocol: 'gather-plan-apply',
    reviewMode: 'none',
    communicationLane: 'direct',
    ...(replyStyle ? { replyStyle } : {}),
  } as AgentRecord;
}

/** The slice of ConversationManager the recovery policy touches. */
function conversation() {
  const messages: Array<{ role: string; content: unknown }> = [];
  return {
    messages,
    addAssistantMessage(content: string) { messages.push({ role: 'assistant', content }); },
    addUserMessage(content: string) { messages.push({ role: 'user', content }); },
    getMessageSnapshot() { return messages; },
  };
}

describe('a conversation always gets a response', () => {
  test('an empty answer is regenerated once, and the retry is what the person receives', () => {
    const agent = record('conversational');
    const chat = conversation();

    // Turn 1: the model returns nothing at all.
    expect(completeOrRegenerate(agent, chat, { content: '' })).toBe(true);
    expect(chat.messages.at(-1)).toEqual({ role: 'user', content: CONVERSATIONAL_REGENERATION_REQUEST });

    // Turn 2: asked again, it answers.
    expect(completeOrRegenerate(agent, chat, { content: "Yes, I'm here." })).toBe(false);
    recoverEmptyConversationalReply(agent);
    expect(agent.fullOutput).toBe("Yes, I'm here.");
  });

  test('whitespace is empty', () => {
    const agent = record('conversational');
    expect(completeOrRegenerate(agent, conversation(), { content: '   \n\t ' })).toBe(true);
  });

  test('two empty answers produce one plain failure line, never silence', () => {
    const agent = record('conversational');
    const chat = conversation();

    expect(completeOrRegenerate(agent, chat, { content: '' })).toBe(true);
    // Still nothing the second time: the run ends rather than asking again.
    expect(completeOrRegenerate(agent, chat, { content: '' })).toBe(false);
    recoverEmptyConversationalReply(agent);

    expect(agent.fullOutput).toBe(CONVERSATIONAL_EMPTY_REPLY_NOTICE);
    expect(agent.fullOutput).toBe('No reply was generated, something went wrong on my side.');
    // One notice, not a repeated one, and no bare acknowledgement anywhere.
    expect(agent.fullOutput).not.toContain('Done');
    expect(agent.fullOutput).not.toContain('Completed');
  });

  test('the regeneration is spent once per run, however many turns follow', () => {
    const agent = record('conversational');
    const chat = conversation();
    expect(completeOrRegenerate(agent, chat, { content: '' })).toBe(true);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(completeOrRegenerate(agent, chat, { content: '' })).toBe(false);
    }
    const requests = chat.messages.filter((m) => m.content === CONVERSATIONAL_REGENERATION_REQUEST);
    expect(requests).toHaveLength(1);
  });

  test('a run that ends some other way still gets the notice at the completion funnel', () => {
    // A turn budget exhausted mid-answer never reaches completeOrRegenerate.
    const agent = record('conversational');
    recoverEmptyConversationalReply(agent);
    expect(agent.fullOutput).toBe(CONVERSATIONAL_EMPTY_REPLY_NOTICE);
  });

  test('a real answer is never touched', () => {
    const agent = record('conversational');
    const chat = conversation();
    expect(completeOrRegenerate(agent, chat, { content: 'The build is green.' })).toBe(false);
    recoverEmptyConversationalReply(agent);
    expect(agent.fullOutput).toBe('The build is green.');
    expect(chat.messages.some((m) => m.content === CONVERSATIONAL_REGENERATION_REQUEST)).toBe(false);
  });
});

describe('background work with nothing to report stays silent', () => {
  test('an empty background answer is neither regenerated nor replaced', () => {
    const agent = record();
    const chat = conversation();
    expect(completeOrRegenerate(agent, chat, { content: '' })).toBe(false);
    recoverEmptyConversationalReply(agent);
    expect(agent.fullOutput).toBe('');
    expect(chat.messages.some((m) => m.content === CONVERSATIONAL_REGENERATION_REQUEST)).toBe(false);
  });

  test('a completion with no output notifies nobody, and still closes the run out', async () => {
    const published: string[] = [];
    const bus = new RuntimeEventBus();
    const pipeline = new ChannelReplyPipeline({
      channelPlugins: {
        getRenderPolicy: async () => null,
        render: async (_surface: string, request: { text: string }) => {
          published.push(request.text);
          return { delivered: true, metadata: {} };
        },
      },
      routeBindings: { captureReplyTarget: async () => {} },
      runtimeBus: bus,
    } as unknown as ConstructorParameters<typeof ChannelReplyPipeline>[0]);

    pipeline.trackPending({
      agentId: 'agent-quiet',
      surfaceKind: 'ntfy',
      task: 'nightly checkin',
      createdAt: Date.now(),
      routeId: 'route-1',
    } as unknown as Parameters<ChannelReplyPipeline['trackPending']>[0]);

    emitAgentCompleted(bus, {
      sessionId: 'test-session',
      traceId: 'complete-quiet',
      source: 'test',
      agentId: 'agent-quiet',
    }, { agentId: 'agent-quiet', durationMs: 5, output: '' });

    await new Promise((resolve) => { setTimeout(resolve, 20); });
    // No "Done.", no "Completed", nothing at all.
    expect(published).toEqual([]);
    // The pipeline invariant: silence still closes the run out, so the poller
    // cannot treat this agent as unhandled and re-deliver it forever.
    expect(pipeline.has('agent-quiet')).toBe(false);
    pipeline.dispose();
  });
});
