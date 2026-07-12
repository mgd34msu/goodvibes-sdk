/**
 * Cost-attribution actuals from the emit sites: tool-internal (ToolLLM) and
 * helper-model LLM calls emit LLM_RESPONSE_RECEIVED with their real token
 * usage, the ambient cost-origin scope stamps the tool/hook/MCP cause, and
 * the turn-domain ingest fills the per-dimension buckets with actuals only —
 * no estimates, no allocation heuristics. The per-dimension rows sum exactly
 * to the session total.
 */
import { describe, expect, test } from 'bun:test';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.ts';
import { withCostOriginAsync } from '../packages/sdk/src/platform/runtime/cost/cost-origin.ts';
import {
  CostAttributionService,
  type ResolvePricing,
} from '../packages/sdk/src/platform/runtime/cost/attribution.ts';
import { emitLlmResponseReceived } from '../packages/sdk/src/platform/runtime/emitters/turn.ts';
import { ToolLLM } from '../packages/sdk/src/platform/config/tool-llm.ts';
import { HelperModel } from '../packages/sdk/src/platform/config/helper-model.ts';
import type { LLMProvider, ChatResponse } from '../packages/sdk/src/platform/providers/interface.ts';

const pricing: ResolvePricing = () => ({ input: 3, output: 15 });

function makeFakeProvider(usage: { inputTokens: number; outputTokens: number }): LLMProvider {
  return {
    name: 'fake-provider',
    models: ['fake-model'],
    isConfigured: () => true,
    chat: async (): Promise<ChatResponse> => ({
      content: 'ok',
      toolCalls: [],
      usage: { ...usage },
      stopReason: 'completed',
    }),
  } as unknown as LLMProvider;
}

/**
 * Mirrors the production turn-domain ingest (the gateway verb registration
 * subscribes to LLM_RESPONSE_RECEIVED and maps origin fields onto the
 * CostUsageRecord) so this test proves the full emit-to-bucket pipeline.
 */
function installIngest(bus: RuntimeEventBus, svc: CostAttributionService): void {
  bus.onDomain('turn', (envelope) => {
    const event = envelope.payload as Record<string, unknown> & { type: string };
    if (event.type !== 'LLM_RESPONSE_RECEIVED') return;
    svc.record({
      at: Date.now(),
      provider: event.provider as string,
      model: event.model as string,
      sessionId: envelope.sessionId,
      ...(event.originTool !== undefined ? { tool: event.originTool as string } : {}),
      ...(event.originHook !== undefined ? { hook: event.originHook as string } : {}),
      ...(event.originMcpServer !== undefined ? { mcpServer: event.originMcpServer as string } : {}),
      inputTokens: event.inputTokens as number,
      outputTokens: event.outputTokens as number,
      cacheReadTokens: (event.cacheReadTokens as number | undefined) ?? 0,
      cacheWriteTokens: (event.cacheWriteTokens as number | undefined) ?? 0,
    });
  });
}

function makeToolLLM(bus: RuntimeEventBus, provider: LLMProvider): ToolLLM {
  return new ToolLLM({
    configManager: { get: (key: string) => (key === 'tools.llmEnabled' ? true : '') } as never,
    providerRegistry: {
      getCurrentModel: () => ({ registryKey: 'fake-provider:fake-model', provider: 'fake-provider', id: 'fake-model' }),
      getForModel: () => provider,
    } as never,
    runtimeBus: bus,
    sessionId: () => 'session-1',
  });
}

