/**
 * Conversation-snapshot bridge wiring (SDK side).
 *
 * agent-manager-conversation-snapshot.test.ts proves AgentManager's bridge
 * API in isolation. These tests prove the two real call sites actually use
 * it:
 *
 *  1. AgentOrchestrator.setConversationSink() wires register/release into
 *     the AgentOrchestratorRunContext that createRunContext() builds for
 *     every run (runtime/services.ts wires this to a real AgentManager;
 *     here we spy on a fake sink instead).
 *  2. orchestrator-runner.ts's runAgentTask() calls
 *     context.registerConversationSource() right after creating the agent's
 *     ConversationManager, and context.releaseConversationSource() exactly
 *     once when the run ends — proven end-to-end against the real turn loop
 *     with a stub LLM provider, not a reimplementation of the loop.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentOrchestrator } from '../packages/sdk/src/platform/agents/orchestrator.js';
import { AgentMessageBus } from '../packages/sdk/src/platform/agents/message-bus.js';
import {
  runAgentTask,
  type AgentOrchestratorRunContext,
} from '../packages/sdk/src/platform/agents/orchestrator-runner.js';
import { ToolRegistry } from '../packages/sdk/src/platform/tools/registry.js';
import type { AgentRecord } from '../packages/sdk/src/platform/tools/agent/manager.js';
import type { LLMProvider } from '../packages/sdk/src/platform/providers/interface.js';
import type { ConversationMessageSnapshot } from '../packages/sdk/src/platform/core/conversation.js';
import type { FeatureFlagManager } from '../packages/sdk/src/platform/runtime/feature-flags/manager.js';

describe('AgentOrchestrator — conversation-sink wiring', () => {
  test('setConversationSink wires register/release into createRunContext(); unset → both undefined so orchestrator-runner\'s ?.() calls are no-ops', () => {
    const orchestrator = new AgentOrchestrator({ messageBus: new AgentMessageBus() });
    // createRunContext() reads this.toolDeps!.providerRegistry! directly —
    // give it just enough to not throw; the actual routing methods are not
    // exercised by this test (it only asserts the register/release wiring).
    (orchestrator as unknown as { toolDeps: { providerRegistry: object } }).toolDeps = { providerRegistry: {} };
    const createRunContext = (): AgentOrchestratorRunContext =>
      (orchestrator as unknown as { createRunContext(): AgentOrchestratorRunContext }).createRunContext();

    const bareContext = createRunContext();
    expect(bareContext.registerConversationSource).toBeUndefined();
    expect(bareContext.releaseConversationSource).toBeUndefined();

    const registered: string[] = [];
    const released: string[] = [];
    orchestrator.setConversationSink({
      register: (agentId) => { registered.push(agentId); },
      release: (agentId) => { released.push(agentId); },
    });
    const wiredContext = createRunContext();
    wiredContext.registerConversationSource?.('ag-1', () => []);
    wiredContext.releaseConversationSource?.('ag-1');
    expect(registered).toEqual(['ag-1']);
    expect(released).toEqual(['ag-1']);

    orchestrator.setConversationSink(null);
    const detachedContext = createRunContext();
    expect(detachedContext.registerConversationSource).toBeUndefined();
    expect(detachedContext.releaseConversationSource).toBeUndefined();
  });
});

function makeAgentRecord(overrides: Partial<AgentRecord> & { id: string; task: string }): AgentRecord {
  return {
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

/** A minimal but real turn loop drive: one turn, no tool calls, immediate completion. */
function makeMinimalRunContext(overrides: {
  registerConversationSource?: (agentId: string, source: () => ConversationMessageSnapshot[]) => void;
  releaseConversationSource?: (agentId: string) => void;
  provider?: LLMProvider;
  workingDirectory: string;
}): AgentOrchestratorRunContext {
  const provider: LLMProvider = overrides.provider ?? {
    name: 'test-provider',
    async chat() {
      return {
        content: 'All done.',
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: 'completed',
      };
    },
  };
  return {
    workingDirectory: overrides.workingDirectory,
    surfaceRoot: undefined,
    runtimeBus: null,
    // Cast: a plain stub satisfies the one method orchestrator-runner reads
    // (isEnabled), and disabling context-window awareness keeps this test
    // focused on the conversation-snapshot bridge rather than context-window
    // math / model-registry lookups.
    featureFlagManager: { isEnabled: () => false } as unknown as FeatureFlagManager,
    emitterContext: () => ({ sessionId: 'test', traceId: 'test', source: 'test' }),
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
    registerConversationSource: overrides.registerConversationSource,
    releaseConversationSource: overrides.releaseConversationSource,
    processManager: undefined,
    messageBus: { getMessages: () => [] },
    getFullRegistry: () => new ToolRegistry(),
    buildScopedRegistry: () => new ToolRegistry(),
    providerRegistry: {
      getCurrentModel: () => ({
        id: 'test-model',
        provider: 'test-provider',
        registryKey: 'test-provider:test-model',
        displayName: 'Test Model',
        description: 'test',
        capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
        contextWindow: 128_000,
        selectable: true,
      }),
      getForModel: () => provider,
      listModels: () => [{
        id: 'test-model',
        provider: 'test-provider',
        registryKey: 'test-provider:test-model',
        displayName: 'Test Model',
        description: 'test',
        capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
        contextWindow: 128_000,
        selectable: true,
      }],
      getContextWindowForModel: () => 128_000,
    },
    resolveProviderForRecord: () => ({
      provider,
      modelId: 'test-model',
      requestedModelId: 'test-provider:test-model',
    }),
    resolveFallbackModelRoutes: () => [],
  };
}

