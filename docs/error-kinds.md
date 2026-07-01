# SDK Error Kinds

> Consumer reference. For handling patterns see [Error Handling](./error-handling.md); for internals see [Error Architecture](./errors.md).

Every error thrown by the SDK's public surface is an instance of `GoodVibesSdkError`. The `kind` field is the primary discriminant — use it in `switch` statements or `if` chains instead of parsing `message` strings or using `instanceof` on subclasses.

## Quick reference

| `kind` | Description | Retryable |
|--------|-------------|----------|
| `auth` | Credential or permission failure | No |
| `config` | Local SDK misconfiguration | No |
| `contract` | Method/route contract violation | No |
| `network` | Transport or connectivity failure | Yes |
| `not-found` | Remote resource does not exist | No |
| `rate-limit` | Upstream rate limit exceeded | Yes |
| `protocol` | Wire-format or protocol failure | Sometimes |
| `service` | Upstream service or HTTP 5xx failure | Sometimes |
| `internal` | Daemon/internal SDK failure | No |
| `tool` | Tool execution failure | Sometimes |
| `validation` | Input failed schema or value checks | No |
| `unknown` | Unclassified error | No |

## Kinds in detail

### `auth`

**When it fires:** The request was rejected due to authentication or authorization failure. Covers HTTP 401 (missing/invalid credentials), 402 (billing), and 403 (insufficient scopes).

**Remediation:**
- On 401: refresh the auth token or redirect to login.
- On 403: check the required scopes in `err.hint`; the user may need elevated permissions.

**Retryable:** No. Fix the credential situation first.

**Example `category` values:** `authentication`, `authorization`, `billing`, `permission`

---

### `config`

**When it fires:** The SDK was called with a missing or invalid configuration value. For example, `normalizeBaseUrl` throws this when `baseUrl` is empty.

**Remediation:** Inspect `err.message` and `err.code` to identify the missing field, then fix the SDK initialization options before retrying.

**Retryable:** No.

**Example `code` values:** `SDK_CONFIGURATION_ERROR`, `SDK_TRANSPORT_BASE_URL_REQUIRED`

---

### `contract`

**When it fires:** A method was invoked that has no registered HTTP binding, or a route ID was requested that does not exist in the contract manifest. These represent usage errors — the caller is invoking something the contract does not define.

**Remediation:** Verify the method ID or route ID against the operator contract manifest. This is typically a programming error caught at development time.

**Retryable:** No.

**Example `code` values:** `SDK_CONTRACT_ERROR`

---

### `network`

**When it fires:** The HTTP fetch failed before a response was received (DNS failure, connection refused, SSE stream error, transport timeout).

**Remediation:** Check connectivity and retry with exponential backoff. The SDK's built-in retry policy (`DEFAULT_HTTP_RETRY_POLICY`) handles common transient cases automatically.

**Retryable:** Yes. `err.recoverable` will be `true`.

**Example `category` values:** `network`, `timeout`

---

### `not-found`

**When it fires:** The remote server returned HTTP 404.

**Remediation:** The resource does not exist at the server. Verify identifiers and do not retry.

**Retryable:** No.

---

### `rate-limit`

**When it fires:** The remote server returned HTTP 429.

**Remediation:** Wait for `err.retryAfterMs` milliseconds (if present) or use exponential backoff, then retry. The SDK's retry policy handles this automatically.

**Retryable:** Yes. `err.recoverable` will be `true`.

---

### `protocol`

**When it fires:** The daemon or transport detected a wire-format, stream, contract framing, or protocol-level failure after a request reached the target.

**Remediation:** Check server/client version alignment and transport logs. Retry only when the operation is idempotent and `err.recoverable` is true.

**Retryable:** Sometimes. Check `err.recoverable`.

---

### `service`

**When it fires:** The remote service returned HTTP 5xx, or a daemon error body surfaced category `service`.

**Remediation:** Log `err.requestId` for debugging. Retry with backoff for 500/502/503/504 — these are typically transient. Do not retry on 501.

**Retryable:** Sometimes. Check `err.recoverable` — the SDK sets it based on status code. HTTP 500/502/503/504 are retryable by default.

---

### `internal`

**When it fires:** The daemon or SDK surfaced a bug or invariant violation from inside GoodVibes rather than from user input, transport, or an upstream provider.

**Remediation:** Log the full structured error and report the bug. Do not rely on retry unless `err.recoverable` is explicitly true.

