import { describe, expect, test } from 'bun:test';
import { ConversationManager } from '../packages/sdk/src/platform/core/conversation.js';
import { handleToolResponseOutcome } from '../packages/sdk/src/platform/core/orchestrator-turn-helpers.js';
import {
  buildWrfcWorkflowRoutingPrompt,
  isWrfcWorkflowRequest,
  toolResultIndicatesAuthoritativeWrfcChain,
} from '../packages/sdk/src/platform/core/wrfc-routing.js';
import type { ToolCall, ToolResult } from '../packages/sdk/src/platform/types/tools.js';

function createProviderRegistry() {
  return {
    getCurrentModel: () => ({
      displayName: 'test-model',
      provider: 'test',
      capabilities: { multimodal: false },
    }),
  };
}

describe('orchestrator WRFC spawn continuation contract', () => {
  test('classifies explicit WRFC execution prompts without catching explanatory questions', () => {
    expect(isWrfcWorkflowRequest('WRFC review for a token bucket rate limiter')).toBe(true);
    expect(isWrfcWorkflowRequest('make a token bucket rate limiter, use an agent to wrfc review it')).toBe(true);
    expect(buildWrfcWorkflowRoutingPrompt('WRFC review for a token bucket rate limiter')).toContain('mode=spawn');
    expect(isWrfcWorkflowRequest('what is WRFC?')).toBe(false);
    expect(buildWrfcWorkflowRoutingPrompt('explain WRFC review')).toBeNull();
  });

  test('detects authoritative WRFC owner tool outputs', () => {
    const direct: ToolResult = {
      callId: 'agent-1',
      success: true,
      output: JSON.stringify({
        agentId: 'agent-owner',
        wrfcId: 'wrfc-1',
        wrfcRole: 'owner',
        authoritativeWrfcChain: true,
        continueRootSpawning: false,
        orchestrationStopSignal: 'wrfc_owner_chain_started',
      }),
    };
    const batch: ToolResult = {
      callId: 'agent-2',
      success: true,
      output: JSON.stringify({
        agents: [{
          id: 'agent-owner',
          wrfcId: 'wrfc-1',
          wrfcRole: 'owner',
          continueRootSpawning: false,
        }],
      }),
    };
    const ordinary: ToolResult = {
      callId: 'agent-3',
      success: true,
      output: JSON.stringify({ agentId: 'agent-worker', continueRootSpawning: true }),
    };

    expect(toolResultIndicatesAuthoritativeWrfcChain(direct)).toBe(true);
    expect(toolResultIndicatesAuthoritativeWrfcChain(batch)).toBe(true);
    expect(toolResultIndicatesAuthoritativeWrfcChain(ordinary)).toBe(false);
  });

  test('suppresses generic root-spawn continuation nudge after authoritative WRFC owner spawn', async () => {
    const conversation = new ConversationManager();
    const toolCalls: ToolCall[] = [{
      id: 'call-agent',
      name: 'agent',
      arguments: { mode: 'spawn', task: 'Build and WRFC review a token bucket rate limiter.' },
    }];

    await handleToolResponseOutcome({
      conversation,
      agentManager: { list: () => [], spawn: () => { throw new Error('not used'); } },
      planManager: null,
      configManager: { get: () => undefined },
      providerRegistry: createProviderRegistry(),
      runtimeBus: null,
      emitterContext: () => ({ sessionId: 'test', traceId: 'test', source: 'test' }),
      turnId: 'turn-1',
      response: {
        content: '',
        toolCalls,
        usage: undefined,
      } as never,
      executeToolCalls: async () => [{
        callId: 'call-agent',
        success: true,
        output: JSON.stringify({
          agentId: 'agent-owner',
          status: 'spawned',
          wrfcId: 'wrfc-1',
          wrfcRole: 'owner',
          authoritativeWrfcChain: true,
          continueRootSpawning: false,
          orchestrationStopSignal: 'wrfc_owner_chain_started',
        }),
      }],
      setPendingToolCalls: () => {},
      messageQueueLength: 0,
      requestRender: () => {},
      sessionId: 'session-1',
    });

    const systemMessages = conversation.getMessageSnapshot()
      .filter((message): message is { role: 'system'; content: string } => message.role === 'system')
      .map((message) => message.content);
    expect(systemMessages.some((message) => message.includes('continue spawning agents now'))).toBe(false);
    expect(systemMessages.some((message) => message.includes('WRFC owner chain is now the authoritative owner'))).toBe(true);
  });

  test('keeps generic continuation nudge for ordinary non-WRFC agent spawns', async () => {
    const conversation = new ConversationManager();
    const toolCalls: ToolCall[] = [{
      id: 'call-agent',
      name: 'agent',
      arguments: { mode: 'spawn', task: 'Inspect package manager configuration.' },
    }];

    await handleToolResponseOutcome({
      conversation,
      agentManager: { list: () => [], spawn: () => { throw new Error('not used'); } },
      planManager: null,
      configManager: { get: () => undefined },
      providerRegistry: createProviderRegistry(),
      runtimeBus: null,
      emitterContext: () => ({ sessionId: 'test', traceId: 'test', source: 'test' }),
      turnId: 'turn-2',
      response: {
        content: '',
        toolCalls,
        usage: undefined,
      } as never,
      executeToolCalls: async () => [{
        callId: 'call-agent',
        success: true,
        output: JSON.stringify({
          agentId: 'agent-worker',
          status: 'spawned',
          authoritativeWrfcChain: false,
          continueRootSpawning: true,
        }),
      }],
      setPendingToolCalls: () => {},
      messageQueueLength: 0,
      requestRender: () => {},
      sessionId: 'session-1',
    });

    const systemMessages = conversation.getMessageSnapshot()
      .filter((message): message is { role: 'system'; content: string } => message.role === 'system')
      .map((message) => message.content);
    expect(systemMessages.some((message) => message.includes('continue spawning agents now'))).toBe(true);
  });
});
