/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * judge.ts — an optional, provider-backed best-of-N judge.
 *
 * A model call that scores a held-merge group's candidates and PROPOSES a
 * winner with reasons. Deliberately kept behind the injectable {@link AttemptJudge}
 * seam (attempts.ts / engine.ts) so the engine stays provider-agnostic and unit-
 * testable with a fake; this is the real wiring the composition root (services.ts)
 * hands the engine. The verdict is always a PROPOSAL — the engine labels it
 * scoredBy:'model' and never auto-picks unless the source item opted in.
 */
import type { ProviderRegistry } from '../providers/registry.js';
import type { AttemptJudge, AttemptJudgeInput, AttemptJudgeVerdict } from './types.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

const SYSTEM_PROMPT = [
  'You are judging several candidate implementations of the SAME task, each produced by a separate agent in its own branch.',
  'Pick the single best candidate by correctness, completeness, and simplicity, or none if all are unacceptable.',
  'Respond with ONLY a JSON object, no prose: {"winnerItemId": string|null, "reasons": string[]}.',
  'winnerItemId MUST be exactly one of the candidate itemIds shown, or null. reasons is a short list explaining the choice.',
].join(' ');

/** Bound each candidate's diff so the prompt stays within a sane token budget. */
const MAX_DIFF_CHARS = 2_000;

export interface ProviderBackedAttemptJudgeOptions {
  readonly timeoutMs?: number | undefined;
}

function buildPrompt(input: AttemptJudgeInput): string {
  const lines: string[] = [`TASK:\n${input.task}`, '', `CANDIDATES (${input.candidates.length}):`];
  for (const c of input.candidates) {
    lines.push('', `- itemId: ${c.itemId} (attempt ${c.attemptIndex}, ${c.state})`);
    if (c.diff) {
      lines.push(`  diffstat: ${c.diff.stat || '(none)'}`);
      const body = c.diff.unifiedDiff.length > MAX_DIFF_CHARS
        ? `${c.diff.unifiedDiff.slice(0, MAX_DIFF_CHARS)}\n… (diff truncated)`
        : c.diff.unifiedDiff;
      lines.push('  diff:', body);
    } else {
      lines.push('  (no diff available — this candidate failed or has no worktree)');
    }
  }
  return lines.join('\n');
}

/** Parse the model's JSON verdict, keeping only a winnerItemId that is a real candidate id. */
export function parseAttemptVerdict(raw: string, input: AttemptJudgeInput, model: string | null): AttemptJudgeVerdict {
  const validIds = new Set(input.candidates.map((c) => c.itemId));
  try {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('no JSON object in judge response');
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { winnerItemId?: unknown; reasons?: unknown };
    const winnerItemId = typeof parsed.winnerItemId === 'string' && validIds.has(parsed.winnerItemId) ? parsed.winnerItemId : null;
    const reasons = Array.isArray(parsed.reasons)
      ? parsed.reasons.filter((r): r is string => typeof r === 'string')
      : [];
    return { winnerItemId, reasons, ...(model ? { model } : {}) };
  } catch (error) {
    return {
      winnerItemId: null,
      reasons: [`judge response could not be parsed as a winner verdict: ${summarizeError(error)}`],
      ...(model ? { model } : {}),
    };
  }
}

export function createProviderBackedAttemptJudge(
  providerRegistry: ProviderRegistry,
  options: ProviderBackedAttemptJudgeOptions = {},
): AttemptJudge {
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? 30_000);
  return async (input: AttemptJudgeInput): Promise<AttemptJudgeVerdict> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    try {
      const current = providerRegistry.getCurrentModel();
      const provider = providerRegistry.getForModel(current.registryKey, current.provider);
      const response = await provider.chat({
        model: current.id,
        messages: [{ role: 'user', content: buildPrompt(input) }],
        systemPrompt: SYSTEM_PROMPT,
        maxTokens: 600,
        reasoningEffort: 'low',
        signal: controller.signal,
      });
      return parseAttemptVerdict(response.content ?? '', input, current.id);
    } catch (error) {
      logger.warn('best-of-N judge model call failed; proposing no winner', { error: summarizeError(error) });
      return { winnerItemId: null, reasons: [`judge unavailable: ${summarizeError(error)}`] };
    } finally {
      clearTimeout(timer);
    }
  };
}