**Retryable:** No by default.

---

### `tool`

**When it fires:** Tool execution failed after dispatch, including tool runtime errors and tool-specific rejected operations.

**Remediation:** Inspect `err.category`, `err.message`, and the tool-specific trace. Retry only when the tool operation is idempotent and marked recoverable.

**Retryable:** Sometimes. Check `err.recoverable`.

---

### `validation`

**When it fires:** Input passed to a daemon route handler failed a required-field check or schema validation. For example, a schedule definition with an invalid or missing field.

**Remediation:** Fix the input payload. `err.message` describes which field or constraint failed.

**Retryable:** No.

**Example `category` values:** `bad_request`

---

### `unknown`

**When it fires:** The error could not be mapped to a specific kind. This is a catch-all for unexpected conditions that do not expose structured category metadata.

**Remediation:** Log the full error including `err.message`, `err.category`, and `err.requestId` for investigation.

**Retryable:** No (conservative default).

---

## Route-Level Error Codes

Daemon HTTP routes return structured error bodies with a `code` string that is separate from the SDK-layer `kind` discriminant. These codes appear in route-specific error responses and are not `GoodVibesSdkError` instances — they are HTTP error body fields returned by the daemon before the SDK maps them to a `GoodVibesSdkError`.

Common route-level codes:

| Code | HTTP Status | Meaning |
|------|-------------|----------|
| `INVALID_KIND` | 400 | The `kind` field in the request body is not a recognized or registered event/intent kind. |
| `INVALID_REQUEST` | 400 | The request body failed a required-field or schema check. |
| `PROVIDER_NOT_CONFIGURED` | 400 | The requested provider is not registered with the daemon's provider registry. |
| `UNAUTHORIZED` | 401 | No valid bearer token or session cookie was present. |
| `FORBIDDEN` | 403 | The caller's principal does not have the required scope. |
| `NOT_FOUND` | 404 | The resource (session, artifact, job, etc.) does not exist. |
| `RATE_LIMITED` | 429 | The request was rejected by an upstream rate-limit policy. |
| `INTERNAL_ERROR` | 500 | The daemon encountered an unhandled internal error. |

The SDK maps these HTTP error responses to `GoodVibesSdkError` instances using the `kind` mapping above. To inspect the raw route-level code, read `err.code` on the thrown `GoodVibesSdkError`. To cross-reference route-specific codes, check the route documentation for that namespace (e.g., [Companion Message Routing](./companion-message-routing.md) for `INVALID_KIND`).

