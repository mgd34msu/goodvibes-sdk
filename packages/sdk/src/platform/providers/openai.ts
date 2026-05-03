import OpenAI, { toFile } from 'openai';
import type {
  LLMProvider,
  ChatRequest,
  ChatResponse,
  ChatStopReason,
  ProviderEmbeddingRequest,
  ProviderEmbeddingResult,
  ProviderBatchAdapter,
  ProviderBatchCreateInput,
  ProviderBatchCreateResult,
  ProviderBatchPollResult,
  ProviderBatchResult,
  ProviderRuntimeMetadata,
  ProviderRuntimeMetadataDeps,
} from './interface.js';

import { mapOpenAIStopReason } from './stop-reason-maps.js';
import { ProviderError } from '../types/errors.js';
import { withRetry } from '../utils/retry.js';
import {
  toOpenAITools,
  toOpenAIMessages,
  fromOpenAIToolCalls,
  extractTextToolCalls,
} from './tool-formats.js';
import type { OpenAIToolCall } from './tool-formats.js';
import type { CacheHitTracker } from './cache-strategy.js';
import { extractOpenAIStreamTextDelta } from './openai-stream-delta.js';
import { summarizeError, toProviderError } from '../utils/error-display.js';

const NOOP_CACHE_HIT_TRACKER: Pick<CacheHitTracker, 'recordTurn'> = {
  recordTurn: () => {},
};

/**
 * OpenAIProvider — wraps the official `openai` npm package.
 * Supports GPT-5 family models with full function/tool calling.
 */
