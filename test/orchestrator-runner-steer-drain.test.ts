/**
 * Orchestrator-runner steer drain, SDK half.
 *
 * Drives the REAL per-agent turn loop (`runAgentTask`, orchestrator-runner.ts)
 * against a scripted fake LLMProvider, with a real AgentMessageBus, a real
 * RuntimeEventBus, and a real ProcessRegistry (`createProcessRegistry`) wired
 * to that same message bus — so `registry.steer()` and the runner's per-turn
 * inbox drain are exercised together, end to end, exactly as they are
 * composed in the real runtime.
 *
 * Covers the brief's test matrix:
 *  - A queued steer message reaches the agent's conversation verbatim (no
 *    "[Directive from …]" framing) at the top of its NEXT turn, never the
 *    turn already in flight when it was queued.
 *  - `communication.consumed` fires exactly once, carrying the queued
 *    messageId, the agentId, and the turn it was drained on.
 *  - A steer queued after the agent has taken its last turn is never drained
 *    and never emits consumed (the honest "stranded" case; resolving the
 *    dangling badge is the TUI's job, not the SDK's, but the SDK must not
 *    lie about consumption that never happened).
 */
import { describe, expect, test, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAgentTask, type AgentOrchestratorRunContext } from '../packages/sdk/src/platform/agents/orchestrator-runner.js';
import { AgentMessageBus } from '../packages/sdk/src/platform/agents/message-bus.js';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.js';
import { createProcessRegistry } from '../packages/sdk/src/platform/runtime/fleet/index.js';
import { ToolRegistry } from '../packages/sdk/src/platform/tools/registry.js';
import type { AgentRecord } from '../packages/sdk/src/platform/tools/agent/manager.js';
import type { LLMProvider, ChatResponse } from '../packages/sdk/src/platform/providers/interface.js';
import type { ModelDefinition } from '../packages/sdk/src/platform/providers/registry-types.js';
import type { ProviderRegistry } from '../packages/sdk/src/platform/providers/registry.js';
import type { CommunicationEvent } from '../packages/sdk/src/events/communication.js';

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeRecord(overrides: Partial<AgentRecord> & { id: string }): AgentRecord {
  return {
    task: 'do work',
    template: 'engineer',
    tools: [],
    status: 'pending',
    startedAt: Date.now(),
    toolCallCount: 0,
    orchestrationDepth: 0,
    executionProtocol: 'direct',
    reviewMode: 'none',
    communicationLane: 'parent-only',
    ...overrides,
  };
}

const FAKE_MODEL: ModelDefinition = {
  id: 'fake-model',
  provider: 'fake',
  registryKey: 'fake:fake-model',
  displayName: 'Fake Model',
  description: 'test-only stub model',
  capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
  contextWindow: 0, // 0 short-circuits context-window-awareness bookkeeping (see applyContextWindowAwareness)
  selectable: true,
};

function makeProviderRegistry(
  provider: LLMProvider,
): Pick<ProviderRegistry, 'getCurrentModel' | 'getForModel' | 'listModels' | 'getContextWindowForModel'> {
  return {
    getCurrentModel: () => FAKE_MODEL,
    getForModel: () => provider,
    listModels: () => [FAKE_MODEL],
    getContextWindowForModel: () => 0,
  };
}

function makeContext(opts: {
  workingDirectory: string;
  runtimeBus: RuntimeEventBus;
  messageBus: Pick<AgentMessageBus, 'getMessages'>;
  provider: LLMProvider;
}): AgentOrchestratorRunContext {
  return {
    workingDirectory: opts.workingDirectory,
    surfaceRoot: undefined,
    runtimeBus: opts.runtimeBus,
    featureFlagManager: null,
    emitterContext: () => ({ sessionId: 'test-session', traceId: 'test-trace', source: 'test' }),
    emitAgentProgress: () => {},
    emitOrchestrationProgress: () => {},
    emitAgentStarted: () => {},
    emitAgentCancelledEvent: () => {},
    emitOrchestrationCancelled: () => {},
    emitAgentFailedEvent: () => {},
    emitOrchestrationFailed: () => {},
    emitAgentCompletedEvent: () => {},
    emitOrchestrationCompleted: () => {},
    emitStreamDelta: () => {},
    processManager: undefined,
    messageBus: opts.messageBus,
    knowledgeService: undefined,
    memoryRegistry: undefined,
    archetypeLoader: undefined,
    providerOptimizer: undefined,
    providerRegistry: makeProviderRegistry(opts.provider),
    getFullRegistry: () => new ToolRegistry(),
    buildScopedRegistry: (_allowedNames, fullRegistry) => fullRegistry,
    resolveProviderForRecord: (_registry, _record, currentModel) => ({
      provider: opts.provider,
      modelId: currentModel.id,
      requestedModelId: currentModel.registryKey,
    }),
    resolveFallbackModelRoutes: () => [],
  };
}

