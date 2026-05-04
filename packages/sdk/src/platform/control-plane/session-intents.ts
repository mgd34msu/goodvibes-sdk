import type { AutomationRouteBinding } from '../automation/routes.js';
import type { AutomationSurfaceKind } from '../automation/types.js';
import type {
  ProviderFailurePolicy,
  ProviderRoutingSelection,
  UnresolvedModelPolicy,
} from '../automation/types.js';
import type { ExecutionIntent } from '../runtime/execution-intents.js';

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
  readonly unresolvedModelPolicy?: UnresolvedModelPolicy | undefined;
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

export interface SharedSessionCompletion {
  readonly session: {
    readonly id: string;
    readonly activeAgentId?: string | undefined;
  };
  readonly continuedInput?: SharedSessionInputRecord | undefined;
  readonly continuedAgentId?: string | undefined;
}
