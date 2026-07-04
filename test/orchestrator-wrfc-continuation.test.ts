import { describe, expect, test } from 'bun:test';
import { ConversationManager } from '../packages/sdk/src/platform/core/conversation.js';
import { handleToolResponseOutcome } from '../packages/sdk/src/platform/core/orchestrator-turn-helpers.js';
import {
  buildWrfcWorkflowRoutingPrompt,
  isWrfcWorkflowRequest,
  toolResultIndicatesAuthoritativeWrfcChain,
  userProhibitsDelegation,
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

  test('an explicit no-delegation instruction suppresses the routing directive entirely', () => {
    // The user asks for WRFC-shaped work but explicitly forbids spawning agents / starting a chain.
    // The harness must inject NOTHING — never coerce against explicit user intent.
    expect(buildWrfcWorkflowRoutingPrompt(
      'Build a slugify CLI with WRFC. Do NOT spawn agents and do NOT start a WRFC chain.',
    )).toBeNull();
    expect(buildWrfcWorkflowRoutingPrompt('WRFC review this, but do it yourself — no agents.')).toBeNull();
    expect(buildWrfcWorkflowRoutingPrompt("Implement the WRFC fix directly; don't delegate.")).toBeNull();
  });

  test('userProhibitsDelegation is high-precision: catches explicit prohibitions, ignores normal requests', () => {
    // Caught — explicit negation paired with a delegation concept, or a direct-action instruction.
    for (const prohibition of [
      'do not spawn agents',
      "don't spawn any subagents",
      'no agents please',
      'without spawning agents',
      'no delegation on this one',
      'do not delegate this',
      'do not start a wrfc chain',
      'no wrfc chain',
      "don't use the agent tool",
      'do it yourself',
      'handle this directly',
      'implement it yourself',
    ]) {
      expect(userProhibitsDelegation(prohibition)).toBe(true);
    }
    // Not caught — ordinary requests, including ones that opt INTO WRFC/agents.
    for (const normal of [
      'WRFC review for a token bucket rate limiter',
      'build a slugify CLI with WRFC',
      'use an agent to wrfc review it',
      'connect directly to the staging database',
      'implement a directly-indexed lookup table',
    ]) {
      expect(userProhibitsDelegation(normal)).toBe(false);
    }
  });

  test('the softened directive is advisory and asserts that the user\'s explicit instructions win', () => {
    const directive = buildWrfcWorkflowRoutingPrompt('WRFC review for a token bucket rate limiter');
    expect(directive).not.toBeNull();
    // Advisory framing, not an imperative command.
    expect(directive).toContain('suggestion, not a command');
    expect(directive).toContain("the user's explicit instructions always win");
    // Still carries the how-to for when the model does choose the pipeline.
    expect(directive).toContain('mode=spawn');
    // No bare imperative "Use the agent tool to start exactly one WRFC owner chain".
    expect(directive).not.toContain('Use the agent tool to start exactly one');
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
      userText: '',
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

  test('attaches current user prompt as authoritative task for root agent tool calls', async () => {
    const conversation = new ConversationManager();
    const toolCalls: ToolCall[] = [{
      id: 'call-agent',
      name: 'agent',
      arguments: {
        mode: 'batch-spawn',
        tasks: [
          { task: 'Design a token bucket rate limiter. Do not write files.', template: 'engineer' },
          { task: 'Review the implementation.', template: 'reviewer' },
        ],
      },
    }];
    let executedCalls: ToolCall[] = [];

    await handleToolResponseOutcome({
      conversation,
      agentManager: { list: () => [], spawn: () => { throw new Error('not used'); } },
      planManager: null,
      configManager: { get: () => undefined },
      providerRegistry: createProviderRegistry(),
      runtimeBus: null,
      emitterContext: () => ({ sessionId: 'test', traceId: 'test', source: 'test' }),
      turnId: 'turn-inject',
      response: {
        content: '',
        toolCalls,
        usage: undefined,
      } as never,
      userText: 'make a token bucket rate limiter',
      executeToolCalls: async (_turnId, calls) => {
        executedCalls = calls;
        return [{
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
        }];
      },
      setPendingToolCalls: () => {},
      messageQueueLength: 0,
      requestRender: () => {},
      sessionId: 'session-1',
    });

    expect(executedCalls).toHaveLength(1);
    expect(executedCalls[0]!.arguments.authoritativeTask).toBe('make a token bucket rate limiter');
    const assistantToolCall = conversation.getMessageSnapshot()
      .find((message) => message.role === 'assistant' && message.toolCalls?.length);
    expect(assistantToolCall?.toolCalls?.[0]?.arguments.authoritativeTask).toBe('make a token bucket rate limiter');
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
      userText: '',
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