describe('per-dimension cost actuals from real emit sites', () => {
  test('a session with main-turn, tool, MCP-tool, and hook spend fills every dimension and sums to the session total', async () => {
    const bus = new RuntimeEventBus();
    const svc = new CostAttributionService({ resolvePricing: pricing });
    installIngest(bus, svc);
    const toolLLM = makeToolLLM(bus, makeFakeProvider({ inputTokens: 100, outputTokens: 10 }));

    // Main-turn spend, exactly as the orchestrator turn loop emits it.
    emitLlmResponseReceived(bus, { sessionId: 'session-1', source: 'turn-loop', traceId: 't1', turnId: 'turn-1' }, {
      turnId: 'turn-1', provider: 'fake-provider', model: 'fake-model', contentSummary: 'x',
      toolCallCount: 0, inputTokens: 1000, outputTokens: 50,
    });

    // A tool-internal LLM call inside the tool's execution scope.
    await withCostOriginAsync({ tool: 'semantic_diff', callId: 'call-1' }, () => toolLLM.chat('diff'));
    // An MCP tool's execution scope (server derived from the qualified name).
    await withCostOriginAsync(
      { tool: 'mcp:github:search_issues', callId: 'call-2', mcpServer: 'github' },
      () => toolLLM.chat('search'),
    );
    // A hook prompt runner scope.
    await withCostOriginAsync({ hook: 'Post:tool:edit' }, () => toolLLM.chat('hook prompt'));

    // Bus delivery is microtask-scheduled.
    await Bun.sleep(1);

    const byTool = svc.attribution('24h', 'tool');
    const byMcp = svc.attribution('24h', 'mcp');
    const byHook = svc.attribution('24h', 'hook');

    // Per-dimension actuals are non-empty.
    expect(byTool.rows.find((r) => r.key === 'semantic_diff')?.tokens.inputTokens).toBe(100);
    expect(byTool.rows.find((r) => r.key === 'mcp:github:search_issues')?.tokens.inputTokens).toBe(100);
    expect(byMcp.rows.find((r) => r.key === 'github')?.tokens.inputTokens).toBe(100);
    expect(byMcp.rows.find((r) => r.key === 'github')?.tokens.outputTokens).toBe(10);
    expect(byHook.rows.find((r) => r.key === 'Post:tool:edit')?.tokens.inputTokens).toBe(100);

    // Actuals only: the session total is the four real calls, nothing else.
    const expectedInput = 1000 + 100 + 100 + 100;
    const expectedOutput = 50 + 10 + 10 + 10;
    for (const result of [byTool, byMcp, byHook]) {
      expect(result.tokens.inputTokens).toBe(expectedInput);
      expect(result.tokens.outputTokens).toBe(expectedOutput);
      // Every dimension's rows sum exactly to the session total.
      const rowInput = result.rows.reduce((sum, row) => sum + row.tokens.inputTokens, 0);
      const rowOutput = result.rows.reduce((sum, row) => sum + row.tokens.outputTokens, 0);
      expect(rowInput).toBe(expectedInput);
      expect(rowOutput).toBe(expectedOutput);
    }

    // Main-turn spend and the hook-scoped call (which carries no tool origin)
    // stay honestly unattributed in the TOOL dimension.
    expect(byTool.rows.find((r) => r.key === '(unattributed)')?.tokens.inputTokens).toBe(1100);
  });

  test('helper-model calls emit their actuals with the ambient origin', async () => {
    const bus = new RuntimeEventBus();
    const svc = new CostAttributionService({ resolvePricing: pricing });
    installIngest(bus, svc);

    const provider = makeFakeProvider({ inputTokens: 40, outputTokens: 4 });
    const helper = new HelperModel({
      configManager: {
        get: (key: string) => {
          if (key === 'helper.enabled') return true;
          if (key === 'helper.globalProvider') return 'fake-provider';
          if (key === 'helper.globalModel') return 'fake-model';
          return '';
        },
        getCategory: () => ({}),
      } as never,
      providerRegistry: {
        getCurrentModel: () => ({ registryKey: 'fake-provider:fake-model', provider: 'fake-provider', id: 'fake-model' }),
        getForModel: () => provider,
      } as never,
      runtimeBus: bus,
      sessionId: () => 'session-2',
    });

    await withCostOriginAsync({ tool: 'commit_helper', callId: 'call-9' }, () => helper.chat('commit_message', 'msg'));
    await Bun.sleep(1);

    const byTool = svc.attribution('24h', 'tool');
    const row = byTool.rows.find((r) => r.key === 'commit_helper');
    expect(row?.tokens.inputTokens).toBe(40);
    expect(row?.tokens.outputTokens).toBe(4);
  });

  test('without a runtime bus, tool-internal calls still work (no emission, no crash)', async () => {
    const provider = makeFakeProvider({ inputTokens: 10, outputTokens: 1 });
    const toolLLM = new ToolLLM({
      configManager: { get: (key: string) => (key === 'tools.llmEnabled' ? true : '') } as never,
      providerRegistry: {
        getCurrentModel: () => ({ registryKey: 'fake-provider:fake-model', provider: 'fake-provider', id: 'fake-model' }),
        getForModel: () => provider,
      } as never,
    });
    expect(await toolLLM.chat('plain')).toBe('ok');
  });
});
