/**
 * checkin/judge.ts
 *
 * The judgment seam. The default implementation makes one structured model call
 * over the current provider/model (the same getCurrentModel + provider.chat
 * primitive the knowledge semantic LLM uses), asking for a compact JSON decision
 * {contact, message, reason}. It is a single decide-and-maybe-notify call, not a
 * multi-turn agent — which is what lets the whole check-in loop close
 * synchronously and stay testable with a fake judge.
 *
 * HONESTY: if the model returns nothing parseable, the judge decides NOT to
 * contact (contact:false) with an explicit reason rather than inventing a
 * message — a check-in must never fabricate a reason to interrupt the user.
 */
import type { ProviderRegistry } from '../providers/registry.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import type { CheckinDecision, CheckinJudge } from './types.js';

const SYSTEM_PROMPT = [
  'You are a proactive check-in assistant deciding whether to interrupt the user.',
  'You are given a compact briefing of the current state of their work.',
  'Decide whether anything genuinely warrants contacting them right now.',
  'Bias strongly toward staying quiet: only contact for something that actually needs their attention or a decision.',
  'Respond with ONE JSON object and nothing else:',
  '{"contact": boolean, "reason": string, "message": string}',
  'When contact is false, leave message empty. When contact is true, message is the short note to send.',
].join('\n');

/**
 * Parse a model response into a decision. Tolerant of surrounding prose/code
 * fences; on any failure returns a quiet decision with an explicit reason.
 */
export function parseCheckinDecision(text: string | null | undefined): CheckinDecision {
  if (!text) return { contact: false, reason: 'no model response' };
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { contact: false, reason: 'model response was not JSON' };
  try {
    const parsed = JSON.parse(match[0]) as { contact?: unknown; reason?: unknown; message?: unknown };
    const contact = parsed.contact === true;
    const reason = typeof parsed.reason === 'string' && parsed.reason.trim() ? parsed.reason.trim() : (contact ? 'model decided to contact' : 'nothing warranted contact');
    const message = typeof parsed.message === 'string' ? parsed.message.trim() : '';
    if (contact && !message) return { contact: false, reason: 'model asked to contact but gave no message' };
    return contact ? { contact, reason, message } : { contact: false, reason };
  } catch {
    return { contact: false, reason: 'model response was not valid JSON' };
  }
}

export interface ProviderBackedCheckinJudgeOptions {
  readonly timeoutMs?: number | undefined;
}

/** Build a judge over the registry's current model. */
export function createProviderBackedCheckinJudge(
  providerRegistry: ProviderRegistry,
  options: ProviderBackedCheckinJudgeOptions = {},
): CheckinJudge {
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? 20_000);
  return {
    decide: async (briefing: string): Promise<CheckinDecision> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref?.();
      try {
        const current = providerRegistry.getCurrentModel();
        const provider = providerRegistry.getForModel(current.registryKey, current.provider);
        const response = await provider.chat({
          model: current.id,
          messages: [{ role: 'user', content: briefing }],
          systemPrompt: SYSTEM_PROMPT,
          maxTokens: 400,
          reasoningEffort: 'low',
          signal: controller.signal,
        });
        return parseCheckinDecision(response.content ?? '');
      } catch (error) {
        logger.warn('Check-in judge model call failed; staying quiet', { error: summarizeError(error) });
        return { contact: false, reason: `judge unavailable: ${summarizeError(error)}` };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
