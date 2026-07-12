import type { AutomationRouteBinding } from '../automation/routes.js';
import type { AutomationSurfaceKind } from '../automation/types.js';
import type {
  ProviderFailurePolicy,
  ProviderRoutingSelection,
} from '../automation/types.js';
import type { ExecutionIntent } from '../runtime/execution-intents.js';
import { resolveModelReference, type ModelIdCandidate } from '../providers/model-id-resolution.js';

export const SHARED_SESSION_INPUT_INTENTS = ['submit', 'steer', 'follow-up'] as const;
export const SHARED_SESSION_INPUT_STATES = ['queued', 'delivered', 'spawned', 'completed', 'cancelled', 'failed', 'rejected'] as const;

export type SharedSessionInputIntent = typeof SHARED_SESSION_INPUT_INTENTS[number];
export type SharedSessionInputState = typeof SHARED_SESSION_INPUT_STATES[number];

export interface SharedSessionHelperModelOverride {
  readonly providerId: string;
  readonly modelId: string;
}

export interface SharedSessionRoutingIntent {
  readonly providerId?: string | undefined;
  readonly modelId?: string | undefined;
  readonly providerSelection?: ProviderRoutingSelection | undefined;
  readonly providerFailurePolicy?: ProviderFailurePolicy | undefined;
  readonly fallbackModels?: readonly string[] | undefined;
  readonly helperModel?: SharedSessionHelperModelOverride | undefined;
  readonly executionIntent?: ExecutionIntent | undefined;
  readonly tools?: readonly string[] | undefined;
  readonly reasoningEffort?: 'instant' | 'low' | 'medium' | 'high' | undefined;
}

export interface SharedSessionInputRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly intent: SharedSessionInputIntent;
  readonly state: SharedSessionInputState;
  readonly correlationId: string;
  readonly causationId?: string | undefined;
  readonly body: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly routeId?: string | undefined;
  readonly surfaceKind?: AutomationSurfaceKind | undefined;
  readonly surfaceId?: string | undefined;
  readonly externalId?: string | undefined;
  readonly threadId?: string | undefined;
  readonly userId?: string | undefined;
  readonly displayName?: string | undefined;
  readonly activeAgentId?: string | undefined;
  readonly metadata: Record<string, unknown>;
  readonly routing?: SharedSessionRoutingIntent | undefined;
  readonly error?: string | undefined;
}

export interface SharedSessionContinuationRequest {
  readonly sessionId: string;
  readonly input: SharedSessionInputRecord;
  readonly task: string;
  readonly routeBinding?: AutomationRouteBinding | undefined;
}

export interface SharedSessionContinuationResult {
  readonly agentId: string;
}

export type SharedSessionContinuationRunner = (
  input: SharedSessionContinuationRequest,
) => SharedSessionContinuationResult | Promise<SharedSessionContinuationResult | null> | null;

export interface SharedSessionAgentSpawnRoutingInput {
  readonly model?: string | undefined;
  readonly provider?: string | undefined;
  readonly tools?: string[] | undefined;
  readonly restrictTools?: boolean | undefined;
  readonly routing?: {
    readonly providerSelection?: ProviderRoutingSelection | undefined;
    readonly providerFailurePolicy?: ProviderFailurePolicy | undefined;
    readonly fallbackModels?: string[] | undefined;
  } | undefined;
  readonly executionIntent?: ExecutionIntent | undefined;
  readonly reasoningEffort?: 'instant' | 'low' | 'medium' | 'high' | undefined;
}

/**
 * When `modelCandidates` (the live registry's model list) is supplied, a
 * bare id with no provider hint resolves via the shared resolver (unique
 * across the registry -> auto-qualify; ambiguous/unknown -> a rich error
 * naming real candidates) instead of the old abstract format lecture. A
 * bare id WITH a provider hint keeps qualifying by concatenation — that
 * path already correctly implements "provider in context -> qualify"
 * without needing registry access.
 */
