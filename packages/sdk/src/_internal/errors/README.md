# Error Hierarchy

This document covers the SDK error class hierarchy, conventions for adding new subclasses, and field semantics.

## Hierarchy

```
Error (built-in)
└── GoodVibesSdkError          // packages/sdk/src/_internal/errors/index.ts
    │   Fields: kind, code?, category, source, recoverable, status?, hint?, …
    │
    ├── ConfigurationError      // SDK misconfiguration; code='SDK_CONFIGURATION_ERROR'
    ├── ContractError           // Daemon contract violation; code='SDK_CONTRACT_ERROR'
    ├── HttpStatusError         // Non-2xx daemon response; code='SDK_HTTP_STATUS_ERROR' (default)
    │
    └── AppError               // packages/sdk/src/_internal/platform/types/errors.ts
        │   Adds: statusCode?, guidance?, detail?, rawMessage?
        │   Constructor: (message, code: string, recoverable: boolean, options?)
        │
        ├── ConfigError         declare readonly code: 'CONFIG_ERROR'
        ├── ProviderError       declare readonly code: 'PROVIDER_ERROR'
        ├── ToolError           declare readonly code: 'TOOL_ERROR'
        ├── AcpError            declare readonly code: 'ACP_ERROR'
        ├── PermissionError     declare readonly code: 'PERMISSION_DENIED'
        └── RenderError         declare readonly code: 'RENDER_ERROR'

    GoodVibesSdkError
    ├── ProviderNotFoundError   declare readonly code: 'PROVIDER_NOT_FOUND'
    │     packages/sdk/src/_internal/platform/providers/provider-not-found-error.ts
    │
    ├── OpsIllegalActionError   declare readonly code: 'OPS_ILLEGAL_ACTION'
    ├── OpsTargetNotFoundError  declare readonly code: 'OPS_TARGET_NOT_FOUND'
    │     packages/sdk/src/_internal/platform/runtime/ops/control-plane.ts
    │
    ├── TaskTransitionError     declare readonly code: 'TASK_TRANSITION_ERROR'
    ├── TaskNotFoundError       declare readonly code: 'TASK_NOT_FOUND'
    ├── TaskNotCancellableError declare readonly code: 'TASK_NOT_CANCELLABLE'
    │     packages/sdk/src/_internal/platform/runtime/tasks/manager.ts
    │
    ├── VersionMismatchError    declare readonly code: 'major_version_mismatch'
    │                                              | 'peer_version_too_old'
    │                                              | 'peer_version_unsupported'
    │     packages/sdk/src/_internal/platform/runtime/remote/transport-contract.ts
    │
    ├── DivergenceGateError     declare readonly code: 'DIVERGENCE_GATE_BLOCKED'
    │     packages/sdk/src/_internal/platform/runtime/permissions/divergence-dashboard.ts
    │
    ├── SimulationEnforcementError  declare readonly code: 'SIMULATION_ENFORCEMENT_BLOCKED'
    │     packages/sdk/src/_internal/platform/runtime/permissions/simulation.ts
    │
    ├── PolicySignatureError    declare readonly code: 'POLICY_SIGNATURE_INVALID'
    │     packages/sdk/src/_internal/platform/runtime/permissions/policy-loader.ts
    │
    └── DeliveryError           declare readonly code: 'DELIVERY_ERROR'
          packages/sdk/src/_internal/platform/integrations/delivery.ts
```

## How to Add a New Error Subclass

### When to extend `GoodVibesSdkError` directly

Use this when the error originates from an SDK-layer concern and does not carry platform-layer fields (`statusCode`, `guidance`, `detail`, `rawMessage`).

```ts
import { GoodVibesSdkError } from '../../errors/index.js';

export class MyModuleError extends GoodVibesSdkError {
  // Narrow the inherited code field to its exact literal.
  declare readonly code: 'MY_MODULE_ERROR';

  constructor(message: string) {
    super(message, {
      code: 'MY_MODULE_ERROR',
      category: 'internal',  // pick the most accurate ErrorCategory
      source: 'runtime',     // pick the most accurate ErrorSource
      recoverable: false,
    });
    this.name = 'MyModuleError';
  }
}
```

