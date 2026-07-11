/**
 * distiller-compaction.ts
 *
 * Fresh-context DISTILLER compaction strategy — an alternative to the in-place
 * structured summarization in `context-compaction.ts`.
 *
 * Where the structured strategy assembles a handoff from many targeted
 * extraction calls over the existing message history, the distiller makes ONE
 * fresh model call that distills the conversation into a structured
 * CONTINUATION BRIEF (task state, decisions made, open threads, key
 * file/symbol references) which then seeds a fresh context. The brief replaces
 * the conversation exactly like the structured handoff does.
 *
 * PARITY, NOT DUPLICATION. The standing instruction chain + active skill
 * frontmatter are re-injected at the boundary here through the SAME
 * `buildReinjectedInstructions` seam the structured strategy uses (never a
 * second copy), and prior re-injected blocks are stripped from the history
 * before it is handed to the distiller model call — identical to
 * `runCompaction`.
 *
 * The distiller does NOT decide whether its own output is good enough: the
 * caller (`compactConversation`) scores every distillation through the SAME
 * quality scorer as the structured strategy and falls back to structured when
 * the distillation scores below the floor. A model-call failure surfaces as a
 * thrown error so the caller can fall back honestly rather than committing an
 * empty brief.
 */

import type { ProviderMessage, LLMProvider } from '../providers/interface.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import type { CompactionContext, CompactionResult, CompactionEvent } from './compaction-types.js';
import { estimateTokens } from './compaction-types.js';
import { estimateConversationTokens } from './context-compaction.js';
import {
  buildHandoffHeader,
  buildReinjectedInstructions,
  stripReinjectedInstructions,
  extractText,
  REINJECT_INSTRUCTIONS_START,
} from './compaction-sections.js';

/**
 * Error thrown when the distiller's fresh model call cannot produce a usable
 * continuation brief (provider unavailable, empty response, call failure). The
 * caller catches this and falls back to the structured strategy.
 */
export class DistillerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DistillerUnavailableError';
  }
}

/** Max characters of conversation transcript fed into the distiller prompt. */
const MAX_TRANSCRIPT_CHARS = 24_000;

/**
 * Build the transcript text handed to the distiller. Prior re-injected
 * instruction blocks are stripped so the model never distills the standing
 * instructions back into the brief on top of the fresh copy re-injected at the
 * boundary (mirrors `runCompaction`).
 */
function buildTranscript(messages: readonly ProviderMessage[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    let text = extractText(msg.content);
    if (text.includes(REINJECT_INSTRUCTIONS_START)) {
      text = stripReinjectedInstructions(text);
    }
    text = text.trim();
    if (!text) continue;
    lines.push(`[${msg.role}]: ${text}`);
  }
  const joined = lines.join('\n\n');
  if (joined.length <= MAX_TRANSCRIPT_CHARS) return joined;
  // Keep the tail — the most recent exchanges carry the live task state.
  return joined.slice(joined.length - MAX_TRANSCRIPT_CHARS);
}

/** The instruction prompt that shapes the continuation brief. */
function buildDistillerPrompt(transcript: string, planTitle: string | null): string {
  const taskHint = planTitle ? `The active plan is titled: "${planTitle}".\n\n` : '';
  return (
    'You are distilling a long assistant/tool conversation into a compact, ' +
    'structured CONTINUATION BRIEF so a fresh context can resume the work with ' +
    'no loss of task state. Do not summarize for a reader — write for the agent ' +
    'that will continue. Be concrete: name files, symbols, decisions, and the ' +
    'exact next steps.\n\n' +
    taskHint +
    'Produce EXACTLY these four markdown sections, each with its heading, and ' +
    'nothing else:\n\n' +
    '## Task State\n' +
    'What is being worked on right now and how far it has progressed.\n\n' +
    '## Decisions Made\n' +
    'Concrete decisions already settled (and why), so they are not re-litigated.\n\n' +
    '## Open Threads\n' +
    'Unfinished work, unresolved questions, and the immediate next steps.\n\n' +
    '## Key References\n' +
    'Key file paths and code symbols (functions, types, modules) touched or ' +
    'relevant, with a one-line note on each.\n\n' +
    '--- CONVERSATION TRANSCRIPT ---\n' +
    transcript
  );
}

/**
 * Resolve a provider + concrete model id for the extraction model, mirroring the
 * structured strategy's resolution. Returns null when the model is not in the
 * registry (the caller then falls back).
 */
