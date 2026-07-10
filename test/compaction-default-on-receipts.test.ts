/**
 * compaction-default-on-receipts.test.ts
 *
 * Auto-compaction ships default-on, guarded by the quality scorer, and every
 * automatic path leaves a visible receipt — a compaction is never silent.
 * Pins: the default-on threshold, the scorer boundary, the guarded compactor's
 * applied vs kept-original (honest fallback) outcomes + receipt, the receipt
 * event shape, and the live context-usage readable for a context chip.
 */
import { describe, expect, test } from 'bun:test';
import { DEFAULT_CONFIG } from '../packages/sdk/src/platform/config/schema.js';
import { computeQualityScore, LOW_QUALITY_THRESHOLD } from '../packages/sdk/src/platform/runtime/compaction/quality-score.js';
import { compactConversation, type ConversationCompactionHost } from '../packages/sdk/src/platform/core/conversation-compaction.js';
import { CompactionQualityError } from '../packages/sdk/src/platform/core/compaction-types.js';
import { emitCompactionReceipt } from '../packages/sdk/src/platform/runtime/emitters/compaction.js';
import { createCoreReadModels } from '../packages/sdk/src/platform/runtime/ui-read-models-core.js';
import type { ProviderRegistry } from '../packages/sdk/src/platform/providers/registry.js';
import type { ProviderMessage } from '../packages/sdk/src/platform/providers/interface.js';
import type { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.js';
import type { RuntimeServices } from '../packages/sdk/src/platform/runtime/services.js';

/**
 * A minimal RuntimeEventBus whose emit() records (channel, payload) into the
 * supplied sink — the repo's standard bus-fixture bridge (a typed factory,
 * not an `any` suppression).
 */
function makeCapturingBus(sink: Array<{ channel: string; payload: unknown }>): RuntimeEventBus {
  return {
    emit(channel: string, env: { payload: unknown }) {
      sink.push({ channel, payload: env.payload });
    },
  } as unknown as RuntimeEventBus;
}

/**
 * A minimal RuntimeServices exposing only the runtimeStore/runtimeBus surface
 * that createCoreReadModels reads. `state` is the runtime state getState()
 * returns; the read model derives the session snapshot from it.
 */
function makeReadModelServices(state: unknown): RuntimeServices {
  return {
    runtimeStore: { getState: () => state, subscribe: () => () => {} },
    runtimeBus: { on: () => () => {} },
  } as unknown as RuntimeServices;
}

// Registry that never yields a provider — llmExtract catches and returns null,
// so compaction assembles only deterministic rule-based sections (no live LLM).
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

// ── default-on ───────────────────────────────────────────────────────────────

describe('auto-compaction default-on', () => {
  test('behavior.autoCompactThreshold defaults to an enabling value (>0)', () => {
    const threshold = DEFAULT_CONFIG.behavior.autoCompactThreshold;
    expect(threshold).toBeGreaterThan(0); // >0 is how "enabled" is expressed
    expect(threshold).toBe(80);
  });
});

// ── quality scorer guard boundary ────────────────────────────────────────────

describe('compaction quality scorer boundary', () => {
  test('flags a no-compression result as low quality, passes a real compression', () => {
    const msgs = [{ role: 'user' as const, content: 'x'.repeat(4000) }];
    const noCompression = computeQualityScore(
      { sessionId: '', messages: msgs, tokensBefore: 1000, contextWindow: 0, strategy: 'autocompact' },
      { messages: [{ role: 'user', content: 'y' }], tokensAfter: 1000, summary: 'y', strategy: 'autocompact', durationMs: 0, warnings: [] },
    );
    expect(noCompression.isLowQuality).toBe(true);
    expect(noCompression.score).toBeLessThan(LOW_QUALITY_THRESHOLD);

    const good = computeQualityScore(
      { sessionId: '', messages: msgs, tokensBefore: 10_000, contextWindow: 0, strategy: 'autocompact' },
      { messages: [{ role: 'user', content: 'context window compaction summary: kept the essentials' }], tokensAfter: 2000, summary: 's', strategy: 'autocompact', durationMs: 0, warnings: [] },
    );
    expect(good.isLowQuality).toBe(false);
  });
});

// ── guarded compactor: applied vs kept-original ──────────────────────────────

describe('guarded compactConversation', () => {
  test('good compaction returns an applied receipt and replaces the messages', async () => {
    const big: ProviderMessage[] = Array.from({ length: 60 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: `message ${i} ` + 'lorem ipsum dolor sit amet '.repeat(80),
    }));
    const { host, getReplaced } = makeHost(big);
    const receipt = await compactConversation(host, stubRegistry, 'test/model', 'auto');
    expect(receipt).toBeDefined();
    expect(receipt!.outcome).toBe('applied');
    expect(receipt!.trigger).toBe('auto');
    expect(receipt!.tokensAfter).toBeLessThan(receipt!.tokensBefore);
    expect(receipt!.qualityGrade).toBeString();
    expect(getReplaced()).not.toBeNull(); // messages were swapped in
  });

  test('scorer-failure fallback: a no-benefit compaction is rejected and the conversation is KEPT', async () => {
    // A tiny conversation cannot be compressed (handoff scaffold >= input), so
    // the quality guard rejects it: CompactionQualityError with a kept-original
    // receipt, and replaceMessagesForLLM is never called.
    const tiny: ProviderMessage[] = [{ role: 'user', content: 'hi' }];
    const { host, getReplaced } = makeHost(tiny);
    let thrown: unknown;
    try {
      await compactConversation(host, stubRegistry, 'test/model', 'auto');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CompactionQualityError);
    const receipt = (thrown as CompactionQualityError).receipt;
    expect(receipt.outcome).toBe('kept-original');
    expect(receipt.lowQuality).toBe(true);
    expect(receipt.detail).toContain('retained');
    expect(getReplaced()).toBeNull(); // conversation was NOT replaced
  });
});

