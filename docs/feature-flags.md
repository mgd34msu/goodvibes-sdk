# Feature Flags

Feature flags are SDK safe defaults, not product policy. The SDK owns the registry,
default state, runtime checks, and kill-switch mechanics. Host applications such as
the TUI own the deployment profile: which flags to enable, disable, or kill for a
given surface.

The registry lives in
`packages/sdk/src/_internal/platform/runtime/feature-flags/flags.ts`.

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
- `registry-only` means the flag is currently a declaration or roadmap marker
  with no meaningful runtime gating found.
- `informational` means the flag is useful for UI/status display but is not the
  behavior gate.

| Flag | Default | Runtime toggle | Status | Guidance |
|---|---:|---:|---|---|
| `permissions-policy-engine` | disabled | no | ready | PermissionManager only applies layered runtime policy when this startup flag is enabled; factory use also enforces the flag when supplied. |
| `permissions-simulation` | disabled | no | ready | Enable only in controlled policy-evaluation environments; it is startup-only. |
| `hitl-ux-modes` | disabled | yes | informational | Display status only; HITL mode behavior is applied from config outside this flag. |
| `unified-runtime-task` | disabled | no | registry-only | Roadmap marker; do not expose as an operator control yet. |
| `plugin-lifecycle` | disabled | no | ready | Startup-only lifecycle factory enforces this flag when a manager is supplied; baseline plugin manager remains separate. |
| `mcp-lifecycle` | disabled | no | ready | Startup-only lifecycle factory enforces this flag when a manager is supplied; baseline MCP registry remains separate. |
| `otel-foundation` | disabled | no | ready | Telemetry provider defaults tracing on when this flag is supplied and enabled; explicit telemetry config still wins. |
| `otel-remote-export` | disabled | yes | registry-only | Requires `otel-foundation`; do not expose until export wiring is finished. |
| `tool-result-reconciliation` | enabled | yes | ready | Keep enabled for normal hosts; disabling reverts unresolved tool calls to warning-only behavior. |
| `policy-signing` | disabled | no | informational | Signing is driven by policy loader options; use this as status only until the flag gates behavior. |
| `session-compaction` | disabled | yes | ready | Enable for hosts that want structured runtime compaction; safe to expose as a runtime toggle. |
| `fetch-sanitization` | disabled | yes | ready | Strong candidate for TUI safe-browsing profiles; enables response sanitization, unknown-host safe-text fallback, and SSRF-risk blocking. |
| `runtime-tools-budget-enforcement` | disabled | yes | ready | Phased executor factory derives budget enforcement from the flag; explicit executor config can still override host policy. |
| `overflow-spill-backends` | disabled | yes | registry-only | Do not expose until alternate spill backends are fully wired. |
| `permission-divergence-dashboard` | disabled | yes | registry-only | Depends on simulation evidence; keep hidden until dashboard/enforce gate is wired. |
| `shell-ast-normalization` | disabled | yes | ready | Strong candidate for developer and safe-exec profiles; enables AST command verdicts and obfuscation denial. |
| `local-provider-context-ingestion` | enabled | yes | ready | Keep enabled unless a host needs static context-window configuration only. |
| `agent-context-window-awareness` | enabled | yes | ready | Keep enabled for normal agent orchestration; disabling removes context-window safeguards. |
| `output-schema-fingerprint` | disabled | yes | ready | Useful for diagnostics and schema drift detection; low-risk opt-in. |
| `policy-as-code` | disabled | yes | registry-only | Roadmap marker; do not expose as active behavior yet. |
| `adaptive-execution-planner` | disabled | yes | ready | Orchestrator decision emission and `/plan` runtime exposure are both gated by the flag. |
| `provider-optimizer` | disabled | yes | ready | Runtime service follows flag transitions; agent routing consumes optimizer decisions when the optimizer is active and not in manual mode. |
| `integration-delivery-slo` | disabled | yes | ready | Delivery queues derive SLO enforcement from the flag unless a host explicitly overrides queue config. |
| `automation-runtime` | disabled | no | registry-only | Legacy roadmap flag; prefer the newer domain flags for future work. |
| `gateway-control-plane` | disabled | no | registry-only | Legacy roadmap flag; prefer `control-plane-gateway` for future work. |
| `omnichannel-route-binding` | disabled | no | registry-only | Legacy roadmap flag; prefer `route-binding` for future work. |
| `omnichannel-surface-adapters` | disabled | no | registry-only | Legacy roadmap flag; surface-specific flags are clearer. |
| `embedded-web-control-ui` | disabled | no | registry-only | Legacy roadmap flag; prefer `web-surface` for future work. |
| `managed-watcher-services` | disabled | no | registry-only | Legacy roadmap flag; prefer `watcher-framework` for future work. |
| `service-installation` | disabled | no | registry-only | Legacy roadmap flag; prefer `service-management` for future work. |
| `adaptive-notification-suppression` | disabled | yes | ready | Safe to expose as a host UX toggle; suppresses noisy operational notifications. |
| `token-scope-rotation-audit` | disabled | yes | registry-only | Security-relevant, but not wired as an active gate yet. |
| `tool-contract-verification` | enabled | yes | ready | Built-in tool registration now passes through contract verification by default; hosts can explicitly disable it for legacy compatibility. |
| `automation-domain` | disabled | yes | registry-only | Target flag for durable automation records and scheduling; finish before exposure. |
| `control-plane-gateway` | disabled | yes | registry-only | Target flag for shared gateway/control-plane hosting; finish before exposure. |
| `route-binding` | disabled | yes | ready | Runtime route binding manager is gated by the flag; durable writes fail closed when disabled. |
| `delivery-engine` | disabled | yes | registry-only | Target flag for delivery tracking; finish before exposure. |
| `slack-surface` | disabled | yes | registry-only | Surface marker; expose only after adapter lifecycle is complete. |
| `discord-surface` | disabled | yes | registry-only | Surface marker; expose only after adapter lifecycle is complete. |
| `ntfy-surface` | disabled | yes | registry-only | Surface marker; expose only after adapter lifecycle is complete. |
| `webhook-surface` | disabled | yes | registry-only | Surface marker; expose only after ingress/egress behavior is complete. |
| `web-surface` | disabled | yes | registry-only | Surface marker; expose only after browser control UI behavior is complete. |
| `watcher-framework` | disabled | yes | registry-only | Target flag for watcher/listener services; finish before exposure. |
| `service-management` | disabled | yes | registry-only | Target flag for install/start/stop/status management; finish before exposure. |

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
    "runtime-tools-budget-enforcement": "enabled"
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
4. Collapse or retire legacy roadmap flags that duplicate newer tier-10 flags.
5. Keep new feature flags out of the table until they have either a tested
   runtime gate or a clear `registry-only` roadmap classification.
