import type { ChatStopReason } from './interface.js';

/** Maps Anthropic raw stop_reason values to the canonical ChatStopReason vocab. */
export const ANTHROPIC_STOP_REASON_MAP: Readonly<Record<string, ChatStopReason>> = {
  end_turn: 'completed',
  max_tokens: 'max_tokens',
  tool_use: 'tool_call',
  stop_sequence: 'stop_sequence',
};

export function mapAnthropicStopReason(raw: string | null | undefined): ChatStopReason {
  if (!raw) return 'unknown';
  return ANTHROPIC_STOP_REASON_MAP[raw] ?? 'unknown';
}

/** Maps OpenAI finish_reason values to the canonical ChatStopReason vocab. */
export const OPENAI_STOP_REASON_MAP: Readonly<Record<string, ChatStopReason>> = {
  stop: 'completed',
  length: 'max_tokens',
  tool_calls: 'tool_call',
  content_filter: 'content_filter',
  function_call: 'tool_call',
};

export function mapOpenAIStopReason(raw: string | null | undefined): ChatStopReason {
  if (!raw) return 'unknown';
  return OPENAI_STOP_REASON_MAP[raw] ?? 'unknown';
}

/** Maps Gemini finishReason values to the canonical ChatStopReason vocab. */
export const GEMINI_STOP_REASON_MAP: Readonly<Record<string, ChatStopReason>> = {
  STOP: 'completed',
  MAX_TOKENS: 'max_tokens',
  SAFETY: 'content_filter',
  RECITATION: 'content_filter',
  OTHER: 'unknown',
  BLOCKLIST: 'content_filter',
  PROHIBITED_CONTENT: 'content_filter',
  SPII: 'content_filter',
  MALFORMED_FUNCTION_CALL: 'unknown',
};

export function mapGeminiStopReason(raw: string | null | undefined): ChatStopReason {
  if (!raw) return 'unknown';
  return GEMINI_STOP_REASON_MAP[raw] ?? 'unknown';
}

/**
 * Maps llama.cpp finish_reason values to the canonical ChatStopReason vocab.
 * llama.cpp uses the OpenAI-compatible finish_reason field ('stop', 'length', 'tool_calls').
 */
export function mapLlamaCppStopReason(
  finishReason: string | null | undefined,
  hasToolCalls: boolean,
): ChatStopReason {
  if (hasToolCalls || finishReason === 'tool_calls') return 'tool_call';
  if (finishReason === 'length') return 'max_tokens';
  return 'completed';
}

/**
 * Maps Ollama done_reason values to the canonical ChatStopReason vocab.
 * Ollama uses its own done_reason field ('stop', 'length', 'tool-calls', 'load', etc.).
 */
export function mapOllamaStopReason(
  doneReason: string,
  hasToolCalls: boolean,
): ChatStopReason {
  if (hasToolCalls || /tool/i.test(doneReason)) return 'tool_call';
  if (/length|max_tokens/i.test(doneReason)) return 'max_tokens';
  return 'completed';
}

/**
 * Maps OpenAI Codex (responses API) status values to the canonical ChatStopReason vocab.
 */
export function mapCodexStopReason(
  status: string | undefined,
  hasToolCalls: boolean,
): ChatStopReason {
  if (hasToolCalls && status === 'completed') return 'tool_call';
  if (status === 'incomplete') return 'max_tokens';
  if (status === 'failed' || status === 'cancelled') return 'error';
  return 'completed';
}

/**
 * Maps LM Studio responses API status values to the canonical ChatStopReason vocab.
 * Used by both the native chat and responses paths in lm-studio.ts.
 */
export function mapLmStudioStopReason(
  status: string | undefined,
  hasToolCalls: boolean,
): ChatStopReason {
  if (hasToolCalls && status === 'completed') return 'tool_call';
  if (status === 'incomplete') return 'max_tokens';
  if (status === 'failed' || status === 'cancelled') return 'error';
  return 'completed';
}
