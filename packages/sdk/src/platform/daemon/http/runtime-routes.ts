import { createDaemonRuntimeRouteHandlers as createSdkDaemonRuntimeRouteHandlers } from '@pellux/goodvibes-daemon-sdk';
import type { DaemonRuntimeRouteContext as SdkDaemonRuntimeRouteContext } from '@pellux/goodvibes-daemon-sdk';
import type {
  AutomationDeliveryPolicy,
  AutomationExternalContentSource,
  AutomationFailurePolicy,
  AutomationScheduleDefinition,
  AutomationSessionTarget,
  CreateAutomationJobInput,
  UpdateAutomationJobInput,
} from '../../automation/index.js';
import type { ProviderModelRoutingPolicy } from '../../automation/types.js';
import {
  EXECUTION_FILESYSTEM_POLICIES,
  EXECUTION_NETWORK_POLICIES,
  EXECUTION_RISK_CLASSES,
  type ExecutionIntent,
} from '../../runtime/execution-intents.js';
import type { DaemonRuntimeRouteContext, DaemonRuntimeRouteHandlerMap } from './runtime-route-types.js';

export type { DaemonRuntimeRouteContext } from './runtime-route-types.js';

type SdkSpawnAgentInput = Parameters<SdkDaemonRuntimeRouteContext['trySpawnAgent']>[0];
type RuntimeRouteSpawnAgentInput = Parameters<DaemonRuntimeRouteContext['trySpawnAgent']>[0];

const providerSelections = new Set(['inherit-current', 'concrete', 'synthetic']);
const providerFailurePolicies = new Set(['ordered-fallbacks', 'fail']);
const executionTargetKinds = new Set(['isolated', 'current', 'pinned', 'background', 'main', 'session', 'route']);
const surfaceKinds = new Set([
  'tui',
  'web',
  'slack',
  'discord',
  'ntfy',
  'webhook',
  'homeassistant',
  'telegram',
  'google-chat',
  'signal',
  'whatsapp',
  'imessage',
  'msteams',
  'bluebubbles',
  'mattermost',
  'matrix',
  'service',
]);
const reasoningEfforts = new Set(['instant', 'low', 'medium', 'high']);
const wakeModes = new Set(['next-heartbeat', 'now']);
const externalContentKinds = new Set([
  'gmail',
  'email',
  'webhook',
  'api',
  'browser',
  'channel_metadata',
  'web_search',
  'web_fetch',
  'slack',
  'discord',
  'ntfy',
  'unknown',
]);
const deliveryModes = new Set(['none', 'webhook', 'surface', 'integration', 'link']);
const failureActions = new Set(['retry', 'cooldown', 'disable', 'dead_letter']);
const retryStrategies = new Set(['fixed', 'linear', 'exponential']);
const executionProtocols = new Set(['direct', 'gather-plan-apply']);
const reviewModes = new Set(['none', 'wrfc']);
const communicationLanes = new Set(['parent-only', 'parent-and-children', 'cohort', 'direct']);
const executionRiskClasses = new Set(EXECUTION_RISK_CLASSES);
const executionNetworkPolicies = new Set(EXECUTION_NETWORK_POLICIES);
const executionFilesystemPolicies = new Set(EXECUTION_FILESYSTEM_POLICIES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === 'boolean';
}

function isOptionalFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || isFiniteNumber(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isOptionalStringArray(value: unknown): value is readonly string[] | undefined {
  return value === undefined || isStringArray(value);
}

function isStringFrom(value: unknown, allowed: ReadonlySet<string>): value is string {
  return typeof value === 'string' && allowed.has(value);
}

function isOptionalStringFrom(value: unknown, allowed: ReadonlySet<string>): value is string | undefined {
  return value === undefined || isStringFrom(value, allowed);
}

function isAutomationScheduleDefinition(value: unknown): value is AutomationScheduleDefinition {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'at') return isFiniteNumber(value.at);
  if (value.kind === 'every') {
    return isFiniteNumber(value.intervalMs) && isOptionalFiniteNumber(value.anchorAt);
  }
  if (value.kind === 'cron') {
    return typeof value.expression === 'string'
      && isOptionalString(value.timezone)
      && isOptionalFiniteNumber(value.staggerMs);
  }
  return false;
}