### When to extend `AppError`

Use this when the error belongs to the platform layer and benefits from `statusCode`, `guidance`, `detail`, or `rawMessage`.

```ts
import { AppError } from '../types/errors.js';

export class MyPlatformError extends AppError {
  // Narrow the inherited code field to its exact literal.
  declare readonly code: 'MY_PLATFORM_ERROR';

  constructor(message: string) {
    super(message, 'MY_PLATFORM_ERROR', false, {
      category: 'internal',
      source: 'runtime',
    });
  }
}
```

### Rules

1. Always pass a `code` to `super()` so the field is populated at runtime.
2. Always add `declare readonly code: 'YOUR_CODE_LITERAL'` as a class-body declaration to narrow the TypeScript type. Do NOT use `readonly code = 'LITERAL' as const` (this creates a re-initializer that shadows the base constructor property).
3. Always set `this.name = 'YourErrorClass'` so stack traces are readable.
4. Pick `category` and `source` from the existing union types; do NOT invent new values without updating the union.
5. Dynamic codes (e.g. `VersionMismatchError` where code comes from a constructor argument) use a union literal type: `declare readonly code: 'A' | 'B' | 'C'`.

## Field Semantics

### `code: string | undefined`

A machine-readable discriminant for this specific error type. Convention: `SCREAMING_SNAKE_CASE` for new platform errors. Every concrete subclass should declare a literal (or union literal) type narrowing via `declare readonly code`.

### `category: ErrorCategory`

Broad semantic bucket. Used by callers to route retry/backoff/alert logic without string-matching `message`.

| Category | Meaning |
|---|---|
| `authentication` | Auth rejected (401, bad token) |
| `authorization` | Auth passed but access denied (403) |
| `billing` | Payment/quota issue (402) |
| `rate_limit` | Throttled (429) |
| `timeout` | Request timed out (408) |
| `network` | Network-level failure (ECONNREFUSED, DNS) |
| `bad_request` | Invalid input (400) |
| `not_found` | Resource not found (404) |
| `permission` | Runtime permission denied |
| `tool` | Tool execution failure |
| `config` | Misconfiguration |
| `protocol` | Wire/transport protocol violation |
| `service` | Upstream server error (5xx) |
| `internal` | Internal SDK/platform bug |
| `contract` | Daemon contract violation |
| `unknown` | Unclassified |

### `source: ErrorSource`

Where the error originated. Used for routing alerts and scoping diagnostics.

| Source | Origin |
|---|---|
| `provider` | LLM provider API |
| `tool` | Tool execution |
| `transport` | HTTP/transport layer |
| `config` | Configuration loading |
| `permission` | Permission evaluator |
| `runtime` | Runtime task/agent management |
| `render` | UI rendering |
| `acp` | Agent Control Protocol |
| `contract` | Daemon contract validation |
| `unknown` | Unclassified |

### `recoverable: boolean`

`true` means the operation MAY be retried (e.g. rate-limit, transient network). `false` means the error is terminal and retrying would not help (e.g. auth failure, misconfiguration, permission denied).

### `kind: SDKErrorKind`

A simplified discriminant derived from `category`. Prefer `error.kind` for exhaustive switch/case handling rather than `instanceof` chains. Defined in `GoodVibesSdkError` — do NOT override in subclasses.

## Regression Coverage

The file `test/arch03-error-hierarchy.test.ts` verifies that every concrete error class:

- Passes `instanceof GoodVibesSdkError` and `instanceof Error`
- Has populated `.category`, `.source`, and `.recoverable` fields
- Carries a `.code` value where applicable

Always run this test suite after adding or modifying error subclasses:

```sh
bun test test/arch03-error-hierarchy.test.ts
```
