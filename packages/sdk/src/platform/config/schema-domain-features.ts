/**
 * schema-domain-features.ts — config domains for runtime features whose
 * meaningful tuning knobs were previously constructor- or tool-call-only:
 * fetch sanitization, the token audit, integration delivery, policy bundles,
 * and agent context/injection tuning. Defaults equal the values those features
 * hardcoded before promotion, so a fresh config reproduces prior behaviour;
 * constructor/per-call params still override.
 *
 * These five sections are top-level config domains, so — like the worktree
 * domain in schema-domain-runtime.ts — they augment GoodVibesConfig via
 * `declare module` here (co-located with their defaults) instead of editing
 * schema-types.ts. Registering the domain is what keeps get('fetch.*') etc. from
 * throwing "section 'fetch' does not exist"; the scalar keys additionally appear
 * in the ConfigKey union / ConfigValue map in schema-types.ts so config.get is typed.
 */
import type { ConfigSetting } from './schema-types.js';
import { intRange, numRange } from './schema-shared.js';

/** Fetch tool: response-sanitization mode, trust-tier host defaults, localhost approval. */
export interface FetchConfig {
  /** Default sanitize mode applied when a fetch call omits sanitize_mode. */
  sanitizeMode: 'none' | 'safe-text' | 'strict';
  /** Comma-separated default trusted hosts (sanitize relaxed); per-call trusted_hosts still adds. */
  trustedHosts: string;
  /** Comma-separated default blocked hosts (always refused); per-call blocked_hosts still adds. */
  blockedHosts: string;
  /**
   * Allow fetches to localhost/loopback dev servers for this project. Persisted
   * per project by the one-tap "allow for this project" approval; private-IP and
   * cloud-metadata blocking is unaffected and absolute.
   */
  allowLocalhost: boolean;
}

/** API token audit: enablement, rotation cadence / warning window / managed enforcement. */
export interface SecurityConfig {
  tokenAudit: {
    enabled: boolean;
    rotationCadenceDays: number;
    rotationWarningDays: number;
    managed: boolean;
  };
}

/** Channel integrations: route binding, delivery tracking, retry / dead-letter / SLO defaults. */
export interface IntegrationsConfig {
  /** Durable binding/resolution of external conversation routes and reply targets. */
  routeBinding: boolean;
  /** First-class delivery tracking: retries, dead letters, per-surface outcomes. */
  deliveryTracking: boolean;
  delivery: {
    maxRetries: number;
    initialDelayMs: number;
    maxDelayMs: number;
    maxDlqSize: number;
    sloEnforced: boolean;
  };
}

/** Policy bundles: registry enablement, signature requirement, bundle source + path. */
export interface PolicyConfig {
  /** Versioned policy bundle registry with promote/rollback and the /policy commands. */
  registryEnabled: boolean;
  /** Reject policy bundles with invalid or missing HMAC signatures in managed mode (restart to apply). */
  requireSignedBundles: boolean;
  bundleSource: 'none' | 'file';
  bundlePath: string;
}

/** Passive-injection and context-window tuning for the agent orchestrator. */
export interface AgentsConfig {
  passiveInjection: {
    /** Per-turn re-retrieval of project-memory knowledge against the evolving conversation. */
    knowledge: boolean;
    /** Additionally inject similarity-ranked source-code chunks (opt-in; higher-variance signal). */
    code: boolean;
    budgetTokens: number;
    relevanceFloor: number;
    codeLimit: number;
  };
  /** Estimate token usage before each provider call and compact past the threshold. */
  contextWindowGuard: boolean;
  contextCompactThreshold: number;
  /** Default per-agent turn budget (hard cap on turns before a run is a max-turns failure). */
  maxTurns: number;
  /** Upper bound a per-spawn maxTurns override cannot exceed — the policy cap always wins. */
  maxTurnsCap: number;
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
    allowLocalhost: false,
  },
  security: {
    tokenAudit: {
      enabled: true,
      rotationCadenceDays: 90,
      rotationWarningDays: 14,
      managed: false,
    },
  },
  integrations: {
    routeBinding: true,
    deliveryTracking: true,
    delivery: {
      maxRetries: 3,
      initialDelayMs: 1_000,
      maxDelayMs: 30_000,
      maxDlqSize: 500,
      sloEnforced: true,
    },
  },
  policy: {
    registryEnabled: false,
    requireSignedBundles: false,
    bundleSource: 'none',
    bundlePath: '',
  },
  agents: {
    passiveInjection: {
      knowledge: true,
      code: false,
      budgetTokens: 800,
      relevanceFloor: 95,
      codeLimit: 3,
    },
    contextWindowGuard: true,
    contextCompactThreshold: 0.85,
    maxTurns: 50,
    maxTurnsCap: 200,
  },
};