function normalizeSharedSessionModelId(
  modelId: string | undefined,
  providerId: string | undefined,
  modelCandidates?: readonly ModelIdCandidate[],
): string | undefined {
  const trimmedModelId = modelId?.trim();
  if (!trimmedModelId) return undefined;
  const trimmedProviderId = providerId?.trim();
  const separatorIndex = trimmedModelId.indexOf(':');
  if (separatorIndex > 0) {
    const modelProviderId = trimmedModelId.slice(0, separatorIndex);
    if (trimmedProviderId && trimmedProviderId !== modelProviderId) {
      throw new Error(`Shared-session routing model '${trimmedModelId}' conflicts with provider '${trimmedProviderId}'.`);
    }
    return trimmedModelId;
  }
  if (trimmedProviderId) return `${trimmedProviderId}:${trimmedModelId}`;
  if (modelCandidates) {
    try {
      return resolveModelReference(trimmedModelId, modelCandidates);
    } catch (err) {
      throw new Error(`Shared-session routing model: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`Shared-session routing model '${trimmedModelId}' must be provider-qualified.`);
}

function normalizeSharedSessionFallbackModels(
  models: readonly string[] | undefined,
  modelCandidates?: readonly ModelIdCandidate[],
): string[] {
  return (models ?? [])
    .filter((model): model is string => typeof model === 'string' && model.trim().length > 0)
    .map((model) => {
      const trimmed = model.trim();
      if (trimmed.includes(':')) return trimmed;
      if (modelCandidates) {
        try {
          return resolveModelReference(trimmed, modelCandidates);
        } catch (err) {
          throw new Error(`Shared-session fallback model: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      throw new Error(`Shared-session fallback model '${model}' must be provider-qualified.`);
    });
}

export function buildSharedSessionAgentSpawnRoutingInput(
  routing: SharedSessionRoutingIntent | undefined,
  options: {
    readonly restrictTools?: boolean | undefined;
    /** The live registry's model candidates — enables bare model id resolution when supplied. */
    readonly modelCandidates?: readonly ModelIdCandidate[] | undefined;
  } = {},
): SharedSessionAgentSpawnRoutingInput {
  if (!routing) return options.restrictTools ? { restrictTools: true } : {};
  const provider = routing.providerId?.trim();
  const model = normalizeSharedSessionModelId(routing.modelId, provider, options.modelCandidates);
  if (provider && !model) {
    throw new Error('Shared-session provider routing requires a provider-qualified model when provider is supplied.');
  }
  const fallbackModels = normalizeSharedSessionFallbackModels(routing.fallbackModels, options.modelCandidates);
  const providerFailurePolicy = routing.providerFailurePolicy ?? (
    fallbackModels.length ? 'ordered-fallbacks' : 'fail'
  );
  if (providerFailurePolicy === 'ordered-fallbacks' && fallbackModels.length === 0) {
    throw new Error('Shared-session ordered fallback routing requires at least one provider-qualified fallback model.');
  }
  if (providerFailurePolicy === 'fail' && fallbackModels.length > 0) {
    throw new Error('Shared-session fail routing cannot include fallback models; use ordered-fallbacks to enable model failover.');
  }
  const agentRouting = {
    providerSelection: routing.providerSelection ?? (provider ? 'concrete' : 'inherit-current'),
    providerFailurePolicy,
    ...(fallbackModels.length ? { fallbackModels } : {}),
  };
  return {
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    ...(routing.tools?.length ? { tools: [...routing.tools] } : {}),
    ...(options.restrictTools ? { restrictTools: true } : {}),
    routing: agentRouting,
    ...(routing.executionIntent ? { executionIntent: routing.executionIntent } : {}),
    ...(routing.reasoningEffort ? { reasoningEffort: routing.reasoningEffort } : {}),
  };
}

export interface SharedSessionCompletion {
  readonly session: {
    readonly id: string;
    readonly activeAgentId?: string | undefined;
  };
  readonly continuedInput?: SharedSessionInputRecord | undefined;
  readonly continuedAgentId?: string | undefined;
}
