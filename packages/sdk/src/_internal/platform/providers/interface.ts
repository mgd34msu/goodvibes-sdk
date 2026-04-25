import type { ToolDefinition, ToolCall } from '../types/tools.js';
import type { ProviderCapability } from './capabilities.js';
import type { SecretsManager } from '../config/secrets.js';
import type { ServiceRegistry } from '../config/service-registry.js';
import type { SubscriptionManager } from '../config/subscriptions.js';

/** Shared budget token map for reasoning effort levels. */
export const REASONING_BUDGET_MAP: Record<string, number> = {
  instant: 0,
  low: 2048,
  medium: 8192,
  high: 32768,
};

/** Runtime metadata emitted by providers for diagnostics and policy surfaces. */
export type ProviderDeclaredAuthRoute =
  | 'api-key'
  | 'secret-ref'
  | 'service-oauth'
  | 'subscription-oauth'
  | 'anonymous'
  | 'none';

export interface ProviderAuthRouteDescriptor {
  readonly route: ProviderDeclaredAuthRoute;
  readonly label: string;
  readonly configured: boolean;
  readonly usable?: boolean;
  readonly freshness?: 'healthy' | 'expiring' | 'expired' | 'pending' | 'unconfigured';
  readonly detail?: string;
  readonly envVars?: readonly string[];
  readonly secretKeys?: readonly string[];
  readonly serviceNames?: readonly string[];
  readonly providerId?: string;
  readonly repairHints?: readonly string[];
}

export interface ProviderUsageCostMetadata {
  readonly source: 'catalog' | 'provider' | 'none';
  readonly currency?: string;
  readonly inputPerMillionTokens?: number;
  readonly outputPerMillionTokens?: number;
  readonly detail?: string;
}

export interface ProviderRuntimeMetadata {
  readonly auth?: {
    readonly mode: 'api-key' | 'oauth' | 'anonymous' | 'none';
    readonly configured: boolean;
    readonly detail?: string;
    readonly envVars?: readonly string[];
    readonly routes?: readonly ProviderAuthRouteDescriptor[];
  };
  readonly models?: {
    readonly defaultModel?: string;
    readonly models: readonly string[];
    readonly embeddingModel?: string;
    readonly embeddingDimensions?: number;
    readonly aliases?: readonly string[];
    readonly suppressedModels?: readonly string[];
  };
  readonly usage?: {
    readonly streaming: boolean;
    readonly toolCalling: boolean;
    readonly parallelTools: boolean;
    readonly promptCaching?: boolean;
    readonly batch?: ProviderBatchRuntimeMetadata;
    readonly cost?: ProviderUsageCostMetadata;
    readonly notes?: readonly string[];
  };
  readonly policy?: {
    readonly local?: boolean;
    readonly dataRetention?: string;
    readonly streamProtocol?: string;
    readonly reasoningMode?: string;
    readonly supportedReasoningEfforts?: readonly string[];
    readonly cacheStrategy?: string;
    readonly notes?: readonly string[];
  };
  readonly notes?: readonly string[];
}

export interface ProviderRuntimeMetadataDeps {
  readonly secretsManager: Pick<SecretsManager, 'listDetailed'>;
  readonly serviceRegistry: Pick<ServiceRegistry, 'getAll' | 'inspect'>;
  readonly subscriptionManager: Pick<SubscriptionManager, 'get' | 'getPending'>;
}

/** Shared embedding request shape used by providers and provider-backed adapters. */
export interface ProviderEmbeddingRequest {
  readonly text: string;
  readonly dimensions: number;
  readonly usage: 'record' | 'query' | 'doctor';
  readonly model?: string;
  readonly signal?: AbortSignal;
  readonly metadata?: Record<string, unknown>;
}

