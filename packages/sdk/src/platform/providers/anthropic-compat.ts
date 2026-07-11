import type {
  LLMProvider,
  ChatRequest,
  ChatResponse,
  ChatStopReason,
  ProviderRuntimeMetadata,
  ProviderRuntimeMetadataDeps,
} from './interface.js';
import { applyAnthropicThinking } from './anthropic-stream.js';
import { ProviderError } from '../types/errors.js';
import { withRetry, type RetryConfig } from '../utils/retry.js';
import { instrumentedLlmCall } from '../runtime/llm-observability.js';
import {
  toAnthropicTools,
  toAnthropicMessages,
} from './tool-formats.js';
import { toProviderError } from '../utils/error-display.js';
import { createAnthropicSSEState, readAnthropicSSEStream, assembleAnthropicContentBlocks } from './anthropic-sse-assembler.js';
import { resolveCompletedStopReason, withProviderStopReason } from './provider-stop-reason.js';
import { parseRateLimitHeaders } from './rate-limit-headers.js';
import { instrumentedFetch } from '../utils/fetch-with-timeout.js';

const ANTHROPIC_API_VERSION = '2023-06-01';


export interface AnthropicCompatOptions {
  /** Unique provider identifier, e.g. 'my-anthropic-proxy' */
  name: string;
  /** Base URL for the Anthropic Messages API, e.g. 'https://my-proxy.example.com/v1' */
  baseURL: string;
  /** API key sent as the x-api-key header */
  apiKey: string;
  /** Model ID to use when none is specified in ChatRequest */
  defaultModel: string;
  /** List of model IDs exposed by this provider */
  models: string[];
  /** Optional extra HTTP headers sent with every request */
  defaultHeaders?: Record<string, string> | undefined;
  /** Optional env vars or secret keys that can satisfy auth for this provider. */
  authEnvVars?: readonly string[] | undefined;
  /** Optional service names that expose service-owned OAuth for this provider. */
  serviceNames?: readonly string[] | undefined;
  /** Optional provider aliases exposed to runtime metadata consumers. */
  aliases?: readonly string[] | undefined;
  /** Optional subscription-provider identity when this provider can use a stored OAuth session. */
  subscriptionProviderId?: string | undefined;
  /** Optional explicit stream protocol label for diagnostics. */
  streamProtocol?: string | undefined;
  /** Optional auth header mode. Default: x-api-key. */
  authHeaderMode?: 'x-api-key' | 'bearer' | undefined;
  /** Optional anonymous/local access posture. */
  allowAnonymous?: boolean | undefined;
  anonymousConfigured?: boolean | undefined;
  anonymousDetail?: string | undefined;
  /**
   * Optional overrides for the transport-level retry backoff (maxRetries /
   * initialDelayMs / maxDelayMs). Defaults to withRetry's DEFAULT_CONFIG when
   * omitted. Exposed so operators can tune backoff and so tests can drive the
   * retry path with a deterministic zero-delay clock instead of real wall-clock
   * sleeps.
   */
  retryConfig?: Partial<RetryConfig> | undefined;
}

/**
 * AnthropicCompatProvider — generic provider for endpoints that speak the
 * Anthropic Messages API (SSE streaming variant). Useful for self-hosted
 * proxies, Claude-compatible services, and any backend that follows the
 * Anthropic Messages API spec.
 *
 * Configured via a custom provider JSON file with `"type": "anthropic-compat"`
 * in the configured providers directory.
 */
export class AnthropicCompatProvider implements LLMProvider {
  readonly name: string;
  readonly models: string[];

  private baseURL: string;
  private apiKey: string;
  private defaultModel: string;
  private defaultHeaders: Record<string, string>;
  private readonly authEnvVars: readonly string[];
  private readonly serviceNames: readonly string[];
  private readonly aliases: readonly string[];
  private readonly subscriptionProviderId?: string | undefined;
  private readonly streamProtocol?: string | undefined;
  private readonly authHeaderMode: 'x-api-key' | 'bearer';
  private readonly allowAnonymous: boolean;
  private readonly anonymousConfigured: boolean;
  private readonly anonymousDetail?: string | undefined;
  private readonly retryConfig?: Partial<RetryConfig> | undefined;

