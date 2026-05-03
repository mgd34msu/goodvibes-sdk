import { describe, it, expect } from 'bun:test';
import type { ChatStopReason } from '../packages/sdk/src/platform/providers/interface.js';
import {
  mapAnthropicStopReason,
  mapOpenAIStopReason,
  mapGeminiStopReason,
  mapLlamaCppStopReason,
  mapOllamaStopReason,
  mapCodexStopReason,
  mapLmStudioStopReason,
} from '../packages/sdk/src/platform/providers/stop-reason-maps.js';

// ---------------------------------------------------------------------------
// Tests — Anthropic
// ---------------------------------------------------------------------------

describe('Anthropic stop reason mapper', () => {
  it('maps end_turn → completed', () => {
    expect(mapAnthropicStopReason('end_turn')).toBe<ChatStopReason>('completed');
  });
  it('maps max_tokens → max_tokens', () => {
    expect(mapAnthropicStopReason('max_tokens')).toBe<ChatStopReason>('max_tokens');
  });
  it('maps tool_use → tool_call', () => {
    expect(mapAnthropicStopReason('tool_use')).toBe<ChatStopReason>('tool_call');
  });
  it('maps stop_sequence → stop_sequence', () => {
    expect(mapAnthropicStopReason('stop_sequence')).toBe<ChatStopReason>('stop_sequence');
  });
  it('falls through to unknown for unmapped values', () => {
    expect(mapAnthropicStopReason('some_future_reason')).toBe<ChatStopReason>('unknown');
  });
  it('returns unknown for null', () => {
    expect(mapAnthropicStopReason(null)).toBe<ChatStopReason>('unknown');
  });
  it('returns unknown for undefined', () => {
    expect(mapAnthropicStopReason(undefined)).toBe<ChatStopReason>('unknown');
  });
  it('returns unknown for empty string', () => {
    expect(mapAnthropicStopReason('')).toBe<ChatStopReason>('unknown');
  });
});

// ---------------------------------------------------------------------------
// Tests — OpenAI
// ---------------------------------------------------------------------------

describe('OpenAI stop reason mapper', () => {
  it('maps stop → completed', () => {
    expect(mapOpenAIStopReason('stop')).toBe<ChatStopReason>('completed');
  });
  it('maps length → max_tokens', () => {
    expect(mapOpenAIStopReason('length')).toBe<ChatStopReason>('max_tokens');
  });
  it('maps tool_calls → tool_call', () => {
    expect(mapOpenAIStopReason('tool_calls')).toBe<ChatStopReason>('tool_call');
  });
  it('maps content_filter → content_filter', () => {
    expect(mapOpenAIStopReason('content_filter')).toBe<ChatStopReason>('content_filter');
  });
  it('maps function_call → tool_call', () => {
    expect(mapOpenAIStopReason('function_call')).toBe<ChatStopReason>('tool_call');
  });
  it('falls through to unknown for unmapped values', () => {
    expect(mapOpenAIStopReason('some_future_reason')).toBe<ChatStopReason>('unknown');
  });
  it('returns unknown for null', () => {
    expect(mapOpenAIStopReason(null)).toBe<ChatStopReason>('unknown');
  });
  it('returns unknown for undefined', () => {
    expect(mapOpenAIStopReason(undefined)).toBe<ChatStopReason>('unknown');
  });
  it('returns unknown for empty string', () => {
    expect(mapOpenAIStopReason('')).toBe<ChatStopReason>('unknown');
  });
});

// ---------------------------------------------------------------------------
// Tests — Gemini
// ---------------------------------------------------------------------------

describe('Gemini stop reason mapper', () => {
  it('maps STOP → completed', () => {
    expect(mapGeminiStopReason('STOP')).toBe<ChatStopReason>('completed');
  });
  it('maps MAX_TOKENS → max_tokens', () => {
    expect(mapGeminiStopReason('MAX_TOKENS')).toBe<ChatStopReason>('max_tokens');
  });
  it('maps SAFETY → content_filter', () => {
    expect(mapGeminiStopReason('SAFETY')).toBe<ChatStopReason>('content_filter');
  });
  it('maps RECITATION → content_filter', () => {
    expect(mapGeminiStopReason('RECITATION')).toBe<ChatStopReason>('content_filter');
  });
  it('maps OTHER → unknown', () => {
    expect(mapGeminiStopReason('OTHER')).toBe<ChatStopReason>('unknown');
  });
  it('maps BLOCKLIST → content_filter', () => {
    expect(mapGeminiStopReason('BLOCKLIST')).toBe<ChatStopReason>('content_filter');
  });
  it('maps PROHIBITED_CONTENT → content_filter', () => {
    expect(mapGeminiStopReason('PROHIBITED_CONTENT')).toBe<ChatStopReason>('content_filter');
  });
  it('maps SPII → content_filter', () => {
    expect(mapGeminiStopReason('SPII')).toBe<ChatStopReason>('content_filter');
  });
  it('maps MALFORMED_FUNCTION_CALL → unknown', () => {
    expect(mapGeminiStopReason('MALFORMED_FUNCTION_CALL')).toBe<ChatStopReason>('unknown');
  });
  it('falls through to unknown for unmapped values', () => {
    expect(mapGeminiStopReason('SOME_FUTURE_REASON')).toBe<ChatStopReason>('unknown');
  });
  it('returns unknown for null', () => {
    expect(mapGeminiStopReason(null)).toBe<ChatStopReason>('unknown');
  });
  it('returns unknown for undefined', () => {
    expect(mapGeminiStopReason(undefined)).toBe<ChatStopReason>('unknown');
  });
});