// ── receipt event shape ──────────────────────────────────────────────────────

describe('compaction receipt event', () => {
  test('emitCompactionReceipt emits a COMPACTION_RECEIPT envelope on the compaction channel', () => {
    const emitted: Array<{ channel: string; payload: unknown }> = [];
    const bus = makeCapturingBus(emitted);
    emitCompactionReceipt(
      bus,
      { sessionId: 's', traceId: 't', source: 'orchestrator' },
      {
        sessionId: 's', trigger: 'auto', strategy: 'structured', tokensBefore: 9000, tokensAfter: 2000,
        messagesBefore: 40, messagesAfter: 1, qualityScore: 0.82, qualityGrade: 'B', lowQuality: false,
        instructionsReinjected: true, validationPassed: true, outcome: 'applied',
      },
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.channel).toBe('compaction');
    expect(emitted[0]!.payload).toMatchObject({ type: 'COMPACTION_RECEIPT', outcome: 'applied', qualityGrade: 'B' });
  });
});

// ── context-usage readable (context chip) ────────────────────────────────────

describe('context-usage readable', () => {
  test('session snapshot exposes contextUsagePct and contextRemainingTokens', () => {
    const state = {
      session: {},
      conversation: { totalTurns: 3, messageCount: 12, estimatedContextTokens: 40_000, turnState: 'idle', stream: { partialToolPreview: undefined } },
      model: { tokenLimits: { contextWindow: 100_000 } },
      permissions: { awaitingDecision: false, denialCount: 0 },
    };
    const snap = createCoreReadModels(makeReadModelServices(state)).session.getSnapshot();
    expect(snap.contextUsagePct).toBe(40);
    expect(snap.contextRemainingTokens).toBe(60_000);
    expect(snap.estimatedContextTokens).toBe(40_000);
  });

  test('usage readable is safe when the context window is unknown (0)', () => {
    const state = {
      session: {},
      conversation: { totalTurns: 0, messageCount: 0, estimatedContextTokens: 1234, turnState: 'idle', stream: {} },
      model: { tokenLimits: { contextWindow: 0 } },
      permissions: { awaitingDecision: false, denialCount: 0 },
    };
    const snap = createCoreReadModels(makeReadModelServices(state)).session.getSnapshot();
    expect(snap.contextUsagePct).toBe(0);
    expect(snap.contextRemainingTokens).toBe(0);
  });
});
