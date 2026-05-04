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

Concrete `AppError` subclasses declare a **literal `code`** via `declare readonly code: '<LITERAL>'`. This lets TypeScript narrow on `err.code` exhaustively; each subclass advertises exactly one code.

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

Because the field is a literal string type, a `switch (err.code)` over the declared codes is exhaustive and the compiler will flag added subclasses that introduce new codes:

```ts
switch (err.code) {
  case 'CONFIG_ERROR':    /* ... */ break;
  case 'PROVIDER_ERROR':  /* ... */ break;
  // etc.
  default: {
    const _exhaustive: never = err.code;
    throw new Error(`unhandled error code: ${_exhaustive}`);
  }
}
```

Prefer `err.kind` for coarse handling (retry / auth / validation), and `err.code` when you need to disambiguate *which* concrete subclass a given `kind` came from.

## Useful fields on every `GoodVibesSdkError`

| Field | Type | Description |
|-------|------|-------------|
| `kind` | `SDKErrorKind` | Primary discriminant for switch/if handling |
| `category` | `ErrorCategory` | Fine-grained classification (e.g. `authentication`, `rate_limit`) |
| `source` | `ErrorSource` | Where the error originated (`transport`, `contract`, `config`, etc.) |
| `status` | `number \| undefined` | HTTP status code if from a transport response |
| `recoverable` | `boolean` | Whether a retry is expected to succeed |
| `hint` | `string \| undefined` | Human-readable remediation hint from the server |
| `retryAfterMs` | `number \| undefined` | Milliseconds to wait before retrying (rate-limit) |
| `requestId` | `string \| undefined` | Opaque ID for log correlation with the daemon |
| `provider` | `string \| undefined` | Provider name if the error originated in a provider call |