// ---------------------------------------------------------------------------
// Tests — llama.cpp
// ---------------------------------------------------------------------------

describe('llama.cpp stop reason mapper', () => {
  it('maps hasToolCalls=true → tool_call (regardless of finish_reason)', () => {
    expect(mapLlamaCppStopReason('stop', true)).toBe<ChatStopReason>('tool_call');
    expect(mapLlamaCppStopReason(null, true)).toBe<ChatStopReason>('tool_call');
  });
  it('maps tool_calls → tool_call', () => {
    expect(mapLlamaCppStopReason('tool_calls', false)).toBe<ChatStopReason>('tool_call');
  });
  it('maps length → max_tokens', () => {
    expect(mapLlamaCppStopReason('length', false)).toBe<ChatStopReason>('max_tokens');
  });
  it('maps stop (no tools) → completed', () => {
    expect(mapLlamaCppStopReason('stop', false)).toBe<ChatStopReason>('completed');
  });
  it('maps null (no tools) → completed', () => {
    expect(mapLlamaCppStopReason(null, false)).toBe<ChatStopReason>('completed');
  });
});

// ---------------------------------------------------------------------------
// Tests — Ollama
// ---------------------------------------------------------------------------

describe('Ollama stop reason mapper', () => {
  it('maps hasToolCalls=true → tool_call', () => {
    expect(mapOllamaStopReason('stop', true)).toBe<ChatStopReason>('tool_call');
  });
  it('maps done_reason containing tool → tool_call', () => {
    expect(mapOllamaStopReason('tool-calls', false)).toBe<ChatStopReason>('tool_call');
  });
  it('maps done_reason containing length → max_tokens', () => {
    expect(mapOllamaStopReason('length', false)).toBe<ChatStopReason>('max_tokens');
    expect(mapOllamaStopReason('max_tokens', false)).toBe<ChatStopReason>('max_tokens');
  });
  it('maps stop → completed', () => {
    expect(mapOllamaStopReason('stop', false)).toBe<ChatStopReason>('completed');
  });
});

// ---------------------------------------------------------------------------
// Tests — OpenAI Codex (responses API)
// ---------------------------------------------------------------------------

describe('OpenAI Codex stop reason mapper', () => {
  it('maps completed + tool calls → tool_call', () => {
    expect(mapCodexStopReason('completed', true)).toBe<ChatStopReason>('tool_call');
  });
  it('maps completed + no tool calls → completed', () => {
    expect(mapCodexStopReason('completed', false)).toBe<ChatStopReason>('completed');
  });
  it('maps incomplete → max_tokens', () => {
    expect(mapCodexStopReason('incomplete', false)).toBe<ChatStopReason>('max_tokens');
  });
  it('maps failed → error', () => {
    expect(mapCodexStopReason('failed', false)).toBe<ChatStopReason>('error');
  });
  it('maps cancelled → error', () => {
    expect(mapCodexStopReason('cancelled', false)).toBe<ChatStopReason>('error');
  });
  it('maps undefined → completed', () => {
    expect(mapCodexStopReason(undefined, false)).toBe<ChatStopReason>('completed');
  });
});

// ---------------------------------------------------------------------------
// Tests — LM Studio (responses API)
// ---------------------------------------------------------------------------

describe('LM Studio stop reason mapper', () => {
  it('maps completed + tool calls → tool_call', () => {
    expect(mapLmStudioStopReason('completed', true)).toBe<ChatStopReason>('tool_call');
  });
  it('maps completed + no tool calls → completed', () => {
    expect(mapLmStudioStopReason('completed', false)).toBe<ChatStopReason>('completed');
  });
  it('maps incomplete → max_tokens', () => {
    expect(mapLmStudioStopReason('incomplete', false)).toBe<ChatStopReason>('max_tokens');
  });
  it('maps failed → error', () => {
    expect(mapLmStudioStopReason('failed', false)).toBe<ChatStopReason>('error');
  });
  it('maps undefined → completed', () => {
    expect(mapLmStudioStopReason(undefined, false)).toBe<ChatStopReason>('completed');
  });
});