> **Three overlapping `code` value-spaces:** `err.code` is a single `string` field, but the value you read may come from any of three overlapping spaces:
>
> 1. **Canonical `SDKErrorCode`** — codes the SDK assigns to `GoodVibesSdkError` (e.g. `RATE_LIMITED`, `AUTH_REQUIRED`, `PROTOCOL_ERROR`, `INTERNAL_ERROR`); see [Canonical SDK error codes](#canonical-sdk-error-codes).
> 2. **Daemon route-body codes** — raw `code` strings in daemon HTTP error bodies (e.g. `INVALID_KIND`, `PROVIDER_NOT_CONFIGURED`, `RATE_LIMITED`, `INTERNAL_ERROR` — enumerated above) before the SDK normalises them.
> 3. **`AppError`-subclass codes** — literal codes declared by `AppError` subclasses (e.g. `CONFIG_ERROR`, `PROVIDER_ERROR`, `TOOL_ERROR`, `ACP_ERROR`, `PERMISSION_DENIED`, `RENDER_ERROR`); see [Config errors and the AppError hierarchy](#config-errors-and-the-apperror-hierarchy).
>
> There is **no suffix rule** distinguishing these spaces: `INTERNAL_ERROR` appears as both a route-body code and a canonical code, and subclass codes exist both with (`CONFIG_ERROR`) and without (`PERMISSION_DENIED`) the `_ERROR` suffix. Always switch on `err.kind` (the `SDKErrorKind` discriminant) first, then read `err.code` only to disambiguate further.

---

## Canonical SDK error codes

Beyond the `kind` discriminant, every `GoodVibesSdkError` carries a `code`. SDK-produced errors set one of the canonical values in the `SDKErrorCode` union (`index.ts:79-111`); caller-supplied codes may be any string, since `code` is typed `SDKErrorCode | (string & {})`.

Prefer the `SDKErrorCodes` const (`index.ts:124-147`) and the runtime guards over bare string literals:

- `isErrorCode(err, SDKErrorCodes.RATE_LIMITED)` (`index.ts:172-177`) returns `true` and narrows `err.code` to the given literal. It works on any object with an optional `code` field.
- `isKnownErrorCode(value)` (`index.ts:185-187`) returns `true` when an arbitrary string is one of the canonical codes — useful for values received over the wire.

```ts
import { isErrorCode, SDKErrorCodes, GoodVibesSdkError } from '@pellux/goodvibes-errors';

try {
  await sdk.operator.accounts.snapshot();
} catch (err) {
  if (err instanceof GoodVibesSdkError && isErrorCode(err, SDKErrorCodes.RATE_LIMITED)) {
    await delay(err.retryAfterMs ?? 1000);
  }
}
```

Canonical codes (`SDKErrorCodes.*`): `AUTH_REQUIRED`, `TOKEN_EXPIRED`, `PERMISSION_DENIED`, `PAYMENT_REQUIRED`, `RATE_LIMITED`, `NETWORK_UNREACHABLE`, `TIMEOUT`, `CANCELLED`, `NOT_FOUND`, `CONFLICT`, `VALIDATION_FAILED`, `AGENT_TIMEOUT`, `AGENT_FAILED`, `TOOL_EXEC_FAILED`, `SERVICE_UNAVAILABLE`, `CONTRACT_MISMATCH`, `PROTOCOL_ERROR`, `INTERNAL_ERROR`, `SDK_CONFIGURATION_ERROR`, `SDK_CONTRACT_ERROR`, `SDK_HTTP_STATUS_ERROR`, `UNKNOWN`.

### Kind → representative code

The SDK infers a representative canonical code for each `kind` (via `inferKind` / `inferCodeFromCategory`, `index.ts:189` onward). The mapping is representative, not exhaustive — one `kind` may surface several codes (for example, `auth` covers `AUTH_REQUIRED`, `TOKEN_EXPIRED`, `PERMISSION_DENIED`, and `PAYMENT_REQUIRED`).

| `kind` | Representative `code` |
|--------|-----------------------|
| `auth` | `AUTH_REQUIRED` |
| `config` | `SDK_CONFIGURATION_ERROR` |
| `contract` | `CONTRACT_MISMATCH` |
| `network` | `NETWORK_UNREACHABLE` |
| `not-found` | `NOT_FOUND` |
| `protocol` | `PROTOCOL_ERROR` |
| `rate-limit` | `RATE_LIMITED` |
| `service` | `SERVICE_UNAVAILABLE` |
| `internal` | `INTERNAL_ERROR` |
| `tool` | `TOOL_EXEC_FAILED` |
| `validation` | `VALIDATION_FAILED` |
| `unknown` | `UNKNOWN` |

---

## WRFC Synthetic Critical Issues

> These are not `GoodVibesSdkError` error kinds — they are WRFC reviewer-report markers that may appear in review task payloads and can be confused for error kinds.

See [WRFC Constraint Propagation](./wrfc-constraint-propagation.md) for the full constraint lifecycle context.

WRFC chains can produce **synthetic critical issues** when the fixer violates constraint continuity (returning a `constraints[]` array with missing or extra IDs compared to the initial engineer enumeration). These are not `GoodVibesSdkError` instances — they are injected directly into the next review cycle's task payload as `[CRITICAL]` block entries and consumed once.

Synthetic critical issues surface under the reviewer's `issues[]` array with `severity: 'critical'` and a description like:

```
Fixer regressed constraint continuity: missing=[c2] extra=[c3]
```

They do not propagate as thrown errors and are not reachable via the error handler or `SDKObserver.onError`. To observe them, subscribe to reviewer `issues` in the `WORKFLOW_REVIEW_COMPLETED` event payload or read the reviewer's `ReviewerReport` from the chain.

---

## Typed error codes

Concrete `AppError` subclasses declare a **literal `code`** via `declare readonly code: '<LITERAL>'`, so narrowing to a specific subclass instance gives you that exact literal:

```ts
export class ConfigError extends AppError {
  declare readonly code: 'CONFIG_ERROR';
  // ...
}

export class ProviderError extends AppError {
  declare readonly code: 'PROVIDER_ERROR';
  // ...
}
```

> **`err.code` is not compiler-exhaustive.** A `switch (err.code)` with a `const _exhaustive: never = err.code` default does **not** type-check on a `GoodVibesSdkError` or `AppError` value. `GoodVibesSdkError.code` is typed `SDKErrorCode | (string & {})` (`index.ts:418`) and `AppError.code` is plain `string` (`platform/types/errors.ts:131`) — both are wide string types, so the `never` assignment is a type error. The trick only compiles after you narrow to a finite, hand-built union of concrete subclasses, where each branch contributes its literal `code`:

```ts
// Compiles only because `err` is narrowed to a finite subclass union first.
function handle(err: ConfigError | ProviderError): void {
  switch (err.code) {
    case 'CONFIG_ERROR':    /* ... */ break;
    case 'PROVIDER_ERROR':  /* ... */ break;
    default: {
      const _exhaustive: never = err.code;
      throw new Error('unhandled error code: ' + String(_exhaustive));
    }
  }
}
```

Prefer `err.kind` for coarse handling (retry / auth / validation), and `err.code` when you need to disambiguate *which* concrete subclass a given `kind` came from.

## Config errors and the AppError hierarchy

Two distinct error types relate to configuration; do not confuse them:

| Type | Code | Import subpath |
|------|------|----------------|
| `ConfigurationError` | `SDK_CONFIGURATION_ERROR` | `@pellux/goodvibes-sdk/errors` |
| `ConfigError` | `CONFIG_ERROR` | `@pellux/goodvibes-sdk/platform/types` |

`ConfigurationError` (`index.ts:555`) extends `GoodVibesSdkError` directly and is thrown for invalid SDK setup (category and kind `config`). `ConfigError` is an `AppError` subclass used by the platform/runtime layer.

`AppError` (`platform/types/errors.ts:119`) extends `GoodVibesSdkError` and adds `statusCode`, `guidance`, `detail`, and `rawMessage`; its `code` is widened to plain `string` (`platform/types/errors.ts:131`). The concrete subclasses ship under `@pellux/goodvibes-sdk/platform/types`:

| Subclass | `code` | Recoverable |
|----------|--------|-------------|
| `ConfigError` | `CONFIG_ERROR` | No |
| `ProviderError` | `PROVIDER_ERROR` | When `statusCode` is in `RETRYABLE_STATUS_CODES` |
| `ToolError` | `TOOL_ERROR` | Yes |
| `AcpError` | `ACP_ERROR` | Yes |
| `PermissionError` | `PERMISSION_DENIED` | No |
| `RenderError` | `RENDER_ERROR` | Yes |

Subclass codes do **not** share one naming convention: `PERMISSION_DENIED` has no `_ERROR` suffix, while the others do.

## Useful fields on every `GoodVibesSdkError`

The class exposes 18 structured fields (`index.ts:406-434`); `toJSON()` (`index.ts:482`) serializes them with `undefined` values omitted.

| Field | Type | Description |
|-------|------|-------------|
| `kind` | `SDKErrorKind` | Primary discriminant for switch/if handling. |
| `code` | `SDKErrorCode \| (string & {})` | Typed error code; canonical for SDK errors, any string for caller-supplied codes. |
| `category` | `ErrorCategory` | Fine-grained classification (e.g. `authentication`, `rate_limit`). |
| `source` | `ErrorSource` | Where the error originated (`transport`, `contract`, `config`, etc.). |
| `recoverable` | `boolean` | Whether a retry is expected to succeed. |
| `status` | `number \| undefined` | HTTP status code if from a transport response. |
| `url` | `string \| undefined` | Request URL for transport failures. |
| `method` | `string \| undefined` | HTTP method for transport failures. |
| `body` | `unknown` | Parsed response body, when available. |
| `hint` | `string \| undefined` | Human-readable remediation hint from the server. |
| `provider` | `string \| undefined` | Provider name if the error originated in a provider call. |
| `operation` | `string \| undefined` | Operation/method name in progress when the error occurred. |
| `phase` | `string \| undefined` | Lifecycle phase in which the failure happened. |
| `requestId` | `string \| undefined` | Opaque ID for log correlation with the daemon. |
| `providerCode` | `string \| undefined` | Provider-specific error code. |
| `providerType` | `string \| undefined` | Provider type/family identifier. |
| `retryAfterMs` | `number \| undefined` | Milliseconds to wait before retrying (rate-limit). |
| `cause` | `unknown` | Original underlying error, preserved without loss. |
