/**
 * Wave-5 Stage B — turn-knowledge-injection.ts code-injection unit suite.
 *
 * buildPerTurnKnowledgeInjection now optionally merges repo code-index hits into the
 * SAME token budget / relevance floor as memory records, tagging each injected line with
 * its source. These are pure-function tests: a fake TurnCodeIndexSource supplies hits +
 * stats, so every honesty gate (empty / provider-mismatch / no-semantic-provider), the
 * similarity→floor projection, budget competition, dedupe, and the flag gate are exercised
 * directly.
 */
import { describe, expect, test } from 'bun:test';
import {
  buildPerTurnKnowledgeInjection,
  CODE_SIMILARITY_TO_SCORE_SCALE,
  DEFAULT_TURN_KNOWLEDGE_RELEVANCE_FLOOR,
  type TurnCodeIndexSource,
} from '../packages/sdk/src/platform/agents/turn-knowledge-injection.js';
import type { MemoryRecord } from '../packages/sdk/src/platform/state/memory-store.js';
import type { CodeContextResult, CodeIndexStats } from '../packages/sdk/src/platform/state/index.js';
import type { ProviderMessage } from '../packages/sdk/src/platform/providers/interface.js';

function makeRecord(overrides: Partial<MemoryRecord> & { id: string }): MemoryRecord {
  return {
    scope: 'project', cls: 'fact', summary: 'a record', detail: undefined, tags: [],
    provenance: [], reviewState: 'fresh', confidence: 60, createdAt: 1, updatedAt: 1, ...overrides,
  };
}
function fakeMemory(records: MemoryRecord[]) {
  return { getAll: () => records };
}

function makeCodeHit(path: string, similarity: number, opts: { label?: 'semantic' | 'lexical'; symbol?: string; startLine?: number; endLine?: number } = {}): CodeContextResult {
  const startLine = opts.startLine ?? 10;
  const endLine = opts.endLine ?? 30;
  return {
    chunk: {
      chunkId: `${path}#${startLine}`,
      path,
      lang: 'ts',
      symbol: opts.symbol ?? 'doThing',
      kind: 'function',
      startLine,
      endLine,
      contentHash: 'h',
      mtimeMs: 1,
      fileHash: 'fh',
    },
    distance: 2 * (1 - similarity),
    similarity,
    label: opts.label ?? 'semantic',
  };
}

const HEALTHY_STATS: Pick<CodeIndexStats, 'available' | 'indexedChunks' | 'embeddingProviderMismatch' | 'semanticRetrievalAvailable'> = {
  available: true,
  indexedChunks: 42,
  embeddingProviderMismatch: undefined,
  semanticRetrievalAvailable: true,
};

function fakeCodeIndex(hits: CodeContextResult[], statsOverride: Partial<typeof HEALTHY_STATS> = {}): TurnCodeIndexSource {
  return {
    search: () => hits,
    stats: () => ({ ...HEALTHY_STATS, ...statsOverride }),
  };
}

const TAIL: ProviderMessage[] = [{ role: 'user', content: 'fix the auth module' }];

function baseInput(over: Partial<Parameters<typeof buildPerTurnKnowledgeInjection>[0]> = {}) {
  return {
    memoryRegistry: fakeMemory([]),
    task: 'fix the auth module',
    conversationTail: TAIL,
    budgetTokens: 4000,
    relevanceFloor: DEFAULT_TURN_KNOWLEDGE_RELEVANCE_FLOOR,
    alreadyInjectedIds: [],
    turn: 1,
    ...over,
  };
}