export const featureConfigSettings: ConfigSetting[] = [
  {
    key: 'fetch.sanitizeMode',
    type: 'enum',
    default: 'safe-text',
    description:
      'Default response sanitization mode applied by the fetch tool when the per-call sanitize_mode is omitted: none (no content sanitization), safe-text (strip active/script content, default), or strict (aggressive text-only reduction). A per-call sanitize_mode always overrides this default. Private-IP and cloud-metadata host blocking applies regardless of mode.',
    enumValues: ['none', 'safe-text', 'strict'],
  },
  {
    key: 'fetch.allowLocalhost',
    type: 'boolean',
    default: false,
    description:
      'Allow the fetch tool to reach localhost/loopback dev servers for this project (e.g. http://localhost:3000). Set by the one-tap "allow for this project" answer to the localhost fetch ask and persisted in the project settings, so it never re-asks. Private-IP and cloud-metadata endpoint blocking is unaffected and absolute.',
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
    key: 'security.tokenAudit.enabled',
    type: 'boolean',
    default: true,
    description:
      'Audit API tokens for minimum-scope violations and overdue rotation, surfacing age, scope, and rotation warnings in diagnostics with typed security events. Default on in advisory mode: tokens are reported, never blocked, unless security.tokenAudit.managed is also true.',
  },
  {
    key: 'security.tokenAudit.rotationCadenceDays',
    type: 'number',
    default: 90,
    description:
      'Default rotation cadence (days) for the token audit: a token older than this is reported overdue. Per-policy rotationCadenceMs overrides this default. Only enforced (blocking) when security.tokenAudit.managed is also true.',
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
      'When true (and security.tokenAudit.enabled is on), tokens with excess scopes or overdue rotation are BLOCKED from use rather than only reported. Default false = advisory reporting only.',
  },
  {
    key: 'integrations.routeBinding',
    type: 'boolean',
    default: true,
    description:
      'Durably bind and resolve external conversation routes, thread contexts, and reply targets across channel surfaces. Default on; it is inert until a channel surface is configured.',
  },
  {
    key: 'integrations.deliveryTracking',
    type: 'boolean',
    default: true,
    description:
      'Track integration deliveries first-class: retries, dead letters, and per-surface delivery outcomes. Default on; it is inert until a channel surface is configured.',
  },
  {
    key: 'integrations.delivery.maxRetries',
    type: 'number',
    default: 3,
    description:
      'Maximum retry attempts for a retryable integration delivery (Slack/Discord/webhook) before it moves to the dead-letter queue. A per-queue maxRetries option overrides this default.',
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
    default: true,
    description:
      'Enforce delivery service-level objectives for channel integrations: failures are classified retryable/terminal, retried with exponential backoff, and dead-letter events are logged at error level and surfaced in integration diagnostics (replayable via /notify replay). When false, dead letters are warn-level only. An explicit per-queue sloEnforced option still overrides this default.',
  },
  {
    key: 'policy.registryEnabled',
    type: 'boolean',
    default: false,
    description:
      'Enable the versioned policy bundle registry with promote/rollback semantics and the /policy load, simulate, diff, promote, and rollback commands. Enforcement requires passing divergence-gate evidence first; default off until that evidence exists.',
  },
  {
    key: 'policy.requireSignedBundles',
    type: 'boolean',
    default: false,
    description:
      'Validate HMAC-SHA256 signatures when policy bundles load: managed mode rejects bundles with invalid or missing signatures; non-managed mode permits unsigned bundles with a warning. Restart to apply. Default off until divergence evidence clears the governance gate.',
  },
  {
    key: 'policy.bundleSource',
    type: 'enum',
    default: 'none',
    description:
      'Where the policy bundle registry loads its initial bundle from at startup: none (no bundle loaded; bundles supplied programmatically or via commands), or file (load policy.bundlePath). Only consulted when policy.registryEnabled is true.',
    enumValues: ['none', 'file'],
  },
  {
    key: 'policy.bundlePath',
    type: 'string',
    default: '',
    description:
      'Filesystem path to the policy bundle JSON loaded at startup when policy.bundleSource is "file" and policy.registryEnabled is true. Empty disables file loading. The loaded bundle enters the registry as a candidate (subject to the divergence gate before promotion).',
  },
  {
    key: 'agents.passiveInjection.knowledge',
    type: 'boolean',
    default: true,
    description:
      'Re-retrieve project-memory knowledge each turn against the evolving conversation (steers, new sub-topics), under the hard token budget with a visible per-turn injection record on the agent record and session transcript. Default on: the block is hard-budgeted and every turn is honestly recorded. Turn off to revert to spawn-time-only injection.',
  },
  {
    key: 'agents.passiveInjection.code',
    type: 'boolean',
    default: false,
    description:
      'Additionally inject similarity-ranked chunks from the repo source-code index each turn as untrusted reference pointers, sharing the knowledge-injection budget and relevance floor, each with an honest match label on the turn record. Default off: code chunks carry no review provenance, so this is deliberately opt-in. Also respects storage.codeIndexEnabled.',
  },
  {
    key: 'agents.passiveInjection.budgetTokens',
    type: 'number',
    default: 800,
    description:
      'Default hard token budget for per-turn passive knowledge/code injection. The effective budget is min(this value, 3% of the model context window). Set 0 to disable injection. A per-run passiveKnowledgeInjectionBudgetTokens override still wins.',
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
      'Maximum number of source-code chunks injected per turn by passive code injection (chunks share the passive-injection token budget and relevance floor).',
    ...intRange(0, 100),
  },
  {
    key: 'agents.contextWindowGuard',
    type: 'boolean',
    default: true,
    description:
      'Before each sub-agent provider call, estimate total token count (system prompt + messages + tool definitions) and compact the conversation past agents.contextCompactThreshold, with layered system-prompt assembly for small windows and a single compaction retry on context-size errors. Turn off to revert to unchecked provider calls.',
  },
  {
    key: 'agents.contextCompactThreshold',
    type: 'number',
    default: 0.85,
    description:
      'Fraction of the model context window at which the agent context-window guard triggers sub-agent conversation compaction (estimated system + messages + tool tokens above this fraction compacts). Distinct from behavior.autoCompactThreshold, which governs main-session conversation compaction.',
    ...numRange(0.1, 0.99),
  },
  {
    key: 'agents.maxTurns',
    type: 'number',
    default: 50,
    description:
      'Default per-agent turn budget: the hard cap on how many turns one agent run may take before it terminates as a max-turns failure (a machine-readable turn-budget-exhausted outcome, distinct from an infrastructure error). A per-spawn override may lower or raise this, but never past agents.maxTurnsCap. Prevents an unbounded agent loop.',
    ...intRange(1, 10_000),
  },
  {
    key: 'agents.maxTurnsCap',
    type: 'number',
    default: 200,
    description:
      'The upper bound a per-spawn maxTurns override cannot exceed. When a spawn requests more turns than this, the cap wins and the applied budget is reported as policy-bound. Keeps a caller from lifting the turn ceiling without limit.',
    ...intRange(1, 100_000),
  },
];
