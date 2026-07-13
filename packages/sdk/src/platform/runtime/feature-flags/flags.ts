/**
 * Internal registry of platform capabilities and their default dispositions.
 *
 * Every entry here is a first-class feature configured through its own domain
 * settings (see feature-settings.ts for the id -> settings-key bindings that
 * surfaces consume). Each defaultState is an owner-ruled default, recorded in
 * the 2026-07-11 rulings worksheet; a disabled entry is a chosen default on a
 * configurable feature, never unreachable capability.
 *
 * This module is implementation detail: the emergency kill-switch plumbing
 * keys off these ids, but no surface renders this registry as its own
 * category — consumers render FEATURE_SETTINGS (domain, option shapes,
 * descriptions) from feature-settings.ts.
 *
 * Ids follow the kebab-case naming convention used throughout the runtime.
 */
import type { FeatureFlag } from './types.js';

/**
 * The canonical list of platform capabilities across all implementation tiers.
 *
 * Add new entries here AND bind them in feature-settings.ts; the manager
 * initialises from this array at startup and the lockstep tests keep the
 * registry, the settings bindings, and the config association map aligned.
 */
export const FEATURE_FLAGS: FeatureFlag[] = [
  // ── Tier 2 ───────────────────────────────────────────────────────────────
  {
    id: 'permissions-policy-engine',
    name: 'Permissions Policy Engine',
    description:
      'Activates the redesigned permission model with granular tool-level and path-level rules.',
    defaultState: 'disabled',
    tier: 2,
    runtimeToggleable: false,
  },

  {
    id: 'permissions-simulation',
    name: 'Permissions Simulation Mode',
    description:
      'Enables the dual-evaluator simulation pipeline for the permissions policy engine. '
      + 'Tracks divergence between actual and candidate evaluators without '
      + 'changing enforcement behaviour until switched to enforce mode. '
      + 'On by default so divergence evidence accumulates before any stricter '
      + 'enforcement is considered; it never blocks tool execution by itself.',
    defaultState: 'enabled',
    tier: 2,
    runtimeToggleable: false,
  },

  // ── Tier 3 ───────────────────────────────────────────────────────────────
  {
    id: 'hitl-ux-modes',
    name: 'HITL UX Modes',
    description:
      'Enables the HITL UX mode system (quiet/balanced/operator) for notification verbosity '
      + 'control. When enabled, ModeManager applies the configured HITL preset to the '
      + 'notification router at startup and on mode change. '
      + 'Set behavior.hitlMode to off to keep the router on its baseline delivery policy '
      + 'and reject HITL mode changes.',
    defaultState: 'enabled',
    tier: 3,
    runtimeToggleable: true,
  },

  {
    id: 'unified-runtime-task',
    name: 'Unified RuntimeTask',
    description:
      'Replaces ad-hoc task tracking with the unified RuntimeTask interface across all subsystems.',
    defaultState: 'disabled',
    tier: 3,
    runtimeToggleable: false,
  },

  // ── Tier 4 ───────────────────────────────────────────────────────────────
  {
    id: 'plugin-lifecycle',
    name: 'Plugin Lifecycle',
    description:
      'Enables the plugin lifecycle with structured init/teardown phases and health integration.',
    defaultState: 'disabled',
    tier: 4,
    runtimeToggleable: false,
  },
  {
    id: 'mcp-lifecycle',
    name: 'MCP Lifecycle',
    description:
      'Enables the MCP server lifecycle with structured connect/disconnect phases and health integration.',
    defaultState: 'disabled',
    tier: 4,
    runtimeToggleable: false,
  },
  {
    id: 'otel-foundation',
    name: 'OTel Foundation',
    description:
      'Enables the OpenTelemetry instrumentation foundation: SDK init, span creation, and in-process export.',
    defaultState: 'disabled',
    tier: 4,
    runtimeToggleable: false,
  },

  // ── Tier 5 ───────────────────────────────────────────────────────────────
  {
    id: 'otel-remote-export',
    name: 'OTel Remote Export',
    description:
      'Enables OTLP/gRPC remote export of spans to a configured collector endpoint. Requires otel-foundation.',
    defaultState: 'disabled',
    tier: 5,
    runtimeToggleable: true,
  },

  // ── Tier 7 ───────────────────────────────────────────────────────────────
  {
    id: 'tool-result-reconciliation',
    name: 'Tool Result Reconciliation',
    description:
      'Detects and reconciles unresolved tool calls at turn end. '
      + 'When enabled, dangling tool-call state causes synthetic error results '
      + 'to be injected and a reconciliation event to be emitted, preventing '
      + 'silent conversation corruption. Disable to keep warning-only logging '
      + 'without synthetic result injection.',
    defaultState: 'enabled',
    tier: 7,
    runtimeToggleable: true,
  },

  // ── Tier 7 (continued) ──────────────────────────────────────────────────
  {
    id: 'policy-signing',
    name: 'Policy Signing',
    description:
      'Enables HMAC-SHA256 signature validation on policy bundle load. '
      + 'When enabled, managed mode rejects bundles with invalid or missing signatures. '
      + 'In non-managed mode, unsigned bundles are permitted with a warning status.',
    defaultState: 'disabled',
    tier: 7,
    runtimeToggleable: false,
  },
  {
    id: 'session-compaction',
    name: 'Session Compaction',
    description:
      'Activates structured session compaction with semantic chunking and relevance scoring. '
      + 'On by default: long sessions compact at behavior.autoCompactThreshold with a receipt '
      + 'on every compaction. Set behavior.compactionStrategy to off to run uncompacted.',
    defaultState: 'enabled',
    tier: 6,
    runtimeToggleable: true,
  },

  {
    id: 'compaction-distiller-strategy',
    name: 'Fresh-Context Distiller Compaction',
    description:
      'Enables the fresh-context DISTILLER compaction strategy as an alternative to '
      + 'the default in-place structured summarization. When on AND '
      + 'behavior.compactionStrategy is set to "distiller", one fresh model call distills '
      + 'the conversation into a structured continuation brief (task state, decisions, open '
      + 'threads, key file/symbol references) that seeds a fresh context, instead of '
      + 'assembling a handoff from many targeted extraction calls. The distillation is scored '
      + 'through the SAME quality scorer as the structured strategy and falls back to '
      + 'structured when it scores below the floor or the fresh call is unavailable — the '
      + 'receipt names the strategy used and any fallback. Standing instruction-chain / '
      + 'active-skill re-injection at the boundary applies to both strategies. Not the '
      + 'default: structured remains the default strategy until quality-score evidence '
      + 'earns distiller the default slot; choose it via behavior.compactionStrategy.',
    defaultState: 'disabled',
    tier: 6,
    runtimeToggleable: true,
  },

  {
    id: 'fetch-sanitization',
    name: 'Fetch Response Sanitization',
    description:
      'Enables fetch response sanitization and host trust tier classification.'
      + ' Sanitizes HTTP response content (none/safe-text/strict modes, default safe-text).'
      + ' Requests to private IPs, cloud metadata endpoints, and encoded private-IP forms are'
      + ' always refused with an honest tool-result reason. Fetches to localhost dev servers'
      + ' ask once and can be allowed per project (fetch.allowLocalhost).'
      + ' Set fetch.sanitizeMode to none to skip content sanitization for trusted flows.',
    defaultState: 'enabled',
    tier: 8,
    runtimeToggleable: true,
  },

  {
    id: 'runtime-tools-budget-enforcement',
    name: 'Runtime Budget Enforcement',
    description:
      'Enables per-phase runtime budget enforcement for tool execution pipelines. '
      + 'Checks wall-clock time (BUDGET_EXCEEDED_MS), token consumption '
      + '(BUDGET_EXCEEDED_TOKENS), and cost (BUDGET_EXCEEDED_COST) limits at phase '
      + 'entry and exit. Terminates the pipeline immediately on hard budget breach '
      + 'and emits a typed diagnostic event. Disable to revert to unlimited execution.',
    defaultState: 'disabled',
    tier: 8,
    runtimeToggleable: true,
  },

  {
    id: 'overflow-spill-backends',
    name: 'Overflow Spill Backends',
    description:
      'Enables the pluggable spill backend system for overflow content. '
      + 'When enabled, spillBackend can be set to file|ledger|diagnostics via config. '
      + 'When disabled, overflow content uses the file spill backend.',
    defaultState: 'disabled',
    tier: 8,
    runtimeToggleable: true,
  },

  {
    id: 'permission-divergence-dashboard',
    name: 'Divergence Dashboard and Enforce Gate',
    description:
      'Enables the divergence dashboard and enforcement gate for permissions simulation. '
      + 'Aggregates divergence by tool/prefix/mode, exposes trend history in diagnostics, '
      + 'and blocks enforce mode transitions when the divergence rate exceeds the configured '
      + 'threshold. Disable to fall back to warn mode (no gate enforcement).',
    defaultState: 'enabled',
    tier: 8,
    runtimeToggleable: true,
  },

  {
    id: 'shell-ast-normalization',
    name: 'Shell AST Normalization',
    description:
      'Enables the Shell AST parser for compound command verdict evaluation. '
      + 'Produces per-segment verdicts (safe/unsafe) with user-facing denial '
      + 'explanations that are strictly more specific than the baseline. '
      + 'Default-on: the AST path is safe to default because a parser failure '
      + 'falls back automatically to the baseline flat segmentation matcher '
      + '(never a hard error, never a blanket allow), and the frozen '
      + 'catastrophic block is enforced identically in both modes. Disable at '
      + 'runtime to force the baseline flat segmentation mode for every command.',
    defaultState: 'enabled',
    tier: 8,
    runtimeToggleable: true,
  },

  {
    id: 'local-provider-context-ingestion',
    name: 'Local Provider Context Window Ingestion',
    description:
      'Enables dynamic ingestion of max_context_length from local/custom provider '
      + '/v1/models endpoints. When enabled, local models use the provider-reported '
      + 'context window (provenance: provider_api) for token budgeting and compaction '
      + 'thresholds instead of the statically-configured contextWindow value. '
      + 'Disable to revert to explicit configured or static limits (configured_cap / fallback).',
    defaultState: 'enabled',
    tier: 9,
    runtimeToggleable: true,
  },

  {
    id: 'agent-context-window-awareness',
    name: 'Agent Context Window Awareness',
    description:
      'Enables context window validation and compaction in the AgentOrchestrator. '
      + 'Before each provider.chat() call, estimates total token count (system prompt + '
      + 'messages + tool definitions) and compacts the conversation when usage exceeds '
      + '85% of the model context window. Also applies layered system prompt assembly '
      + '(drops conventions then project context for small windows) and catches '
      + '"context size exceeded" errors from the provider with a single compaction retry. '
      + 'Disable to revert to unchecked provider.chat() calls.',
    defaultState: 'enabled',
    tier: 9,
    runtimeToggleable: true,
  },

  {
    id: 'agent-passive-knowledge-injection',
    name: 'Agent Passive Knowledge Injection',
    description:
      'Enables per-turn re-retrieval of project-memory knowledge against the EVOLVING main-'
      + 'session conversation (steers, new sub-topics), not just the frozen spawn-time task. '
      + 'Re-runs retrieval only when a new user/steer message arrived this turn, applies a '
      + 'relevance floor to filter filler, and holds the injected block to a hard token '
      + 'budget (min ~800 tokens or 3% of the model context window) with a visible per-turn '
      + 'record (candidates considered, ids injected, ids dropped for budget, token cost, '
      + 'embeddings backend) stored on AgentRecord.turnInjections and the session transcript. '
      + 'Default-on is safe specifically because the block is hard-budgeted and every turn '
      + 'is honestly recorded, never silently eating context. Disable or set the budget to 0 '
      + 'to revert to spawn-time-only injection (base system prompt byte-identical).',
    defaultState: 'enabled',
    tier: 9,
    runtimeToggleable: true,
  },

  {
    id: 'agent-passive-code-injection',
    name: 'Agent Passive Code Injection',
    description:
      'Enables per-turn passive retrieval from the repo SOURCE-TREE CODE INDEX (CodeIndexStore) '
      + 'alongside project-memory knowledge, sharing the SAME token budget and relevance floor. '
      + 'When the query would benefit and the index is built, similarity-ranked code chunks are '
      + 'injected as untrusted reference pointers, each recorded on the turn injection record with '
      + 'source=code-index and its honest match label (semantic/lexical). Never injects from an '
      + 'empty or provider-mismatched index, or from a hashed-only (no real semantic) provider — '
      + 'the store exposes each of those and the turn record states which. '
      + 'DEFAULT OFF (unlike agent-passive-knowledge-injection, which defaults on): code injection '
      + 'is a newer, higher-variance signal than reviewed project memory — code chunks carry no '
      + 'review/trust provenance and a weak similarity match can pull in a plausibly-worded but '
      + 'wrong chunk — so this first landing is opt-in, earned on by the same hard-budget + '
      + 'honest-record discipline before it becomes a default. Also respects the embedder’s '
      + 'storage.codeIndexEnabled setting; disable either to revert to memory-only injection.',
    defaultState: 'disabled',
    tier: 9,
    runtimeToggleable: true,
  },

  {
    id: 'output-schema-fingerprint',
    name: 'Output Schema Fingerprints',
    description:
      'Appends `_meta.outputSchemaFingerprint` (SHA-256 of sorted result key names) '
      + 'and `_meta.schemaShapeId` (canonical mode identifier) to tool results from '
      + 'the find, analyze, and inspect tools. Enables schema drift detection and '
      + 'diagnostic fingerprint surfaces. Disable to omit fingerprint metadata.',
    defaultState: 'disabled',
    tier: 8,
    runtimeToggleable: true,
  },
  // ── Policy-as-Code ───────────────────────────────────────────────────────────
  {
    id: 'policy-as-code',
    name: 'Policy-as-Code',
    description:
      'Enables the versioned policy bundle registry with promote/rollback semantics. '
      + 'Requires simulation evidence (divergence gate passing) before enforcement. '
      + 'Exposes /policy load, /policy simulate, /policy diff, /policy promote, '
      + 'and /policy rollback commands. Divergence trends visible by command class/prefix '
      + 'via the diagnostics panel.',
    defaultState: 'disabled',
    tier: 5,
    runtimeToggleable: true,
  },

  // Adaptive Execution Planner.
  {
    id: 'adaptive-execution-planner',
    name: 'Adaptive Execution Planner',
    description:
      'Enables the Adaptive Execution Planner, which scores strategy candidates '
      + '(single/cohort/background/remote) using risk, latency, and capability '
      + 'inputs and selects the best execution strategy each turn. '
      + 'Exposes /plan mode, /plan explain, and /plan override commands. '
      + 'Disable to revert to implicit single-call execution.',
    defaultState: 'disabled',
    tier: 5,
    runtimeToggleable: true,
  },
  // Provider Optimizer.
  {
    id: 'provider-optimizer',
    name: 'Provider Optimizer',
    description:
      'Enables the capability-contract-driven provider routing optimizer. '
      + 'In auto mode, selects the best capable provider for each request profile '
      + 'using ProviderCapabilityRegistry contracts. Supports manual, auto, and pinned '
      + 'routing modes with deterministic, fully-explainable route decisions. '
      + 'Exposes /provider route, /provider explain-route, /provider pin, and '
      + '/provider fallback test commands.',
    defaultState: 'disabled',
    tier: 5,
    runtimeToggleable: true,
  },

  // ── Integration Delivery SLO ────────────────────────────────────────────
  {
    id: 'integration-delivery-slo',
    name: 'Integration Delivery SLO',
    description:
      'Enforces delivery service-level objectives for the enabled channel surfaces '
      + '(Slack, Discord, webhooks): failures are classified as retryable or terminal, '
      + 'retried with exponential backoff, and dead-letter events are logged at error '
      + 'level and surfaced in integration diagnostics. Dead-letter entries are exposed '
      + 'via /notify dlq and replayable via /notify replay. Enabled by default alongside '
      + 'the channel family it belongs to; disable to keep warn-level logging without '
      + 'DLQ tracking.',
    defaultState: 'enabled',
    tier: 6,
    runtimeToggleable: true,
  },
  // ── Adaptive Notification Suppression ──────────────────────────────────────
  {
    id: 'adaptive-notification-suppression',
    name: 'Adaptive Notification Suppression',
    description:
      'Enables mode-context and burst-detection policies in the NotificationRouter. '
      + 'In quiet/minimal mode, operational churn is suppressed before reaching the '
      + 'conversation or status bar. Burst detection collapses rapid domain:level '
      + 'floods into panel_only with a burst_collapsed reason code. '
      + 'On by default now that collapsed groups have a visible home: the notifications '
      + 'panel renders burst-collapsed groups with their reason codes. '
      + 'Disable to revert to base default + quiet-typing + batch-window policies only.',
    defaultState: 'enabled',
    tier: 3,
    runtimeToggleable: true,
  },

  // ── Token Scope and Rotation Audit ────────────────────────────────────────
  {
    id: 'token-scope-rotation-audit',
    name: 'Token Scope and Rotation Audit',
    description:
      'Enables minimum scope principle checks and rotation cadence audits for API tokens. '
      + 'In managed mode, tokens with excess scopes or overdue rotation are blocked from use. '
      + 'Diagnostics panel surfaces token age, scope violations, and rotation warnings. '
      + 'Emits TOKEN_SCOPE_VIOLATION, TOKEN_ROTATION_WARNING, TOKEN_ROTATION_EXPIRED, '
      + 'and TOKEN_BLOCKED events via the security event domain. '
      + 'On by default in advisory mode (security.tokenAudit.managed false): tokens are '
      + 'reported, never blocked, until managed enforcement is opted into.',
    defaultState: 'enabled',
    tier: 7,
    runtimeToggleable: true,
  },

  // Tool Contract Verification.
  {
    id: 'tool-contract-verification',
    name: 'Tool Contract Verification',
    description:
      'Enables registration-time contract checks for all registered tools. '
      + 'Validates schema validity, timeout/cancellation semantics, permission class '
      + 'mapping, output policy alignment, and idempotency declarations. '
      + 'Invalid tools fail closed with actionable diagnostics. '
      + 'Exposes /tool verify <name>, /tool verify-all, and /tool contract show <name> commands.',
    defaultState: 'enabled',
    tier: 8,
    runtimeToggleable: true,
  },

  // ── Automation and Omnichannel Foundation ───────────────────────────────
  {
    id: 'automation-domain',
    name: 'Automation Domain',
    description:
      'Enables the first-class automation job/run domain used by the shared scheduling engine. '
      + 'This is the top-level switch for durable automation records, schedule evaluation, and '
      + 'run history. On by default: with no routines defined it idles and surfaces a '
      + 'how-to-create-your-first-routine empty state instead of requiring setup.',
    defaultState: 'enabled',
    tier: 10,
    runtimeToggleable: true,
  },
  {
    // NOTE: control-plane-gateway was the first tier-10 capability to default ON (One-Platform).
    // A stock daemon (no config) must be able to stream companion chat over SSE;
    // leaving this OFF made a fresh daemon return 503 on the live-stream path (the
    // "stock daemon is dead" bug).
    //
    // HONEST SURFACE STATEMENT: flipping this default ON DOES expose surface — just not
    // an UNAUTHENTICATED one. Concretely it turns on: (1) the auth-gated streaming surface
    // — SSE `/api/control-plane/events`, the companion-chat `.../events` stream, and the WS
    // control channel — every one of which returns 401 before any principal is resolved
    // (daemon-sdk/control-routes.ts), and per-channel scopes are enforced on the fan-out
    // (e.g. read:sessions on session-update); and (2) the inert pre-auth login shell — the
    // handful of unauthenticated bootstrap endpoints that carry NO session/runtime data and
    // exist only to establish auth. The default bind stays loopback and the 60/min + 5/min
    // rate limiters are unchanged. It remains runtimeToggleable, so an operator who wants a
    // request/response-only daemon can turn it back off via the controlPlane.gateway
    // setting, which is honoured over this default.
    // The channel family (route-binding, delivery-engine, the chat surfaces,
    // homeassistant-surface) graduated together once inbound channel messages became gated
    // by the per-surface owner allowlist (unknown senders ignored) with reply-based
    // approve/deny wired to the shared approval broker. web-surface, watcher-framework, and
    // service-management were later ruled on as defaults too (2026-07-11 rulings), so the
    // whole reachability tier now defaults on with the web surface bound to loopback.
    id: 'control-plane-gateway',
    name: 'Control-Plane Gateway',
    description:
      'Enables the shared gateway/control-plane host that serves state snapshots, live streams, '
      + 'and authenticated automation control APIs to terminal hosts and remote clients.',
    defaultState: 'enabled',
    tier: 10,
    runtimeToggleable: true,
  },
  {
    id: 'route-binding',
    name: 'Route Binding',
    description:
      'Enables durable binding and resolution of external conversation routes, thread contexts, '
      + 'and reply targets across surfaces.',
    defaultState: 'enabled',
    tier: 10,
    runtimeToggleable: true,
  },
  {
    id: 'delivery-engine',
    name: 'Delivery Engine',
    description:
      'Enables first-class delivery tracking for automation results, retries, dead letters, and '
      + 'surface-specific delivery outcomes.',
    defaultState: 'enabled',
    tier: 10,
    runtimeToggleable: true,
  },
  {
    id: 'slack-surface',
    name: 'Slack Surface',
    description:
      'Enables the Slack client adapter for interactive command ingress, threaded replies, and '
      + 'notification delivery. Inbound messages are gated by the per-surface owner allowlist '
      + '(seeded from the first identified sender; unknown senders are ignored).',
    defaultState: 'enabled',
    tier: 10,
    runtimeToggleable: true,
  },
  {
    id: 'discord-surface',
    name: 'Discord Surface',
    description:
      'Enables the Discord client adapter for interaction handling, message replies, and '
      + 'notification delivery. Inbound messages are gated by the per-surface owner allowlist '
      + '(seeded from the first identified sender; unknown senders are ignored).',
    defaultState: 'enabled',
    tier: 10,
    runtimeToggleable: true,
  },
  {
    id: 'ntfy-surface',
    name: 'ntfy Surface',
    description:
      'Enables the ntfy notification surface for push-style delivery and deep links back into the '
      + 'control-plane UI. Inbound messages are gated by the per-surface owner allowlist when the '
      + 'sender carries an identity (unknown senders are ignored).',
    defaultState: 'enabled',
    tier: 10,
    runtimeToggleable: true,
  },
  {
    id: 'webhook-surface',
    name: 'Webhook Surface',
    description:
      'Enables the generic webhook surface for machine-to-machine ingress and egress. '
      + 'Ingress requires the configured webhook verification; sender-identified messages are '
      + 'additionally gated by the per-surface owner allowlist.',
    defaultState: 'enabled',
    tier: 10,
    runtimeToggleable: true,
  },
  {
    id: 'homeassistant-surface',
    name: 'Home Assistant Surface',
    description:
      'Enables the Home Assistant surface for daemon/device integration, Home Assistant '
      + 'event delivery, service-call tools, and Home Assistant-originated prompts. Inbound '
      + 'prompts are gated by the per-surface owner allowlist when the sender carries an '
      + 'identity (unknown senders are ignored).',
    defaultState: 'enabled',
    tier: 10,
    runtimeToggleable: true,
  },
  // Every remaining channel adapter carries its own surface gate entry, bound
  // (constant kind) to its surfaces.<x>.enabled domain key — the honest
  // user-facing switch. The capability is always present; activation needs
  // the enabled key + credentials. Ids match the surface strings the channel
  // plugin registry registers (see channels/builtin/plugins.ts).
  {
    id: 'telegram-surface',
    name: 'Telegram Surface',
    description:
      'Enables the Telegram client adapter for command ingress, threaded replies, and '
      + 'notification delivery. Activation needs surfaces.telegram.enabled plus bot '
      + 'credentials; inbound messages are gated by the per-surface owner allowlist.',
    defaultState: 'enabled',
    tier: 10,
    runtimeToggleable: true,
  },
  {
    id: 'whatsapp-surface',
    name: 'WhatsApp Surface',
    description:
      'Enables the WhatsApp client adapter for command ingress, interactive actions, and '
      + 'notification delivery. Activation needs surfaces.whatsapp.enabled plus API '
      + 'credentials; inbound messages are gated by the per-surface owner allowlist.',
    defaultState: 'enabled',
    tier: 10,
    runtimeToggleable: true,
  },
  {
    id: 'signal-surface',
    name: 'Signal Surface',
    description:
      'Enables the Signal client adapter for command ingress and notification delivery. '
      + 'Activation needs surfaces.signal.enabled plus a linked signal-cli endpoint; inbound '
      + 'messages are gated by the per-surface owner allowlist.',
    defaultState: 'enabled',
    tier: 10,
    runtimeToggleable: true,
  },
  {
    id: 'msteams-surface',
    name: 'Microsoft Teams Surface',
    description:
      'Enables the Microsoft Teams client adapter for command ingress, threaded replies, and '
      + 'notification delivery. Activation needs surfaces.msteams.enabled plus bot '
      + 'credentials; inbound messages are gated by the per-surface owner allowlist.',
    defaultState: 'enabled',
    tier: 10,
    runtimeToggleable: true,
  },
  {
    id: 'matrix-surface',
    name: 'Matrix Surface',
    description:
      'Enables the Matrix client adapter for command ingress, threaded replies, and '
      + 'notification delivery. Activation needs surfaces.matrix.enabled plus homeserver '
      + 'credentials; inbound messages are gated by the per-surface owner allowlist.',
    defaultState: 'enabled',
    tier: 10,
    runtimeToggleable: true,
  },
  {
    id: 'mattermost-surface',
    name: 'Mattermost Surface',
    description:
      'Enables the Mattermost client adapter for command ingress, threaded replies, and '
      + 'notification delivery. Activation needs surfaces.mattermost.enabled plus server '
      + 'credentials; inbound messages are gated by the per-surface owner allowlist.',
    defaultState: 'enabled',
    tier: 10,
    runtimeToggleable: true,
  },
  {
    id: 'imessage-surface',
    name: 'iMessage Surface',
    description:
      'Enables the iMessage client adapter for command ingress and notification delivery. '
      + 'Activation needs surfaces.imessage.enabled plus a bridge endpoint; inbound messages '
      + 'are gated by the per-surface owner allowlist.',
    defaultState: 'enabled',
    tier: 10,
    runtimeToggleable: true,
  },
  {
    id: 'bluebubbles-surface',
    name: 'BlueBubbles Surface',
    description:
      'Enables the BlueBubbles client adapter for iMessage command ingress and notification '
      + 'delivery via a BlueBubbles server. Activation needs surfaces.bluebubbles.enabled '
      + 'plus server credentials; inbound messages are gated by the per-surface owner allowlist.',
    defaultState: 'enabled',
    tier: 10,
    runtimeToggleable: true,
  },
  {
    id: 'google-chat-surface',
    name: 'Google Chat Surface',
    description:
      'Enables the Google Chat client adapter for command ingress, threaded replies, and '
      + 'notification delivery. Activation needs surfaces.googleChat.enabled plus app '
      + 'credentials; inbound messages are gated by the per-surface owner allowlist.',
    defaultState: 'enabled',
    tier: 10,
    runtimeToggleable: true,
  },
  {
    id: 'telephony-surface',
    name: 'Telephony Surface',
    description:
      'Enables the telephony adapter for delivery-oriented voice/SMS notification egress and '
      + 'webhook ingress. Activation needs surfaces.telephony.enabled plus provider '
      + 'credentials; inbound events are gated by the per-surface owner allowlist.',
    defaultState: 'enabled',
    tier: 10,
    runtimeToggleable: true,
  },
  {
    id: 'web-surface',
    name: 'Web Surface',
    description:
      'Enables the browser-based operator surface backed by the shared control plane. '
      + 'On by default, bound to loopback (web.hostMode local, 127.0.0.1): a stock install '
      + 'serves the web surface on this machine only and announces its URL once at start. '
      + 'Widen deliberately via web.hostMode network/custom.',
    defaultState: 'enabled',
    tier: 10,
    runtimeToggleable: true,
  },
  {
    id: 'watcher-framework',
    name: 'Watcher Framework',
    description:
      'Enables managed watcher/listener services, checkpointing, and recovery semantics for '
      + 'long-running external sources. On by default: with no watchers configured the '
      + 'framework idles and consumes nothing.',
    defaultState: 'enabled',
    tier: 10,
    runtimeToggleable: true,
  },
  {
    id: 'service-management',
    name: 'Service Management',
    description:
      'Enables install/start/stop/status/autostart management for running Goodvibes as a '
      + 'durable host service. On by default: the management verbs become available, but '
      + 'nothing is installed or started until explicitly requested (service.autostart '
      + 'stays false).',
    defaultState: 'enabled',
    tier: 10,
    runtimeToggleable: true,
  },
  {
    id: 'daemon-auto-update',
    name: 'Daemon Auto-Update',
    description:
      'The daemon checks for a new release hourly, downloads and checksum-verifies it, swaps '
      + 'binaries at a no-active-work moment (never mid-turn), keeps the previous binary for '
      + 'one-command rollback, and restarts via the service manager. On by default per the '
      + 'owner directive; update.auto turns it off, update.intervalMinutes tunes the cadence.',
    defaultState: 'enabled',
    tier: 10,
    runtimeToggleable: true,
  },

  // ── Execution Isolation ────────────────────────────────────────────────────
  {
    id: 'exec-sandbox',
    name: 'Per-Command Exec Sandbox',
    description:
      'Enables the per-command OS-level exec boundary (bubblewrap on Linux): the workspace is '
      + 'writable, the rest of the filesystem read-only, /tmp isolated, and network disabled unless '
      + 'a command is on sandbox.egressAllowlist. When active, boundary-safe commands that would '
      + 'otherwise prompt can auto-allow, and commands needing host access (network, host-privilege '
      + 'escalation, package installs) surface as named escalation asks. The frozen catastrophic '
      + 'command block stays in force identically inside the boundary. On by default where the '
      + 'host probe passes (Linux with bubblewrap available); the first auto-allow announces '
      + 'once that commands now run contained and escalations will ask. When bubblewrap is '
      + 'absent (or on non-Linux hosts) the feature reports honestly unavailable and the exec '
      + 'path is byte-for-byte unchanged. Set sandbox.enabled false to revert to unsandboxed exec.',
    defaultState: 'enabled',
    tier: 11,
    runtimeToggleable: true,
  },
  {
    id: 'sandbox-model-judgment',
    name: 'Sandbox Model-Judgment Tier',
    description:
      'Enables an optional model-judgment pass on the residual sandbox ask-tail: when the '
      + 'per-command exec sandbox is active and a command still lands on ask (a boundary needing '
      + 'host access — network, host-privilege escalation), a provider call over the command, its '
      + 'sandbox plan, workspace context, and the policy reasons produces a PROPOSED verdict with '
      + 'stated reasons. The tier NEVER converts allow→deny and NEVER touches the frozen '
      + 'catastrophic-only exec block (rm -rf /, dd to devices, mkfs, fork bomb…); it can only '
      + 'ANNOTATE the human ask ("model judgment: looks safe because… / flags risk because…") or, '
      + 'ONLY when the operator opted into sandbox.judgment auto-approve, auto-approve a looks-safe '
      + 'verdict. A flags-risk verdict never auto-denies — it annotates the ask the human still '
      + 'decides; a judgment failure degrades to a plain ask. Every judgment leaves a receipt. '
      + 'On by default in annotate-only mode (sandbox.judgment annotate); auto-approval is a '
      + 'separate explicit opt-in (sandbox.judgment auto-approve).',
    defaultState: 'enabled',
    tier: 11,
    runtimeToggleable: true,
  },
  // ── Reachability ───────────────────────────────────────────────────────────
  {
    id: 'relay-connect',
    name: 'Outbound Zero-Knowledge Relay',
    description:
      'Lets the daemon connect OUTBOUND to a self-hostable, zero-knowledge relay and register under '
      + 'an unguessable rendezvous id so surfaces can reach it from outside the LAN. An end-to-end '
      + 'channel (ECDH P-256 → HKDF → AES-256-GCM) terminates INSIDE the daemon before any application '
      + 'byte, so the relay operator only ever sees ciphertext plus connection metadata; the daemon is '
      + 'authenticated to surfaces by static-key pinning from the pairing payload. Relay, channel, and '
      + 'OAuth credentials at rest are encrypted under the random secrets keyfile (never host-derived '
      + 'identity). No connection is made without explicit configuration: the relay.enabled config '
      + 'switch and a configured relay.url still gate every connection — leave either unset to keep '
      + 'the daemon LAN-only.',
    defaultState: 'enabled',
    tier: 11,
    runtimeToggleable: true,
  },
];

/**
 * Convenience map for O(1) lookups by flag id.
 * Built once at module load time.
 */
export const FEATURE_FLAG_MAP: ReadonlyMap<string, FeatureFlag> = new Map(
  FEATURE_FLAGS.map((f) => [f.id, f]),
);