describe('code injection — honest source labeling within the shared budget', () => {
  test('a code hit above the floor is injected, labeled source=code-index, ingestMode=its match label', () => {
    // similarity 0.8 → score 160, above the default floor 95
    const code = fakeCodeIndex([makeCodeHit('src/auth.ts', 0.8, { label: 'semantic', symbol: 'verify' })]);
    const result = buildPerTurnKnowledgeInjection(baseInput({ codeIndex: code, codeInjectionEnabled: true }));

    expect(result.block).not.toBeNull();
    expect(result.record.injectedIds).toEqual(['src/auth.ts:10-30']);
    expect(result.record.injectedSources).toEqual(['code-index']);
    expect(result.record.ingestModes).toEqual(['semantic']);
    expect(result.record.codeCandidatesConsidered).toBe(1);
    expect(result.record.codeInjectionSkipped).toBeUndefined();
    expect(result.block).toContain('## Injected Code Context');
    expect(result.block).toContain('src/auth.ts:10-30');
  });

  test('memory and code compete in one merged, best-first list with parallel source labels', () => {
    const memory = fakeMemory([makeRecord({ id: 'mem_auth', summary: 'auth module uses JWT rotation', tags: ['auth'], reviewState: 'reviewed', confidence: 90 })]);
    // code similarity 0.6 → score 120
    const code = fakeCodeIndex([makeCodeHit('src/auth.ts', 0.6)]);
    const result = buildPerTurnKnowledgeInjection(baseInput({ memoryRegistry: memory, codeIndex: code, codeInjectionEnabled: true }));

    expect(result.record.injectedIds).toContain('mem_auth');
    expect(result.record.injectedIds).toContain('src/auth.ts:10-30');
    // parallel arrays stay aligned
    const idx = result.record.injectedIds.indexOf('src/auth.ts:10-30');
    expect(result.record.injectedSources[idx]).toBe('code-index');
    const memIdx = result.record.injectedIds.indexOf('mem_auth');
    expect(result.record.injectedSources[memIdx]).toBe('memory');
    expect(result.block).toContain('## Injected Project Knowledge');
    expect(result.block).toContain('## Injected Code Context');
  });
});

describe('code injection — similarity → floor projection (scale 200)', () => {
  test('boundary: score exactly at the floor is admitted, just under is rejected', () => {
    const floor = 100;
    const atFloor = 0.5; // 0.5 * 200 = 100 === floor
    const belowFloor = 0.49; // 98 < 100
    const inRange = buildPerTurnKnowledgeInjection(baseInput({
      codeIndex: fakeCodeIndex([makeCodeHit('src/at.ts', atFloor)]),
      codeInjectionEnabled: true,
      relevanceFloor: floor,
    }));
    expect(inRange.record.injectedIds).toEqual(['src/at.ts:10-30']);

    const under = buildPerTurnKnowledgeInjection(baseInput({
      codeIndex: fakeCodeIndex([makeCodeHit('src/under.ts', belowFloor)]),
      codeInjectionEnabled: true,
      relevanceFloor: floor,
    }));
    expect(under.block).toBeNull();
    expect(under.record.codeCandidatesConsidered).toBe(1);
    expect(under.record.codeInjectionSkipped).toBe('no code chunks cleared the relevance floor');
  });

  test('an unrelated (orthogonal) chunk at similarity ~0.29 never clears the default floor', () => {
    const orthogonal = fakeCodeIndex([makeCodeHit('src/unrelated.ts', 0.29)]); // 0.29*200 = 58 < 95
    const result = buildPerTurnKnowledgeInjection(baseInput({ codeIndex: orthogonal, codeInjectionEnabled: true }));
    expect(result.block).toBeNull();
    expect(CODE_SIMILARITY_TO_SCORE_SCALE).toBe(200);
  });
});

describe('code injection — never injects from an unhealthy index (stats gates)', () => {
  test('empty index (indexedChunks 0) => skipped "code index empty", no search, no injection', () => {
    let searched = false;
    const code: TurnCodeIndexSource = {
      search: () => { searched = true; return [makeCodeHit('src/x.ts', 0.9)]; },
      stats: () => ({ ...HEALTHY_STATS, indexedChunks: 0 }),
    };
    const result = buildPerTurnKnowledgeInjection(baseInput({ codeIndex: code, codeInjectionEnabled: true }));
    expect(result.block).toBeNull();
    expect(searched).toBe(false);
    expect(result.record.codeInjectionSkipped).toBe('code index empty');
    expect(result.record.codeCandidatesConsidered).toBe(0);
  });

  test('provider-space mismatch => skipped with the store’s own message, never injects', () => {
    const code = fakeCodeIndex([makeCodeHit('src/x.ts', 0.9)], { embeddingProviderMismatch: 'embeddings built with X, current provider Y — rebuild to re-embed' });
    const result = buildPerTurnKnowledgeInjection(baseInput({ codeIndex: code, codeInjectionEnabled: true }));
    expect(result.block).toBeNull();
    expect(result.record.codeInjectionSkipped).toContain('rebuild to re-embed');
  });

  test('no semantic provider (hashed-only) => skipped "no semantic embedding provider"', () => {
    const code = fakeCodeIndex([makeCodeHit('src/x.ts', 0.9)], { semanticRetrievalAvailable: false });
    const result = buildPerTurnKnowledgeInjection(baseInput({ codeIndex: code, codeInjectionEnabled: true }));
    expect(result.block).toBeNull();
    expect(result.record.codeInjectionSkipped).toBe('no semantic embedding provider');
  });

  test('unavailable store => skipped "code index unavailable"', () => {
    const code = fakeCodeIndex([makeCodeHit('src/x.ts', 0.9)], { available: false });
    const result = buildPerTurnKnowledgeInjection(baseInput({ codeIndex: code, codeInjectionEnabled: true }));
    expect(result.block).toBeNull();
    expect(result.record.codeInjectionSkipped).toBe('code index unavailable');
  });
});

