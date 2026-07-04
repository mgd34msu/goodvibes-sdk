/**
 * context-compaction.ts
 *
 * Context compaction engine for the GoodVibes platform runtime.
 *
 * Architecture:
 *   - Deterministic structure: fixed sections assembled in order
 *   - Targeted LLM calls for: substance filter, tool relevance, resolved problems,
 *     older agent summary
 *   - Rule-based sections: handoff, memories, current task, running agents,
 *     agent activity table, plan progress, session lineage
 *   - Post-compaction validation: sanity-checks required sections
 *   - Context-window-aware thresholds
 *
 * Public API:
 *   estimateConversationTokens(messages)   — rough token count for a message array
 *   estimateTokens(text)                   — rough token count for a string
 *   shouldAutoCompact(opts)                — check if configured usage threshold or safety buffer is exceeded
 *   compactSmallWindow(messages, keepRecent) — simplified compaction for small context windows
 *   compactMessages(ctx, registry)         — structured compaction entry point
 *   checkAndCompact(autoOpts, ctx)         — check and compact if threshold exceeded
 *   getCompactionEvents()                  — return compaction event log
 *   getLastCompactionEvent()               — return most recent compaction event
 */

import type { ProviderMessage, ContentPart, LLMProvider } from '../providers/interface.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { logger } from '../utils/logger.js';
import type {
  CompactionSection,
  CompactionContext,
  CompactionResult,
  CompactionEvent,
  CompactionConfig,
} from './compaction-types.js';
import { DEFAULT_COMPACTION_CONFIG, IMAGE_TOKEN_ESTIMATE, estimateTokens } from './compaction-types.js';
import { summarizeError } from '../utils/error-display.js';
import {
  buildHandoffHeader,
  buildSessionMemories,
  buildCurrentTask,
  buildRunningAgents,
  buildCompletedAgentWork,
  gatherRecentConversation,
  buildConversationFilterPrompt,
  buildToolResultsPrompt,
  buildAgentActivityTable,
  buildOlderAgentSummaryPrompt,
  buildResolvedProblemsPrompt,
  buildPlanProgress,
  buildSessionLineage,
  extractText,
} from './compaction-sections.js';
import { isActiveAgent } from '../tools/agent/predicates.js';

export type { CompactionEvent, CompactionResult, CompactionContext } from './compaction-types.js';

export interface AutoCompactOptions {
  /** Current input token count from last LLM response. */
  currentTokens: number;
  /** Maximum context window for the current model. */
  contextWindow: number;
  /** Whether auto-compact is already in progress (prevent re-entry). */
  isCompacting: boolean;
  /**
   * Usage percentage that triggers compaction. Defaults to 80. Set to 0 to disable
   * the percentage trigger; the safety buffer still applies as an independent backstop.
   */
  thresholdPercent?: number | undefined;
  /** Remaining-token safety buffer that also triggers compaction. Defaults to 15000. */
  minRemainingTokens?: number | undefined;
}

export interface AutoCompactDecision {
  readonly shouldCompact: boolean;
  readonly reason: 'threshold' | 'safety-buffer' | null;
  readonly currentTokens: number;
  readonly contextWindow: number;
  readonly usagePct: number;
  readonly thresholdPercent: number;
  readonly thresholdTokens: number;
  readonly remainingTokens: number;
  readonly safetyBufferTokens: number;
}

// ---------------------------------------------------------------------------
// Compaction trigger constants
// ---------------------------------------------------------------------------

/**
 * Default remaining-token safety buffer for auto-compaction. Acts as a backstop:
 * compaction triggers when the remaining context drops below this buffer. 15k gives
 * room for the ~6.5k compaction output + LLM extraction calls on large windows.
 * The effective buffer is capped at SAFETY_BUFFER_MAX_WINDOW_FRACTION of the context
 * window (see getAutoCompactDecision) so it scales down on small/medium windows instead
 * of forcing near-constant compaction, while remaining an independent backstop on large windows.
 */
