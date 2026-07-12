import { FEATURE_FLAG_MAP } from './feature-flags/flags.js';
import type { FlagState } from './feature-flags/types.js';

export interface SecuritySettingReport {
  /** The settings key that controls this behavior. */
  readonly key: string;
  readonly type: 'setting' | 'configuration';
  /** Internal capability id used to resolve the live state. */
  readonly featureId: string;
  readonly defaultState: FlagState | string;
  readonly currentState: FlagState | string;
  readonly securityRelevant: true;
  readonly summary: string;
  readonly insecureWhen: string;
  readonly enablementEffect: string;
  readonly enablementRequirements: readonly string[];
  readonly operationalNotes: readonly string[];
}

export interface SecuritySettingsReporter {
  getState?(featureId: string): FlagState;
  isEnabled?(featureId: string): boolean;
}

const SECURITY_FEATURE_SETTINGS: readonly Omit<SecuritySettingReport, 'currentState'>[] = [
  {
    key: 'fetch.sanitizeMode',
    type: 'setting',
    featureId: 'fetch-sanitization',
    defaultState: FEATURE_FLAG_MAP.get('fetch-sanitization')?.defaultState ?? 'enabled',
    securityRelevant: true,
    summary: 'Controls fetch response sanitization; host trust-tier blocking is always active.',
    insecureWhen:
      'When fetch.sanitizeMode is none, response content is returned without sanitization; private-IP and cloud-metadata blocking still applies.',
    enablementEffect:
      'At safe-text (the default) or strict, unknown hosts are sanitized, explicitly blocked hosts are denied, and private/metadata targets are denied before request or redirect follow. Localhost dev servers ask once and can be allowed per project (fetch.allowLocalhost).',
    enablementRequirements: [
      'Add trusted_hosts only for hosts whose raw content is safe to expose to the model.',
      'Keep fetch.sanitizeMode at safe-text or strict unless the target host is explicitly trusted.',
    ],
    operationalNotes: [
      'Requests to private IPs, link-local metadata endpoints, and encoded private IP forms are always blocked.',
      'Redirect chains are validated hop-by-hop.',
      'Localhost fetches are refused until approved; the approval persists per project via fetch.allowLocalhost.',
    ],
  },
  {
    key: 'permissions.engine',
    type: 'setting',
    featureId: 'permissions-policy-engine',
    defaultState: FEATURE_FLAG_MAP.get('permissions-policy-engine')?.defaultState ?? 'disabled',
    securityRelevant: true,
    summary: 'Selects the layered permission evaluator (policy-engine) for tool execution.',
    insecureWhen:
      'At baseline, the SDK uses the baseline permission manager and does not enforce layered path/tool policy bundles.',
    enablementEffect:
      'At policy-engine, tool calls can be evaluated against granular runtime policy rules before execution.',
    enablementRequirements: [
      'Provide or load a valid permission policy.',
      'Validate policy behavior in prompt/custom modes before using enforce-heavy deployments.',
    ],
    operationalNotes: [
      'Applies at startup; set it before constructing runtime services.',
    ],
  },
  {
    key: 'policy.requireSignedBundles',
    type: 'setting',
    featureId: 'policy-signing',
    defaultState: FEATURE_FLAG_MAP.get('policy-signing')?.defaultState ?? 'disabled',
    securityRelevant: true,
    summary: 'Controls HMAC signature validation for managed permission policy bundles.',
    insecureWhen:
      'When off, managed policy bundles are not cryptographically verified by this check.',
    enablementEffect:
      'When on, managed mode rejects policy bundles with invalid or missing signatures.',
    enablementRequirements: [
      'Provision the policy signing secret in the runtime environment or secret store.',
      'Sign policy bundles before loading them in managed mode.',
    ],
    operationalNotes: [
      'Unsigned local development bundles may need a non-managed mode or explicit signing during rollout.',
    ],
  },
  {
    key: 'permissions.simulation',
    type: 'setting',
    featureId: 'permissions-simulation',
    defaultState: FEATURE_FLAG_MAP.get('permissions-simulation')?.defaultState ?? 'enabled',
    securityRelevant: true,
    summary: 'Runs the candidate permission evaluator beside the active evaluator without changing enforcement.',
    insecureWhen:
      'When off, operators do not receive divergence telemetry before moving to stricter permission policy enforcement.',
    enablementEffect:
      'When on (the default), the SDK records evaluator divergence so clients can validate a stricter permission policy before enforcing it.',
    enablementRequirements: [
      'Review divergence diagnostics before switching enforcement modes.',
    ],
    operationalNotes: [
      'Simulation never blocks tool execution by itself; it is an observability step for permission hardening.',
    ],
  },
  {
    key: 'permissions.divergenceDashboard',
    type: 'setting',
    featureId: 'permission-divergence-dashboard',
    defaultState: FEATURE_FLAG_MAP.get('permission-divergence-dashboard')?.defaultState ?? 'enabled',
    securityRelevant: true,
    summary: 'Surfaces permission evaluator divergence and gates enforce-mode rollout.',
    insecureWhen:
      'When off, clients may lack a first-class view of permission divergence before enabling stricter enforcement.',
    enablementEffect:
      'When on (the default), divergence by command class, prefix, and mode is exposed for diagnostics and can block unsafe enforce-mode transitions.',
    enablementRequirements: [
      'Keep permissions.simulation on so divergence data exists.',
      'Configure an acceptable divergence threshold for the host surface.',
    ],
    operationalNotes: [
      'This is a rollout-control feature; it may prevent policy promotion until divergence is resolved.',
    ],
  },
  {
    key: 'policy.registryEnabled',
    type: 'setting',
    featureId: 'policy-as-code',
    defaultState: FEATURE_FLAG_MAP.get('policy-as-code')?.defaultState ?? 'disabled',
    securityRelevant: true,
    summary: 'Controls versioned permission policy bundle promotion and rollback.',
    insecureWhen:
      'When off, permission policy changes are not managed through SDK-level promote/rollback controls.',
    enablementEffect:
      'When on, policy bundles can be loaded, diffed, simulated, promoted, and rolled back with recorded evidence.',
    enablementRequirements: [
      'Define a policy bundle source and promotion flow.',
      'Use permissions.simulation and policy.requireSignedBundles for high-assurance managed deployments.',
    ],
    operationalNotes: [
      'Operational clients need to handle policy promotion failures and rollback states.',
    ],
  },
  {
    key: 'runtime.toolBudget.enforced',
    type: 'setting',
    featureId: 'runtime-tools-budget-enforcement',
    defaultState: FEATURE_FLAG_MAP.get('runtime-tools-budget-enforcement')?.defaultState ?? 'disabled',
    securityRelevant: true,
    summary: 'Controls runtime budget enforcement for tool execution pipelines.',
    insecureWhen:
      'When off, tool phases do not fail closed on SDK-level wall-clock, token, or cost budget breaches.',
    enablementEffect:
      'When on, tools can be interrupted at phase boundaries when configured budgets are exceeded.',
    enablementRequirements: [
      'Configure appropriate budget limits (runtime.toolBudget.maxMs/maxTokens/maxCostUsd) for the host surface.',
      'Ensure callers handle budget-exceeded tool errors as normal failures.',
    ],
    operationalNotes: [
      'Long-running tools or large batch operations may fail earlier once budgets are enforced.',
    ],
  },
  {
    key: 'security.tokenAudit.enabled',
    type: 'setting',
    featureId: 'token-scope-rotation-audit',
    defaultState: FEATURE_FLAG_MAP.get('token-scope-rotation-audit')?.defaultState ?? 'enabled',
    securityRelevant: true,
    summary: 'Audits API tokens for excessive scopes and stale rotation cadence.',
    insecureWhen:
      'When off, token scope and age findings are not reported at all; when on without security.tokenAudit.managed, findings are advisory only.',
    enablementEffect:
      'When on (the default) with security.tokenAudit.managed, tokens with excess scopes or expired rotation windows can be blocked from use.',
    enablementRequirements: [
      'Define expected token scopes for the deployed integrations.',
      'Configure rotation cadence and managed-mode policy before relying on blocking behavior.',
    ],
    operationalNotes: [
      'In managed mode, tokens that currently work may be blocked if they are over-scoped or overdue for rotation.',
    ],
  },
  {
    key: 'tools.contractVerification',
    type: 'setting',
    featureId: 'tool-contract-verification',
    defaultState: FEATURE_FLAG_MAP.get('tool-contract-verification')?.defaultState ?? 'enabled',
    securityRelevant: true,
    summary: 'Validates registered tool contracts, timeout behavior, permission class mapping, and output policy alignment.',
    insecureWhen:
      'When off, malformed or under-declared tools can register without SDK contract verification.',
    enablementEffect:
      'When on (the default), invalid tool contracts fail closed with actionable diagnostics before normal execution.',
    enablementRequirements: [
      'Keep tool definitions accurate, including side effects and permission classes.',
      'Fix contract diagnostics in custom tool plugins before enabling in strict deployments.',
    ],
    operationalNotes: [
      'On by default; turning it off should be limited to isolated tool-development sessions.',
    ],
  },
  {
    key: 'permissions.commandParser',
    type: 'setting',
    featureId: 'shell-ast-normalization',
    defaultState: FEATURE_FLAG_MAP.get('shell-ast-normalization')?.defaultState ?? 'enabled',
    securityRelevant: true,
    summary: 'Controls AST-aware shell command evaluation for exec permission review (default ast).',
    insecureWhen:
      'At flat, exec command review uses baseline flat segmentation for every command and may provide less precise command verdicts.',
    enablementEffect:
      'At ast (the default), compound shell commands are decomposed into per-segment verdicts with more specific denial explanations. A parser failure falls back automatically to the baseline flat-segmentation matcher — never a hard error and never a blanket allow — and the frozen catastrophic block is enforced identically in both modes.',
    enablementRequirements: [
      'None — ast is the default and remains runtime-switchable.',
      'Set permissions.commandParser to flat to force the baseline matcher for every command.',
    ],
    operationalNotes: [
      'Complex shell syntax receives more granular per-segment verdicts in ast mode.',
      'Denial explanations come from the AST verdict when the parse succeeds; on parse failure the baseline matcher produces the denial instead.',
    ],
  },
];

export function getSecuritySettingsReport(
  reporter: SecuritySettingsReporter | null | undefined,
): SecuritySettingReport[] {
  return SECURITY_FEATURE_SETTINGS.map((setting) => {
    const currentState = reporter?.getState
      ? safeGetState(reporter, setting.featureId, setting.defaultState)
      : reporter?.isEnabled?.(setting.featureId)
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
  featureId: string,
  fallback: FlagState | string,
): FlagState | string {
  try {
    return reporter.getState?.(featureId) ?? fallback;
  } catch {
    return fallback;
  }
}
