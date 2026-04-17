# SDK Error Kinds

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
| `server` | Remote server error | Sometimes |
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

### `server`

**When it fires:** The remote server returned HTTP 5xx, or a `protocol`/`service`/`internal` category was surfaced by the daemon error body.

**Remediation:** Log `err.requestId` for debugging. Retry with backoff for 500/502/503/504 — these are typically transient. Do not retry on 501.

**Retryable:** Sometimes. Check `err.recoverable` — the SDK sets it based on status code. HTTP 500/502/503/504 are retryable by default.

---

### `validation`

**When it fires:** Input passed to a daemon route handler failed a required-field check or schema validation. For example, a schedule definition with an invalid or missing field.

**Remediation:** Fix the input payload. `err.message` describes which field or constraint failed.

**Retryable:** No.

**Example `category` values:** `bad_request`

---

### `unknown`

**When it fires:** The error could not be mapped to a specific kind. This is a catch-all for `tool`/`unknown` category errors and unexpected conditions.

**Remediation:** Log the full error including `err.message`, `err.category`, and `err.requestId` for investigation.

**Retryable:** No (conservative default).

---

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
