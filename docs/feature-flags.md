# Feature Flags

Feature flags are SDK safe defaults, not product policy. The SDK owns the registry,
default state, runtime checks, and kill-switch mechanics. Host applications such as
the TUI own the deployment profile: which flags to enable, disable, or kill for a
given surface.

The registry lives in
`packages/sdk/src/platform/runtime/feature-flags/flags.ts`.

## Ownership Model

The SDK is responsible for:

- Declaring every flag with a stable id, description, default state, tier, and
  `runtimeToggleable` value.
- Enforcing feature gates in runtime code paths.
- Choosing conservative safe defaults for embedders that do not provide a policy.
- Loading persisted `featureFlags` overrides when it creates the default
  `FeatureFlagManager`.

Host applications are responsible for:

- Persisting operator policy in config.
- Presenting profiles such as safe browsing, developer, automation, or CI.
- Passing an already configured `FeatureFlagManager` when the host wants full
  control over startup state.
- Only exposing runtime toggles for flags where `runtimeToggleable: true`.
- Treating `killed` as an emergency state that requires an explicit operator
  action to leave.

## State Semantics

| State | Meaning |
|---|---|
| `enabled` | The feature is active. |
| `disabled` | The feature is inactive; missing config falls back to the registry default. |
| `killed` | The feature is emergency-disabled and cannot be re-enabled until first moved back to `disabled`. |

`runtimeToggleable: false` means a flag must be configured before startup, except
for emergency kill operations. A host should not offer live toggles for these
flags.

## Implementation Status

Status values in this table are intentionally direct:

- `ready` means runtime code currently checks the flag and the feature has a
  concrete behavior change.
- `registry-only` means the flag is currently declared for host visibility but
  has no meaningful runtime gating found.
- `informational` means the flag is useful for UI/status display but is not the
  behavior gate.

SDK-created runtime services inject the feature manager and therefore follow
the safe defaults below. Direct construction without a feature manager uses the
constructor's explicit options and does not apply config-backed host policy.