/** Shared embedding response shape used by providers and provider-backed adapters. */
export interface ProviderEmbeddingResult {
  readonly vector: Float32Array | readonly number[];
  readonly dimensions: number;
  readonly modelId?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface ProviderBatchRuntimeMetadata {
  readonly supported: boolean;
  readonly discount?: string;
  readonly completionWindow?: string;
  readonly endpoints?: readonly string[];
  readonly maxRequestsPerProviderBatch?: number;
  readonly maxInputBytes?: number;
  readonly notes?: readonly string[];
}

export type ProviderBatchStatus =
  | 'queued'
  | 'submitted'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired';

export interface ProviderBatchChatRequest {
  readonly customId: string;
  readonly params: Omit<ChatRequest, 'signal' | 'onDelta'>;
}

export interface ProviderBatchCreateInput {
  readonly requests: readonly ProviderBatchChatRequest[];
  readonly metadata?: Record<string, string>;
  readonly completionWindow?: '24h';
}

export interface ProviderBatchCreateResult {
  readonly providerBatchId: string;
  readonly status: ProviderBatchStatus;
  readonly raw?: unknown;
}

export interface ProviderBatchPollResult extends ProviderBatchCreateResult {
  readonly resultAvailable: boolean;
}

export interface ProviderBatchResult {
  readonly customId: string;
  readonly status: 'succeeded' | 'failed' | 'cancelled' | 'expired';
  readonly response?: ChatResponse;
  readonly error?: {
    readonly message: string;
    readonly code?: string;
    readonly raw?: unknown;
  };
  readonly raw?: unknown;
}

export interface ProviderBatchAdapter {
  readonly kind: 'provider-batch';
  readonly endpoints: readonly string[];
  createChatBatch(input: ProviderBatchCreateInput): Promise<ProviderBatchCreateResult>;
  retrieveBatch(providerBatchId: string): Promise<ProviderBatchPollResult>;
  cancelBatch?(providerBatchId: string): Promise<ProviderBatchPollResult>;
  getResults(providerBatchId: string): Promise<readonly ProviderBatchResult[]>;
}

/** Contract all LLM providers must implement. */
export interface LLMProvider {
  readonly name: string;
  readonly models: string[];
  readonly batch?: ProviderBatchAdapter;
  /**
   * Optional self-declared capability overrides for this provider instance.
   * When present, these take precedence over the built-in `PROVIDER_DEFAULTS`
   * table in `capabilities.ts` but are overridden by per-model `MODEL_OVERRIDES`.
   *
   * @remarks Useful for custom / dynamically-discovered providers that know
   * their own capabilities and want to participate in explainable routing.
   */
  readonly capabilities?: Partial<ProviderCapability>;
  chat(params: ChatRequest): Promise<ChatResponse>;
  embed?(request: ProviderEmbeddingRequest): Promise<ProviderEmbeddingResult>;
  describeRuntime?(deps: ProviderRuntimeMetadataDeps): ProviderRuntimeMetadata | Promise<ProviderRuntimeMetadata>;
  /**
   * Returns true if this provider has a valid API key or other credentials
   * configured. When false, any chat() call will fail with an auth error.
   *
   * Optional — providers that don't implement this are assumed configured.
   */
  isConfigured?(): boolean;
}

/** Incremental tool call data received during streaming. */
export interface PartialToolCall {
  index: number;
  id?: string;
  name?: string;
  arguments?: string;  // Partial JSON string
}

/** A single streaming delta from the provider. */
export interface StreamDelta {
  content?: string;           // Text content delta
  toolCalls?: PartialToolCall[];  // Incremental tool call data
  reasoning?: string;         // Reasoning/thinking delta
}

/** Content part for multimodal messages. */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mediaType: string };

export interface ChatRequest {
  messages: ProviderMessage[];
  tools?: ToolDefinition[];
  model: string;
  maxTokens?: number;
  signal?: AbortSignal;
  systemPrompt?: string;
  /** Controls reasoning depth for models that support it. Format varies by provider. */
  reasoningEffort?: 'instant' | 'low' | 'medium' | 'high';
  /** Mercury-2 specific: whether to include a reasoning summary in the response. */
  reasoningSummary?: boolean;
  /** Called per-chunk during streaming when streaming is enabled. */
  onDelta?: (delta: StreamDelta) => void;
}

/**
 * Normalized stop-reason vocabulary for `ChatResponse`.
 * Every provider's raw finish reason maps to exactly one canonical value.
 */
export type ChatStopReason =
  | 'completed'        // Natural end of generation (was 'end')
  | 'max_tokens'       // Output token limit reached
  | 'tool_call'        // Model requested tool invocation (was 'tool_use')
  | 'stop_sequence'    // Matched an explicit stop sequence
  | 'content_filter'   // Provider content filter triggered
  | 'error'            // Generation aborted due to error
  | 'unknown';         // Fallback for unmapped provider values

export interface ChatResponse {
  content: string;
  toolCalls: ToolCall[];
  usage: {
    inputTokens: number;       // Billed input tokens (excludes cache tokens on Anthropic)
    outputTokens: number;
    cacheReadTokens?: number;  // Anthropic: tokens read from prompt cache
    cacheWriteTokens?: number; // Anthropic: tokens written to prompt cache
  };
  /** Normalized stop reason — use this for cross-provider comparisons. */
  stopReason: ChatStopReason;
  /**
   * Raw stop reason string emitted by the underlying provider, preserved for
   * consumers that need provider-specific detail (e.g. analytics, debugging).
   */
  providerStopReason?: string;
  /** Mercury-2 specific: condensed chain-of-thought, if requested. */
  reasoningSummary?: string;
  /**
   * Cache metrics for this response.
   * @remarks Currently only populated by the Anthropic provider. Other providers return `undefined`.
   */
  cacheMetrics?: {
    strategy: string;           // e.g. 'explicit-4bp', 'automatic', 'implicit', 'none'
    breakpointsPlaced: number;
    hitRate?: number;           // Computed from this response's usage
  };
}

export type ProviderMessage =
  | { role: 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; callId: string; content: string; name?: string };
