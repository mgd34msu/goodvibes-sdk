/**
 * schema-domain-feature-controls.ts — ConfigSetting entries for per-feature
 * enablement and mode keys that live in domains declared elsewhere
 * (schema-domain-core.ts / schema-domain-runtime.ts own the defaults; this
 * file only contributes the schema entries, keeping those files under their
 * line ceilings). Every platform capability is a first-class domain setting;
 * the runtime derives its internal gates from these keys (see
 * runtime/feature-flags/feature-settings.ts for the bindings).
 */
import type { ConfigSetting } from './schema-types.js';
import { intRange, numRange } from './schema-shared.js';

export const featureControlSettings: ConfigSetting[] = [
  {
    key: 'permissions.engine',
    type: 'enum',
    default: 'baseline',
    description:
      'Permission evaluator: baseline (default) or policy-engine (the redesigned layered model with granular tool-level, path-level, and parameter-level rules). Restart to apply. Default baseline until divergence evidence from the shadow simulation clears the gate.',
    enumValues: ['baseline', 'policy-engine'],
  },
  {
    key: 'permissions.simulation',
    type: 'boolean',
    default: true,
    description:
      'Run the candidate permission evaluator beside the active one, recording divergence without changing enforcement. Default on so divergence evidence accumulates before stricter enforcement is considered; it never blocks tool execution by itself. Restart to apply.',
  },
  {
    key: 'permissions.divergenceDashboard',
    type: 'boolean',
    default: true,
    description:
      'Aggregate permission-evaluator divergence by tool/prefix/mode, expose trend history in diagnostics, and block enforce-mode transitions while the divergence rate exceeds permissions.divergenceThreshold. Turn off to fall back to warn mode (no gate enforcement).',
  },
  {
    key: 'permissions.commandParser',
    type: 'enum',
    default: 'ast',
    description:
      'Compound shell command evaluation: ast (default — per-segment safe/unsafe verdicts with specific denial explanations, automatic fallback to flat on any parser failure) or flat (baseline segmentation). The frozen catastrophic command block is enforced identically in both modes.',
    enumValues: ['ast', 'flat'],
  },
  {
    key: 'behavior.toolResultReconciliation',
    type: 'enum',
    default: 'reconcile',
    description:
      'What happens to dangling tool-call state at turn end: reconcile (default — synthetic error results are injected and a reconciliation event emitted, preventing silent conversation corruption) or warn-only (log a warning without injecting results).',
    enumValues: ['reconcile', 'warn-only'],
  },
  {
    key: 'provider.localContextIngestion',
    type: 'boolean',
    default: true,
    description:
      'Ingest max_context_length from local/custom provider /v1/models endpoints so local models use the provider-reported context window for token budgeting and compaction thresholds. Turn off to use only explicitly configured or static limits.',
  },
  {
    key: 'planner.adaptive',
    type: 'boolean',
    default: false,
    description:
      'Score execution-strategy candidates (single/cohort/background/remote) on risk, latency, and capability inputs each turn and select the best one, with /plan mode, explain, and override commands. Default off until the routing-visibility UX lands; off means implicit single-call execution.',
  },
  {
    key: 'tools.contractVerification',
    type: 'boolean',
    default: true,
    description:
      'Run registration-time contract checks on every registered tool: schema validity, timeout/cancellation semantics, permission-class mapping, output-policy alignment, and idempotency declarations. Invalid tools fail closed with actionable diagnostics. Turn off to let tools register unchecked.',
  },
  {
    key: 'tools.outputSchemaFingerprints',
    type: 'boolean',
    default: false,
    description:
      'Append _meta.outputSchemaFingerprint (SHA-256 of sorted result key names) and _meta.schemaShapeId to results from the find, analyze, and inspect tools, enabling schema drift detection. Default off.',
  },
  {
    key: 'telemetry.otelMode',
    type: 'enum',
    default: 'off',
    description:
      'OpenTelemetry instrumentation: off (default — no OTel SDK initialization), in-process (span creation and in-process export only), or remote-export (additionally export spans over OTLP/gRPC to the configured collector). Switching away from off requires a restart; in-process <-> remote-export applies live.',
    enumValues: ['off', 'in-process', 'remote-export'],
  },
  {
    key: 'runtime.unifiedTasks',
    type: 'boolean',
    default: false,
    description:
      'Replace ad-hoc task tracking with the unified RuntimeTask interface across all subsystems. Restart to apply. Default off.',
  },
  {
    key: 'runtime.pluginLifecycle',
    type: 'boolean',
    default: false,
    description:
      'Structured plugin lifecycle with init/teardown phases and health integration. Restart to apply. Default off until the plugin catalog work lands.',
  },
  {
    key: 'runtime.mcpLifecycle',
    type: 'boolean',
    default: false,
    description:
      'Structured MCP server lifecycle with connect/disconnect phases and health integration. Restart to apply. Default off until the plugin catalog work lands.',
  },
  {
    key: 'runtime.toolBudget.enforced',
    type: 'boolean',
    default: false,
    description:
      'Enforce per-phase runtime budgets on tool execution: wall-clock, token, and cost limits (runtime.toolBudget.maxMs/maxTokens/maxCostUsd) checked at phase entry and exit, terminating the pipeline on a hard breach with a typed diagnostic event. Default off until budget attribution wiring lands.',
  },
  {
    key: 'runtime.toolBudget.maxMs',
    type: 'number',
    default: 0,
    description:
      'Default per-phase wall-clock budget (ms) for tool execution when runtime.toolBudget.enforced is true. 0 = unlimited. A per-call ToolRuntimeContext.budget.maxMs overrides this default.',
    ...intRange(0, 24 * 60 * 60 * 1000),
  },
  {
    key: 'runtime.toolBudget.maxTokens',
    type: 'number',
    default: 0,
    description:
      'Default token budget for a single tool execution when runtime.toolBudget.enforced is true (checked against a tool result tokenCount annotation at phase exit). 0 = unlimited. A per-call ToolRuntimeContext.budget.maxTokens overrides.',
    ...intRange(0, 100_000_000),
  },
  {
    key: 'runtime.toolBudget.maxCostUsd',
    type: 'number',
    default: 0,
    description:
      'Default cost budget (USD) for a single tool execution when runtime.toolBudget.enforced is true (checked against a tool result costUsd annotation at phase exit). 0 = unlimited. A per-call ToolRuntimeContext.budget.maxCostUsd overrides.',
    ...numRange(0, 1_000_000),
  },
  {
    key: 'notifications.adaptiveSuppression',
    type: 'boolean',
    default: true,
    description:
      'Adaptive notification suppression: in quiet/minimal mode, operational churn is filtered before reaching the conversation or status bar, and rapid domain:level floods collapse into panel-only groups with a burst_collapsed reason code rendered by the notifications panel. Critical, milestone, and alert notifications are always exempt. Turn off to keep only the base delivery policies.',
  },
  {
    key: 'notifications.burstWindowMs',
    type: 'number',
    default: 1_000,
    description:
      'Observation window (ms) for the adaptive-suppression burst detector: rapid domain:level notifications arriving within this window count toward the burst threshold. Applied at NotificationRouter construction.',
    ...intRange(1, 60 * 60 * 1000),
  },
  {
    key: 'notifications.burstThreshold',
    type: 'number',
    default: 3,
    description:
      'Number of notifications for one domain:level group within the burst window that trips adaptive suppression, collapsing further ones to panel_only with a burst_collapsed reason. Critical/milestone/alert notifications are always exempt.',
    ...intRange(1, 10_000),
  },
  {
    key: 'notifications.burstCooldownMs',
    type: 'number',
    default: 3_000,
    description:
      'Cooldown (ms) after a domain:level group trips the burst detector before it can trip again. Applied at NotificationRouter construction.',
    ...intRange(0, 60 * 60 * 1000),
  },
];