export const COMPACTION_BUFFER_TOKENS = 15_000;
/**
 * The remaining-token safety buffer is capped at this fraction of the context
 * window. A fixed token buffer (COMPACTION_BUFFER_TOKENS) must not reserve an
 * outsized share of small/medium windows, so the effective buffer is the lesser
 * of the configured buffer and this fraction of the window. On a 128k window the
 * full buffer applies (128k * 0.125 = 16k >= 15k); on smaller windows it scales
 * down so the backstop fires near the window edge rather than on near-empty
 * conversations, while still firing independently of high percentage thresholds.
 */
export const SAFETY_BUFFER_MAX_WINDOW_FRACTION = 0.125;
export const DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT = 80;

/**
 * Context windows smaller than this use simplified compaction (summarize last N messages)
 * instead of the full structured output, since there isn't enough room for extraction calls.
 */
export const SMALL_WINDOW_THRESHOLD = 12_000;

// ---------------------------------------------------------------------------
// Compaction event log (in-memory, session-scoped)
// ---------------------------------------------------------------------------

const compactionEvents: CompactionEvent[] = [];

export function getCompactionEvents(): readonly CompactionEvent[] {
  return compactionEvents;
}

export function getLastCompactionEvent(): CompactionEvent | null {
  return compactionEvents.length > 0
    ? compactionEvents[compactionEvents.length - 1]!
    : null;
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/** Rough token estimate: 4 chars ≈ 1 token. Used for threshold checks. */
export function estimateConversationTokens(messages: ProviderMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      total += estimateTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content as ContentPart[]) {
        if (part.type === 'text') {
          total += estimateTokens(part.text);
        } else if (part.type === 'image') {
          total += IMAGE_TOKEN_ESTIMATE;
        }
      }
    }
  }
  return total;
}

export { estimateTokens } from './compaction-types.js';

// ---------------------------------------------------------------------------
// Should compact?
// ---------------------------------------------------------------------------

function normalizeThresholdPercent(value: number | undefined): number {
  if (value === undefined) return DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT;
  if (!Number.isFinite(value)) return DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT;
  return Math.max(0, Math.min(100, value));
}

export function getAutoCompactDecision(opts: AutoCompactOptions): AutoCompactDecision {
  const currentTokens = Math.max(0, opts.currentTokens);
  const contextWindow = Math.max(0, opts.contextWindow);
  const thresholdPercent = normalizeThresholdPercent(opts.thresholdPercent);
  const safetyBufferTokens = Math.max(0, opts.minRemainingTokens ?? COMPACTION_BUFFER_TOKENS);
  const usagePct = contextWindow > 0 ? (currentTokens / contextWindow) * 100 : 0;
  const thresholdTokens = contextWindow > 0 ? Math.floor((contextWindow * thresholdPercent) / 100) : 0;
  const remainingTokens = Math.max(0, contextWindow - currentTokens);
  // Scale the flat safety buffer to the window so a fixed token buffer never
  // reserves an outsized share of small/medium windows. A flat 15k buffer would
  // trip a 20k window at ~25% usage, and would fire on every request — even an
  // empty conversation — for any window at or below the buffer size. Capping the
  // buffer at a fraction of the window keeps the full configured buffer on large
  // windows (e.g. 128k) while scaling it down on small ones, WITHOUT collapsing
  // the backstop for high (or disabled) percentage thresholds, where the buffer
  // is the only thing standing between usage and the window edge. (Clamping to
  // the threshold headroom instead would make the buffer fire no earlier than the
  // threshold itself, nullifying it as an independent backstop.)
  const effectiveBuffer = Math.min(
    safetyBufferTokens,
    Math.floor(contextWindow * SAFETY_BUFFER_MAX_WINDOW_FRACTION),
  );
  let reason: AutoCompactDecision['reason'] = null;

  if (!opts.isCompacting && contextWindow > 0) {
    if (thresholdPercent > 0 && currentTokens >= thresholdTokens) {
      reason = 'threshold';
    } else if (currentTokens > 0 && effectiveBuffer > 0 && remainingTokens <= effectiveBuffer) {
      reason = 'safety-buffer';
    }
  }

  return {
    shouldCompact: reason !== null,
    reason,
    currentTokens,
    contextWindow,
    usagePct,
    thresholdPercent,
    thresholdTokens,
    remainingTokens,
    safetyBufferTokens,
  };
}

