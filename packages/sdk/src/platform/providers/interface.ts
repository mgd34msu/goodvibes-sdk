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
  readonly usable?: boolean | undefined;
  readonly freshness?: 'healthy' | 'expiring' | 'expired' | 'pending' | 'unconfigured' | undefined;
  readonly detail?: string | undefined;
  readonly envVars?: readonly string[] | undefined;
  readonly secretKeys?: readonly string[] | undefined;
  readonly serviceNames?: readonly string[] | undefined;
  readonly providerId?: string | undefined;
  readonly repairHints?: readonly string[] | undefined;
}

export interface ProviderUsageCostMetadata {
  readonly source: 'catalog' | 'provider' | 'none';
  readonly currency?: string | undefined;
  readonly inputPerMillionTokens?: number | undefined;
  readonly outputPerMillionTokens?: number | undefined;
  readonly detail?: string | undefined;
}

export interface ProviderRuntimeMetadata {
  readonly auth?: {
    readonly mode: 'api-key' | 'oauth' | 'anonymous' | 'none';
    readonly configured: boolean;
    readonly detail?: string | undefined;
    readonly envVars?: readonly string[] | undefined;
    readonly routes?: readonly ProviderAuthRouteDescriptor[] | undefined;
  };
  readonly models?: {
    readonly defaultModel?: string | undefined;
    readonly models: readonly string[];
    readonly embeddingModel?: string | undefined;
    readonly embeddingDimensions?: number | undefined;
    readonly aliases?: readonly string[] | undefined;
    readonly suppressedModels?: readonly string[] | undefined;
  };
  readonly usage?: {
    readonly streaming: boolean;
    readonly toolCalling: boolean;
    readonly parallelTools: boolean;
    readonly promptCaching?: boolean | undefined;
    readonly batch?: ProviderBatchRuntimeMetadata | undefined;
    readonly cost?: ProviderUsageCostMetadata | undefined;
    readonly notes?: readonly string[] | undefined;
  };
  readonly policy?: {
    readonly local?: boolean | undefined;
    readonly dataRetention?: string | undefined;
    readonly streamProtocol?: string | undefined;
    readonly reasoningMode?: string | undefined;
    readonly supportedReasoningEfforts?: readonly string[] | undefined;
    readonly cacheStrategy?: string | undefined;
    readonly notes?: readonly string[] | undefined;
  };
  readonly notes?: readonly string[] | undefined;
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
  readonly model?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

/** Shared embedding response shape used by providers and provider-backed adapters. */
export interface ProviderEmbeddingResult {
  readonly vector: Float32Array | readonly number[];
  readonly dimensions: number;
  readonly modelId?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface ProviderBatchRuntimeMetadata {
  readonly supported: boolean;
  readonly discount?: string | undefined;
  readonly completionWindow?: string | undefined;
  readonly endpoints?: readonly string[] | undefined;
  readonly maxRequestsPerProviderBatch?: number | undefined;
  readonly maxInputBytes?: number | undefined;
  readonly notes?: readonly string[] | undefined;
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
  readonly metadata?: Record<string, string> | undefined;
  readonly completionWindow?: '24h' | undefined;
}

export interface ProviderBatchCreateResult {
  readonly providerBatchId: string;
  readonly status: ProviderBatchStatus;
  readonly raw?: unknown | undefined;
}

export interface ProviderBatchPollResult extends ProviderBatchCreateResult {
  readonly resultAvailable: boolean;
}

export interface ProviderBatchResult {
  readonly customId: string;
  readonly status: 'succeeded' | 'failed' | 'cancelled' | 'expired';
  readonly response?: ChatResponse | undefined;
  readonly error?: {
    readonly message: string;
    readonly code?: string | undefined;
    readonly raw?: unknown | undefined;
  };
  readonly raw?: unknown | undefined;
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
  readonly batch?: ProviderBatchAdapter | undefined;
  /**
   * Optional self-declared capability overrides for this provider instance.
   * When present, these take precedence over the built-in `PROVIDER_DEFAULTS`
   * table in `capabilities.ts` but are overridden by per-model `MODEL_OVERRIDES`.
   *
   * @remarks Useful for custom / dynamically-discovered providers that know
   * their own capabilities and want to participate in explainable routing.
   */
  readonly capabilities?: Partial<ProviderCapability> | undefined;
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
  id?: string | undefined;
  name?: string | undefined;
  arguments?: string | undefined;  // Partial JSON string
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
  tools?: ToolDefinition[] | undefined;
  model: string;
  maxTokens?: number | undefined;
  signal?: AbortSignal | undefined;
  systemPrompt?: string | undefined;
  /** Controls reasoning depth for models that support it. Format varies by provider. */
  reasoningEffort?: 'instant' | 'low' | 'medium' | 'high' | undefined;
  /** Mercury-2 specific: whether to include a reasoning summary in the response. */
  reasoningSummary?: boolean | undefined;
  /** Called per-chunk during streaming when streaming is enabled. */
  onDelta?: ((delta: StreamDelta) => void) | undefined | undefined;
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
  providerStopReason?: string | undefined;
  /** Mercury-2 specific: condensed chain-of-thought, if requested. */
  reasoningSummary?: string | undefined;
  /**
   * Cache metrics for this response.
   * @remarks Currently only populated by the Anthropic provider. Other providers return `undefined`.
   */
  cacheMetrics?: {
    strategy: string;           // e.g. 'explicit-4bp', 'automatic', 'implicit', 'none'
    breakpointsPlaced: number;
    hitRate?: number | undefined;  // Computed from this response's usage
  };
}

export type ProviderMessage =
  | { role: 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; callId: string; content: string; name?: string | undefined };