describe('code injection — flag/gate off is a hard no-op', () => {
  test('codeInjectionEnabled false: index never queried, no code fields set', () => {
    let searched = false;
    const code: TurnCodeIndexSource = {
      search: () => { searched = true; return [makeCodeHit('src/x.ts', 0.9)]; },
      stats: () => HEALTHY_STATS,
    };
    const result = buildPerTurnKnowledgeInjection(baseInput({ codeIndex: code, codeInjectionEnabled: false }));
    expect(searched).toBe(false);
    expect(result.record.codeCandidatesConsidered).toBe(0);
    expect(result.record.codeInjectionSkipped).toBeUndefined();
  });

  test('no code source at all: memory-only record shape unchanged (codeCandidatesConsidered 0)', () => {
    const memory = fakeMemory([makeRecord({ id: 'mem_1', summary: 'auth module JWT rotation', tags: ['auth'], reviewState: 'reviewed', confidence: 90 })]);
    const result = buildPerTurnKnowledgeInjection(baseInput({ memoryRegistry: memory }));
    expect(result.record.injectedIds).toEqual(['mem_1']);
    expect(result.record.injectedSources).toEqual(['memory']);
    expect(result.record.codeCandidatesConsidered).toBe(0);
    expect(result.block).not.toContain('## Injected Code Context');
  });
});

describe('code injection — budget competition and dedupe', () => {
  test('a lower-scored code hit is dropped for budget before a higher-scored memory record', () => {
    const memory = fakeMemory([makeRecord({ id: 'mem_hi', summary: 'auth module JWT rotation reviewed and trusted', tags: ['auth'], reviewState: 'reviewed', confidence: 95 })]);
    const code = fakeCodeIndex([makeCodeHit('src/auth.ts', 0.5)]); // score 100, lower than the memory record
    // First measure the full cost, then set budget one token short.
    const full = buildPerTurnKnowledgeInjection(baseInput({ memoryRegistry: memory, codeIndex: code, codeInjectionEnabled: true, budgetTokens: 100_000 }));
    expect(full.record.injectedIds).toContain('src/auth.ts:10-30');

    const tight = buildPerTurnKnowledgeInjection(baseInput({ memoryRegistry: memory, codeIndex: code, codeInjectionEnabled: true, budgetTokens: full.record.tokenCost - 1 }));
    expect(tight.record.injectedIds).toEqual(['mem_hi']);
    expect(tight.record.droppedForBudget).toEqual(['src/auth.ts:10-30']);
    expect(tight.record.tokenCost).toBeLessThanOrEqual(tight.record.budgetTokens);
  });

  test('a code id already in alreadyInjectedIds is not re-listed (retry-fresh dedupe)', () => {
    const code = fakeCodeIndex([makeCodeHit('src/auth.ts', 0.8, { startLine: 10, endLine: 30 }), makeCodeHit('src/other.ts', 0.7, { startLine: 5, endLine: 9 })]);
    const result = buildPerTurnKnowledgeInjection(baseInput({ codeIndex: code, codeInjectionEnabled: true, alreadyInjectedIds: ['src/auth.ts:10-30'] }));
    expect(result.record.injectedIds).toEqual(['src/other.ts:5-9']);
    expect(result.record.codeCandidatesConsidered).toBe(1); // the deduped one is not "considered"
  });

  test('compose-fresh: two calls recompute independently against their own alreadyInjected sets', () => {
    const code = fakeCodeIndex([makeCodeHit('src/auth.ts', 0.8)]);
    const first = buildPerTurnKnowledgeInjection(baseInput({ codeIndex: code, codeInjectionEnabled: true }));
    expect(first.record.injectedIds).toEqual(['src/auth.ts:10-30']);
    const second = buildPerTurnKnowledgeInjection(baseInput({ codeIndex: code, codeInjectionEnabled: true, alreadyInjectedIds: first.record.injectedIds }));
    expect(second.record.injectedIds).toEqual([]); // already surfaced, none fresh
    expect(second.block).toBeNull();
  });
});
