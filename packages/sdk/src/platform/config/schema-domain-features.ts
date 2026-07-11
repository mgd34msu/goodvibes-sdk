/**
 * schema-domain-features.ts — config for flag-gated runtime features whose
 * meaningful tuning knobs were previously constructor- or tool-call-only. Each
 * section here backs one feature flag (see runtime/feature-flags/flags.ts and
 * the FEATURE_FLAG_CONFIG association map). Defaults equal the values those
 * features hardcoded before promotion, so turning a flag on with no config
 * change reproduces prior behaviour; constructor/per-call params still override.
 *
 * These five sections are brand-new top-level config domains, so — like the
 * worktree domain in schema-domain-runtime.ts — they augment GoodVibesConfig
 * via `declare module` here (co-located with their defaults) instead of editing
 * schema-types.ts. Registering the domain is what keeps get('fetch.*') etc. from
 * throwing "section 'fetch' does not exist"; the scalar keys additionally appear
 * in the ConfigKey union / ConfigValue map in schema-types.ts so config.get is typed.
 */
import type { ConfigSetting } from './schema-types.js';
import { intRange, numRange } from './schema-shared.js';

/** fetch-sanitization: default response-sanitization mode + trust-tier host defaults. */
export interface FetchConfig {
  /** Default sanitize mode applied when a fetch call omits sanitize_mode. */
  sanitizeMode: 'none' | 'safe-text' | 'strict';
  /** Comma-separated default trusted hosts (sanitize relaxed); per-call trusted_hosts still adds. */
  trustedHosts: string;
  /** Comma-separated default blocked hosts (always refused); per-call blocked_hosts still adds. */
  blockedHosts: string;
}

/** token-scope-rotation-audit: rotation cadence / warning window / managed enforcement defaults. */
export interface SecurityConfig {
  tokenAudit: {
    rotationCadenceDays: number;
    rotationWarningDays: number;
    managed: boolean;
  };
}

/** integration-delivery-slo: retry / backoff / dead-letter / SLO-enforcement defaults. */
export interface IntegrationsConfig {
  delivery: {
    maxRetries: number;
    initialDelayMs: number;
    maxDelayMs: number;
    maxDlqSize: number;
    sloEnforced: boolean;
  };
}

/** policy-as-code: bundle source + path so the registry is configurable without /policy commands. */
export interface PolicyConfig {
  bundleSource: 'none' | 'file';
  bundlePath: string;
}

/** Passive-injection and context-window-awareness tuning for the agent orchestrator. */
export interface AgentsConfig {
  passiveInjection: {
    budgetTokens: number;
    relevanceFloor: number;
    codeLimit: number;
  };
  contextCompactThreshold: number;
}

declare module './schema-types.js' {
  interface GoodVibesConfig {
    fetch: FetchConfig;
    security: SecurityConfig;
    integrations: IntegrationsConfig;
    policy: PolicyConfig;
    agents: AgentsConfig;
  }
}

export const featureConfigDefaults: {
  fetch: FetchConfig;
  security: SecurityConfig;
  integrations: IntegrationsConfig;
  policy: PolicyConfig;
  agents: AgentsConfig;
} = {
  fetch: {
    sanitizeMode: 'safe-text',
    trustedHosts: '',
    blockedHosts: '',
  },
  security: {
    tokenAudit: {
      rotationCadenceDays: 90,
      rotationWarningDays: 14,
      managed: false,
    },
  },
  integrations: {
    delivery: {
      maxRetries: 3,
      initialDelayMs: 1_000,
      maxDelayMs: 30_000,
      maxDlqSize: 500,
      sloEnforced: false,
    },
  },
  policy: {
    bundleSource: 'none',
    bundlePath: '',
  },
  agents: {
    passiveInjection: {
      budgetTokens: 800,
      relevanceFloor: 95,
      codeLimit: 3,
    },
    contextCompactThreshold: 0.85,
  },
};

