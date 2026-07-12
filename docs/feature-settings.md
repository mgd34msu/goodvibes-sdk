# Feature Settings

Every platform capability is a first-class setting in its natural configuration
domain. There is no separate enablement namespace: turning a feature on, off, or
into one of its modes is done through the same settings keys that tune it
(`behavior.compactionStrategy`, `sandbox.enabled`, `notifications.adaptiveSuppression`,
`web.enabled`, ...). Surfaces render the per-feature metadata exported as
`FEATURE_SETTINGS` from `@pellux/goodvibes-sdk/platform/runtime/feature-flags`:
each feature's domain, enablement shape (boolean or enum with its active
values), associated tuning keys, real behavior description, restart
requirement, and stock default.

Defaults are owner-ruled: a default-off feature is a chosen default on a fully
configurable capability, never unreachable machinery.

## How enablement works

- The SDK derives each internal capability gate from its bound settings key at
  startup and keeps it live through config subscriptions. Setting
  `behavior.compactionStrategy` to `off` turns session compaction off;
  setting `sandbox.judgment` to `auto-approve` opts into judgment auto-approval.
- Several features share one key as its real option shape: the compaction pair
  rides `behavior.compactionStrategy` (`off`/`structured`/`distiller`), the
  OpenTelemetry pair rides `telemetry.otelMode`
  (`off`/`in-process`/`remote-export`).
- Restart-gated features (the permissions engine and simulation, unified task
  tracking, plugin/MCP lifecycles, the OTel foundation, policy signing) accept
  live settings changes but honestly report pending-restart instead of faking a
  live apply.
- An emergency kill switch survives as internal plumbing
  (`FeatureFlagManager.kill`): killed capabilities stay off until explicitly
  un-killed, regardless of settings. It is an operator escape hatch, not a
  configuration surface.

## Migration from the legacy featureFlags config

Configs written before the dissolution carried a `featureFlags` record. On
first load the SDK migrates each entry onto its domain settings key (explicit
choices preserved — a legacy `disabled` maps to the feature's off value, a
legacy `enabled` defers to an existing domain switch it used to AND with),
removes the legacy record, persists the rewritten file, and logs a one-line
receipt. `sandbox.judgmentAutoApprove` migrates onto `sandbox.judgment` the
same way. No user action is needed.

## Capability catalog

