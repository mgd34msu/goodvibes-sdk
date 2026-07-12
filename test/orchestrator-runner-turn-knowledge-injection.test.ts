/**
 * Orchestrator-runner integration: per-turn passive knowledge
 * injection wiring inside `runAgentTask`.
 *
 * Drives the REAL turn loop (`runAgentTask`) against a scripted fake LLMProvider and a
 * real `AgentMessageBus` (so `messageBus.send(..., {kind:'steer'})` exercises the exact
 * same drain path as orchestrator-runner-steer-drain.test.ts), with a fake memory
 * registry standing in for the SDK's MemoryRegistry (module-level retrieval behavior is
 * already covered by test/turn-knowledge-injection.test.ts). Covers the brief's
 * integration test matrix:
 *  - the systemPrompt sent to provider.chat on the turn a steer lands contains a block
 *    reflecting the steer, and a `knowledge_injection` session message + a
 *    record.turnInjections entry with a numeric tokenCost are recorded;
 *  - turn-1 baseline (spawn-time) injection ids are never duplicated in a later block;
 *  - the cheap re-retrieval guard: turns with no new input reuse the prior block and do
 *    NOT re-invoke the ranking pipeline (asserted via a getAll() call counter);
 *  - the compounding-regression guard: flag off (or a config budget of 0) produces a
 *    byte-identical systemPrompt across every turn, steer included;
 *  - the compaction-interaction guard: a tight context window never lets base+block
 *    exceed the same 85% threshold applyContextWindowAwareness enforces on the base.
 */
