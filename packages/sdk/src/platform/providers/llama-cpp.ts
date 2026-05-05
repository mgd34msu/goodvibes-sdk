import { withRetry } from '../utils/retry.js';
import { instrumentedLlmCall } from '../runtime/llm-observability.js';
import { ProviderError } from '../types/errors.js';
import type { ToolCall } from '../types/tools.js';
import type { ProviderCapability } from './capabilities.js';
import type {
  ChatRequest,
  ChatResponse,
  LLMProvider,
  PartialToolCall,
  ProviderEmbeddingRequest,
  ProviderEmbeddingResult,
  ProviderMessage,
  ProviderRuntimeMetadata,
  ProviderRuntimeMetadataDeps,
} from './interface.js';
import { OpenAICompatProvider, type OpenAICompatOptions } from './openai-compat.js';
import { mapLlamaCppStopReason } from './stop-reason-maps.js';
import { summarizeError, toProviderError } from '../utils/error-display.js';
import { instrumentedFetch } from '../utils/fetch-with-timeout.js';
import {
  extractTextToolCalls,
  fromOpenAIToolCalls,
  toOpenAIMessages,
  toOpenAITools,
  type OpenAIToolCall,
} from './tool-formats.js';

type NativeFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type LlamaCppChatCompletion = {
  choices?: Array<{
    finish_reason?: string | null | undefined;
    message?: {
      content?: unknown | undefined;
      reasoning?: unknown | undefined;
      reasoning_content?: unknown | undefined;
      tool_calls?: unknown | undefined;
    };
  }>;
  usage?: {
    prompt_tokens?: number | undefined;
    completion_tokens?: number | undefined;
    prompt_tokens_details?: {
      cached_tokens?: number | undefined;
    };
  };
};

export interface LlamaCppProviderOptions extends OpenAICompatOptions {
  nativeFetch?: NativeFetch | undefined;
  compatProvider?: LLMProvider | undefined;
}

export class LlamaCppProvider implements LLMProvider {
  readonly name: string;
  readonly models: string[];
  readonly capabilities?: Partial<ProviderCapability> | undefined;

  private readonly defaultModel: string;
  private readonly reasoningFormat: OpenAICompatOptions['reasoningFormat'];
  private readonly nativeChatUrl: string;
  private readonly nativeFetch: NativeFetch;
  private readonly compatProvider: LLMProvider;
  private readonly apiKey: string;
  private readonly defaultHeaders?: Record<string, string> | undefined;

  constructor(opts: LlamaCppProviderOptions) {
    this.name = opts.name;
    this.models = opts.models;
    this.capabilities = opts.capabilities;
    this.defaultModel = opts.defaultModel;
    this.reasoningFormat = opts.reasoningFormat ?? 'none';
    this.nativeChatUrl = deriveLlamaCppChatUrl(opts.baseURL);
    this.nativeFetch = opts.nativeFetch ?? instrumentedFetch;
    this.compatProvider = opts.compatProvider ?? new OpenAICompatProvider(opts);
    this.apiKey = opts.apiKey;
    this.defaultHeaders = opts.defaultHeaders;
  }

  isConfigured(): boolean {
    return this.compatProvider.isConfigured?.() ?? true;
  }

  async chat(params: ChatRequest): Promise<ChatResponse> {
    return (await instrumentedLlmCall(
      () => withRetry(async () => {
      if (!shouldUseNonStreamingLlamaCpp(params)) {
        return this.compatProvider.chat(params);
      }
      return this.chatViaNonStreamingCompat(params, params.model || this.defaultModel);
    }), { provider: this.name, model: params.model || this.defaultModel })).result;
  }

  async embed(request: ProviderEmbeddingRequest): Promise<ProviderEmbeddingResult> {
    if (!this.compatProvider.embed) {
      throw new ProviderError('llama.cpp OpenAI-compatible transport does not support embeddings.', {
        statusCode: 501,
        provider: this.name,
        operation: 'embed',
        phase: 'response',
      });
    }
    return this.compatProvider.embed(request);
  }