| Feature | Setting (enablement) | Active when | Default | Restart | Notes |
|---|---|---|---|---|---|
| Permissions policy engine | `permissions.engine` | `policy-engine` | `baseline` (off) | yes | Layered tool/path/parameter rules; dark until divergence evidence clears the gate. |
| Permissions simulation | `permissions.simulation` | `true` | on | yes | Shadow dual-evaluator divergence recording; never blocks execution. |
| Divergence dashboard + enforce gate | `permissions.divergenceDashboard` | `true` | on | no | Tunes via `permissions.divergenceThreshold`, `permissions.maxDivergenceRecords`. |
| Shell command parsing | `permissions.commandParser` | `ast` | `ast` (on) | no | Per-segment verdicts with automatic fallback to `flat`; catastrophic block identical in both modes. |
| Policy signing | `policy.requireSignedBundles` | `true` | off | yes | HMAC validation of policy bundles in managed mode. |
| Policy bundle registry | `policy.registryEnabled` | `true` | off | no | Promote/rollback registry + `/policy` commands; tunes via `policy.bundleSource`, `policy.bundlePath`. |
| Notification verbosity modes | `behavior.hitlMode` | `quiet`/`balanced`/`operator` | `balanced` (on) | no | `off` keeps the baseline delivery policy and rejects mode changes. |
| Tool-result reconciliation | `behavior.toolResultReconciliation` | `reconcile` | `reconcile` (on) | no | `warn-only` logs dangling tool calls without synthetic results. |
| Session compaction | `behavior.compactionStrategy` | `structured`/`distiller` | `structured` (on) | no | `off` runs sessions uncompacted; threshold via `behavior.autoCompactThreshold`. |
| Distiller compaction strategy | `behavior.compactionStrategy` | `distiller` | off (structured) | no | Fresh-context continuation brief; falls back to structured below the quality floor. |
| Unified runtime tasks | `runtime.unifiedTasks` | `true` | off | yes | Unified RuntimeTask tracking across subsystems. |
| Plugin lifecycle | `runtime.pluginLifecycle` | `true` | off | yes | Structured init/teardown with health integration. |
| MCP lifecycle | `runtime.mcpLifecycle` | `true` | off | yes | Structured connect/disconnect with health integration. |
| Tool budget enforcement | `runtime.toolBudget.enforced` | `true` | off | no | Hard wall-clock/token/cost limits via `runtime.toolBudget.maxMs`/`maxTokens`/`maxCostUsd`. |
| Overflow spill backend | `tools.overflowSpillBackend` | `ledger`/`diagnostics` | `file` | no | The backend selection is always honored; `file` is the stock behavior. |
| Tool contract verification | `tools.contractVerification` | `true` | on | no | Registration-time contract checks; invalid tools fail closed. |
| Output schema fingerprints | `tools.outputSchemaFingerprints` | `true` | off | no | `_meta` fingerprints on find/analyze/inspect results. |
| OpenTelemetry foundation | `telemetry.otelMode` | `in-process`/`remote-export` | `off` | yes (from off) | SDK init, span creation, in-process export. |
| OTel remote export | `telemetry.otelMode` | `remote-export` | off | no | OTLP export; decision-log export tunes via `telemetry.decisionOtlp*`. |
| Local provider context ingestion | `provider.localContextIngestion` | `true` | on | no | Provider-reported context windows for local models. |
| Provider optimizer | `provider.optimizerMode` | `manual`/`auto`/`pinned` | `off` | no | Capability-contract routing; pin via `provider.optimizerPinnedModel`. |
| Adaptive execution planner | `planner.adaptive` | `true` | off | no | Strategy scoring + `/plan` commands; dark until routing-visibility UX lands. |
| Fetch sanitization | `fetch.sanitizeMode` | always active | `safe-text` | no | Content modes `none`/`safe-text`/`strict`; private-IP/metadata blocking is absolute; localhost asks once (`fetch.allowLocalhost`). |
| Token scope/rotation audit | `security.tokenAudit.enabled` | `true` | on (advisory) | no | Blocking requires `security.tokenAudit.managed` too. |
| Adaptive notification suppression | `notifications.adaptiveSuppression` | `true` | on | no | Quiet/minimal filtering + burst collapse to the panel; tunes via `notifications.burst*`. |
| Integration delivery SLO | `integrations.delivery.sloEnforced` | `true` | on | no | Retry/backoff/dead-letter enforcement; tunes via `integrations.delivery.*`. |
| Route binding | `integrations.routeBinding` | `true` | on | no | Durable conversation routes across channel surfaces. |
| Delivery tracking | `integrations.deliveryTracking` | `true` | on | no | First-class delivery attempts, retries, dead letters. |
| Automation | `automation.enabled` | `true` | on | no | Idles with a how-to-create-your-first-routine empty state until a routine exists. |
| Control-plane gateway | `controlPlane.gateway` | `true` | on | no | State snapshots, SSE/WS streams, control APIs; every streaming endpoint auth-gated, loopback bind. |
| Slack surface | `surfaces.slack.enabled` | `true` | off (needs credentials) | no | Capability always present; the adapter runs when enabled + configured. |
| Discord surface | `surfaces.discord.enabled` | `true` | off (needs credentials) | no | Same activation pattern as Slack. |
| ntfy surface | `surfaces.ntfy.enabled` | `true` | off (needs topic) | no | Same activation pattern. |
| Webhook surface | `surfaces.webhook.enabled` | `true` | off (needs target/secret) | no | Same activation pattern. |
| Home Assistant surface | `surfaces.homeassistant.enabled` | `true` | off (needs instance) | no | Same activation pattern. |
| Web surface | `web.enabled` | `true` | on (loopback) | no | Announces its URL once at daemon start; widen via `web.hostMode`. |
| Watcher framework | `watchers.enabled` | `true` | on | no | Idles with no watchers configured. |
| Service management | `service.enabled` | `true` | on | no | Install/start/stop/status verbs; nothing installs until requested (`service.autostart` stays off). |
| Exec sandbox | `sandbox.enabled` | `true` | on (probe-gated) | no | bubblewrap boundary on Linux; honestly unavailable elsewhere; first contained run announces once. |
| Sandbox model judgment | `sandbox.judgment` | `annotate`/`auto-approve` | `annotate` (on) | no | Annotates escalation asks; `auto-approve` is a separate explicit opt-in. |
| Outbound relay | `relay.enabled` | `true` | on | no | No connection without an explicit `relay.url`; leave empty to stay LAN-only. |
| Agent context-window guard | `agents.contextWindowGuard` | `true` | on | no | Pre-call token estimation + compaction at `agents.contextCompactThreshold`. |
| Passive knowledge injection | `agents.passiveInjection.knowledge` | `true` | on | no | Hard-budgeted per-turn retrieval with visible turn records. |
| Passive code injection | `agents.passiveInjection.code` | `true` | off | no | Deliberately opt-in; shares the knowledge budget and relevance floor. |

The `prompt` value for `permissions.tools.<name>` triggers a user-approval prompt before each call to that tool. See [Tool safety](./tool-safety.md) and [Security](./security.md#permission-system) for how permission decisions are evaluated.

## Recommended host profiles

Stock defaults already include sanitized fetch, the exec sandbox where the
host probe passes, adaptive notification suppression, session compaction, the
loopback web surface, and advisory token auditing. Profiles below show
deliberate deviations.

Hardened browsing / adversarial web content:

```json
{
  "fetch": { "sanitizeMode": "strict" },
  "permissions": {
    "mode": "custom",
    "tools": {
      "fetch": "prompt",
      "exec": "prompt",
      "write": "prompt",
      "edit": "prompt",
      "agent": "prompt",
      "workflow": "prompt",
      "mcp": "prompt"
    }
  }
}
```

Minimal local-only host (no serving, no automation):

```json
{
  "web": { "enabled": false },
  "automation": { "enabled": false },
  "watchers": { "enabled": false },
  "service": { "enabled": false },
  "controlPlane": { "gateway": false }
}
```

Headless automation with hard budgets:

```json
{
  "runtime": { "toolBudget": { "enforced": true, "maxMs": 600000, "maxCostUsd": 5 } },
  "tools": { "outputSchemaFingerprints": true },
  "permissions": { "mode": "custom" }
}
```

## Defaults report

`bun run flags:graduation` (and the `flags.graduation.report` operator verb)
prints the feature defaults report: every capability's current default, its
default-disposition state, and whatever real validation evidence exists. The
release policy fails while any capability sits judged-ready without either
flipping on or recording a dated hold.