import { describe, expect, test, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAgentTask, type AgentOrchestratorRunContext } from '../packages/sdk/src/platform/agents/orchestrator-runner.js';
import { buildOrchestratorSystemPrompt } from '../packages/sdk/src/platform/agents/orchestrator-prompts.js';
import { AgentMessageBus } from '../packages/sdk/src/platform/agents/message-bus.js';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.js';
import { createProcessRegistry } from '../packages/sdk/src/platform/runtime/fleet/index.js';
import { createFeatureFlagManager } from '../packages/sdk/src/platform/runtime/feature-flags/manager.js';
import { ToolRegistry } from '../packages/sdk/src/platform/tools/registry.js';
import { estimateConversationTokens, estimateTokens } from '../packages/sdk/src/platform/core/context-compaction.js';
import { appendGoodVibesRuntimeAwarenessPrompt } from '../packages/sdk/src/platform/tools/goodvibes-runtime/index.js';
import type { AgentRecord } from '../packages/sdk/src/platform/tools/agent/manager.js';
import type { LLMProvider, ChatResponse, ProviderMessage } from '../packages/sdk/src/platform/providers/interface.js';
import type { ModelDefinition } from '../packages/sdk/src/platform/providers/registry-types.js';
import type { ProviderRegistry } from '../packages/sdk/src/platform/providers/registry.js';
import type { MemoryRecord } from '../packages/sdk/src/platform/state/memory-store.js';

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeRecord(overrides: Partial<AgentRecord> & { id: string }): AgentRecord {
  return {
    task: 'update the deployment docs',
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

function makeMemoryRecord(overrides: Partial<MemoryRecord> & { id: string }): MemoryRecord {
  return {
    scope: 'project',
    cls: 'fact',
    summary: 'a record',
    detail: undefined,
    tags: [],
    provenance: [],
    reviewState: 'fresh',
    confidence: 55,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

/**
 * Three high-scoring, task-matching filler records. Spawn-time injection
 * (buildOrchestratorSystemPrompt) has NO relevance floor and NO budget — it takes the
 * top-3 candidates by score>0, so a lone topically-unrelated record would otherwise be
 * trivially "the only candidate" and land in the spawn baseline regardless of
 * relevance. These fillers occupy that top-3 for a frozen task of
 * "update the deployment docs" so a record that does NOT match that task is reliably
 * excluded from the spawn baseline, letting tests isolate what per-turn retrieval adds.
 */
function makeDeploymentDocsFillers(): MemoryRecord[] {
  return [
    makeMemoryRecord({ id: 'mem_filler_1', summary: 'deployment docs: update the staging rollout checklist', tags: ['deploy'], reviewState: 'reviewed', confidence: 90 }),
    makeMemoryRecord({ id: 'mem_filler_2', summary: 'deployment docs: update the production rollback checklist', tags: ['deploy'], reviewState: 'reviewed', confidence: 88 }),
    makeMemoryRecord({ id: 'mem_filler_3', summary: 'deployment docs: update the canary release checklist', tags: ['deploy'], reviewState: 'reviewed', confidence: 86 }),
  ];
}

/** getAll() call count is the cheap, reliable proxy for "did retrieval actually run" —
 *  selectKnowledgeForTaskScored calls registry.getAll() exactly once per invocation,
 *  spawn-time or per-turn, with or without a searchSemantic method present. */
function makeCountingMemoryRegistry(records: MemoryRecord[]) {
  const counters = { getAllCalls: 0 };
  return {
    registry: {
      getAll: () => {
        counters.getAllCalls += 1;
        return records;
      },
    },
    counters,
  };
}

const FAKE_MODEL: ModelDefinition = {
  id: 'fake-model',
  provider: 'fake',
  registryKey: 'fake:fake-model',
  displayName: 'Fake Model',
  description: 'test-only stub model',
  capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
  contextWindow: 0, // 0 short-circuits context-window-awareness bookkeeping unless overridden per-test
  selectable: true,
};

function makeProviderRegistry(
  provider: LLMProvider,
  contextWindow = 0,
): Pick<ProviderRegistry, 'getCurrentModel' | 'getForModel' | 'listModels' | 'getContextWindowForModel'> {
  return {
    getCurrentModel: () => FAKE_MODEL,
    getForModel: () => provider,
    listModels: () => [FAKE_MODEL],
    getContextWindowForModel: () => contextWindow,
  };
}

function makeContext(opts: {
  workingDirectory: string;
  runtimeBus: RuntimeEventBus;
  messageBus: Pick<AgentMessageBus, 'getMessages'>;
  provider: LLMProvider;
  contextWindow?: number;
  featureFlagManager?: AgentOrchestratorRunContext['featureFlagManager'];
  memoryRegistry?: AgentOrchestratorRunContext['memoryRegistry'];
  passiveKnowledgeInjectionBudgetTokens?: number;
  passiveKnowledgeInjectionRelevanceFloor?: number;
}): AgentOrchestratorRunContext {
  return {
    workingDirectory: opts.workingDirectory,
    surfaceRoot: undefined,
    runtimeBus: opts.runtimeBus,
    featureFlagManager: opts.featureFlagManager ?? null,
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
    memoryRegistry: opts.memoryRegistry,
    passiveKnowledgeInjectionBudgetTokens: opts.passiveKnowledgeInjectionBudgetTokens,
    passiveKnowledgeInjectionRelevanceFloor: opts.passiveKnowledgeInjectionRelevanceFloor,
    archetypeLoader: undefined,
    providerOptimizer: undefined,
    providerRegistry: makeProviderRegistry(opts.provider, opts.contextWindow ?? 0),
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

describe('orchestrator-runner — per-turn passive knowledge injection', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  test('a steer surfaces a record the frozen task alone would miss; records the turn, dedupes against the spawn baseline', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'turn-knowledge-'));
    const messageBus = new AgentMessageBus();
    const runtimeBus = new RuntimeEventBus();
    const record = makeRecord({ id: 'ag-turn-knowledge-1' });
    const registry = createProcessRegistry(makeRegistryDeps(record, messageBus));

    // mem_ratelimit's baseline score against the frozen task (confidence 55 + fresh +20 =
    // 75, no token match) sits BELOW both the 3 fillers' scores (so spawn-time's top-3
    // excludes it) and the default relevance floor (95, so turn-1 per-turn retrieval —
    // which does query against the still-frozen task — excludes it too). Only the
    // steer's "rate limiting" tokens (+20 each) push its score to 115, clearing the floor.
    const { registry: memoryRegistry } = makeCountingMemoryRegistry([
      ...makeDeploymentDocsFillers(),
      makeMemoryRecord({
        id: 'mem_ratelimit',
        summary: 'rate limiting: token bucket, 100 requests per minute',
        tags: ['rate-limiting'],
        reviewState: 'fresh',
        confidence: 55,
      }),
    ]);

    const capturedSystemPrompts: string[] = [];
    let chatCallCount = 0;
    const provider: LLMProvider = {
      name: 'fake',
      models: ['fake-model'],
      async chat(request): Promise<ChatResponse> {
        chatCallCount += 1;
        capturedSystemPrompts.push(request.systemPrompt ?? '');
        if (chatCallCount === 1) {
          registry.steer(record.id, 'focus on rate limiting specifically');
          return { content: '', toolCalls: [{ id: 'call-1', name: 'nonexistent_tool', arguments: {} }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'tool_call' };
        }
        return { content: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' };
      },
    };

    const context = makeContext({ workingDirectory: tmpDir, runtimeBus, messageBus, provider, memoryRegistry });
    await runAgentTask(context, record);
    await flushMicrotasks();

    expect(chatCallCount).toBe(2);
    expect(record.status).toBe('completed');

    // Turn 1: the frozen task never mentions rate limiting — the spawn-time baseline
    // (top-3 fillers) and turn-1 per-turn retrieval (same frozen query, below floor) both
    // leave mem_ratelimit out.
    expect(capturedSystemPrompts[0]).not.toContain('mem_ratelimit');

    // Turn 2: the steer's content flows into the derived query and surfaces the record.
    expect(capturedSystemPrompts[1]).toContain('mem_ratelimit');
    expect(capturedSystemPrompts[1]).toContain('Injected Project Knowledge');

    // Honest per-turn record: stored on AgentRecord.turnInjections AND the session
    // transcript, with a numeric, budget-consistent tokenCost.
    const injectedTurn = record.turnInjections?.find((entry) => entry.injectedIds.includes('mem_ratelimit'));
    expect(injectedTurn).toBeDefined();
    expect(injectedTurn?.turn).toBe(2);
    expect(typeof injectedTurn?.tokenCost).toBe('number');
    expect(injectedTurn!.tokenCost).toBeGreaterThan(0);
    expect(injectedTurn!.tokenCost).toBeLessThanOrEqual(injectedTurn!.budgetTokens);

    registry.dispose();
  });

  test('turns without new input reuse the prior block: the ranking pipeline is not re-invoked', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'turn-knowledge-reuse-'));
    const messageBus = new AgentMessageBus();
    const runtimeBus = new RuntimeEventBus();
    const record = makeRecord({ id: 'ag-turn-knowledge-2', task: 'fix the rate limiting bug' });
    const registry = createProcessRegistry(makeRegistryDeps(record, messageBus));

    const { registry: memoryRegistry, counters } = makeCountingMemoryRegistry([
      makeMemoryRecord({ id: 'mem_ratelimit', summary: 'rate limiting: token bucket, 100 requests per minute', tags: ['rate-limiting'], reviewState: 'reviewed', confidence: 80 }),
    ]);

    let chatCallCount = 0;
    // Snapshot the CUMULATIVE getAll() count at the moment each chat() call is made —
    // retrieval for a turn always runs (or is skipped) before that turn's chat call, so
    // this pins exactly which turns re-ran the ranking pipeline. Reading the counter only
    // after runAgentTask resolves (as the whole task loop has already finished by then)
    // would not distinguish "grew on turn 4" from "grew on turn 2".
    const getAllCallsAtChat: number[] = [];
    const provider: LLMProvider = {
      name: 'fake',
      models: ['fake-model'],
      async chat(): Promise<ChatResponse> {
        chatCallCount += 1;
        getAllCallsAtChat.push(counters.getAllCalls);
        if (chatCallCount < 3) {
          // Turns 1 and 2: a tool call, no steer — no new conversation input.
          return { content: '', toolCalls: [{ id: `call-${chatCallCount}`, name: 'nonexistent_tool', arguments: {} }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'tool_call' };
        }
        if (chatCallCount === 3) {
          // Turn 3: a steer is queued mid-turn — it lands on the message bus AFTER this
          // chat call's own (already-made) retrieval decision, so it cannot affect turn
          // 3's own count; it becomes visible to turn 4's drain instead.
          registry.steer(record.id, 'also check the burst allowance');
          return { content: '', toolCalls: [{ id: 'call-3', name: 'nonexistent_tool', arguments: {} }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'tool_call' };
        }
        return { content: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' };
      },
    };

    const context = makeContext({ workingDirectory: tmpDir, runtimeBus, messageBus, provider, memoryRegistry });
    await runAgentTask(context, record);
    await flushMicrotasks();

    expect(chatCallCount).toBe(4);
    expect(record.status).toBe('completed');
    // getAll() is called once for the spawn-time baseline (buildOrchestratorSystemPrompt)
    // and once for turn 1's per-turn retrieval (turn===1 counts as "new input") — both
    // BEFORE turn 1's chat call. Turns 2 and 3 have no new input, so the pipeline is not
    // re-invoked (count holds at 2). Turn 4 drains turn 3's steer at its own top — that
    // IS new input — so the count grows to 3 exactly there, not before.
    expect(getAllCallsAtChat).toEqual([2, 2, 2, 3]);

    registry.dispose();
  });

  test('flag disabled: base system prompt is byte-identical across every turn, steer included (no compounding)', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'turn-knowledge-flagoff-'));
    const messageBus = new AgentMessageBus();
    const runtimeBus = new RuntimeEventBus();
    const record = makeRecord({ id: 'ag-turn-knowledge-flagoff' });
    const registry = createProcessRegistry(makeRegistryDeps(record, messageBus));

    const { registry: memoryRegistry } = makeCountingMemoryRegistry([
      makeMemoryRecord({ id: 'mem_ratelimit', summary: 'rate limiting: token bucket, 100 requests per minute', tags: ['rate-limiting'], reviewState: 'reviewed', confidence: 90 }),
    ]);

    const featureFlagManager = createFeatureFlagManager();
    featureFlagManager.disable('agent-passive-knowledge-injection');

    const capturedSystemPrompts: string[] = [];
    let chatCallCount = 0;
    const provider: LLMProvider = {
      name: 'fake',
      models: ['fake-model'],
      async chat(request): Promise<ChatResponse> {
        chatCallCount += 1;
        capturedSystemPrompts.push(request.systemPrompt ?? '');
        if (chatCallCount === 1) {
          registry.steer(record.id, 'focus on rate limiting specifically');
          return { content: '', toolCalls: [{ id: 'call-1', name: 'nonexistent_tool', arguments: {} }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'tool_call' };
        }
        return { content: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' };
      },
    };

    const context = makeContext({ workingDirectory: tmpDir, runtimeBus, messageBus, provider, memoryRegistry, featureFlagManager });
    await runAgentTask(context, record);
    await flushMicrotasks();

    expect(chatCallCount).toBe(2);
    // The spawn-time baseline (buildOrchestratorSystemPrompt, pre-existing/out-of-scope
    // for this per-turn injection feature) is unaffected by this flag and may still appear in both prompts — that is
    // fine and expected. What must hold, and is asserted here, is that turn 2's prompt is
    // BYTE-IDENTICAL to turn 1's (the steer changed nothing) and that no per-turn record
    // was ever produced.
    expect(capturedSystemPrompts[0]).toBe(capturedSystemPrompts[1]);
    expect(record.turnInjections ?? []).toEqual([]);

    registry.dispose();
  });

  test('config budget of 0 is a hard no-op even with the flag enabled and a matching steer', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'turn-knowledge-budget0-'));
    const messageBus = new AgentMessageBus();
    const runtimeBus = new RuntimeEventBus();
    const record = makeRecord({ id: 'ag-turn-knowledge-budget0' });
    const registry = createProcessRegistry(makeRegistryDeps(record, messageBus));

    const { registry: memoryRegistry } = makeCountingMemoryRegistry([
      makeMemoryRecord({ id: 'mem_ratelimit', summary: 'rate limiting: token bucket, 100 requests per minute', tags: ['rate-limiting'], reviewState: 'reviewed', confidence: 90 }),
    ]);

    const capturedSystemPrompts: string[] = [];
    let chatCallCount = 0;
    const provider: LLMProvider = {
      name: 'fake',
      models: ['fake-model'],
      async chat(request): Promise<ChatResponse> {
        chatCallCount += 1;
        capturedSystemPrompts.push(request.systemPrompt ?? '');
        if (chatCallCount === 1) {
          registry.steer(record.id, 'focus on rate limiting specifically');
          return { content: '', toolCalls: [{ id: 'call-1', name: 'nonexistent_tool', arguments: {} }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'tool_call' };
        }
        return { content: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' };
      },
    };

    const context = makeContext({
      workingDirectory: tmpDir,
      runtimeBus,
      messageBus,
      provider,
      memoryRegistry,
      passiveKnowledgeInjectionBudgetTokens: 0,
    });
    await runAgentTask(context, record);
    await flushMicrotasks();

    expect(chatCallCount).toBe(2);
    // As in the flag-disabled test above: the spawn-time baseline is untouched by this
    // config knob (out of this per-turn injection feature's scope) and may appear in both; what matters is that the
    // two prompts are byte-identical and no per-turn record was produced.
    expect(capturedSystemPrompts[0]).toBe(capturedSystemPrompts[1]);
    expect(record.turnInjections ?? []).toEqual([]);

    registry.dispose();
  });

  test('compaction interaction: a tight context window never lets base+block exceed the 85% threshold', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'turn-knowledge-threshold-'));
    const messageBus = new AgentMessageBus();
    const runtimeBus = new RuntimeEventBus();
    // Reuse the "deployment docs" frozen task from the first test: the 3 fillers occupy
    // spawn-time's top-3 (mem_big's baseline score of confidence 90 + reviewed +40 = 130
    // loses to each filler's ~206-210), so mem_big is excluded from the SPAWN baseline —
    // isolating this test to the PER-TURN budget mechanism alone. mem_big still clears
    // the default relevance floor (95) on baseline score alone, so turn-1 per-turn
    // retrieval attempts to inject it; only its size against a tight budget is at stake.
    const record = makeRecord({ id: 'ag-turn-knowledge-threshold', task: 'update the deployment docs' });
    const { registry: memoryRegistry } = makeCountingMemoryRegistry([
      ...makeDeploymentDocsFillers(),
      // A summary long enough that its rendered block costs well over the ~40-token
      // headroom this test leaves for it.
      makeMemoryRecord({
        id: 'mem_big',
        summary: 'rate limiting uses a distributed token bucket with per-tenant quotas, burst allowance, sliding window reconciliation, and a Redis-backed counter that is synchronized across every regional edge node every five seconds',
        tags: ['rate-limiting'],
        reviewState: 'reviewed',
        confidence: 90,
      }),
    ]);

    // Measure the REAL base prompt's token cost first (same call runAgentTask makes
    // internally at systemPrompt = buildOrchestratorSystemPrompt(record, undefined, context)),
    // using the SAME memoryRegistry so the spawn-time baseline this computes (the 3
    // fillers) matches what the real run will produce — then pick a context window whose
    // 85% threshold sits only slightly above that, leaving a small but nonzero headroom
    // for a block, and no headroom at all for one that's too large to fit.
    const probeContext = makeContext({
      workingDirectory: tmpDir,
      runtimeBus,
      messageBus,
      provider: { name: 'probe', models: [], chat: async () => { throw new Error('unused'); } },
      memoryRegistry,
    });
    // NOTE: the actual chat() call wraps the composed systemPrompt in
    // appendGoodVibesRuntimeAwarenessPrompt(...) at the call site — a fixed-size runtime
    // notice appended AFTER every budget/threshold decision runs (pre-existing behavior,
    // unrelated to and unchanged by the per-turn knowledge injection feature: neither the old nor the new code counts this
    // suffix in applyContextWindowAwareness's own sysTokens estimate). Folding its cost
    // into the probe measurement here makes THIS TEST's wire-level "never exceeds
    // threshold" assertion honest, without changing what the runner itself measures.
    const baseSystemPrompt = appendGoodVibesRuntimeAwarenessPrompt(buildOrchestratorSystemPrompt(record, undefined, probeContext));
    const baseTokens = estimateTokens(baseSystemPrompt);
    const initialMessageTokens = estimateConversationTokens([{ role: 'user', content: record.task } as ProviderMessage]);
    const tightWindow = Math.ceil((baseTokens + initialMessageTokens + 40) / 0.85); // ~40 tokens of headroom

    const processRegistry = createProcessRegistry(makeRegistryDeps(record, messageBus));
    const capturedSystemPrompts: string[] = [];
    let chatCallCount = 0;
    const provider: LLMProvider = {
      name: 'fake',
      models: ['fake-model'],
      async chat(request): Promise<ChatResponse> {
        chatCallCount += 1;
        capturedSystemPrompts.push(request.systemPrompt ?? '');
        return { content: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' };
      },
    };

    const context = makeContext({
      workingDirectory: tmpDir,
      runtimeBus,
      messageBus,
      provider,
      memoryRegistry,
      contextWindow: tightWindow,
      featureFlagManager: createFeatureFlagManager(),
    });
    await runAgentTask(context, record);
    await flushMicrotasks();

    expect(chatCallCount).toBe(1);
    // Whatever the runner decided to send, it must never exceed the same 85% threshold
    // applyContextWindowAwareness itself enforces — the block cannot silently push it over.
    const sentTokens = estimateTokens(capturedSystemPrompts[0]!) + estimateConversationTokens([{ role: 'user', content: record.task } as ProviderMessage]);
    expect(sentTokens).toBeLessThanOrEqual(Math.floor(tightWindow * 0.85));
    // The oversized record could not fit in ~40 tokens of headroom, so it must be absent
    // (and the top-3 fillers, having already been surfaced at spawn time, do not appear
    // a second time either — dedupe, not budget, explains their absence from any
    // per-turn block, but either way none of them re-inflate the prompt).
    expect(capturedSystemPrompts[0]).not.toContain('mem_big');

    processRegistry.dispose();
  });
});