export const featureConfigSettings: ConfigSetting[] = [
  {
    key: 'fetch.sanitizeMode',
    type: 'enum',
    default: 'safe-text',
    description:
      'Default response sanitization mode applied by the fetch tool when the fetch-sanitization feature flag is on and the per-call sanitize_mode is omitted: none (no sanitization), safe-text (strip active/script content, default), or strict (aggressive text-only reduction). A per-call sanitize_mode always overrides this default.',
    enumValues: ['none', 'safe-text', 'strict'],
  },
  {
    key: 'fetch.trustedHosts',
    type: 'string',
    default: '',
    description:
      'Comma-separated default trusted hosts for fetch sanitization/trust-tier classification (e.g. docs.example.com, api.internal). Trusted hosts relax sanitization. Per-call trusted_hosts are added on top of this default; empty means no host is trusted by default.',
  },
  {
    key: 'fetch.blockedHosts',
    type: 'string',
    default: '',
    description:
      'Comma-separated default blocked hosts for fetch trust-tier classification. Blocked hosts are always refused regardless of sanitize mode. Per-call blocked_hosts are added on top of this default. The built-in SSRF-risk block (private IPs, metadata endpoints, localhost variants) applies independently of this list.',
  },
  {
    key: 'security.tokenAudit.rotationCadenceDays',
    type: 'number',
    default: 90,
    description:
      'Default rotation cadence (days) for the token-scope-rotation-audit feature: a token older than this is reported overdue. Per-policy rotationCadenceMs overrides this default. Only enforced (blocking) when security.tokenAudit.managed is true and the feature flag is enabled.',
    ...intRange(1, 3650),
  },
  {
    key: 'security.tokenAudit.rotationWarningDays',
    type: 'number',
    default: 14,
    description:
      'Default lead time (days) before the rotation-cadence due date at which a token is reported as a rotation warning. Per-policy rotationWarningThresholdMs overrides this default.',
    ...intRange(0, 3650),
  },
  {
    key: 'security.tokenAudit.managed',
    type: 'boolean',
    default: false,
    description:
      'When true (and the token-scope-rotation-audit feature flag is enabled), tokens with excess scopes or overdue rotation are BLOCKED from use rather than only reported. Default false = advisory reporting only.',
  },
  {
    key: 'integrations.delivery.maxRetries',
    type: 'number',
    default: 3,
    description:
      'Maximum retry attempts for a retryable integration delivery (Slack/Discord/webhook) before it moves to the dead-letter queue, when the integration-delivery-slo feature is active. A per-queue maxRetries option overrides this default.',
    ...intRange(0, 100),
  },
  {
    key: 'integrations.delivery.initialDelayMs',
    type: 'number',
    default: 1_000,
    description:
      'Initial exponential-backoff delay (ms) between integration delivery retries. Delay grows as initialDelayMs * 2^(attempt-1) with jitter, capped at integrations.delivery.maxDelayMs.',
    ...intRange(0, 60 * 60 * 1000),
  },
  {
    key: 'integrations.delivery.maxDelayMs',
    type: 'number',
    default: 30_000,
    description: 'Upper cap (ms) on the exponential-backoff delay between integration delivery retries.',
    ...intRange(0, 24 * 60 * 60 * 1000),
  },
  {
    key: 'integrations.delivery.maxDlqSize',
    type: 'number',
    default: 500,
    description:
      'Maximum entries retained in the integration delivery dead-letter queue; oldest entries are evicted first past this size.',
    ...intRange(1, 100_000),
  },
  {
    key: 'integrations.delivery.sloEnforced',
    type: 'boolean',
    default: false,
    description:
      'When true (or the integration-delivery-slo feature flag is enabled), dead-letter events are logged at error level and surfaced in integration diagnostics; when false they are warn-level only. An explicit per-queue sloEnforced option still overrides this default.',
  },
  {
    key: 'policy.bundleSource',
    type: 'enum',
    default: 'none',
    description:
      'Where the policy-as-code registry loads its initial bundle from at startup: none (no bundle loaded; bundles supplied programmatically or via commands), or file (load policy.bundlePath). Only consulted when the policy-as-code feature flag is enabled.',
    enumValues: ['none', 'file'],
  },
  {
    key: 'policy.bundlePath',
    type: 'string',
    default: '',
    description:
      'Filesystem path to the policy bundle JSON loaded at startup when policy.bundleSource is "file" and the policy-as-code feature flag is enabled. Empty disables file loading. The loaded bundle enters the registry as a candidate (subject to the divergence gate before promotion).',
  },
  {
    key: 'agents.passiveInjection.budgetTokens',
    type: 'number',
    default: 800,
    description:
      'Default hard token budget for per-turn passive knowledge/code injection (agent-passive-knowledge-injection / agent-passive-code-injection). The effective budget is min(this value, 3% of the model context window). Set 0 to disable injection. A per-run passiveKnowledgeInjectionBudgetTokens override still wins.',
    ...intRange(0, 1_000_000),
  },
  {
    key: 'agents.passiveInjection.relevanceFloor',
    type: 'number',
    default: 95,
    description:
      'Minimum relevance score (higher = stricter) a knowledge/code candidate must clear to be eligible for per-turn passive injection. Filters filler before the token budget is applied. A per-run passiveKnowledgeInjectionRelevanceFloor override still wins.',
    ...intRange(0, 1000),
  },
  {
    key: 'agents.passiveInjection.codeLimit',
    type: 'number',
    default: 3,
    description:
      'Maximum number of source-code chunks injected per turn by agent-passive-code-injection (chunks share the passive-injection token budget and relevance floor).',
    ...intRange(0, 100),
  },
  {
    key: 'agents.contextCompactThreshold',
    type: 'number',
    default: 0.85,
    description:
      'Fraction of the model context window at which the agent-context-window-awareness feature triggers sub-agent conversation compaction (estimated system + messages + tool tokens above this fraction compacts). Distinct from behavior.autoCompactThreshold, which governs main-session conversation compaction.',
    ...numRange(0.1, 0.99),
  },
];