function isProviderModelRoutingPolicy(value: unknown): value is ProviderModelRoutingPolicy {
  return isRecord(value)
    && isOptionalStringFrom(value.providerSelection, providerSelections)
    && isOptionalStringFrom(value.providerFailurePolicy, providerFailurePolicies)
    && isOptionalStringArray(value.fallbackModels);
}

function isAutomationSessionTarget(value: unknown): value is AutomationSessionTarget {
  return isRecord(value)
    && isStringFrom(value.kind, executionTargetKinds)
    && isOptionalString(value.sessionId)
    && isOptionalString(value.routeId)
    && isOptionalString(value.threadId)
    && isOptionalString(value.channelId)
    && isOptionalStringFrom(value.surfaceKind, surfaceKinds)
    && isOptionalString(value.pinnedSessionId)
    && isOptionalBoolean(value.preserveThread)
    && isOptionalBoolean(value.createIfMissing);
}

function isAutomationExternalContentSource(value: unknown): value is AutomationExternalContentSource {
  if (typeof value === 'string') return externalContentKinds.has(value);
  return isRecord(value)
    && typeof value.kind === 'string'
    && isOptionalString(value.id)
    && isOptionalString(value.url)
    && isOptionalString(value.routeId)
    && isOptionalStringFrom(value.surfaceKind, surfaceKinds)
    && (value.metadata === undefined || isRecord(value.metadata));
}

function isAutomationDeliveryTarget(value: unknown): value is AutomationDeliveryPolicy['targets'][number] {
  return isRecord(value)
    && isStringFrom(value.kind, deliveryModes)
    && isOptionalStringFrom(value.surfaceKind, surfaceKinds)
    && isOptionalString(value.address)
    && isOptionalString(value.routeId)
    && isOptionalString(value.label);
}

function isAutomationDeliveryTargetArray(value: unknown): value is AutomationDeliveryPolicy['targets'] {
  return Array.isArray(value) && value.every(isAutomationDeliveryTarget);
}

function isPartialAutomationDeliveryPolicy(value: unknown): value is Partial<AutomationDeliveryPolicy> {
  return isRecord(value)
    && isOptionalStringFrom(value.mode, deliveryModes)
    && (value.targets === undefined || isAutomationDeliveryTargetArray(value.targets))
    && (value.fallbackTargets === undefined || isAutomationDeliveryTargetArray(value.fallbackTargets))
    && isOptionalBoolean(value.includeSummary)
    && isOptionalBoolean(value.includeTranscript)
    && isOptionalBoolean(value.includeLinks)
    && isOptionalString(value.replyToRouteId);
}

function isAutomationRetryPolicy(value: unknown): value is AutomationFailurePolicy['retryPolicy'] {
  return isRecord(value)
    && isFiniteNumber(value.maxAttempts)
    && isFiniteNumber(value.delayMs)
    && isStringFrom(value.strategy, retryStrategies)
    && isOptionalFiniteNumber(value.maxDelayMs)
    && isOptionalFiniteNumber(value.jitterMs);
}

function isPartialAutomationFailurePolicy(value: unknown): value is Partial<AutomationFailurePolicy> {
  return isRecord(value)
    && isOptionalStringFrom(value.action, failureActions)
    && isOptionalFiniteNumber(value.maxConsecutiveFailures)
    && isOptionalFiniteNumber(value.cooldownMs)
    && (value.retryPolicy === undefined || isAutomationRetryPolicy(value.retryPolicy))
    && isOptionalString(value.deadLetterRouteId)
    && isOptionalBoolean(value.disableAfterFailures)
    && isOptionalString(value.notifyRouteId);
}

