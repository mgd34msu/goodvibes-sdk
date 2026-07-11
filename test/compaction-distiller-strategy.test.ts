/**
 * compaction-distiller-strategy.test.ts
 *
 * The fresh-context DISTILLER compaction strategy: an alternative to in-place
 * structured summarization, selected by config + gated by a graduation-tracked
 * feature flag, scored through the SAME quality scorer as the structured
 * strategy, and falling back to structured (recorded on the receipt) when the
 * distillation is unavailable or scores below the floor. Instruction-chain /
 * active-skill re-injection at the boundary applies to both strategies.
 */
import { describe, expect, test } from 'bun:test';
import {
  compactConversation,
  resolveCompactionStrategy,
  type ConversationCompactionHost,
} from '../packages/sdk/src/platform/core/conversation-compaction.js';
import {
  distillConversation,
  DistillerUnavailableError,
} from '../packages/sdk/src/platform/core/distiller-compaction.js';
import { REINJECT_INSTRUCTIONS_START } from '../packages/sdk/src/platform/core/compaction-sections.js';
import type { CompactionContext } from '../packages/sdk/src/platform/core/compaction-types.js';
import type { ProviderRegistry } from '../packages/sdk/src/platform/providers/registry.js';
import type { ProviderMessage } from '../packages/sdk/src/platform/providers/interface.js';

// A registry whose provider.chat returns a fixed brief — the distiller's fresh
// model call. `listModels` advertises the extraction model so resolution finds it.
function makeBriefRegistry(brief: string): ProviderRegistry {
  return {
    getForModel() {
      return {
        chat: async () => ({ content: brief }),
      };
    },
    listModels() {
      return [{ provider: 'test', id: 'model', registryKey: 'test/model' }];
    },
  } as unknown as ProviderRegistry;
}

// A registry whose provider.chat returns `first` on the first call (the
// distiller's single fresh call) and `rest` on every later call (the
// structured strategy's targeted extraction calls), so a distiller→structured
// fallback can be exercised with a realistic structured result.
function makeSequencedRegistry(first: string, rest: string): ProviderRegistry {
  let calls = 0;
  return {
    getForModel() {
      return {
        chat: async () => ({ content: (calls++ === 0 ? first : rest) }),
      };
    },
    listModels() {
      return [{ provider: 'test', id: 'model', registryKey: 'test/model' }];
    },
  } as unknown as ProviderRegistry;
}

// A registry that never yields a provider — distiller resolution fails, and
// structured's llmExtract also degrades to rule-based sections.
const stubRegistry = {
  getForModel() { throw new Error('no provider in test'); },
  listModels() { return []; },
} as unknown as ProviderRegistry;

function makeHost(messages: ProviderMessage[]) {
  let replaced: ProviderMessage[] | null = null;
  const host: ConversationCompactionHost = {
    getMessageCount: () => messages.length,
    getMessagesForLLM: () => messages,
    replaceMessagesForLLM: (m) => { replaced = m; },
    getSessionMemoryStore: () => null,
    getSessionLineageTracker: () => ({ addCompactionEntry: () => {} }),
  };
  return { host, getReplaced: () => replaced };
}

function bigConversation(n = 60): ProviderMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
    content: `message ${i} ` + 'lorem ipsum dolor sit amet consectetur '.repeat(80),
  }));
}

function distillerContext(
  messages: ProviderMessage[],
  extra: Partial<CompactionContext> = {},
): CompactionContext {
  return {
    messages,
    sessionMemories: [],
    agents: [],
    wrfcChains: [],
    activePlan: null,
    lineageEntries: [],
    compactionCount: 0,
    contextWindow: 100_000,
    trigger: 'auto',
    extractionModelId: 'test/model',
    strategy: 'distiller',
    ...extra,
  };
}

const GOOD_BRIEF =
  '## Task State\nImplementing the distiller.\n\n## Decisions Made\nUse one fresh call.\n\n'
  + '## Open Threads\nWire the flag.\n\n## Key References\n`distiller-compaction.ts` — the strategy.';

// ── strategy resolution (config + flag gate) ─────────────────────────────────

describe('resolveCompactionStrategy', () => {
  test('config distiller + flag ON → distiller', () => {
    expect(resolveCompactionStrategy('distiller', true)).toBe('distiller');
  });
  test('config distiller + flag OFF (dark) → structured (un-graduated)', () => {
    expect(resolveCompactionStrategy('distiller', false)).toBe('structured');
  });
  test('config structured → structured regardless of flag', () => {
    expect(resolveCompactionStrategy('structured', true)).toBe('structured');
  });
  test('unknown/absent config → structured', () => {
    expect(resolveCompactionStrategy(undefined, true)).toBe('structured');
  });
});