  async describeRuntime(deps: ProviderRuntimeMetadataDeps): Promise<ProviderRuntimeMetadata> {
    const { buildStandardProviderAuthRoutes } = await import('./runtime-metadata.js');
    const authRoutes = await buildStandardProviderAuthRoutes({
      providerId: this.name,
      allowAnonymous: !this.apiKey,
      anonymousConfigured: !this.apiKey,
      anonymousDetail: 'Local llama.cpp servers are often exposed without authentication.',
    }, deps);
    return {
      auth: {
        mode: this.apiKey ? 'api-key' : 'anonymous',
        configured: true,
        detail: this.apiKey
          ? 'llama.cpp OpenAI-compatible endpoint has an API key configured.'
          : 'llama.cpp OpenAI-compatible endpoint is running without an API key.',
        routes: authRoutes,
      },
      models: {
        defaultModel: this.defaultModel,
        models: this.models,
      },
      usage: {
        streaming: true,
        toolCalling: true,
        parallelTools: true,
        promptCaching: false,
        notes: ['llama.cpp uses a non-streaming recovery path for tool turns and delegates embeddings to the configured embedding provider.'],
      },
      policy: {
        local: true,
        streamProtocol: 'openai-chat-completions',
        reasoningMode: this.reasoningFormat ?? 'provider-default',
        supportedReasoningEfforts: ['instant', 'low', 'medium', 'high'],
        cacheStrategy: 'provider-managed',
      },
    };
  }

  private async chatViaNonStreamingCompat(
    params: ChatRequest,
    model: string,
  ): Promise<ChatResponse> {
    const extraBody = buildReasoningBody(this.reasoningFormat, params.reasoningEffort);
    const body: Record<string, unknown> = {
      model,
      messages: toOpenAIMessages(params.messages, params.systemPrompt),
      ...(params.tools && params.tools.length > 0 ? { tools: toOpenAITools(params.tools) } : {}),
      ...(params.maxTokens ? { max_tokens: params.maxTokens } : {}),
      stream: false,
      ...extraBody,
    };

    let response: Response;
    try {
      response = await this.nativeFetch(this.nativeChatUrl, {
        method: 'POST',
        headers: buildHeaders(this.apiKey, this.defaultHeaders),
        body: JSON.stringify(body),
        ...(params.signal !== undefined ? { signal: params.signal } : {}),
      } as RequestInit);
    } catch (err: unknown) {
      throw normalizeProviderError(err, this.name, 'chat', 'request');
    }

    if (!response.ok) {
      throw await buildHttpError('llama.cpp chat', response, this.name, 'chat', 'request');
    }

    let payload: LlamaCppChatCompletion;
    try {
      payload = await response.json() as LlamaCppChatCompletion;
    } catch (err: unknown) {
      throw new ProviderError(
        `llama.cpp chat returned invalid JSON: ${summarizeError(err)}`,
        {
          statusCode: 502,
          provider: this.name,
          operation: 'chat',
          phase: 'response',
        },
      );
    }

    const choice = payload.choices?.[0];
    const message = choice?.message ?? {};
    const reasoningText = extractMessageText(message.reasoning_content) ?? extractMessageText(message.reasoning) ?? '';
    let responseText = extractMessageText(message.content) ?? '';
    let structuredToolCalls = normalizeOpenAIToolCalls(message.tool_calls);
    let finalToolCalls = structuredToolCalls.length > 0 ? fromOpenAIToolCalls(structuredToolCalls) : [];

    if (reasoningText) {
      params.onDelta?.({ reasoning: reasoningText });
    }

    if (structuredToolCalls.length > 0) {
      emitToolCallDeltas(structuredToolCalls, params);
    }

    if (finalToolCalls.length === 0 && (responseText.includes('<|toolcallbegin|>') || responseText.includes('<|tool_call_begin|>'))) {
      const extracted = extractTextToolCalls(responseText);
      if (extracted.toolCalls.length > 0) {
        finalToolCalls = extracted.toolCalls;
        responseText = extracted.cleanedContent;
        emitToolCallDeltas(
          finalToolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: {
              name: call.name,
              arguments: JSON.stringify(call.arguments),
            },
          })),
          params,
        );
      }
    }

    if (responseText) {
      params.onDelta?.({ content: responseText });
    }

    const stopReason = mapLlamaCppStopReason(choice?.finish_reason, finalToolCalls.length > 0);

    const rawStopReason = choice?.finish_reason ?? undefined;
    return {
      content: responseText,
      toolCalls: finalToolCalls,
      usage: {
        inputTokens: payload.usage?.prompt_tokens ?? 0,
        outputTokens: payload.usage?.completion_tokens ?? 0,
        ...(typeof payload.usage?.prompt_tokens_details?.cached_tokens === 'number'
          ? { cacheReadTokens: payload.usage.prompt_tokens_details.cached_tokens }
          : {}),
      },
      stopReason,
      ...(rawStopReason !== undefined ? { providerStopReason: rawStopReason } : {}),
    };
  }
}