/**
 * Returns true when context usage reaches the configured percentage threshold
 * or the remaining-token safety buffer is exhausted, unless compaction is
 * already active.
 */
export function shouldAutoCompact(opts: AutoCompactOptions): boolean {
  return getAutoCompactDecision(opts).shouldCompact;
}

// ---------------------------------------------------------------------------
// Small-window simplified compaction
// ---------------------------------------------------------------------------

/**
 * Simplified compaction for context windows smaller than SMALL_WINDOW_THRESHOLD (12k).
 * There isn't enough room for LLM extraction calls, so we just keep the last
 * `keepRecent` messages and add a brief summary note.
 *
 * @param messages - Full conversation message array
 * @param keepRecent - Number of recent messages to keep verbatim (default: 10)
 * @returns Truncated message array with a summary pair prepended
 */
export function compactSmallWindow(
  messages: ProviderMessage[],
  keepRecent = 10,
): ProviderMessage[] {
  if (messages.length <= keepRecent) return messages;
  const recentMessages = messages.slice(-keepRecent);
  const omittedCount = messages.length - keepRecent;
  const summaryMsg: ProviderMessage = {
    role: 'user' as const,
    content: `[Context compacted — small window mode, ${omittedCount} messages summarized]`,
  };
  const summaryReply: ProviderMessage = {
    role: 'assistant' as const,
    content: `[${omittedCount} earlier messages omitted to fit context window. Continuing from recent conversation.]`,
  };
  return [summaryMsg, summaryReply, ...recentMessages];
}

// ---------------------------------------------------------------------------
// LLM extraction helper
// ---------------------------------------------------------------------------

/**
 * Call the LLM with a prompt and return the trimmed response text.
 * Returns null on any failure (compaction should degrade gracefully).
 */