| Flag | Default | Runtime toggle | Status | Guidance |
|---|---:|---:|---|---|
| `permissions-policy-engine` | disabled | no | ready | PermissionManager only applies layered runtime policy when this startup flag is enabled; factory use also enforces the flag when supplied. |
| `permissions-simulation` | disabled | no | ready | Enable only in controlled policy-evaluation environments; it is startup-only. |
| `hitl-ux-modes` | disabled | yes | ready | ModeManager only allows HITL preset changes, domain overrides, and router application when this flag is enabled. |
| `unified-runtime-task` | disabled | no | ready | Task manager creation remains available, but task mutation/read APIs fail closed or return empty results when the flag is supplied and disabled. |
| `plugin-lifecycle` | disabled | no | ready | Startup-only lifecycle factory enforces this flag when a manager is supplied; baseline plugin manager remains separate. |
| `mcp-lifecycle` | disabled | no | ready | Startup-only lifecycle factory enforces this flag when a manager is supplied; baseline MCP registry remains separate. |
| `otel-foundation` | disabled | no | ready | Telemetry provider defaults tracing on when this flag is supplied and enabled; explicit telemetry config still wins. |
| `otel-remote-export` | disabled | yes | ready | Requires `otel-foundation`; when both are enabled, telemetry provider wires the configured OTLP exporter. |
| `tool-result-reconciliation` | enabled | yes | ready | Keep enabled for normal hosts; disabling reverts unresolved tool calls to warning-only behavior. |
| `policy-signing` | disabled | no | ready | Policy loader validates signatures and enforces managed-mode rejection only when this startup flag is enabled. |
| `session-compaction` | disabled | yes | ready | Enable for hosts that want structured runtime compaction; safe to expose as a runtime toggle. |
| `fetch-sanitization` | disabled | yes | ready | Strong candidate for TUI safe-browsing profiles; enables response sanitization, unknown-host safe-text fallback, SSRF-risk host blocking, redirect-target revalidation, and streaming response-size caps. Disabled means the SDK does not add this extra sanitization layer and should be surfaced through the security settings report. |
| `runtime-tools-budget-enforcement` | disabled | yes | ready | Phased executor factory derives budget enforcement from the flag; explicit executor config can still override host policy. |
| `overflow-spill-backends` | disabled | yes | ready | OverflowHandler forces the file backend while disabled; ledger/diagnostics backends require this flag. |
| `permission-divergence-dashboard` | disabled | yes | ready | Divergence dashboard factory is gated; disabled hosts cannot create the dashboard/enforce gate through the SDK factory. |
| `shell-ast-normalization` | disabled | yes | ready | Strong candidate for developer and safe-exec profiles; enables AST command verdicts and obfuscation denial. |
| `local-provider-context-ingestion` | enabled | yes | ready | Keep enabled unless a host needs static context-window configuration only. |
| `agent-context-window-awareness` | enabled | yes | ready | Keep enabled for normal agent orchestration; disabling removes context-window safeguards. |
| `output-schema-fingerprint` | disabled | yes | ready | Useful for diagnostics and schema drift detection; low-risk opt-in. |
| `policy-as-code` | disabled | yes | ready | Policy registry factory is gated; promote/rollback registry creation requires explicit host opt-in. |
| `adaptive-execution-planner` | disabled | yes | ready | Orchestrator decision emission and `/plan` runtime exposure are both gated by the flag. |
| `provider-optimizer` | disabled | yes | ready | Runtime service follows flag transitions; agent routing consumes optimizer decisions when the optimizer is active and not in manual mode. |
| `integration-delivery-slo` | disabled | yes | ready | Delivery queues derive SLO enforcement from the flag unless a host explicitly overrides queue config. |
| `adaptive-notification-suppression` | disabled | yes | ready | Safe to expose as a host UX toggle; suppresses noisy operational notifications. |
| `token-scope-rotation-audit` | disabled | yes | ready | Audits always report findings, but managed-mode token blocking only happens when this flag is enabled. |
| `tool-contract-verification` | enabled | yes | ready | Built-in tool registration now passes through contract verification by default; hosts can explicitly disable it for custom tool registry alignment. |
| `automation-domain` | disabled | yes | ready | AutomationManager read/mutation/scheduling APIs are gated; disabled SDK services expose empty reads and fail closed on mutations. |
| `control-plane-gateway` | disabled | yes | ready | ControlPlaneGateway snapshots, live streams, Web UI, and websocket clients are gated. |
| `route-binding` | disabled | yes | ready | Runtime route binding manager is gated by the flag; durable writes fail closed when disabled. |
| `delivery-engine` | disabled | yes | ready | AutomationDeliveryManager returns no attempts while disabled and also respects surface-specific gates. |
| `slack-surface` | disabled | yes | ready | Slack surface records, plugins, and delivery targets require this flag unless the omnichannel alias is enabled. |
| `discord-surface` | disabled | yes | ready | Discord surface records, plugins, and delivery targets require this flag unless the omnichannel alias is enabled. |
| `ntfy-surface` | disabled | yes | ready | ntfy surface records, plugins, and delivery targets require this flag unless the omnichannel alias is enabled. |
| `webhook-surface` | disabled | yes | ready | Webhook surface records, plugins, and delivery targets require this flag unless the omnichannel alias is enabled. |
| `homeassistant-surface` | disabled | yes | ready | Home Assistant surface records, signed webhook ingress, event delivery, setup manifest, and HA REST-backed tools require this flag unless the omnichannel alias is enabled. |
| `web-surface` | disabled | yes | ready | Web control surface records and plugins require this flag unless the embedded web alias is enabled. |
| `watcher-framework` | disabled | yes | ready | WatcherRegistry list/read APIs return empty while disabled; registration/start/stop/run/remove fail closed. |
| `service-management` | disabled | yes | ready | PlatformServiceManager status reports disabled state; install/start/stop/restart/uninstall fail closed. |

## Recommended Host Profiles

Safe browsing / adversarial web content:

```json
{
  "featureFlags": {
    "fetch-sanitization": "enabled",
    "shell-ast-normalization": "enabled",
    "output-schema-fingerprint": "enabled"
  },
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

Developer local default:

```json
{
  "featureFlags": {
    "shell-ast-normalization": "enabled",
    "output-schema-fingerprint": "enabled",
    "adaptive-notification-suppression": "enabled"
  }
}
```

Headless automation should be explicit. Avoid relying on registry defaults when
side effects are expected:

```json
{
  "featureFlags": {
    "shell-ast-normalization": "enabled",
    "runtime-tools-budget-enforcement": "enabled",
    "automation-domain": "enabled",
    "delivery-engine": "enabled",
    "route-binding": "enabled"
  },
  "permissions": {
    "mode": "custom"
  }
}
```

## Completion Priorities

1. Extend `fetch-sanitization`: blocked-host and unknown-host gates are covered;
   add redirect-chain checks and sanitized evidence checks in `web_search`.
2. Extend `shell-ast-normalization`: obfuscation denial is covered; add compound
   command and user-facing denial-output fixtures.
3. Tighten `tool-contract-verification` metadata over time by adding explicit
   categories and idempotency declarations to side-effecting tools.
   behavior.
5. Keep new feature flags out of the table until they have either a tested
   runtime gate or a clear `registry-only` classification.
