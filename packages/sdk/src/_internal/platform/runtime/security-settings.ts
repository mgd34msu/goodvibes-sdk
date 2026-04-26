import { FEATURE_FLAG_MAP } from './feature-flags/flags.js';
import type { FlagState } from './feature-flags/types.js';

export interface SecuritySettingReport {
  readonly key: string;
  readonly type: 'feature-flag' | 'configuration';
  readonly defaultState: FlagState | string;
  readonly currentState: FlagState | string;
  readonly securityRelevant: true;
  readonly summary: string;
  readonly insecureWhen: string;
  readonly enablementEffect: string;
  readonly enablementRequirements: readonly string[];
  readonly compatibilityNotes: readonly string[];
}

export interface SecuritySettingsReporter {
  getState?(flagId: string): FlagState;
  isEnabled?(flagId: string): boolean;
}

const SECURITY_FEATURE_SETTINGS: readonly Omit<SecuritySettingReport, 'currentState'>[] = [
  {
    key: 'featureFlags.fetch-sanitization',
    type: 'feature-flag',
    defaultState: FEATURE_FLAG_MAP.get('fetch-sanitization')?.defaultState ?? 'disabled',
    securityRelevant: true,
    summary: 'Controls fetch response sanitization and host trust-tier checks for the fetch tool.',
    insecureWhen:
      'When disabled, fetch preserves legacy behavior: responses are returned without SDK sanitization and SSRF-risk hosts are not blocked by this feature gate.',
    enablementEffect:
      'When enabled, unknown hosts are sanitized by default, explicitly blocked hosts are denied, and localhost/private/metadata targets are denied before request or redirect follow.',
    enablementRequirements: [
      'Enable featureFlags.fetch-sanitization in SDK/TUI configuration.',
      'Add trusted_hosts only for hosts whose raw content is safe to expose to the model.',
      'Keep sanitize_mode at safe-text or strict unless the target host is explicitly trusted.',
    ],
    compatibilityNotes: [
      'Requests to localhost, private IPs, link-local metadata endpoints, and encoded private IP forms are blocked when the feature is enabled.',
      'Redirect chains are validated hop-by-hop when the feature is enabled.',
    ],
  },
  {
    key: 'featureFlags.permissions-policy-engine',
    type: 'feature-flag',
    defaultState: FEATURE_FLAG_MAP.get('permissions-policy-engine')?.defaultState ?? 'disabled',
    securityRelevant: true,
    summary: 'Controls the redesigned layered permission evaluator for tool execution.',
    insecureWhen:
      'When disabled, the SDK uses the baseline permission manager and does not enforce layered path/tool policy bundles.',
    enablementEffect:
      'When enabled, tool calls can be evaluated against granular runtime policy rules before execution.',
    enablementRequirements: [
      'Provide or load a valid permission policy.',
      'Validate policy behavior in prompt/custom modes before using enforce-heavy deployments.',
    ],
    compatibilityNotes: [
      'Startup-only flag; consumers should set it before constructing runtime services.',
    ],
  },
  {
    key: 'featureFlags.policy-signing',
    type: 'feature-flag',
    defaultState: FEATURE_FLAG_MAP.get('policy-signing')?.defaultState ?? 'disabled',
    securityRelevant: true,
    summary: 'Controls HMAC signature validation for managed permission policy bundles.',
    insecureWhen:
      'When disabled, managed policy bundles are not cryptographically verified by this gate.',
    enablementEffect:
      'When enabled, managed mode rejects policy bundles with invalid or missing signatures.',
    enablementRequirements: [
      'Provision the policy signing secret in the runtime environment or secret store.',
      'Sign policy bundles before loading them in managed mode.',
    ],
    compatibilityNotes: [
      'Unsigned local development bundles may need a non-managed mode or explicit signing during rollout.',
    ],
  },
  {
    key: 'featureFlags.permissions-simulation',
    type: 'feature-flag',
    defaultState: FEATURE_FLAG_MAP.get('permissions-simulation')?.defaultState ?? 'disabled',
    securityRelevant: true,
    summary: 'Runs the candidate permission evaluator beside the active evaluator without changing enforcement.',
    insecureWhen:
      'When disabled, operators do not receive divergence telemetry before moving to stricter permission policy enforcement.',
    enablementEffect:
      'When enabled, the SDK records evaluator divergence so clients can validate a stricter permission policy before enforcing it.',
    enablementRequirements: [
      'Enable alongside permissions-policy-engine during policy rollout.',
      'Review divergence diagnostics before switching enforcement modes.',
    ],
    compatibilityNotes: [
      'Simulation should not block tool execution by itself; it is an observability step for permission hardening.',
    ],
  },
  {
    key: 'featureFlags.permission-divergence-dashboard',
    type: 'feature-flag',
    defaultState: FEATURE_FLAG_MAP.get('permission-divergence-dashboard')?.defaultState ?? 'disabled',
    securityRelevant: true,
    summary: 'Surfaces permission evaluator divergence and gates enforce-mode rollout.',
    insecureWhen:
      'When disabled, clients may lack a first-class view of permission divergence before enabling stricter enforcement.',
    enablementEffect:
      'When enabled, divergence by command class, prefix, and mode is exposed for diagnostics and can block unsafe enforce-mode transitions.',
    enablementRequirements: [
      'Enable permissions-simulation first so divergence data exists.',
      'Configure an acceptable divergence threshold for the host surface.',
    ],
    compatibilityNotes: [
      'This is a rollout-control feature; it may prevent policy promotion until divergence is resolved.',
    ],
  },
  {
    key: 'featureFlags.policy-as-code',
    type: 'feature-flag',
    defaultState: FEATURE_FLAG_MAP.get('policy-as-code')?.defaultState ?? 'disabled',
    securityRelevant: true,
    summary: 'Controls versioned permission policy bundle promotion and rollback.',
    insecureWhen:
      'When disabled, permission policy changes are not managed through SDK-level promote/rollback controls.',
    enablementEffect:
      'When enabled, policy bundles can be loaded, diffed, simulated, promoted, and rolled back with recorded evidence.',
    enablementRequirements: [
      'Define a policy bundle source and promotion flow.',
      'Use permissions-simulation and policy-signing for high-assurance managed deployments.',
    ],
    compatibilityNotes: [
      'Operational clients need to handle policy promotion failures and rollback states.',
    ],
  },
  {
    key: 'featureFlags.runtime-tools-budget-enforcement',
    type: 'feature-flag',
    defaultState: FEATURE_FLAG_MAP.get('runtime-tools-budget-enforcement')?.defaultState ?? 'disabled',
    securityRelevant: true,
    summary: 'Controls runtime budget enforcement for tool execution pipelines.',
    insecureWhen:
      'When disabled, tool phases do not fail closed on SDK-level wall-clock, token, or cost budget breaches.',
    enablementEffect:
      'When enabled, tools can be interrupted at phase boundaries when configured budgets are exceeded.',
    enablementRequirements: [
      'Configure appropriate budget limits for the host surface.',
      'Ensure callers handle budget-exceeded tool errors as normal failures.',
    ],
    compatibilityNotes: [
      'Long-running tools or large batch operations may fail earlier once budgets are enforced.',
    ],
  },
  {
    key: 'featureFlags.token-scope-rotation-audit',
    type: 'feature-flag',
    defaultState: FEATURE_FLAG_MAP.get('token-scope-rotation-audit')?.defaultState ?? 'disabled',
    securityRelevant: true,
    summary: 'Audits API tokens for excessive scopes and stale rotation cadence.',
    insecureWhen:
      'When disabled, token scope and age findings are advisory only and are not enforced by this gate.',
    enablementEffect:
      'When enabled in managed mode, tokens with excess scopes or expired rotation windows can be blocked from use.',
    enablementRequirements: [
      'Define expected token scopes for the deployed integrations.',
      'Configure rotation cadence and managed-mode policy before relying on blocking behavior.',
    ],
    compatibilityNotes: [
      'Tokens that currently work may be blocked if they are over-scoped or overdue for rotation.',
    ],
  },
  {
    key: 'featureFlags.tool-contract-verification',
    type: 'feature-flag',
    defaultState: FEATURE_FLAG_MAP.get('tool-contract-verification')?.defaultState ?? 'enabled',
    securityRelevant: true,
    summary: 'Validates registered tool contracts, timeout behavior, permission class mapping, and output policy compatibility.',
    insecureWhen:
      'When disabled, malformed or under-declared tools can register without SDK contract verification.',
    enablementEffect:
      'When enabled, invalid tool contracts fail closed with actionable diagnostics before normal execution.',
    enablementRequirements: [
      'Keep tool definitions accurate, including side effects and permission classes.',
      'Fix contract diagnostics in custom tool plugins before enabling in strict deployments.',
    ],
    compatibilityNotes: [
      'This flag defaults to enabled; disabling it is a compatibility escape hatch for legacy/custom tools.',
    ],
  },
  {
    key: 'featureFlags.shell-ast-normalization',
    type: 'feature-flag',
    defaultState: FEATURE_FLAG_MAP.get('shell-ast-normalization')?.defaultState ?? 'disabled',
    securityRelevant: true,
    summary: 'Controls AST-aware shell command normalization for exec permission review.',
    insecureWhen:
      'When disabled, exec command review falls back to baseline flat segmentation and may provide less precise command verdicts.',
    enablementEffect:
      'When enabled, compound shell commands are decomposed into per-segment verdicts with more specific denial explanations.',
    enablementRequirements: [
      'Enable the flag where bash-language-server/parser support is available.',
      'Review compatibility with host command allow/deny policy.',
    ],
    compatibilityNotes: [
      'Complex shell syntax can receive stricter or more granular verdicts when enabled.',
    ],
  },
];

export function getSecuritySettingsReport(
  reporter: SecuritySettingsReporter | null | undefined,
): SecuritySettingReport[] {
  return SECURITY_FEATURE_SETTINGS.map((setting) => {
    const flagId = setting.key.replace(/^featureFlags\./, '');
    const currentState = reporter?.getState
      ? safeGetState(reporter, flagId, setting.defaultState)
      : reporter?.isEnabled?.(flagId)
        ? 'enabled'
        : setting.defaultState;
    return {
      ...setting,
      currentState,
    };
  });
}

function safeGetState(
  reporter: SecuritySettingsReporter,
  flagId: string,
  fallback: FlagState | string,
): FlagState | string {
  try {
    return reporter.getState?.(flagId) ?? fallback;
  } catch {
    return fallback;
  }
}