  constructor(opts: AnthropicCompatOptions) {
    this.name = opts.name;
    this.models = opts.models;
    this.baseURL = opts.baseURL.replace(/\/$/, ''); // strip trailing slash
    this.apiKey = opts.apiKey;
    this.defaultModel = opts.defaultModel;
    this.defaultHeaders = opts.defaultHeaders ?? {};
    this.authEnvVars = opts.authEnvVars ?? [];
    this.serviceNames = opts.serviceNames ?? [];
    this.aliases = opts.aliases ?? [];
    this.subscriptionProviderId = opts.subscriptionProviderId;
    this.streamProtocol = opts.streamProtocol;
    this.authHeaderMode = opts.authHeaderMode ?? 'x-api-key';
    this.allowAnonymous = opts.allowAnonymous ?? false;
    this.anonymousConfigured = opts.anonymousConfigured ?? false;
    this.anonymousDetail = opts.anonymousDetail;
    this.retryConfig = opts.retryConfig;
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey) || this.anonymousConfigured;
  }

  async chat(params: ChatRequest): Promise<ChatResponse> {
    const { messages, tools, model, maxTokens, signal, systemPrompt, onDelta, onRetry, reasoningEffort } = params;

    return (await instrumentedLlmCall(
      () => withRetry(async () => {
      const resolvedModel = model ?? this.defaultModel;

      const body: Record<string, unknown> = {
        model: resolvedModel,
        max_tokens: maxTokens ?? 8192,
        messages: toAnthropicMessages(messages),
        stream: true,
      };

      if (systemPrompt) {
        body['system'] = systemPrompt;
      }

      if (tools && tools.length > 0) {
        body['tools'] = toAnthropicTools(tools);
      }

      applyAnthropicThinking(body, reasoningEffort, Infinity);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'anthropic-version': ANTHROPIC_API_VERSION,
        ...this.defaultHeaders,
      };
      if (this.apiKey) {
        if (this.authHeaderMode === 'bearer') {
          headers['Authorization'] = `Bearer ${this.apiKey}`;
        } else {
          headers['x-api-key'] = this.apiKey;
        }
      }

      if (body['thinking']) {
        headers['anthropic-beta'] = 'interleaved-thinking-2025-05-14';
      }

      let res: Response;
      try {
        res = await instrumentedFetch(`${this.baseURL}/messages`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          ...(signal !== undefined ? { signal } : {}),
        } as RequestInit);
      } catch (err: unknown) {
        throw toProviderError(err, {
          provider: this.name,
          operation: 'chat',
          phase: 'request',
        });
      }

      if (!res.ok) {
        const text = await res.text().catch(() => 'unknown error');
        throw new ProviderError(
          `AnthropicCompat(${this.name}) API error ${res.status}: ${text}`,
          {
            statusCode: res.status,
            provider: this.name,
            operation: 'chat',
            phase: 'request',
          },
        );
      }

      const rateLimit = parseRateLimitHeaders(res.headers) ?? undefined;

      // Parse SSE stream
      const state = createAnthropicSSEState();

      const reader = res.body?.getReader();
      if (!reader) {
        throw new ProviderError(`AnthropicCompat(${this.name}) returned no response body.`, {
          statusCode: 502,
          provider: this.name,
          operation: 'chat',
          phase: 'response',
        });
      }

      await readAnthropicSSEStream(reader, state, onDelta, `AnthropicCompat(${this.name})`);

      const { text, toolCalls } = assembleAnthropicContentBlocks(state.toolBlocks, state.responseText, this.name);

      return {
        content: text,
        toolCalls,
        usage: { inputTokens: state.inputTokens, outputTokens: state.outputTokens, cacheReadTokens: state.cacheReadTokens, cacheWriteTokens: state.cacheWriteTokens },
        stopReason: resolveCompletedStopReason(state.stopReason, text),
        ...withProviderStopReason(state.rawStopReason),
        ...(rateLimit ? { rateLimit } : {}),
      };
    }, this.retryConfig, onRetry), { provider: this.name, model: model ?? this.defaultModel })).result;
  }

  async describeRuntime(deps: ProviderRuntimeMetadataDeps): Promise<ProviderRuntimeMetadata> {
    const { buildStandardProviderAuthRoutes } = await import('./runtime-metadata.js');
    const authRoutes = await buildStandardProviderAuthRoutes({
      providerId: this.name,
      apiKeyEnvVars: this.authEnvVars,
      secretKeys: this.authEnvVars,
      serviceNames: this.serviceNames,
      ...(this.subscriptionProviderId ? { subscriptionProviderId: this.subscriptionProviderId } : {}),
      allowAnonymous: this.allowAnonymous,
      anonymousConfigured: this.anonymousConfigured,
      anonymousDetail: this.anonymousDetail,
    }, deps);
    return {
      auth: {
        mode: this.allowAnonymous && !this.apiKey ? 'anonymous' : 'api-key',
        configured: Boolean(this.apiKey) || this.anonymousConfigured,
        detail: this.apiKey
          ? `API key for ${this.name} is available`
          : this.allowAnonymous
            ? (this.anonymousDetail ?? `${this.name} can be used without a stored API key`)
            : `API key for ${this.name} is not configured`,
        ...(this.authEnvVars.length > 0 ? { envVars: this.authEnvVars } : {}),
        routes: authRoutes,
      },
      models: {
        defaultModel: this.defaultModel,
        models: this.models,
        ...(this.aliases.length > 0 ? { aliases: this.aliases } : {}),
      },
      usage: {
        streaming: true,
        toolCalling: true,
        parallelTools: true,
        promptCaching: true,
        notes: ['Anthropic prompt caching and thinking controls are surfaced through the compat wrapper.'],
      },
      policy: {
        local: false,
        streamProtocol: this.streamProtocol ?? 'anthropic-sse',
        reasoningMode: 'thinking_budget',
        supportedReasoningEfforts: ['instant', 'low', 'medium', 'high'],
        cacheStrategy: 'anthropic-prompt-cache',
      },
    };
  }
}
