/**
 * Compaction re-injects the standing instruction chain and active skill
 * frontmatter at the compaction boundary, so compaction never silently strips
 * standing instructions. Pins:
 *   - the instruction chain is present after compaction
 *   - active skill frontmatter is present after compaction
 *   - the block appears exactly once when compaction runs twice (no stacking)
 *   - the compaction receipt records that instructions were re-injected
 */
import { describe, expect, test } from 'bun:test';
import { compactMessages } from '../packages/sdk/src/platform/core/context-compaction.js';
import type { CompactionContext } from '../packages/sdk/src/platform/core/compaction-types.js';
import type { ProviderRegistry } from '../packages/sdk/src/platform/providers/registry.js';

// A registry that never yields a usable provider — llmExtract catches the
// failure and returns null, so compaction assembles only deterministic
// rule-based sections. That keeps these tests free of live LLM calls.
const stubRegistry = {
  getForModel() {
    throw new Error('no provider available in test');
  },
  listModels() {
    return [];
  },
} as unknown as ProviderRegistry;

function baseCtx(overrides: Partial<CompactionContext>): CompactionContext {
  return {
    messages: [{ role: 'user', content: 'please do the original task' }],
    sessionMemories: [],
    agents: [],
    wrfcChains: [],
    activePlan: null,
    lineageEntries: [],
    compactionCount: 0,
    contextWindow: 100_000,
    trigger: 'manual',
    extractionModelId: 'test/model',
    ...overrides,
  };
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('compaction — instruction / skill re-injection', () => {
  test('re-includes the system instruction chain after compaction', async () => {
    const CHAIN = 'ZZ_STANDING_INSTRUCTION_CHAIN_ZZ never skip the checks';
    const result = await compactMessages(baseCtx({ instructionChain: CHAIN }), stubRegistry);

    expect(result.summary).toContain(CHAIN);
    expect(result.messages[0]?.content).toContain(CHAIN);
    expect(result.sections.some((s) => s.id === 'reinjected-instructions')).toBe(true);
    expect(result.event.instructionsReinjected).toBe(true);
  });

  test('re-includes active skill frontmatter after compaction', async () => {
    const SKILL = 'name: verify\ntriggers: [verify, check]';
    const result = await compactMessages(
      baseCtx({ instructionChain: 'chain-x', activeSkillFrontmatter: SKILL }),
      stubRegistry,
    );

    expect(result.summary).toContain('name: verify');
    expect(result.summary).toContain('triggers: [verify, check]');
    expect(result.summary).toContain('### Active Skill');
  });

  test('does not duplicate the block when compaction runs twice', async () => {
    const CHAIN = 'ZZ_UNIQUE_STANDING_RULE_ZZ';

    const first = await compactMessages(baseCtx({ instructionChain: CHAIN }), stubRegistry);
    expect(occurrences(first.summary, CHAIN)).toBe(1);

    // Simulate the conversation now being the single compacted message from the
    // first pass (as ConversationManager.replaceMessagesForLLM would install it)
    // and run compaction again with the same standing chain.
    const second = await compactMessages(
      baseCtx({ messages: first.messages, instructionChain: CHAIN, compactionCount: 1 }),
      stubRegistry,
    );

    // The chain must appear exactly once — the fresh re-injected copy — with the
    // prior copy stripped out of the carried-over message history.
    expect(occurrences(second.summary, CHAIN)).toBe(1);
    expect(second.event.instructionsReinjected).toBe(true);
  });

  test('does not re-inject when neither chain nor skill is present', async () => {
    const result = await compactMessages(baseCtx({}), stubRegistry);
    expect(result.sections.some((s) => s.id === 'reinjected-instructions')).toBe(false);
    expect(result.event.instructionsReinjected).toBe(false);
  });
});

// The handoff-header constant is the transcript renderers' detection contract
// for folding compaction-continuation messages — it must stay byte-identical
// to what buildHandoffHeader() actually emits.
import { buildHandoffHeader, COMPACTION_HANDOFF_HEADER } from '../packages/sdk/src/platform/core/compaction-sections.js';

describe('compaction handoff header constant', () => {
  test('COMPACTION_HANDOFF_HEADER matches buildHandoffHeader output', () => {
    const section = buildHandoffHeader();
    expect(section.content).toBe(COMPACTION_HANDOFF_HEADER);
    expect(section.id).toBe('handoff-header');
  });
});