async function llmExtract(
  registry: ProviderRegistry,
  modelId: string,
  providerName: string | undefined,
  prompt: string,
  label: string,
): Promise<string | null> {
  if (!prompt.trim()) return null;

  let provider: LLMProvider;
  let providerModelId: string;
  try {
    provider = registry.getForModel(modelId, providerName);
    const modelDef = registry.listModels().find((model) => (
      providerName
        ? model.provider === providerName && (model.registryKey === modelId || model.id === modelId)
        : model.registryKey === modelId
    ));
    if (!modelDef) {
      throw new Error(`Model '${modelId}' is not in registry.`);
    }
    providerModelId = modelDef.id;
  } catch (err) {
    logger.warn(`Compaction: failed to get provider for ${label}`, {
      modelId,
      err: summarizeError(err),
    });
    return null;
  }

  try {
    const response = await provider.chat({
      messages: [{ role: 'user', content: prompt }],
      model: providerModelId,
    });
    const text = response.content?.trim() ?? '';
    if (!text) {
      logger.warn(`Compaction: LLM returned empty response for ${label}`);
      return null;
    }
    return text;
  } catch (err) {
    logger.warn(`Compaction: LLM extraction failed for ${label}`, {
      err: summarizeError(err),
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Post-compaction validation
// ---------------------------------------------------------------------------

function validateCompaction(
  sections: CompactionSection[],
  ctx: CompactionContext,
  totalTokens: number,
  config: CompactionConfig,
): string[] {
  const warnings: string[] = [];
  const sectionIds = new Set(sections.map((s) => s.id));

  if (!sectionIds.has('handoff-header')) {
    warnings.push('CRITICAL: handoff-header section is missing');
  }
  if (!sectionIds.has('current-task')) {
    warnings.push('WARNING: current-task section is missing');
  }

  const hasRunningAgents = ctx.agents.some(isActiveAgent);
  if (hasRunningAgents && !sectionIds.has('running-agents')) {
    warnings.push('WARNING: running agents exist but running-agents section is missing');
  }

  if (ctx.sessionMemories.length > 0 && !sectionIds.has('session-memories')) {
    warnings.push('WARNING: session memories exist but session-memories section is missing');
  }

  if (ctx.compactionCount > 0 && !ctx.originalTask) {
    warnings.push(
      'WARNING: compactionCount > 0 but originalTask is missing — lineage may be broken upstream',
    );
  }

  if (totalTokens > config.totalCeiling) {
    warnings.push(
      `WARNING: total tokens (${totalTokens}) exceeds ceiling (${config.totalCeiling})`,
    );
  }

  return warnings;
}

/**
 * resolveLineageOriginalTask — decide what text (if any) to show as
 * "Original task" in the session-lineage section.
 *
 * The lastUserMsg fallback is only valid for the very first compaction of a
 * session (compactionCount === 0): a genuine edge case where originalTask was
 * never recorded upstream. Past that point, falling back to the current
 * last-user-message would silently mislabel the CURRENT task as "Original
 * task" once real lineage exists — so the fallback is gated to
 * compactionCount === 0 only. See the matching `validateCompaction` warning
 * for compactionCount > 0 with a missing originalTask.
 */
export function resolveLineageOriginalTask(
  originalTask: string | undefined,
  lastUserMsg: string | null,
  compactionCount: number,
): string | undefined {
  return originalTask ?? (compactionCount === 0 ? lastUserMsg ?? undefined : undefined);
}

// ---------------------------------------------------------------------------
// Assemble compacted output
// ---------------------------------------------------------------------------

function assembleSections(sections: CompactionSection[]): string {
  const parts: string[] = [];
  for (const section of sections) {
    if (section.header) {
      parts.push(section.header);
    }
    parts.push(section.content);
    parts.push(''); // blank line between sections
  }
  return parts.join('\n').trimEnd();
}

// ---------------------------------------------------------------------------
// Core compaction logic
// ---------------------------------------------------------------------------

/**
 * compactMessages — structured compaction entry point.
 */
export async function compactMessages(
  ctx: CompactionContext,
  registry: ProviderRegistry,
): Promise<CompactionResult> {
  return runCompaction(ctx, registry);
}

/**
 * runCompaction — structured compaction implementation.
 *
 * Accepts a CompactionContext containing all data sources. Makes targeted LLM
 * calls for substance filtering and extraction (parallelized), assembles a
 * structured handoff context, validates it, and returns a CompactionResult.
 */
async function runCompaction(
  ctx: CompactionContext,
  registry: ProviderRegistry,
): Promise<CompactionResult> {
  const config = DEFAULT_COMPACTION_CONFIG;
  const tokensBeforeEstimate = estimateConversationTokens(ctx.messages);

  logger.info('Context compaction: starting', {
    trigger: ctx.trigger,
    messageCount: ctx.messages.length,
    tokensBeforeEstimate,
    agentCount: ctx.agents.length,
    chainCount: ctx.wrfcChains.length,
  });

  // ---------------------------------------------------------------------------
  // Build rule-based sections (no LLM needed)
  // ---------------------------------------------------------------------------
  const sections: CompactionSection[] = [];

  // Handoff header (always present)
  sections.push(buildHandoffHeader());

  // Current task
  const planTitle = ctx.activePlan?.title ?? null;
  const lastUserMsg = (() => {
    for (let i = ctx.messages.length - 1; i >= 0; i--) {
      const msg = ctx.messages[i];
      if (msg?.role === 'user') {
        const text = extractText(msg.content);
        if (text.trim()) return text.trim();
      }
    }
    return null;
  })();
  const currentTaskSection = buildCurrentTask(planTitle, lastUserMsg);
  if (currentTaskSection) sections.push(currentTaskSection);

  // Session memories
  const memoriesSection = buildSessionMemories([...ctx.sessionMemories]);
  if (memoriesSection) sections.push(memoriesSection);

  // Running agents
  const runningSection = buildRunningAgents(ctx.agents, ctx.wrfcChains);
  if (runningSection) sections.push(runningSection);

  // Completed agent work (rule-based) — standalone agents not covered by a WRFC chain
  const completedSection = buildCompletedAgentWork(ctx.agents, ctx.wrfcChains);
  if (completedSection) sections.push(completedSection);

  // Agent activity table (rule-based, needed before LLM calls to determine remaining)
  const { section: activitySection, remainingChains } = buildAgentActivityTable(
    ctx.wrfcChains,
    config.agentActivityBudget,
  );
  if (activitySection) sections.push(activitySection);

  // ---------------------------------------------------------------------------
  // Prepare all LLM-assisted prompts
  // ---------------------------------------------------------------------------
  const gatheredMessages = gatherRecentConversation(
    ctx.messages,
    config.recentConversationBudget,
  );
  const filterPrompt = gatheredMessages.length > 0
    ? buildConversationFilterPrompt(gatheredMessages)
    : '';

  const toolMessages = ctx.messages.filter((m) => m.role === 'tool');
  const toolPrompt = toolMessages.length > 0
    ? buildToolResultsPrompt(toolMessages)
    : '';

  const olderPrompt = remainingChains.length > 0
    ? buildOlderAgentSummaryPrompt(remainingChains)
    : '';

  const allUserAssistant = ctx.messages.filter(
    (m) => m.role === 'user' || m.role === 'assistant',
  );
  const problemsPrompt = allUserAssistant.length > 0
    ? buildResolvedProblemsPrompt(allUserAssistant)
    : '';

  // ---------------------------------------------------------------------------
  // Parallelize all 4 independent LLM extraction calls
  // ---------------------------------------------------------------------------
  const [filteredText, toolSummary, olderSummary, problemsText] = await Promise.all([
    llmExtract(registry, ctx.extractionModelId, ctx.extractionProvider, filterPrompt, 'conversation-filter'),
    llmExtract(registry, ctx.extractionModelId, ctx.extractionProvider, toolPrompt, 'tool-results'),
    llmExtract(registry, ctx.extractionModelId, ctx.extractionProvider, olderPrompt, 'older-agent-summary'),
    llmExtract(registry, ctx.extractionModelId, ctx.extractionProvider, problemsPrompt, 'resolved-problems'),
  ]);

  // ---------------------------------------------------------------------------
  // Assemble LLM-assisted sections
  // ---------------------------------------------------------------------------

  // Recent conversation
  if (gatheredMessages.length > 0) {
    if (filteredText) {
      sections.push({
        id: 'recent-conversation',
        header: '## Recent Conversation',
        content: filteredText,
        tokens: estimateTokens('## Recent Conversation\n' + filteredText),
      });
    } else {
      // Include raw gathered messages if the LLM filter fails.
      const fallbackLines = gatheredMessages.map((m) => {
        const text = extractText(m.content);
        return `[${m.role}]: ${text.trim()}`;
      });
      const fallbackContent = fallbackLines.join('\n\n');
      sections.push({
        id: 'recent-conversation',
        header: '## Recent Conversation',
        content: fallbackContent,
        tokens: estimateTokens('## Recent Conversation\n' + fallbackContent),
      });
    }
  }

  // Tool results
  if (toolSummary) {
    sections.push({
      id: 'tool-results',
      header: '## Tool Results & Files Modified',
      content: toolSummary,
      tokens: estimateTokens('## Tool Results & Files Modified\n' + toolSummary),
    });
  }

  // Older agent summary
  if (olderSummary) {
    sections.push({
      id: 'older-agent-summary',
      header: '## Older Work Summary',
      content: olderSummary,
      tokens: estimateTokens('## Older Work Summary\n' + olderSummary),
    });
  }

  // Resolved problems
  if (problemsText && problemsText.toLowerCase().trim() !== 'empty'
      && !problemsText.toLowerCase().includes('no resolved problems')) {
    sections.push({
      id: 'resolved-problems',
      header: '## Resolved Problems',
      content: problemsText,
      tokens: estimateTokens('## Resolved Problems\n' + problemsText),
    });
  }

  // Plan progress (rule-based)
  const planSection = buildPlanProgress(ctx.activePlan);
  if (planSection) sections.push(planSection);

  // Session lineage (rule-based, append-only)
  const lineageSection = buildSessionLineage(
    resolveLineageOriginalTask(ctx.originalTask, lastUserMsg, ctx.compactionCount),
    ctx.lineageEntries,
    ctx.compactionCount,
  );
  if (lineageSection) sections.push(lineageSection);

  // ---------------------------------------------------------------------------
  // Assemble and validate
  // ---------------------------------------------------------------------------
  const compactedText = assembleSections(sections);
  const totalTokens = sections.reduce((sum, s) => sum + s.tokens, 0);
  const validationWarnings = validateCompaction(sections, ctx, totalTokens, config);

  if (validationWarnings.length > 0) {
    logger.warn('Context compaction: validation warnings', { warnings: validationWarnings });
  }

  // Build the new message list: a single user message containing the compacted context
  const newMessages: ProviderMessage[] = [
    {
      role: 'user',
      content: compactedText,
    },
  ];

  const tokensAfterEstimate = estimateConversationTokens(newMessages);

  const event: CompactionEvent = {
    timestamp: Date.now(),
    messagesBeforeCompaction: ctx.messages.length,
    messagesAfterCompaction: newMessages.length,
    tokensBeforeEstimate,
    tokensAfterEstimate,
    modelId: ctx.extractionModelId,
    trigger: ctx.trigger,
    sectionsIncluded: sections.map((s) => s.id),
    validationPassed: validationWarnings.length === 0,
  };

  compactionEvents.push(event);
  if (compactionEvents.length > 50) compactionEvents.shift();

  logger.info('Context compaction: complete', {
    trigger: ctx.trigger,
    modelId: ctx.extractionModelId,
    messagesBeforeCompaction: event.messagesBeforeCompaction,
    messagesAfterCompaction: event.messagesAfterCompaction,
    tokensBeforeEstimate: event.tokensBeforeEstimate,
    tokensAfterEstimate: event.tokensAfterEstimate,
    tokensSaved: event.tokensBeforeEstimate - event.tokensAfterEstimate,
    sectionsIncluded: event.sectionsIncluded,
    validationWarnings: validationWarnings.length,
  });

  return {
    messages: newMessages,
    summary: compactedText,
    tokensBeforeEstimate,
    tokensAfterEstimate,
    event,
    sections,
    validationWarnings,
  };
}

// ---------------------------------------------------------------------------
// checkAndCompact
// ---------------------------------------------------------------------------

/**
 * checkAndCompact — Check if context usage exceeds threshold and compact if so.
 * Returns the compaction result if compaction was performed, null otherwise.
 *
 */
export async function checkAndCompact(
  autoOpts: AutoCompactOptions,
  ctx: CompactionContext,
  registry: ProviderRegistry,
): Promise<CompactionResult | null> {
  if (!shouldAutoCompact(autoOpts)) return null;

  return compactMessages(
    { ...ctx, trigger: 'auto' } as CompactionContext,
    registry,
  );
}