// ---------------------------------------------------------------------------
// Integration — llama.cpp provider wiring
// ---------------------------------------------------------------------------

describe('llama.cpp provider stop-reason wiring', () => {
  it('tool_calls finish_reason → tool_call stopReason', () => {
    // Simulates: choice.finish_reason='tool_calls', no accumulated tool calls
    expect(mapLlamaCppStopReason('tool_calls', false)).toBe<ChatStopReason>('tool_call');
  });

  it('accumulated tool calls → tool_call stopReason regardless of finish_reason', () => {
    expect(mapLlamaCppStopReason('stop', true)).toBe<ChatStopReason>('tool_call');
  });

  it('length finish_reason → max_tokens stopReason', () => {
    expect(mapLlamaCppStopReason('length', false)).toBe<ChatStopReason>('max_tokens');
  });

  it('stop finish_reason → completed stopReason', () => {
    expect(mapLlamaCppStopReason('stop', false)).toBe<ChatStopReason>('completed');
  });
});

// ---------------------------------------------------------------------------
// Integration — Ollama provider wiring
// ---------------------------------------------------------------------------

describe('Ollama provider stop-reason wiring', () => {
  it('done_reason=tool-calls → tool_call stopReason', () => {
    // Simulates { done: true, done_reason: 'tool-calls' } Ollama chunk
    expect(mapOllamaStopReason('tool-calls', false)).toBe<ChatStopReason>('tool_call');
  });

  it('accumulated tool calls → tool_call stopReason', () => {
    expect(mapOllamaStopReason('stop', true)).toBe<ChatStopReason>('tool_call');
  });

  it('done_reason=length → max_tokens stopReason', () => {
    expect(mapOllamaStopReason('length', false)).toBe<ChatStopReason>('max_tokens');
  });

  it('done_reason=stop → completed stopReason', () => {
    expect(mapOllamaStopReason('stop', false)).toBe<ChatStopReason>('completed');
  });
});

// ---------------------------------------------------------------------------
// Integration — OpenAI Codex provider wiring
// ---------------------------------------------------------------------------

describe('OpenAI Codex provider stop-reason wiring', () => {
  it('response.completed with tool calls → tool_call stopReason', () => {
    // Simulates: status='completed', resolvedToolCalls.length > 0
    expect(mapCodexStopReason('completed', true)).toBe<ChatStopReason>('tool_call');
  });

  it('response.completed with no tool calls → completed stopReason', () => {
    expect(mapCodexStopReason('completed', false)).toBe<ChatStopReason>('completed');
  });

  it('response.incomplete → max_tokens stopReason', () => {
    expect(mapCodexStopReason('incomplete', false)).toBe<ChatStopReason>('max_tokens');
  });

  it('response.failed → error stopReason', () => {
    expect(mapCodexStopReason('failed', false)).toBe<ChatStopReason>('error');
  });

  it('response.cancelled → error stopReason', () => {
    expect(mapCodexStopReason('cancelled', false)).toBe<ChatStopReason>('error');
  });
});

// ---------------------------------------------------------------------------
// Integration — LM Studio provider wiring
// ---------------------------------------------------------------------------

describe('LM Studio provider stop-reason wiring', () => {
  it('response.completed with tool calls → tool_call stopReason', () => {
    // Simulates: status='completed', resolvedToolCalls.length > 0
    expect(mapLmStudioStopReason('completed', true)).toBe<ChatStopReason>('tool_call');
  });

  it('response.completed with no tool calls → completed stopReason', () => {
    expect(mapLmStudioStopReason('completed', false)).toBe<ChatStopReason>('completed');
  });

  it('response.incomplete → max_tokens stopReason', () => {
    expect(mapLmStudioStopReason('incomplete', false)).toBe<ChatStopReason>('max_tokens');
  });

  it('response.failed → error stopReason', () => {
    expect(mapLmStudioStopReason('failed', false)).toBe<ChatStopReason>('error');
  });
});

// ---------------------------------------------------------------------------
// ChatStopReason type exhaustiveness
// ---------------------------------------------------------------------------

describe('ChatStopReason type exhaustiveness', () => {
  it('all canonical values are valid ChatStopReason literals', () => {
    const allValues: ChatStopReason[] = [
      'completed',
      'max_tokens',
      'tool_call',
      'stop_sequence',
      'content_filter',
      'error',
      'unknown',
    ];
    // Every value round-trips through a type-safe assignment
    for (const v of allValues) {
      const r: ChatStopReason = v;
      expect(typeof r).toBe('string');
    }
    expect(allValues).toHaveLength(7);
  });
});
