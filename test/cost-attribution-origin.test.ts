/**
 * cost-attribution-origin.test.ts
 *
 * The cost-attribution ORIGIN wire (item: per-tool/hook/MCP cost emit-site tags):
 * an LLM usage event emitted inside a cost-origin scope carries the tool/hook/MCP
 * cause, and the turn-bus ingest maps it onto a CostUsageRecord so
 * cost.attribution.get grouped by tool/hook/mcp reflects the true source.
 */
import { describe, expect, test } from 'bun:test';
import {
  getCostOrigin,
  withCostOriginAsync,
  mcpServerOfToolName,
} from '../packages/sdk/src/platform/runtime/cost/cost-origin.ts';
import {
  CostAttributionService,
  type ResolvePricing,
} from '../packages/sdk/src/platform/runtime/cost/attribution.ts';
import { emitLlmResponseReceived } from '../packages/sdk/src/platform/runtime/emitters/turn.ts';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.ts';

const pricing: ResolvePricing = () => ({ input: 3, output: 15 });

describe('cost-origin ALS scope', () => {
  test('getCostOrigin is empty outside any scope', () => {
    expect(getCostOrigin()).toEqual({});
  });

  test('withCostOriginAsync exposes the origin to nested async work and replaces (not merges)', async () => {
    await withCostOriginAsync({ tool: 'agent', callId: 'c1' }, async () => {
      expect(getCostOrigin()).toEqual({ tool: 'agent', callId: 'c1' });
      // A nested scope replaces the outer origin rather than inheriting it.
      await withCostOriginAsync({ hook: 'Post:tool:edit' }, async () => {
        expect(getCostOrigin()).toEqual({ hook: 'Post:tool:edit' });
      });
      expect(getCostOrigin()).toEqual({ tool: 'agent', callId: 'c1' });
    });
    expect(getCostOrigin()).toEqual({});
  });

  test('mcpServerOfToolName extracts the server segment from a qualified MCP tool name', () => {
    expect(mcpServerOfToolName('mcp:github:search_issues')).toBe('github');
    expect(mcpServerOfToolName('mcp:github')).toBe('github');
    expect(mcpServerOfToolName('read')).toBeUndefined();
    expect(mcpServerOfToolName('mcp:')).toBeUndefined();
  });
});

describe('emit inside a cost-origin scope stamps the event', () => {
  test('emitLlmResponseReceived merges the ambient origin onto LLM_RESPONSE_RECEIVED', async () => {
    const bus = new RuntimeEventBus();
    const seen: Array<Record<string, unknown>> = [];
    bus.onDomain('turn', (env) => {
      if (env.payload.type === 'LLM_RESPONSE_RECEIVED') seen.push(env.payload as Record<string, unknown>);
    });
    await withCostOriginAsync({ tool: 'mcp:github:search', mcpServer: 'github', callId: 'c9' }, async () => {
      emitLlmResponseReceived(bus, { sessionId: 's1', traceId: 't1', turnId: 'turn1' }, {
        turnId: 'turn1', provider: 'anthropic', model: 'claude-x', contentSummary: 'x',
        toolCallCount: 0, inputTokens: 10, outputTokens: 2,
      });
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.originTool).toBe('mcp:github:search');
    expect(seen[0]!.originMcpServer).toBe('github');
    expect(seen[0]!.originCallId).toBe('c9');
  });

  test('emit with no active scope carries no origin fields', async () => {
    const bus = new RuntimeEventBus();
    const seen: Array<Record<string, unknown>> = [];
    bus.onDomain('turn', (env) => {
      if (env.payload.type === 'LLM_RESPONSE_RECEIVED') seen.push(env.payload as Record<string, unknown>);
    });
    emitLlmResponseReceived(bus, { sessionId: 's1', traceId: 't1', turnId: 'turn1' }, {
      turnId: 'turn1', provider: 'anthropic', model: 'claude-x', contentSummary: 'x',
      toolCallCount: 0, inputTokens: 10, outputTokens: 2,
    });
    // Delivery is via queueMicrotask; let it flush.
    await Promise.resolve();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.originTool).toBeUndefined();
    expect(seen[0]!.originHook).toBeUndefined();
    expect(seen[0]!.originMcpServer).toBeUndefined();
  });
});

describe('attribution groups spend by the tagged origin', () => {
  test('records tagged with tool/hook/mcp attribute to those dimensions', () => {
    const svc = new CostAttributionService({ resolvePricing: pricing, now: () => 1000 });
    svc.record({ at: 1000, provider: 'anthropic', model: 'm', sessionId: 's', tool: 'agent', inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    svc.record({ at: 1000, provider: 'anthropic', model: 'm', sessionId: 's', hook: 'Post:tool:edit', inputTokens: 50, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    svc.record({ at: 1000, provider: 'anthropic', model: 'm', sessionId: 's', mcpServer: 'github', inputTokens: 25, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    // Untagged reasoning spend stays out of the tool/hook/mcp dimensions.
    svc.record({ at: 1000, provider: 'anthropic', model: 'm', sessionId: 's', inputTokens: 200, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

    const byTool = svc.attribution('24h', 'tool');
    expect(byTool.rows.find((r) => r.key === 'agent')?.tokens.inputTokens).toBe(100);
    expect(byTool.rows.find((r) => r.key === '(unattributed)')?.tokens.inputTokens).toBe(275);

    const byHook = svc.attribution('24h', 'hook');
    expect(byHook.rows.find((r) => r.key === 'Post:tool:edit')?.tokens.inputTokens).toBe(50);

    const byMcp = svc.attribution('24h', 'mcp');
    expect(byMcp.rows.find((r) => r.key === 'github')?.tokens.inputTokens).toBe(25);
  });
});