function makeRegistryDeps(record: AgentRecord, messageBus: Pick<AgentMessageBus, 'send'>) {
  return {
    agentManager: { list: () => [record], cancel: () => false },
    wrfcController: { listChains: () => [] },
    processManager: { list: () => [], stop: () => false, getStatus: () => undefined },
    watcherRegistry: { list: () => [], stopWatcher: () => null },
    workflow: {
      workflowManager: { list: () => [], cancel: () => false },
      triggerManager: { list: () => [], remove: () => false, disable: () => false },
      scheduleManager: { list: () => [], remove: () => false, disable: () => false },
    },
    messageBus,
  };
}

function userMessageContents(messages: readonly unknown[]): string[] {
  return messages
    .filter((m): m is { role: string; content: unknown } => typeof m === 'object' && m !== null && 'role' in m)
    .filter((m) => m.role === 'user' && typeof m.content === 'string')
    .map((m) => m.content as string);
}

describe('orchestrator-runner — steer drain (Wave-3, W3.2)', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  test('a queued steer reaches the conversation verbatim at the next turn top, and communication.consumed fires exactly once', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'wo602-steer-'));
    const messageBus = new AgentMessageBus();
    const runtimeBus = new RuntimeEventBus();
    const consumedEvents: Array<Extract<CommunicationEvent, { type: 'COMMUNICATION_CONSUMED' }>> = [];
    runtimeBus.onDomain('communication', (envelope) => {
      if (envelope.payload.type === 'COMMUNICATION_CONSUMED') consumedEvents.push(envelope.payload);
    });

    const record = makeRecord({ id: 'ag-steer-drain' });
    const registry = createProcessRegistry(makeRegistryDeps(record, messageBus));

    const capturedMessages: unknown[][] = [];
    let steerMessageId = '';
    let chatCallCount = 0;
    const provider: LLMProvider = {
      name: 'fake',
      models: ['fake-model'],
      async chat(request): Promise<ChatResponse> {
        chatCallCount += 1;
        capturedMessages.push(request.messages as unknown[]);
        if (chatCallCount === 1) {
          // Simulate the operator steering the agent while its first turn is
          // already in flight (mid-tool-round, per the brief's delivery
          // contract) — this must NOT be visible in turn 1's own messages
          // (already captured above) and must land at turn 2's drain.
          const result = registry.steer(record.id, 'focus on the auth module first');
          expect(result.queued).toBe(true);
          if (result.queued) steerMessageId = result.messageId;
          return {
            content: '',
            toolCalls: [{ id: 'call-1', name: 'nonexistent_tool', arguments: {} }],
            usage: { inputTokens: 10, outputTokens: 5 },
            stopReason: 'tool_call',
          };
        }
        return {
          content: 'done',
          toolCalls: [],
          usage: { inputTokens: 10, outputTokens: 5 },
          stopReason: 'completed',
        };
      },
    };

    const context = makeContext({ workingDirectory: tmpDir, runtimeBus, messageBus, provider });
    await runAgentTask(context, record);
    await flushMicrotasks();

    expect(chatCallCount).toBe(2);
    expect(record.status).toBe('completed');
    expect(steerMessageId.length).toBeGreaterThan(0);

    // Red half: turn 1's own messages must NOT already contain the steer —
    // it wasn't queued until partway through turn 1's LLM call.
    expect(userMessageContents(capturedMessages[0]!)).not.toContain('focus on the auth module first');

    // Green half: turn 2's messages contain it verbatim — no "[Steer from
    // operator]" (or any "[Kind from sender]") wrapper.
    expect(userMessageContents(capturedMessages[1]!)).toContain('focus on the auth module first');
    for (const content of userMessageContents(capturedMessages[1]!)) {
      expect(content).not.toContain('[Steer from operator]');
      expect(content).not.toContain('Directive from');
    }

    // The honest "consumed at boundary" signal: exactly once, matching the
    // queued messageId, on the turn it was actually drained (turn 2).
    expect(consumedEvents).toHaveLength(1);
    expect(consumedEvents[0]?.messageId).toBe(steerMessageId);
    expect(consumedEvents[0]?.agentId).toBe(record.id);
    expect(consumedEvents[0]?.turn).toBe(2);

    registry.dispose();
  });

  test('wo/chain-state-honesty: a steer drained into a turn whose chat call then fails never emits consumed', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'wo-chain-state-honesty-steer-fail-'));
    const messageBus = new AgentMessageBus();
    const runtimeBus = new RuntimeEventBus();
    const consumedEvents: unknown[] = [];
    runtimeBus.onDomain('communication', (envelope) => {
      if (envelope.payload.type === 'COMMUNICATION_CONSUMED') consumedEvents.push(envelope.payload);
    });

    const record = makeRecord({ id: 'ag-steer-drain-then-fail' });
    const registry = createProcessRegistry(makeRegistryDeps(record, messageBus));

    let steerMessageId = '';
    let chatCallCount = 0;
    const provider: LLMProvider = {
      name: 'fake',
      models: ['fake-model'],
      async chat(): Promise<ChatResponse> {
        chatCallCount += 1;
        if (chatCallCount === 1) {
          // Same mid-turn-1 steer as the happy-path test above — it will be
          // drained at the TOP of turn 2, before turn 2's chat call below.
          const result = registry.steer(record.id, 'focus on the auth module first');
          expect(result.queued).toBe(true);
          if (result.queued) steerMessageId = result.messageId;
          return {
            content: '',
            toolCalls: [{ id: 'call-1', name: 'nonexistent_tool', arguments: {} }],
            usage: { inputTokens: 10, outputTokens: 5 },
            stopReason: 'tool_call',
          };
        }
        // Turn 2: the steer is drained into the conversation (see the runner's
        // pending-message loop) BEFORE this call runs, then this call fails.
        // A generic error is not network/rate-limit/fallback-eligible, so the
        // runner's retry loop rethrows immediately — this is the "chat
        // exhausts retries" case the fix targets: the drain happened, but the
        // turn it was drained into never produced a successful response.
        throw new Error('simulated total chat failure on turn 2');
      },
    };

    const context = makeContext({ workingDirectory: tmpDir, runtimeBus, messageBus, provider });
    await runAgentTask(context, record);
    await flushMicrotasks();

    expect(chatCallCount).toBe(2);
    expect(record.status).toBe('failed');
    expect(steerMessageId.length).toBeGreaterThan(0);

    // The honest signal: the steer was drained into turn 2's conversation,
    // but turn 2's chat call never succeeded, so consumed must NEVER fire —
    // emitting it here would tell a consumer the steer was incorporated when
    // the run actually died without ever producing a response for it.
    expect(consumedEvents).toHaveLength(0);

    registry.dispose();
  });

  test('a steer queued after the agent has already begun its final (no-tool-call) turn is never drained and never emits consumed', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'wo602-steer-stranded-'));
    const messageBus = new AgentMessageBus();
    const runtimeBus = new RuntimeEventBus();
    const consumedEvents: unknown[] = [];
    runtimeBus.onDomain('communication', (envelope) => {
      if (envelope.payload.type === 'COMMUNICATION_CONSUMED') consumedEvents.push(envelope.payload);
    });

    const record = makeRecord({ id: 'ag-steer-stranded' });
    const registry = createProcessRegistry(makeRegistryDeps(record, messageBus));

    const provider: LLMProvider = {
      name: 'fake',
      models: ['fake-model'],
      async chat(): Promise<ChatResponse> {
        // Queued mid this — the agent's only turn — AFTER its own drain
        // already ran empty. There is no further turn to drain it on.
        const result = registry.steer(record.id, 'too late');
        expect(result.queued).toBe(true); // accepted onto the inbox…
        return { content: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' };
      },
    };

    const context = makeContext({ workingDirectory: tmpDir, runtimeBus, messageBus, provider });
    await runAgentTask(context, record);
    await flushMicrotasks();

    expect(record.status).toBe('completed');
    // …but "queued" must never be conflated with "consumed": no drain ever
    // happened, so no consumed event may fire.
    expect(consumedEvents).toHaveLength(0);

    registry.dispose();
  });
});