describe('runAgentTask — conversation-snapshot bridge call sites', () => {
  test('registers a live source right after creating the ConversationManager, then releases exactly once on normal completion', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'snapshot-bridge-'));
    try {
      const registeredIds: string[] = [];
      const releasedIds: string[] = [];
      let liveSourceDuringRun: (() => ConversationMessageSnapshot[]) | null = null;

      const context = makeMinimalRunContext({
        workingDirectory: dir,
        registerConversationSource: (agentId, source) => {
          registeredIds.push(agentId);
          liveSourceDuringRun = source;
        },
        releaseConversationSource: (agentId) => {
          releasedIds.push(agentId);
        },
      });

      const record = makeAgentRecord({ id: 'ag-bridge-1', task: 'say hello' });
      await runAgentTask(context, record);

      expect(registeredIds).toEqual(['ag-bridge-1']);
      expect(releasedIds).toEqual(['ag-bridge-1']); // exactly once
      expect(record.status).toBe('completed');

      // The registered source really reflected the real ConversationManager:
      // the task's user message plus the assistant's final reply.
      expect(liveSourceDuringRun).not.toBeNull();
      const snapshot = liveSourceDuringRun!();
      expect(snapshot.some((m) => m.role === 'user' && m.content === 'say hello')).toBe(true);
      expect(snapshot.some((m) => m.role === 'assistant' && m.content === 'All done.')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('releases exactly once even when the agent chat call throws (handleAgentRunFailure path)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'snapshot-bridge-fail-'));
    try {
      const releasedIds: string[] = [];
      const failingProvider: LLMProvider = {
        name: 'test-provider',
        async chat() {
          throw new Error('provider exploded');
        },
      };
      const context = makeMinimalRunContext({
        workingDirectory: dir,
        provider: failingProvider,
        registerConversationSource: () => {},
        releaseConversationSource: (agentId) => releasedIds.push(agentId),
      });

      const record = makeAgentRecord({ id: 'ag-bridge-fail', task: 'this will fail' });
      await runAgentTask(context, record);

      expect(record.status).toBe('failed');
      expect(releasedIds).toEqual(['ag-bridge-fail']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('releasing is a no-op call shape when no sink is wired (registerConversationSource/releaseConversationSource undefined)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'snapshot-bridge-unwired-'));
    try {
      const context = makeMinimalRunContext({ workingDirectory: dir });
      expect(context.registerConversationSource).toBeUndefined();
      expect(context.releaseConversationSource).toBeUndefined();

      const record = makeAgentRecord({ id: 'ag-bridge-unwired', task: 'no sink attached' });
      await expect(runAgentTask(context, record)).resolves.toBeUndefined();
      expect(record.status).toBe('completed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
