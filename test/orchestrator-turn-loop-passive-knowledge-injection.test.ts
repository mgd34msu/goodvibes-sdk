/**
 * Main-session integration: per-turn passive knowledge injection wiring
 * inside `executeOrchestratorTurnLoop` (core/orchestrator-turn-loop.ts).
 *
 * An earlier change wired this feature into the AGENT path only
 * (agents/orchestrator-runner.ts runAgentTask) — the TUI's MAIN interactive session runs a
 * completely separate turn loop that never called buildPerTurnKnowledgeInjection at all.
 * This suite drives that main-loop turn loop directly (it accepts a fully mockable
 * `OrchestratorTurnLoopContext`, so no `Orchestrator` construction is needed — the same
 * "pure function over an injected context" seam the agent-path's own tests exploit for
 * runAgentTask), covering the brief's integration test matrix:
 *  - a relevant memory record composes onto the systemPrompt actually sent to
 *    provider.chat(), and a TurnInjectionRecord is handed to
 *    context.recordTurnKnowledgeInjection with a numeric tokenCost;
 *  - honest zero-injection: no record clears the relevance floor -> a record with a
 *    `reason` is still produced (retrieval was attempted and is accounted for), but the
 *    sent systemPrompt is unaffected;
 *  - flag disabled: systemPrompt is byte-identical to the base+wrfc prompt and no record
 *    is ever produced;
 *  - a budget override of 0 is a hard no-op even with a matching record and the flag on;
 *  - reuse across tool-continuation iterations of the SAME executeOrchestratorTurnLoop()
 *    call: the block built on iteration 1 (the human message) is composed again on
 *    iteration 2 (a tool round, no new human input) WITHOUT re-invoking retrieval, and is
 *    never duplicated/concatenated (no compounding);
 *  - context-pressure re-derivation: when live tokens grow past the fixed 85% safety
 *    threshold between iteration 1 (block fits) and iteration 2 (block would no longer
 *    fit), composeTurnSystemPrompt drops the reused block for iteration 2's call only,
 *    re-validating fit fresh at each call site rather than trusting the iteration-1
 *    decision;
 *  - dedupe across separate user turns: an id surfaced on one
 *    executeOrchestratorTurnLoop() call is never re-listed on a later call that shares the
 *    same alreadyInjectedIds-backing state (mirrors how Orchestrator's
 *    turnKnowledgeIdsAlreadySurfaced persists for the life of the session).
 */
import { describe, expect, test } from 'bun:test';
import {
  executeOrchestratorTurnLoop,
  type OrchestratorTurnLoopContext,
} from '../packages/sdk/src/platform/core/orchestrator-turn-loop.js';
import { ConversationManager } from '../packages/sdk/src/platform/core/conversation.js';
import { ToolRegistry } from '../packages/sdk/src/platform/tools/registry.js';
import { appendGoodVibesRuntimeAwarenessPrompt } from '../packages/sdk/src/platform/tools/goodvibes-runtime/index.js';
import type { LLMProvider, ChatResponse } from '../packages/sdk/src/platform/providers/interface.js';
import type { ModelDefinition } from '../packages/sdk/src/platform/providers/registry-types.js';
import type { HelperModel } from '../packages/sdk/src/platform/config/helper-model.js';
import type { MemoryRecord } from '../packages/sdk/src/platform/state/memory-store.js';
import type { TurnKnowledgeRegistrySource, TurnInjectionRecord } from '../packages/sdk/src/platform/agents/turn-knowledge-injection.js';

const BASE_SYSTEM_PROMPT = 'You are the goodvibes assistant.';
// getSystemPrompt() output is always passed through appendGoodVibesRuntimeAwarenessPrompt
// at the call site (pre-existing, unrelated to this per-turn knowledge injection feature) before any per-turn knowledge block
// is composed onto it — this is the "no injection happened" baseline every "byte-identical"
// assertion in this suite compares against, not the raw BASE_SYSTEM_PROMPT.
const EXPECTED_BASE_PROMPT = appendGoodVibesRuntimeAwarenessPrompt(BASE_SYSTEM_PROMPT);