function hasValidAutomationJobFields(input: Record<string, unknown>): boolean {
  return isOptionalString(input.description)
    && isOptionalString(input.model)
    && isOptionalString(input.provider)
    && isOptionalStringArray(input.fallbackModels)
    && (input.routing === undefined || isProviderModelRoutingPolicy(input.routing))
    && (input.executionIntent === undefined || isExecutionIntent(input.executionIntent))
    && (input.target === undefined || isAutomationSessionTarget(input.target))
    && isOptionalString(input.template)
    && isOptionalStringFrom(input.reasoningEffort, reasoningEfforts)
    && isOptionalString(input.thinking)
    && isOptionalStringFrom(input.wakeMode, wakeModes)
    && isOptionalFiniteNumber(input.timeoutMs)
    && isOptionalStringArray(input.toolAllowlist)
    && isOptionalBoolean(input.autoApprove)
    && isOptionalBoolean(input.allowUnsafeExternalContent)
    && (input.externalContentSource === undefined || isAutomationExternalContentSource(input.externalContentSource))
    && isOptionalBoolean(input.lightContext)
    && (input.delivery === undefined || isPartialAutomationDeliveryPolicy(input.delivery))
    && (input.failure === undefined || isPartialAutomationFailurePolicy(input.failure))
    && isOptionalBoolean(input.enabled)
    && isOptionalBoolean(input.deleteAfterRun);
}

function isCreateAutomationJobInput(input: unknown): input is CreateAutomationJobInput {
  return isRecord(input)
    && typeof input.name === 'string'
    && typeof input.prompt === 'string'
    && isAutomationScheduleDefinition(input.schedule)
    && hasValidAutomationJobFields(input);
}

function isUpdateAutomationJobInput(input: unknown): input is UpdateAutomationJobInput {
  return isRecord(input)
    && isOptionalString(input.name)
    && isOptionalString(input.prompt)
    && (input.schedule === undefined || isAutomationScheduleDefinition(input.schedule))
    && hasValidAutomationJobFields(input);
}

function parseCreateAutomationJobInput(input: Record<string, unknown>): CreateAutomationJobInput {
  if (!isCreateAutomationJobInput(input)) {
    throw new Error('Invalid automation job create payload from runtime route parser.');
  }
  return input;
}

function parseUpdateAutomationJobInput(input: Record<string, unknown>): UpdateAutomationJobInput {
  if (!isUpdateAutomationJobInput(input)) {
    throw new Error('Invalid automation job update payload from runtime route parser.');
  }
  return input;
}

function isExecutionIntent(value: unknown): value is ExecutionIntent {
  return isRecord(value)
    && isOptionalStringFrom(value.riskClass, executionRiskClasses)
    && isOptionalBoolean(value.requiresApproval)
    && isOptionalStringFrom(value.networkPolicy, executionNetworkPolicies)
    && isOptionalStringFrom(value.filesystemPolicy, executionFilesystemPolicies);
}

function isRuntimeRouteSpawnAgentInput(input: SdkSpawnAgentInput): input is RuntimeRouteSpawnAgentInput {
  return input.mode === 'spawn'
    && typeof input.task === 'string'
    && isOptionalString(input.model)
    && isOptionalStringArray(input.tools)
    && isOptionalString(input.provider)
    && isOptionalString(input.context)
    && (input.executionIntent === undefined || isExecutionIntent(input.executionIntent))
    && isOptionalStringFrom(input.executionProtocol, executionProtocols)
    && isOptionalStringFrom(input.reviewMode, reviewModes)
    && isOptionalStringFrom(input.communicationLane, communicationLanes)
    && isOptionalBoolean(input.dangerously_disable_wrfc);
}

function parseRuntimeRouteSpawnAgentInput(input: SdkSpawnAgentInput): RuntimeRouteSpawnAgentInput {
  if (!isRuntimeRouteSpawnAgentInput(input)) {
    throw new Error('Invalid agent spawn payload from runtime route parser.');
  }
  return input;
}

export function createDaemonRuntimeRouteHandlers(
  context: DaemonRuntimeRouteContext,
): DaemonRuntimeRouteHandlerMap {
  return createSdkDaemonRuntimeRouteHandlers({
    ...context,
    automationManager: {
      ...context.automationManager,
      createJob: (input) => context.automationManager.createJob(parseCreateAutomationJobInput(input)),
      updateJob: (jobId, input) => context.automationManager.updateJob(jobId, parseUpdateAutomationJobInput(input)),
    },
    trySpawnAgent: (input, logLabel, sessionId) => {
      const spawnInput = parseRuntimeRouteSpawnAgentInput(input);
      return context.trySpawnAgent({
        ...spawnInput,
        ...(spawnInput.tools ? { tools: [...spawnInput.tools] } : {}),
      }, logLabel, sessionId);
    },
  });
}
