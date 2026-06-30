import type { ChatStopReason, StreamDelta } from './interface.js';
import type { AnthropicContentBlock } from './tool-formats.js';
import { mapAnthropicStopReason } from './stop-reason-maps.js';
import { fromAnthropicContent, parseToolCallArguments } from './tool-formats.js';
import { logger } from '../utils/logger.js';
import { SseLineBuffer } from './sse-line-buffer.js';

/** Anthropic SSE event shape (wire format from both direct API and compat endpoints). */
export interface AnthropicSSEEvent {
  type: string;
  index?: number | undefined;
  delta?: {
    type?: string | undefined;
    text?: string | undefined;
    thinking?: string | undefined;
    partial_json?: string | undefined;
    stop_reason?: string | null | undefined;
  };
  content_block?: {
    type: string;
    id?: string | undefined;
    name?: string | undefined;
  };
  message?: {
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number | undefined;
      cache_creation_input_tokens?: number | undefined;
    };
  };
  usage?: {
    input_tokens?: number | undefined;
    output_tokens?: number | undefined;
    cache_read_input_tokens?: number | undefined;
    cache_creation_input_tokens?: number | undefined;
  };
}

/** Mutable accumulator for a single Anthropic streaming response. */
export interface AnthropicSSEState {
  responseText: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  rawStopReason: string | undefined;
  stopReason: ChatStopReason;
  toolBlocks: Map<number, { id: string; name: string; args: string }>;
}

/** Create a fresh zero-valued SSE accumulator. */
export function createAnthropicSSEState(): AnthropicSSEState {
  return {
    responseText: '',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    rawStopReason: undefined,
    stopReason: 'unknown',
    toolBlocks: new Map(),
  };
}

/**
 * Dispatch one Anthropic SSE event into the accumulator.
 * Mutates state in place and calls onDelta for real-time delivery.
 */
export function processAnthropicSSEEvent(
  event: AnthropicSSEEvent,
  state: AnthropicSSEState,
  onDelta: ((delta: StreamDelta) => void) | undefined,
): void {
  if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
    const idx = event.index ?? 0;
    state.toolBlocks.set(idx, {
      id: event.content_block.id ?? '',
      name: event.content_block.name ?? '',
      args: '',
    });
    if (onDelta) {
      onDelta({ toolCalls: [{ index: idx, id: event.content_block.id, name: event.content_block.name }] });
    }
  } else if (event.type === 'content_block_delta') {
    const idx = event.index ?? 0;
    if (event.delta?.type === 'text_delta' && event.delta.text) {
      state.responseText += event.delta.text;
      if (onDelta) onDelta({ content: event.delta.text });
    } else if (event.delta?.type === 'thinking_delta' && event.delta.thinking) {
      if (onDelta) onDelta({ reasoning: event.delta.thinking });
    } else if (event.delta?.type === 'input_json_delta' && event.delta.partial_json) {
      const block = state.toolBlocks.get(idx);
      if (block) block.args += event.delta.partial_json;
      if (onDelta) {
        onDelta({ toolCalls: [{ index: idx, arguments: event.delta.partial_json }] });
      }
    }
  } else if (event.type === 'message_delta') {
    if (event.delta?.stop_reason) {
      state.rawStopReason = event.delta.stop_reason;
      state.stopReason = mapAnthropicStopReason(state.rawStopReason);
    }
    if (event.usage?.output_tokens) state.outputTokens = event.usage.output_tokens;
    if (event.usage?.cache_read_input_tokens != null) state.cacheReadTokens = event.usage.cache_read_input_tokens;
    if (event.usage?.cache_creation_input_tokens != null) state.cacheWriteTokens = event.usage.cache_creation_input_tokens;
  } else if (event.type === 'message_start') {
    if (event.message?.usage) {
      state.inputTokens = event.message.usage.input_tokens;
      state.outputTokens = event.message.usage.output_tokens;
      state.cacheReadTokens = event.message.usage.cache_read_input_tokens ?? 0;
      state.cacheWriteTokens = event.message.usage.cache_creation_input_tokens ?? 0;
    }
  }
}

/**
 * Read an Anthropic SSE stream to completion, dispatching each event through
 * processAnthropicSSEEvent. Uses SseLineBuffer for correct CRLF handling.
 *
 * @param reader       ReadableStream reader from the fetch response body.
 * @param state        Accumulator to mutate (created with createAnthropicSSEState).
 * @param onDelta      Optional streaming delta callback.
 * @param providerLabel Used in warn logs, e.g. 'Anthropic' or 'AnthropicCompat(my-proxy)'.
 */
export async function readAnthropicSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  state: AnthropicSSEState,
  onDelta: ((delta: StreamDelta) => void) | undefined,
  providerLabel: string,
): Promise<void> {
  const sseBuffer = new SseLineBuffer();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of sseBuffer.feed(value)) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data || data === '[DONE]') continue;
        let event: AnthropicSSEEvent;
        try {
          event = JSON.parse(data) as AnthropicSSEEvent;
        } catch {
          logger.warn(`${providerLabel} SSE: failed to parse JSON chunk`, {
            chunkPreview: data.slice(0, 200),
            chunkLength: data.length,
          });
          continue;
        }
        processAnthropicSSEEvent(event, state, onDelta);
      }
    }
    // Drain any bytes left after the last newline: servers (notably home-grown
    // anthropic-compat proxies) may close the connection right after a final
    // `data: {...}` line with no trailing newline, which would otherwise drop the
    // closing message_delta (stop_reason + usage). flush() returns [] for
    // newline-terminated streams, so this is a no-op for compliant servers.
    for (const line of sseBuffer.flush()) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (!data || data === '[DONE]') continue;
      let event: AnthropicSSEEvent;
      try {
        event = JSON.parse(data) as AnthropicSSEEvent;
      } catch {
        logger.warn(`${providerLabel} SSE: failed to parse JSON chunk`, {
          chunkPreview: data.slice(0, 200),
          chunkLength: data.length,
        });
        continue;
      }
      processAnthropicSSEEvent(event, state, onDelta);
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Assemble the final content + toolCalls from accumulated streaming state.
 * Sorts tool blocks by stream index, parses JSON arguments, and calls
 * fromAnthropicContent to produce the canonical response shape.
 *
 * @param fallbackBlocks Used by the SDK provider: if no streaming content was
 *   accumulated, fall back to finalMessage.content instead of returning empty.
 */
export function assembleAnthropicContentBlocks(
  toolBlocks: Map<number, { id: string; name: string; args: string }>,
  responseText: string,
  providerName: string,
  fallbackBlocks?: AnthropicContentBlock[],
): ReturnType<typeof fromAnthropicContent> {
  const contentBlocks: AnthropicContentBlock[] = [];
  if (responseText) {
    contentBlocks.push({ type: 'text', text: responseText } as AnthropicContentBlock);
  }
  for (const [, block] of [...toolBlocks.entries()].sort(([a], [b]) => a - b)) {
    const parsedInput = parseToolCallArguments(block.args, {
      provider: providerName,
      toolName: block.name,
      callId: block.id,
    });
    if (parsedInput === undefined) continue;
    contentBlocks.push({
      type: 'tool_use',
      id: block.id,
      name: block.name,
      input: parsedInput,
    } as AnthropicContentBlock);
  }
  const target = contentBlocks.length > 0 ? contentBlocks : (fallbackBlocks ?? []);
  return fromAnthropicContent(target);
}