export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';
  readonly models: string[] = [];
  readonly batch: ProviderBatchAdapter;

  private client: OpenAI;
  private readonly apiKey: string;
  private readonly embeddingModel = 'text-embedding-3-small';
  private readonly cacheHitTracker: Pick<CacheHitTracker, 'recordTurn'>;

  constructor(apiKey: string, cacheHitTracker: Pick<CacheHitTracker, 'recordTurn'> = NOOP_CACHE_HIT_TRACKER) {
    this.apiKey = apiKey;
    this.client = new OpenAI({ apiKey });
    this.cacheHitTracker = cacheHitTracker;
    this.batch = {
      kind: 'provider-batch',
      endpoints: ['/v1/chat/completions'],
      createChatBatch: (input) => this.createChatBatch(input),
      retrieveBatch: (providerBatchId) => this.retrieveBatch(providerBatchId),
      cancelBatch: (providerBatchId) => this.cancelBatch(providerBatchId),
      getResults: (providerBatchId) => this.getBatchResults(providerBatchId),
    };
  }

  async chat(params: ChatRequest): Promise<ChatResponse> {
    const { messages, tools, model, maxTokens, signal, systemPrompt, onDelta, reasoningEffort: _reasoningEffort } = params;
    // Note: OpenAI GPT-5 does not expose reasoning effort as a configurable API parameter

    return withRetry(async () => {
      let responseText = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheReadTokens = 0;
      let rawStopReason: string | undefined;
      let stopReason: ChatStopReason = 'unknown';
      let rawToolCalls: OpenAIToolCall[] = [];

      const openaiMessages = toOpenAIMessages(messages, systemPrompt);
      const openaiTools = tools && tools.length > 0 ? toOpenAITools(tools) : undefined;

      try {
        const stream = await this.client.chat.completions.create(
          {
            model,
            messages: openaiMessages as Parameters<typeof this.client.chat.completions.create>[0]['messages'],
            ...(openaiTools ? { tools: openaiTools as Parameters<typeof this.client.chat.completions.create>[0]['tools'] } : {}),
            ...(maxTokens ? { max_tokens: maxTokens } : {}),
            stream: true,
            stream_options: { include_usage: true },
          },
          { signal },
        );

        const accToolCalls: Map<number, { id: string; name: string; args: string }> = new Map();

        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta;
          const textDelta = extractOpenAIStreamTextDelta(chunk);
          for (const contentDelta of textDelta.content) {
            responseText += contentDelta;
            if (onDelta) onDelta({ content: contentDelta });
          }
          for (const reasoningDelta of textDelta.reasoning) {
            if (onDelta) onDelta({ reasoning: reasoningDelta });
          }

          // Accumulate streaming tool_calls deltas
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (!accToolCalls.has(idx)) {
                accToolCalls.set(idx, { id: tc.id ?? '', name: tc.function?.name ?? '', args: '' });
              }
              const entry = accToolCalls.get(idx)!;
              if (tc.id) entry.id = tc.id;
              if (tc.function?.name) entry.name = tc.function.name;
              if (tc.function?.arguments) entry.args += tc.function.arguments;
              if (onDelta) {
                onDelta({ toolCalls: [{ index: idx, id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments }] });
              }
            }
          }

          const finishReason = chunk.choices[0]?.finish_reason;
          if (finishReason) {
            rawStopReason = finishReason;
            stopReason = mapOpenAIStopReason(finishReason);
          }

          const usage = (chunk as { usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } }).usage;
          if (usage) {
            inputTokens = usage.prompt_tokens ?? 0;
            outputTokens = usage.completion_tokens ?? 0;
            cacheReadTokens = usage.prompt_tokens_details?.cached_tokens ?? cacheReadTokens;
          }
        }

        // Finalise accumulated tool calls
        for (const [, tc] of [...accToolCalls.entries()].sort(([a], [b]) => a - b)) {
          rawToolCalls.push({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.args },
          });
        }
      } catch (err: unknown) {
        const { hasStatus } = await import('../utils/retry.js');
        const status = hasStatus(err) ? err.status : undefined;
        throw toProviderError(err, {
          ...(status !== undefined ? { statusCode: status } : {}),
          provider: this.name,
          operation: 'chat',
          phase: 'stream',
        });
      }

      // Some models may emit tool calls as raw text tokens instead of the
      // OpenAI function-calling wire format. Fall back to text extraction.
      let toolCalls = rawToolCalls.length > 0 ? fromOpenAIToolCalls(rawToolCalls) : [];
      if (toolCalls.length === 0 && (responseText.includes('<|toolcallbegin|>') || responseText.includes('<|tool_call_begin|>'))) {
        const extracted = extractTextToolCalls(responseText);
        if (extracted.toolCalls.length > 0) {
          toolCalls = extracted.toolCalls;
          responseText = extracted.cleanedContent;
          stopReason = 'tool_call';
          rawStopReason = rawStopReason ?? 'tool_calls';
        }
      }

      this.cacheHitTracker.recordTurn({
        inputTokens,
        cacheReadTokens,
      });

      return {
        content: responseText,
        toolCalls,
        usage: {
          inputTokens,
          outputTokens,
          ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
        },
        stopReason: stopReason === 'unknown' && responseText ? 'completed' : stopReason,
        ...(rawStopReason !== undefined ? { providerStopReason: rawStopReason } : {}),
      };
    });
  }

  async embed(request: ProviderEmbeddingRequest): Promise<ProviderEmbeddingResult> {
    let response;
    try {
      response = await this.client.embeddings.create(
        {
          model: request.model ?? this.embeddingModel,
          input: request.text,
          ...(request.dimensions ? { dimensions: request.dimensions } : {}),
        },
        request.signal ? { signal: request.signal } : undefined,
      );
    } catch (error: unknown) {
      throw toProviderError(error, {
        provider: this.name,
        operation: 'embed',
        phase: 'request',
      });
    }
    const embedding = response.data[0]?.embedding ?? [];
    return {
      vector: Float32Array.from(embedding),
      dimensions: embedding.length,
      modelId: response.model,
      metadata: {
        usage: request.usage,
        provider: this.name,
      },
    };
  }

  isConfigured(): boolean {
    return this.apiKey.trim().length > 0;
  }

  async describeRuntime(deps: ProviderRuntimeMetadataDeps): Promise<ProviderRuntimeMetadata> {
    const configured = Boolean(process.env.OPENAI_API_KEY || process.env.OPENAI_KEY);
    const { buildStandardProviderAuthRoutes } = await import('./runtime-metadata.js');
    const authRoutes = await buildStandardProviderAuthRoutes({
      providerId: 'openai',
      apiKeyEnvVars: ['OPENAI_API_KEY', 'OPENAI_KEY'],
      serviceNames: ['openai'],
      subscriptionProviderId: 'openai',
    }, deps);
    return {
      auth: {
        mode: 'api-key',
        configured,
        detail: configured ? 'OpenAI API key available' : 'OPENAI_API_KEY or OPENAI_KEY not set',
        envVars: ['OPENAI_API_KEY', 'OPENAI_KEY'],
        routes: authRoutes,
      },
      models: {
        models: this.models,
        embeddingModel: this.embeddingModel,
        embeddingDimensions: 384,
      },
      usage: {
        streaming: true,
        toolCalling: true,
        parallelTools: true,
        batch: {
          supported: true,
          discount: 'Provider-side Batch API pricing is discounted versus live API pricing where OpenAI offers the discount.',
          completionWindow: '24h',
          endpoints: ['/v1/chat/completions'],
          maxRequestsPerProviderBatch: 50_000,
          maxInputBytes: 200 * 1024 * 1024,
          notes: ['Batch requests are asynchronous and non-streaming. Results are correlated by custom_id.'],
        },
        notes: ['Embeddings use the OpenAI embeddings API.'],
      },
      policy: {
        local: false,
        streamProtocol: 'openai-chat-completions',
        reasoningMode: 'provider-default',
        cacheStrategy: 'implicit-openai-cache-observation',
        notes: ['OpenAI embedding usage is subject to OpenAI API terms.'],
      },
    };
  }

  private async createChatBatch(input: ProviderBatchCreateInput): Promise<ProviderBatchCreateResult> {
    const lines = input.requests.map((request) => JSON.stringify({
      custom_id: request.customId,
      method: 'POST',
      url: '/v1/chat/completions',
      body: this.toOpenAIBatchChatBody(request.params),
    })).join('\n') + '\n';
    const file = await this.client.files.create({
      file: await toFile(new Blob([lines], { type: 'application/jsonl' }), 'goodvibes-openai-chat-batch.jsonl'),
      purpose: 'batch',
    });
    const metadata = input.metadata && Object.keys(input.metadata).length > 0 ? input.metadata : undefined;
    const batch = await this.client.batches.create({
      input_file_id: file.id,
      endpoint: '/v1/chat/completions',
      completion_window: input.completionWindow ?? '24h',
      ...(metadata ? { metadata } : {}),
    });
    return {
      providerBatchId: batch.id,
      status: this.mapOpenAIBatchStatus(batch.status),
      raw: batch,
    };
  }

  private async retrieveBatch(providerBatchId: string): Promise<ProviderBatchPollResult> {
    const batch = await this.client.batches.retrieve(providerBatchId);
    return {
      providerBatchId: batch.id,
      status: this.mapOpenAIBatchStatus(batch.status),
      resultAvailable: typeof batch.output_file_id === 'string' || typeof batch.error_file_id === 'string',
      raw: batch,
    };
  }

  private async cancelBatch(providerBatchId: string): Promise<ProviderBatchPollResult> {
    const batch = await this.client.batches.cancel(providerBatchId);
    return {
      providerBatchId: batch.id,
      status: this.mapOpenAIBatchStatus(batch.status),
      resultAvailable: typeof batch.output_file_id === 'string' || typeof batch.error_file_id === 'string',
      raw: batch,
    };
  }

  private async getBatchResults(providerBatchId: string): Promise<readonly ProviderBatchResult[]> {
    const batch = await this.client.batches.retrieve(providerBatchId);
    const results: ProviderBatchResult[] = [];
    if (typeof batch.output_file_id === 'string' && batch.output_file_id.length > 0) {
      results.push(...await this.readOpenAIBatchResultFile(batch.output_file_id, false));
    }
    if (typeof batch.error_file_id === 'string' && batch.error_file_id.length > 0) {
      results.push(...await this.readOpenAIBatchResultFile(batch.error_file_id, true));
    }
    return results;
  }

  private toOpenAIBatchChatBody(params: Omit<ChatRequest, 'signal' | 'onDelta'>): Record<string, unknown> {
    const openaiMessages = toOpenAIMessages(params.messages, params.systemPrompt);
    const openaiTools = params.tools && params.tools.length > 0 ? toOpenAITools(params.tools) : undefined;
    return {
      model: params.model,
      messages: openaiMessages,
      ...(openaiTools ? { tools: openaiTools } : {}),
      ...(params.maxTokens ? { max_tokens: params.maxTokens } : {}),
      stream: false,
    };
  }

  private mapOpenAIBatchStatus(status: string): ProviderBatchPollResult['status'] {
    if (status === 'completed') return 'completed';
    if (status === 'failed') return 'failed';
    if (status === 'cancelled' || status === 'cancelling') return 'cancelled';
    if (status === 'expired') return 'expired';
    if (status === 'in_progress' || status === 'finalizing') return 'running';
    return 'submitted';
  }

  private async readOpenAIBatchResultFile(fileId: string, forceFailed: boolean): Promise<ProviderBatchResult[]> {
    const response = await this.client.files.content(fileId);
    const text = await response.text();
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
    const results: ProviderBatchResult[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        results.push(this.parseOpenAIBatchResult(parsed, forceFailed));
      } catch (error: unknown) {
        results.push({
          customId: `unparseable:${crypto.randomUUID()}`,
          status: 'failed',
          error: {
            message: `Unable to parse OpenAI batch result line: ${summarizeError(error)}`,
          },
          raw: line,
        });
      }
    }
    return results;
  }

  private parseOpenAIBatchResult(parsed: Record<string, unknown>, forceFailed: boolean): ProviderBatchResult {
    const customId = typeof parsed['custom_id'] === 'string' ? parsed['custom_id'] : `unknown:${crypto.randomUUID()}`;
    const response = toRecord(parsed['response']);
    const statusCode = typeof response['status_code'] === 'number' ? response['status_code'] : 0;
    const body = toRecord(response['body']);
    const error = parsed['error'] ?? body['error'];
    if (forceFailed || statusCode >= 400 || error !== undefined) {
      const errorRecord = toRecord(error);
      return {
        customId,
        status: 'failed',
        error: {
          message: typeof errorRecord['message'] === 'string' ? errorRecord['message'] : `OpenAI batch request failed${statusCode ? ` with status ${statusCode}` : ''}`,
          ...(typeof errorRecord['code'] === 'string' ? { code: errorRecord['code'] } : {}),
          raw: error ?? parsed,
        },
        raw: parsed,
      };
    }
    return {
      customId,
      status: 'succeeded',
      response: this.openAIBatchBodyToChatResponse(body),
      raw: parsed,
    };
  }

  private openAIBatchBodyToChatResponse(body: Record<string, unknown>): ChatResponse {
    const choices = Array.isArray(body['choices']) ? body['choices'] : [];
    const firstChoice = toRecord(choices[0]);
    const message = toRecord(firstChoice['message']);
    const content = message['content'];
    const responseText = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((part) => {
            const record = toRecord(part);
            return typeof record['text'] === 'string' ? record['text'] : '';
          }).join('')
        : '';
    const rawToolCalls = Array.isArray(message['tool_calls'])
      ? message['tool_calls'].map((entry) => toRecord(entry) as unknown as OpenAIToolCall)
      : [];
    const usage = toRecord(body['usage']);
    const promptDetails = toRecord(usage['prompt_tokens_details']);
    const rawFinishReason = typeof firstChoice['finish_reason'] === 'string' ? firstChoice['finish_reason'] : undefined;
    const stopReason = rawFinishReason ? mapOpenAIStopReason(rawFinishReason) : (responseText ? 'completed' : 'unknown');
    return {
      content: responseText,
      toolCalls: rawToolCalls.length > 0 ? fromOpenAIToolCalls(rawToolCalls) : [],
      usage: {
        inputTokens: typeof usage['prompt_tokens'] === 'number' ? usage['prompt_tokens'] : 0,
        outputTokens: typeof usage['completion_tokens'] === 'number' ? usage['completion_tokens'] : 0,
        ...(typeof promptDetails['cached_tokens'] === 'number' && promptDetails['cached_tokens'] > 0
          ? { cacheReadTokens: promptDetails['cached_tokens'] }
          : {}),
      },
      stopReason,
      ...(rawFinishReason ? { providerStopReason: rawFinishReason } : {}),
    };
  }
}

function toRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