function resolveProvider(
  registry: ProviderRegistry,
  modelId: string,
  providerName: string | undefined,
): { provider: LLMProvider; providerModelId: string } | null {
  try {
    const provider = registry.getForModel(modelId, providerName);
    const modelDef = registry.listModels().find((model) => (
      providerName
        ? model.provider === providerName && (model.registryKey === modelId || model.id === modelId)
        : model.registryKey === modelId
    ));
    if (!modelDef) return null;
    return { provider, providerModelId: modelDef.id };
  } catch (err) {
    logger.warn('Distiller: failed to resolve provider', { modelId, err: summarizeError(err) });
    return null;
  }
}

/**
 * distillConversation — fresh-context distiller strategy entry point.
 *
 * Makes one fresh model call to produce a structured continuation brief,
 * re-injects the standing instruction chain + active skill at the boundary, and
 * returns a `CompactionResult` in the same shape the structured strategy
 * returns (so the caller scores and commits it identically).
 *
 * @throws DistillerUnavailableError when the fresh model call cannot produce a
 *         usable brief; the caller falls back to the structured strategy.
 */
export async function distillConversation(
  ctx: CompactionContext,
  registry: ProviderRegistry,
): Promise<CompactionResult> {
  const tokensBeforeEstimate = estimateConversationTokens(ctx.messages);
  const transcript = buildTranscript(ctx.messages);

  if (!transcript.trim()) {
    throw new DistillerUnavailableError('No distillable conversation content.');
  }

  const resolved = resolveProvider(registry, ctx.extractionModelId, ctx.extractionProvider);
  if (!resolved) {
    throw new DistillerUnavailableError(
      `Extraction model '${ctx.extractionModelId}' is not available for distillation.`,
    );
  }

  const prompt = buildDistillerPrompt(transcript, ctx.activePlan?.title ?? null);

  let brief: string;
  try {
    const response = await resolved.provider.chat({
      messages: [{ role: 'user', content: prompt }],
      model: resolved.providerModelId,
    });
    brief = response.content?.trim() ?? '';
  } catch (err) {
    throw new DistillerUnavailableError(`Distiller model call failed: ${summarizeError(err)}`);
  }

  if (!brief) {
    throw new DistillerUnavailableError('Distiller model returned an empty brief.');
  }

  // Assemble the compacted context: handoff header, then the re-injected
  // standing instructions (SAME seam as structured — parity, not a second
  // copy), then the distilled brief.
  const header = buildHandoffHeader();
  const reinjected = buildReinjectedInstructions(ctx.instructionChain, ctx.activeSkillFrontmatter);
  const instructionsReinjected = reinjected !== null;

  const parts: string[] = [header.content, ''];
  if (reinjected) {
    parts.push(reinjected.header, reinjected.content, '');
  }
  parts.push('## Continuation Brief (distilled)', '', brief);
  const compactedText = parts.join('\n').trimEnd();

  const newMessages: ProviderMessage[] = [{ role: 'user', content: compactedText }];
  const tokensAfterEstimate = estimateConversationTokens(newMessages);

  const sectionsIncluded = [
    'handoff-header',
    ...(instructionsReinjected ? ['reinjected-instructions'] : []),
    'continuation-brief',
  ];

  const event: CompactionEvent = {
    timestamp: Date.now(),
    messagesBeforeCompaction: ctx.messages.length,
    messagesAfterCompaction: newMessages.length,
    tokensBeforeEstimate,
    tokensAfterEstimate,
    modelId: ctx.extractionModelId,
    trigger: ctx.trigger,
    sectionsIncluded,
    validationPassed: true,
    instructionsReinjected,
  };

  logger.info('Distiller compaction: complete', {
    trigger: ctx.trigger,
    modelId: ctx.extractionModelId,
    messagesBeforeCompaction: event.messagesBeforeCompaction,
    tokensBeforeEstimate,
    tokensAfterEstimate,
    tokensSaved: tokensBeforeEstimate - tokensAfterEstimate,
    instructionsReinjected,
  });

  return {
    messages: newMessages,
    summary: compactedText,
    tokensBeforeEstimate,
    tokensAfterEstimate,
    event,
    sections: [
      { id: 'handoff-header', header: '', content: header.content, tokens: header.tokens },
      ...(reinjected ? [reinjected] : []),
      {
        id: 'continuation-brief',
        header: '## Continuation Brief (distilled)',
        content: brief,
        tokens: estimateTokens(brief),
      },
    ],
    validationWarnings: [],
  };
}