const FAKE_MODEL: ModelDefinition = {
  id: 'fake-model',
  provider: 'fake',
  registryKey: 'fake:fake-model',
  displayName: 'Fake Model',
  description: 'test-only stub model',
  capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
  contextWindow: 0,
  selectable: true,
};

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

function makeCountingMemoryRegistry(records: MemoryRecord[]): { registry: TurnKnowledgeRegistrySource; counters: { getAllCalls: number } } {
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

interface TestContextOverrides {
  text: string;
  provider: LLMProvider;
  memoryRegistry?: TurnKnowledgeRegistrySource | undefined;
  enabled?: boolean;
  budgetTokens?: number | undefined;
  relevanceFloor?: number | undefined;
  contextWindow?: number;
  alreadyInjectedIds?: Set<string>;
  turnSequence?: { value: number };
  turnInjectionRecords?: TurnInjectionRecord[];
}

/** Builds a fully mockable OrchestratorTurnLoopContext, mirroring the pattern
 *  orchestrator-runner-turn-knowledge-injection.test.ts uses for AgentOrchestratorRunContext. */
function makeContext(opts: TestContextOverrides): {
  context: OrchestratorTurnLoopContext;
  capturedSystemPrompts: string[];
  turnInjectionRecords: TurnInjectionRecord[];
  alreadyInjectedIds: Set<string>;
  markedFailed: { value: boolean };
} {
  const conversation = new ConversationManager();
  conversation.addUserMessage(opts.text);

  const capturedSystemPrompts: string[] = [];
  const turnInjectionRecords = opts.turnInjectionRecords ?? [];
  const alreadyInjectedIds = opts.alreadyInjectedIds ?? new Set<string>();
  const sequence = opts.turnSequence ?? { value: 0 };
  const markedFailed = { value: false };

  const wrappedProvider: LLMProvider = {
    name: opts.provider.name,
    models: opts.provider.models,
    chat: async (request) => {
      capturedSystemPrompts.push(request.systemPrompt ?? '');
      return opts.provider.chat(request);
    },
  };

  const context: OrchestratorTurnLoopContext = {
    conversation,
    toolRegistry: new ToolRegistry(),
    getSystemPrompt: () => BASE_SYSTEM_PROMPT,
    getAbortSignal: () => undefined,
    hookDispatcher: null,
    requestRender: () => {},
    runtimeBus: null,
    agentManager: { list: () => [], spawn: async () => 'noop-agent-id' },
    configManager: {
      get: (key: string) => {
        if (key === 'display.stream') return false;
        if (key === 'cache.hitRateWarningThreshold') return 0;
        if (key === 'cache.monitorHitRate') return false;
        if (key === 'agents.contextCompactThreshold') return 0.85;
        if (key === 'agents.passiveInjection.budgetTokens') return 800;
        if (key === 'agents.passiveInjection.relevanceFloor') return 95;
        if (key === 'agents.passiveInjection.codeLimit') return 3;
        return undefined;
      },
    },
    providerRegistry: {
      require: () => wrappedProvider,
      getCurrentModel: () => FAKE_MODEL,
      getForModel: () => wrappedProvider,
      getTokenLimitsForModel: () => ({
        maxOutputTokens: 4096,
        maxToolResultTokens: 50_000,
        maxToolCalls: 128,
        maxReasoningTokens: 16_384,
      }),
      getContextWindowForModel: () => opts.contextWindow ?? 0,
      recordContextWindowRejection: () => {},
      reconcileObservedContextWindow: () => {},
    },
    favoritesStore: undefined,
    cacheHitTracker: { getMetrics: () => ({ turns: 0, hitRate: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalInputTokens: 0 }) },
    helperModel: { getUsage: () => ({ calls: 0, inputTokens: 0, outputTokens: 0 }) } as unknown as HelperModel,
    sessionId: 'test-session',
    preTurnPlan: null,
    planManager: null,
    text: opts.text,
    content: undefined,
    turnId: 'test-turn',
    emitterContext: () => ({ sessionId: 'test-session', traceId: 'test-trace', source: 'test' }),
    executeToolCalls: async (_id, calls) => calls.map((call) => ({ callId: call.id, success: true, output: 'ok' })),
    checkContextWindowPreflight: async () => 'ok',
    normalizeUsage: (usage) => usage,
    estimateFreshTurnInputTokens: () => 0,
    getMessageQueueLength: () => 0,
    isReconciliationEnabled: () => true,
    setPendingToolCalls: () => {},
    setAutoSpawnTimeout: () => {},
    setStreamingActive: () => {},
    setStreamingInputTokens: () => {},
    addStreamingOutputTokens: () => {},
    setLastRequestInputTokens: () => {},
    setLastInputTokens: () => {},
    markTurnFailed: () => { markedFailed.value = true; },
    noteModelContextWindowWarning: () => {},
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    memoryRegistry: opts.memoryRegistry,
    isPassiveKnowledgeInjectionEnabled: () => opts.enabled ?? true,
    passiveKnowledgeInjectionBudgetTokens: opts.budgetTokens,
    passiveKnowledgeInjectionRelevanceFloor: opts.relevanceFloor,
    getAlreadyInjectedKnowledgeIds: () => [...alreadyInjectedIds],
    addInjectedKnowledgeIds: (ids) => { for (const id of ids) alreadyInjectedIds.add(id); },
    recordTurnKnowledgeInjection: (record) => { turnInjectionRecords.push(record); },
    nextTurnKnowledgeSequence: () => ++sequence.value,
  };

  return { context, capturedSystemPrompts, turnInjectionRecords, alreadyInjectedIds, markedFailed };
}

function finalResponseProvider(content = 'done'): LLMProvider {
  return {
    name: 'fake',
    models: ['fake-model'],
    async chat(): Promise<ChatResponse> {
      return { content, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' };
    },
  };
}

describe('orchestrator-turn-loop — main-session per-turn passive knowledge injection', () => {
  test('a relevant memory record composes onto the sent systemPrompt and is recorded with a numeric tokenCost', async () => {
    const { registry: memoryRegistry } = makeCountingMemoryRegistry([
      makeMemoryRecord({
        id: 'mem_ratelimit',
        summary: 'rate limiting: token bucket, 100 requests per minute',
        tags: ['rate-limiting'],
        reviewState: 'reviewed',
        confidence: 90,
      }),
    ]);

    const { context, capturedSystemPrompts, turnInjectionRecords } = makeContext({
      text: 'how do I configure rate limiting for the API',
      provider: finalResponseProvider(),
      memoryRegistry,
    });

    await executeOrchestratorTurnLoop(context);

    expect(capturedSystemPrompts).toHaveLength(1);
    expect(capturedSystemPrompts[0]).toContain('mem_ratelimit');
    expect(capturedSystemPrompts[0]).toContain('Injected Project Knowledge');
    // Base prompt is still present underneath the block — this is additive, not a
    // replacement of the bootstrap-composed prompt.
    expect(capturedSystemPrompts[0]).toContain(BASE_SYSTEM_PROMPT);

    expect(turnInjectionRecords).toHaveLength(1);
    const record = turnInjectionRecords[0]!;
    expect(record.injectedIds).toEqual(['mem_ratelimit']);
    expect(typeof record.tokenCost).toBe('number');
    expect(record.tokenCost).toBeGreaterThan(0);
    expect(record.tokenCost).toBeLessThanOrEqual(record.budgetTokens);
  });

  test('honest zero-injection: no record clears the relevance floor -> a reasoned record is still produced, prompt unaffected', async () => {
    const { registry: memoryRegistry } = makeCountingMemoryRegistry([
      // confidence 55 + fresh(+20) = 75, well under the default relevance floor (95), and
      // shares no tokens with the query text below.
      makeMemoryRecord({ id: 'mem_unrelated', summary: 'unrelated topic entirely', confidence: 55 }),
    ]);

    const { context, capturedSystemPrompts, turnInjectionRecords } = makeContext({
      text: 'what is the weather like today',
      provider: finalResponseProvider(),
      memoryRegistry,
    });

    await executeOrchestratorTurnLoop(context);

    expect(capturedSystemPrompts[0]).not.toContain('Injected Project Knowledge');
    expect(capturedSystemPrompts[0]).toBe(EXPECTED_BASE_PROMPT);

    expect(turnInjectionRecords).toHaveLength(1);
    expect(turnInjectionRecords[0]!.injectedIds).toEqual([]);
    expect(turnInjectionRecords[0]!.reason).toBeDefined();
  });

  test('flag disabled: systemPrompt is byte-identical to the base prompt and no record is ever produced', async () => {
    const { registry: memoryRegistry } = makeCountingMemoryRegistry([
      makeMemoryRecord({ id: 'mem_ratelimit', summary: 'rate limiting: token bucket, 100 requests per minute', confidence: 90, reviewState: 'reviewed' }),
    ]);

    const { context, capturedSystemPrompts, turnInjectionRecords } = makeContext({
      text: 'tell me about rate limiting',
      provider: finalResponseProvider(),
      memoryRegistry,
      enabled: false,
    });

    await executeOrchestratorTurnLoop(context);

    expect(capturedSystemPrompts[0]).toBe(EXPECTED_BASE_PROMPT);
    expect(turnInjectionRecords).toEqual([]);
  });

  test('a budget override of 0 is a hard no-op even with a matching record and the flag enabled', async () => {
    const { registry: memoryRegistry } = makeCountingMemoryRegistry([
      makeMemoryRecord({ id: 'mem_ratelimit', summary: 'rate limiting: token bucket, 100 requests per minute', confidence: 90, reviewState: 'reviewed' }),
    ]);

    const { context, capturedSystemPrompts, turnInjectionRecords } = makeContext({
      text: 'tell me about rate limiting',
      provider: finalResponseProvider(),
      memoryRegistry,
      budgetTokens: 0,
    });

    await executeOrchestratorTurnLoop(context);

    expect(capturedSystemPrompts[0]).toBe(EXPECTED_BASE_PROMPT);
    expect(turnInjectionRecords).toEqual([]);
  });

  test('reuse across tool-continuation iterations: retrieval runs once, the same block is composed on both calls, no compounding', async () => {
    const { registry: memoryRegistry, counters } = makeCountingMemoryRegistry([
      makeMemoryRecord({ id: 'mem_ratelimit', summary: 'rate limiting: token bucket, 100 requests per minute', confidence: 90, reviewState: 'reviewed' }),
    ]);

    let chatCallCount = 0;
    const provider: LLMProvider = {
      name: 'fake',
      models: ['fake-model'],
      async chat(): Promise<ChatResponse> {
        chatCallCount += 1;
        if (chatCallCount === 1) {
          return { content: '', toolCalls: [{ id: 'call-1', name: 'nonexistent_tool', arguments: {} }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'tool_call' };
        }
        return { content: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' };
      },
    };

    const { context, capturedSystemPrompts } = makeContext({
      text: 'tell me about rate limiting',
      provider,
      memoryRegistry,
    });

    await executeOrchestratorTurnLoop(context);

    expect(chatCallCount).toBe(2);
    expect(counters.getAllCalls).toBe(1); // retrieval ran exactly once, not once per iteration
    expect(capturedSystemPrompts).toHaveLength(2);
    expect(capturedSystemPrompts[0]).toContain('mem_ratelimit');
    // Iteration 2 reuses the SAME block verbatim — not a second, concatenated copy.
    expect(capturedSystemPrompts[1]).toBe(capturedSystemPrompts[0]);
    const blockOccurrences = capturedSystemPrompts[1]!.split('mem_ratelimit').length - 1;
    expect(blockOccurrences).toBe(1);
  });

  test('context-pressure re-derivation: a reused block that no longer fits is dropped fresh at the later call site, not carried over stale', async () => {
    const { registry: memoryRegistry } = makeCountingMemoryRegistry([
      makeMemoryRecord({
        id: 'mem_ratelimit',
        summary: 'rate limiting uses a distributed token bucket with per-tenant quotas and burst allowance',
        confidence: 90,
        reviewState: 'reviewed',
      }),
    ]);

    // A context window sized so the block (measured at 221 tokens for this fixture) fits
    // comfortably against the SHORT iteration-1 conversation (7 tokens of user text + 240
    // tokens of base+awareness system prompt, leaving ~263 tokens of headroom under a 510
    // token threshold), but the tool result appended after iteration 1 (1500 tokens of
    // padding) pushes live tokens far past that same threshold by the time iteration 2's
    // call is composed. The budget override (800) is generous on purpose so the headroom
    // clamp — not the budget — is what this test exercises.
    const contextWindow = 600;

    let chatCallCount = 0;
    const provider: LLMProvider = {
      name: 'fake',
      models: ['fake-model'],
      async chat(): Promise<ChatResponse> {
        chatCallCount += 1;
        if (chatCallCount === 1) {
          return { content: '', toolCalls: [{ id: 'call-1', name: 'nonexistent_tool', arguments: {} }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'tool_call' };
        }
        return { content: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' };
      },
    };

    const { context, capturedSystemPrompts } = makeContext({
      text: 'tell me about rate limiting',
      provider,
      memoryRegistry,
      contextWindow,
      budgetTokens: 800,
    });
    context.executeToolCalls = async (_id, calls) => calls.map((call) => ({
      callId: call.id,
      success: true,
      // ~1500 estimated tokens (estimateTokens ~= chars/4) — comfortably enough to blow
      // through the 510-token threshold once added to the base+block cost.
      output: 'x '.repeat(3000),
    }));

    await executeOrchestratorTurnLoop(context);

    expect(chatCallCount).toBe(2);
    expect(capturedSystemPrompts[0]).toContain('mem_ratelimit');
    // The live re-check at iteration 2's call site drops the reused block once it no
    // longer fits under the threshold, instead of resending a stale, over-budget prompt.
    expect(capturedSystemPrompts[1]).not.toContain('mem_ratelimit');
    expect(capturedSystemPrompts[1]).toBe(EXPECTED_BASE_PROMPT);
  });

  test('dedupe across separate user turns: an id surfaced on one call is never re-listed on a later call sharing the same surfaced-ids state', async () => {
    const { registry: memoryRegistry } = makeCountingMemoryRegistry([
      makeMemoryRecord({ id: 'mem_ratelimit', summary: 'rate limiting: token bucket, 100 requests per minute', confidence: 90, reviewState: 'reviewed' }),
    ]);
    const sharedAlreadyInjectedIds = new Set<string>();
    const sharedRecords: TurnInjectionRecord[] = [];
    const sharedSequence = { value: 0 };

    const first = makeContext({
      text: 'tell me about rate limiting',
      provider: finalResponseProvider(),
      memoryRegistry,
      alreadyInjectedIds: sharedAlreadyInjectedIds,
      turnInjectionRecords: sharedRecords,
      turnSequence: sharedSequence,
    });
    await executeOrchestratorTurnLoop(first.context);
    expect(first.capturedSystemPrompts[0]).toContain('mem_ratelimit');

    // A second, later user turn (a fresh executeOrchestratorTurnLoop() call, as a new
    // runTurn() would make) asking about the SAME topic — the record would score high
    // again, but Orchestrator's persistent alreadyInjectedIds set (shared here) excludes
    // it from ever being listed twice in the session.
    const second = makeContext({
      text: 'tell me more about rate limiting',
      provider: finalResponseProvider(),
      memoryRegistry,
      alreadyInjectedIds: sharedAlreadyInjectedIds,
      turnInjectionRecords: sharedRecords,
      turnSequence: sharedSequence,
    });
    await executeOrchestratorTurnLoop(second.context);

    expect(second.capturedSystemPrompts[0]).not.toContain('mem_ratelimit');
    expect(sharedRecords).toHaveLength(2);
    expect(sharedRecords[0]!.injectedIds).toEqual(['mem_ratelimit']);
    expect(sharedRecords[1]!.injectedIds).toEqual([]);
    // Turn numbers are monotonic across the two calls (session-lifetime sequence, not
    // reset per call).
    expect(sharedRecords[0]!.turn).toBe(1);
    expect(sharedRecords[1]!.turn).toBe(2);
  });

  test('memoryRegistry undefined is a hard no-op: no crash, no record, base prompt only', async () => {
    const { context, capturedSystemPrompts, turnInjectionRecords } = makeContext({
      text: 'tell me about rate limiting',
      provider: finalResponseProvider(),
      memoryRegistry: undefined,
    });

    await expect(executeOrchestratorTurnLoop(context)).resolves.toBeUndefined();
    expect(capturedSystemPrompts[0]).toBe(EXPECTED_BASE_PROMPT);
    expect(turnInjectionRecords).toEqual([]);
  });

  test('a sparse config source that returns undefined for the passive-injection keys still injects at the documented defaults', async () => {
    // A real ConfigManager always resolves the schema default for every key, but
    // context.configManager is typed Pick<ConfigManager, 'get'> — a partial/stub
    // implementation (as some embedders and tests supply) can legitimately return
    // undefined for a key it does not model. Before restoring the module-constant
    // fallbacks, `agents.contextCompactThreshold` -> undefined made the headroom
    // clamp NaN (turnBudgetTokens never > 0 -> hard no-op every turn) and
    // `agents.passiveInjection.relevanceFloor` -> undefined made every relevance
    // comparison against NaN silently fail (no record ever clears the floor) —
    // both a total, permanent injection blackout with no error, no matter how
    // relevant the record. This proves injection still works at the documented
    // defaults (0.85 / 95 / 800 / 3) when a config source omits these keys.
    const { registry: memoryRegistry } = makeCountingMemoryRegistry([
      makeMemoryRecord({
        id: 'mem_ratelimit',
        summary: 'rate limiting: token bucket, 100 requests per minute',
        tags: ['rate-limiting'],
        reviewState: 'reviewed',
        confidence: 90,
      }),
    ]);

    const { context, capturedSystemPrompts, turnInjectionRecords } = makeContext({
      text: 'how do I configure rate limiting for the API',
      provider: finalResponseProvider(),
      memoryRegistry,
      // Non-zero so the headroom-clamp branch (the one that reads
      // agents.contextCompactThreshold) actually runs instead of being skipped —
      // a contextWindow of 0 would hide the threshold-NaN regression entirely.
      contextWindow: 100_000,
    });
    context.configManager = {
      get: (key: string) => {
        if (key === 'display.stream') return false;
        if (key === 'cache.hitRateWarningThreshold') return 0;
        if (key === 'cache.monitorHitRate') return false;
        // Every passive-injection / context-compaction key this sparse source does
        // not model — the exact shape a partial embedder-supplied config takes.
        return undefined;
      },
    };

    await executeOrchestratorTurnLoop(context);

    expect(capturedSystemPrompts).toHaveLength(1);
    expect(capturedSystemPrompts[0]).toContain('mem_ratelimit');
    expect(capturedSystemPrompts[0]).toContain('Injected Project Knowledge');
    expect(turnInjectionRecords).toHaveLength(1);
    expect(turnInjectionRecords[0]!.injectedIds).toEqual(['mem_ratelimit']);
    expect(turnInjectionRecords[0]!.budgetTokens).toBe(800); // DEFAULT_TURN_KNOWLEDGE_BUDGET_TOKENS
  });
});
