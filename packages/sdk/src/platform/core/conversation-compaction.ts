import type { ProviderMessage } from '../providers/interface.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { logger } from '../utils/logger.js';
import { compactMessages } from './context-compaction.js';
import type { CompactionContext } from './context-compaction.js';
import type { CompactionReceipt } from './compaction-types.js';
import { CompactionQualityError } from './compaction-types.js';
import { computeQualityScore, LOW_QUALITY_THRESHOLD } from '../runtime/compaction/quality-score.js';
import type { SessionMemoryStore } from './session-memory.js';
import type { SessionLineageTracker } from './session-lineage.js';
import { summarizeError } from '../utils/error-display.js';

export interface ConversationCompactionHost {
  getMessageCount(): number;
  getMessagesForLLM(): ProviderMessage[];
  replaceMessagesForLLM(newMessages: ProviderMessage[]): void;
  getSessionMemoryStore(): Pick<SessionMemoryStore, 'list'> | null;
  getSessionLineageTracker(): Pick<SessionLineageTracker, 'addCompactionEntry'>;
}

export async function compactConversation(
  host: ConversationCompactionHost,
  registry: ProviderRegistry,
  modelId: string,
  trigger: 'auto' | 'manual' = 'manual',
  provider?: string,
  context?: CompactionContext,
): Promise<CompactionReceipt | undefined> {
  if (host.getMessageCount() === 0) return undefined;

  try {
    const llmMessages = host.getMessagesForLLM();
    const compactionContext: CompactionContext = context ?? {
      messages: llmMessages,
      trigger,
      extractionModelId: modelId,
      extractionProvider: provider,
      sessionMemories: [],
      agents: [],
      wrfcChains: [],
      activePlan: null,
      lineageEntries: [],
      compactionCount: 0,
      contextWindow: 0,
    };
    const result = await compactMessages(compactionContext, registry);

    // Quality guard: score the compaction before committing it. A low-quality
    // result (e.g. no compression, or a destroyed handoff) is rejected — the
    // full conversation is kept and the failure is surfaced honestly rather
    // than silently swapping in a bad summary.
    const quality = computeQualityScore(
      {
        sessionId: '',
        messages: llmMessages,
        tokensBefore: result.tokensBeforeEstimate,
        contextWindow: compactionContext.contextWindow,
        strategy: 'autocompact',
      },
      {
        messages: result.messages,
        tokensAfter: result.tokensAfterEstimate,
        summary: result.summary,
        strategy: 'autocompact',
        durationMs: 0,
        warnings: result.validationWarnings,
      },
    );

    const receiptBase = {
      trigger,
      strategy: 'structured',
      tokensBefore: result.tokensBeforeEstimate,
      tokensAfter: result.tokensAfterEstimate,
      messagesBefore: result.event.messagesBeforeCompaction,
      messagesAfter: result.event.messagesAfterCompaction,
      qualityScore: quality.score,
      qualityGrade: quality.grade,
      lowQuality: quality.isLowQuality,
      instructionsReinjected: result.event.instructionsReinjected ?? false,
      validationPassed: result.validationWarnings.length === 0,
      sectionsIncluded: result.sections.map((s) => s.id),
    };

    // Fail honestly when the scorer flags low quality OR the compaction bought
    // nothing (output no smaller than input). The latter is a real failed
    // compaction the composite score can miss — it rewards the compression axis
    // even when a broken/empty extraction technically "shrank" tokens — so a
    // no-net-reduction result is treated as a failure and the conversation is
    // kept rather than swapping in a summary that did not help.
    const noReduction = result.tokensAfterEstimate >= result.tokensBeforeEstimate;
    if (quality.isLowQuality || noReduction) {
      const detail = quality.isLowQuality
        ? `Compaction quality ${quality.score.toFixed(2)} (${quality.grade}) below threshold ${LOW_QUALITY_THRESHOLD}; conversation retained. ${quality.description}`
        : `Compaction produced no token reduction (${result.tokensBeforeEstimate} -> ${result.tokensAfterEstimate}); conversation retained.`;
      logger.warn('Compaction rejected by quality guard — conversation kept', { detail, trigger });
      throw new CompactionQualityError({ ...receiptBase, lowQuality: true, outcome: 'kept-original', detail });
    }

    host.replaceMessagesForLLM(result.messages);

    const memoriesCount = host.getSessionMemoryStore()?.list().length ?? 0;
    const memoriesPart = memoriesCount > 0 ? `, ${memoriesCount} pinned memories` : '';
    const saved = result.tokensBeforeEstimate - result.tokensAfterEstimate;
    const savedKTokens = Math.round(saved / 1000);
    host.getSessionLineageTracker().addCompactionEntry(
      `${trigger} compact, saved ~${savedKTokens}K tokens${memoriesPart}.`,
    );

    logger.info('Conversation compacted', {
      trigger,
      messagesBeforeCompaction: result.event.messagesBeforeCompaction,
      messagesAfterCompaction: result.event.messagesAfterCompaction,
      tokensBeforeEstimate: result.tokensBeforeEstimate,
      tokensAfterEstimate: result.tokensAfterEstimate,
      tokensSaved: saved,
      qualityScore: quality.score,
      qualityGrade: quality.grade,
    });

    return { ...receiptBase, outcome: 'applied' };
  } catch (err: unknown) {
    if (err instanceof CompactionQualityError) throw err;
    const msg = summarizeError(err);
    logger.error('Compact failed', { error: msg });
    throw err;
  }
}