// ── distiller unit: fresh brief + instruction re-injection parity ────────────

describe('distillConversation', () => {
  test('produces a continuation brief and re-injects standing instructions at the boundary', async () => {
    const ctx = distillerContext(bigConversation(), { instructionChain: 'ALWAYS run the gates.' });
    const result = await distillConversation(ctx, makeBriefRegistry(GOOD_BRIEF));
    expect(result.messages).toHaveLength(1);
    const text = result.messages[0]!.content as string;
    expect(text).toContain('Continuation Brief (distilled)');
    expect(text).toContain('## Task State');
    // Parity with structured: the standing instruction chain is re-injected.
    expect(text).toContain(REINJECT_INSTRUCTIONS_START);
    expect(text).toContain('ALWAYS run the gates.');
    expect(result.event.instructionsReinjected).toBe(true);
    expect(result.tokensAfterEstimate).toBeLessThan(result.tokensBeforeEstimate);
  });

  test('throws DistillerUnavailableError when the extraction model is not in the registry', async () => {
    const ctx = distillerContext(bigConversation());
    await expect(distillConversation(ctx, stubRegistry)).rejects.toBeInstanceOf(DistillerUnavailableError);
  });

  test('throws DistillerUnavailableError on an empty brief', async () => {
    const ctx = distillerContext(bigConversation());
    await expect(distillConversation(ctx, makeBriefRegistry('   '))).rejects.toBeInstanceOf(DistillerUnavailableError);
  });
});

// ── end-to-end via compactConversation: applied + fallback receipts ──────────

describe('compactConversation with the distiller strategy', () => {
  test('good distillation applies, and the receipt NAMES the distiller strategy', async () => {
    const messages = bigConversation();
    const { host, getReplaced } = makeHost(messages);
    const ctx = distillerContext(messages);
    const receipt = await compactConversation(host, makeBriefRegistry(GOOD_BRIEF), 'test/model', 'auto', undefined, ctx);
    expect(receipt).toBeDefined();
    expect(receipt!.outcome).toBe('applied');
    expect(receipt!.strategy).toBe('distiller');
    expect(receipt!.requestedStrategy).toBeUndefined(); // no fallback
    expect(receipt!.strategyFallbackReason).toBeUndefined();
    expect(getReplaced()).not.toBeNull();
  });

  test('unavailable distiller falls back to structured; the receipt records the fallback', async () => {
    const messages = bigConversation();
    const { host, getReplaced } = makeHost(messages);
    const ctx = distillerContext(messages);
    // stubRegistry: distiller resolution fails → DistillerUnavailableError → structured.
    const receipt = await compactConversation(host, stubRegistry, 'test/model', 'auto', undefined, ctx);
    expect(receipt).toBeDefined();
    expect(receipt!.outcome).toBe('applied');
    expect(receipt!.strategy).toBe('structured');
    expect(receipt!.requestedStrategy).toBe('distiller');
    expect(receipt!.strategyFallbackReason).toContain('distiller unavailable');
    expect(getReplaced()).not.toBeNull();
  });

  test('a distillation with no token reduction falls back to structured (scored by the same scorer)', async () => {
    const messages = bigConversation();
    const { host } = makeHost(messages);
    const ctx = distillerContext(messages);
    // The distiller call (first) returns a brief far larger than the input →
    // no token reduction → score-gate fallback. Structured extraction (later
    // calls) returns a concise summary so structured itself compresses.
    const hugeBrief = '## Task State\n' + 'x '.repeat(200_000);
    const registry = makeSequencedRegistry(hugeBrief, 'kept the essentials: files changed, decisions made, next steps');
    const receipt = await compactConversation(host, registry, 'test/model', 'auto', undefined, ctx);
    expect(receipt).toBeDefined();
    expect(receipt!.strategy).toBe('structured');
    expect(receipt!.requestedStrategy).toBe('distiller');
    expect(receipt!.strategyFallbackReason).toContain('fell back to structured');
    // Same scorer gates it: either the quality floor or the no-reduction guard.
    expect(receipt!.strategyFallbackReason).toMatch(/below floor|no token reduction/);
  });
});