function shouldUseNonStreamingLlamaCpp(params: ChatRequest): boolean {
  if ((params.tools?.length ?? 0) > 0) return true;
  return params.messages.some((message) => (
    message.role === 'tool'
    || (message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0)
  ));
}

function deriveLlamaCppChatUrl(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/, '');
  if (trimmed.endsWith('/chat/completions')) return trimmed;
  if (trimmed.endsWith('/v1')) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

function buildReasoningBody(
  reasoningFormat: OpenAICompatOptions['reasoningFormat'],
  reasoningEffort: ChatRequest['reasoningEffort'],
): Record<string, unknown> {
  if (reasoningFormat === 'llamacpp') {
    return {
      enable_thinking: reasoningEffort !== undefined && reasoningEffort !== 'instant',
    };
  }
  if (reasoningFormat === 'openrouter' && reasoningEffort) {
    return { reasoning: { effort: reasoningEffort } };
  }
  if (reasoningFormat === 'mercury' && reasoningEffort) {
    return { reasoning_effort: reasoningEffort };
  }
  return {};
}

function buildHeaders(
  apiKey: string,
  defaultHeaders?: Record<string, string>,
): Record<string, string> {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    ...(defaultHeaders ?? {}),
  };
}

function extractMessageText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return null;

  const fragments: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      fragments.push(entry);
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const text = record.text ?? record.content ?? record.delta;
    if (typeof text === 'string' && text.length > 0) {
      fragments.push(text);
    }
  }
  return fragments.length > 0 ? fragments.join('') : null;
}

function normalizeOpenAIToolCalls(value: unknown): OpenAIToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    const fn = record.function;
    if (!fn || typeof fn !== 'object') return [];
    const functionRecord = fn as Record<string, unknown>;
    const name = typeof functionRecord.name === 'string' ? functionRecord.name : '';
    if (!name) return [];
    const rawArguments = functionRecord.arguments;
    const argumentsText = typeof rawArguments === 'string'
      ? rawArguments
      : JSON.stringify(rawArguments ?? {});
    return [{
      id: typeof record.id === 'string' && record.id.length > 0 ? record.id : `llamacpp_call_${index}`,
      type: 'function' as const,
      function: {
        name,
        arguments: argumentsText,
      },
    }];
  });
}

function emitToolCallDeltas(
  toolCalls: OpenAIToolCall[],
  params: ChatRequest,
): void {
  toolCalls.forEach((toolCall, index) => {
    const partial: PartialToolCall = {
      index,
      id: toolCall.id,
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
    };
    params.onDelta?.({ toolCalls: [partial] });
  });
}

async function buildHttpError(
  prefix: string,
  response: Response,
  provider: string,
  operation: string,
  phase: string,
): Promise<ProviderError> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const error = toRecord(parsed.error);
    if (Object.keys(error).length > 0) {
      const code = typeof error.code === 'string' ? `${error.code}: ` : '';
      const message = typeof error.message === 'string' ? error.message : text;
      return new ProviderError(`${prefix} error ${response.status}: ${code}${message}`, {
        statusCode: response.status,
        provider,
        operation,
        phase,
      });
    }
  } catch {
    // fall through
  }
  return new ProviderError(`${prefix} error ${response.status}: ${text || response.statusText}`, {
    statusCode: response.status,
    provider,
    operation,
    phase,
  });
}

function normalizeProviderError(err: unknown, provider: string, operation: string, phase = 'request'): ProviderError {
  const status = getErrorStatus(err);
  return toProviderError(err, {
    ...(status !== undefined ? { statusCode: status } : {}),
    provider,
    operation,
    phase,
  });
}

function getErrorStatus(err: unknown): number | undefined {
  if (err && typeof err === 'object') {
    const record = err as { status?: unknown; statusCode?: unknown };
    if (typeof record.status === 'number') return record.status;
    if (typeof record.statusCode === 'number') return record.statusCode;
  }
  return undefined;
}

function getErrorMessage(err: unknown): string {
  return summarizeError(err);
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}
