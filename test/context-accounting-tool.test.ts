import { describe, expect, test } from 'bun:test';
import {
  ContextAccountingHolder,
  createContextAccountingTool,
  type ContextAccountingSource,
} from '../packages/sdk/src/platform/tools/context-accounting/index.js';
import type { TurnInjectionRecord } from '../packages/sdk/src/platform/agents/turn-knowledge-injection.js';

function makeInjection(over: Partial<TurnInjectionRecord>): TurnInjectionRecord {
  return {
    turn: 1,
    query: 'q',
    candidatesConsidered: 0,
    codeCandidatesConsidered: 0,
    injectedIds: [],
    injectedSources: [],
    droppedForBudget: [],
    tokenCost: 0,
    budgetTokens: 500,
    relevanceFloor: 60,
    ingestModes: [],
    embeddingBackend: 'available',
    ...over,
  };
}

function sourceWith(injections: TurnInjectionRecord[]): ContextAccountingSource {
  return {
    scope: 'interactive-session',
    sessionId: 'sess-1',
    getTurnInjections: () => injections,
    getTokenState: () => ({
      measured: { input: 1200, output: 300, cacheRead: 900, cacheWrite: 100 },
      lastInputTokens: 2100,
      contextWindow: 200_000,
    }),
    getCompactionState: () => ({ isCompacting: false, compactionCount: 2 }),
  };
}

async function runTool(source: ContextAccountingSource | null) {
  const holder = new ContextAccountingHolder();
  if (source) holder.setSource(source);
  const tool = createContextAccountingTool(holder);
  const result = await tool.execute({});
  expect(result.success).toBe(true);
  return JSON.parse(result.output!) as Record<string, unknown>;
}

describe('context_accounting tool', () => {
  test('is honest when no session source is bound', async () => {
    const out = await runTool(null);
    expect(out.available).toBe(false);
    expect(String(out.reason)).toContain('No live session context');
  });

  test('reports injected ids, measured tokens, and flags estimates', async () => {
    const out = await runTool(sourceWith([
      makeInjection({ turn: 3, injectedIds: ['mem-a', 'mem-b'], injectedSources: ['memory', 'memory'], tokenCost: 140 }),
    ]));
    expect(out.available).toBe(true);
    expect(out.scope).toBe('interactive-session');
    expect(out.sessionId).toBe('sess-1');
    const turn = out.turn as Record<string, unknown>;
    const latest = turn.latestInjection as Record<string, unknown>;
    expect(latest.injectedIds).toEqual(['mem-a', 'mem-b']);
    expect(latest.tokenCostEstimated).toBe(140);
    const budget = out.tokenBudget as Record<string, unknown>;
    expect(budget.measured).toEqual({ input: 1200, output: 300, cacheRead: 900, cacheWrite: 100 });
    expect(budget.lastInputTokens).toBe(2100);
    // 2100 / 200000 = 1.05% — derived, flagged.
    expect(budget.contextUsedPctEstimated).toBe(1.1);
    expect(out.estimates).toBeDefined();
  });

  test('distinguishes floored/dropped recall from a degraded index', async () => {
    const floored = await runTool(sourceWith([
      makeInjection({ injectedIds: ['mem-a'], injectedSources: ['memory'], droppedForBudget: ['mem-x', 'mem-y'] }),
    ]));
    const recall = floored.recallContract as Record<string, unknown>;
    expect(recall.relevanceFloor).toBe(60);
    expect(recall.droppedForBudget).toEqual(['mem-x', 'mem-y']);
    expect(String(recall.note)).toContain('dropped to fit the token budget');

    const degraded = await runTool(sourceWith([
      makeInjection({ reason: 'no records cleared the relevance floor', embeddingBackend: 'fallback-lexical' }),
    ]));
    const drecall = degraded.recallContract as Record<string, unknown>;
    expect(drecall.degraded).toBe(true);
    expect(String(drecall.note)).toContain('degraded to lexical');
    expect(String(drecall.note)).toContain('Nothing injected this turn');
  });

  test('honest note when no injection has been recorded at all', async () => {
    const out = await runTool(sourceWith([]));
    const recall = out.recallContract as Record<string, unknown>;
    expect(String(recall.note)).toContain('No per-turn injection has been recorded');
  });
});
