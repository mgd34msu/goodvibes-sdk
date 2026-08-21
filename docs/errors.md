# Error architecture

> Internal source map. For consumer guidance see [Error Handling](./error-handling.md) and [SDK Error Kinds](./error-kinds.md).

GoodVibes errors use shared categories and kinds from
`@pellux/goodvibes-errors`. Everything below lives in that package, split
across three source files. `daemon-error-contract.ts` holds the daemon wire
types, `error-codes.ts` holds the canonical `SDKErrorCode` union and its
runtime helpers, and `index.ts` holds the error classes and everything that
builds on the other two. `index.ts` re-exports the `error-codes.ts` symbols
unchanged, so consumers import everything from the package root regardless of
which file defines it.

## Source map

| Concern | Symbol | Defined in |
|---------|--------|----------|
| Wire category union | `DaemonErrorCategory` (type + const) | `daemon-error-contract.ts` |
| Wire source union | `DaemonErrorSource` | `daemon-error-contract.ts` |
| Daemon error body shape | `StructuredDaemonErrorBody` | `daemon-error-contract.ts` |
| Memory-record-miss 404 code | `MEMORY_RECORD_NOT_FOUND_CODE` | `daemon-error-contract.ts` |
| SDK category (adds `'contract'`) | `ErrorCategory` | `index.ts` |
| SDK source (adds `'contract'`) | `ErrorSource` | `index.ts` |
| Kind discriminant union | `SDKErrorKind` | `index.ts` |
| Canonical code union | `SDKErrorCode` | `error-codes.ts` |
| Runtime code const | `SDKErrorCodes` | `error-codes.ts` |
| Code guards | `isErrorCode` / `isKnownErrorCode` | `error-codes.ts` |
| Category to kind | `inferKind` | `index.ts` |
| Base error class | `GoodVibesSdkError` | `index.ts` |
| Config error | `ConfigurationError` | `index.ts` |
| Contract error | `ContractError` | `index.ts` |
| HTTP error | `HttpStatusError` | `index.ts` |

## Important rules

- Retryable status codes are defined once, in `RETRYABLE_STATUS_CODES` (`[408, 429, 500, 502, 503, 504]`). `GoodVibesSdkError` derives `recoverable` from this set when the caller does not pass `recoverable` explicitly. The SDK platform layer (`AppError` and its subclasses) and the `transport-http` retry policy both import this same constant instead of redeclaring the list; an error-contract CI check fails the build if any other file inlines the literal array.
- Transport failures preserve `url`, `method`, `status`, `retryAfterMs`, and the provider context fields `provider` / `operation` / `phase` / `requestId` / `providerCode` / `providerType`. There is no `event` field. The authoritative per-field table lives in [Error kinds](./error-kinds.md#useful-fields-on-every-goodvibessdkerror).
- Contract violations are `ContractError` (code `SDK_CONTRACT_ERROR`, kind/category `contract`).
- Configuration failures are `ConfigurationError` (code `SDK_CONFIGURATION_ERROR`, kind/category `config`).
- HTTP failures are `HttpStatusError` (code defaults to `SDK_HTTP_STATUS_ERROR`, source `transport`).
- Unknown values are normalized without losing the original `cause`.
- A daemon 404 whose body carries `code: 'MEMORY_RECORD_NOT_FOUND'` means the addressed memory record genuinely does not exist, and the memory-spine wire layer folds that specific 404 to `null`. Any other 404 (a route that does not exist at all, or a bare legacy 404 with no code) means the daemon does not serve that verb and must be rejected honestly rather than folded to `null`.

Do not introduce parallel error taxonomies in extension packages.

## Constructing and serializing errors

- `GoodVibesSdkErrorOptions` is the construction surface for every error class. All fields are optional, and `code`, `category`, and `recoverable` are inferred when omitted.
- `createHttpStatusError(status, url, method, body, fallbackHint?)` builds an `HttpStatusError` from a response. When `body` satisfies `isStructuredDaemonErrorBody` the daemon-supplied fields win. The `code` is taken from an explicit `code` in the body first, falling back to a code derived from the body's `category`, and finally to a code derived from `status`. When the body is unstructured, `code` is inferred from `status` directly.
- `toJSON()` serializes the structured fields via `omitUndefined`, dropping `undefined` entries; `cause` is preserved through the native `Error` `cause` option and walked recursively (up to 32 levels, cycle-safe) through `.cause`, `.originalError`, and `.error` chains.
- `instanceof` is realm-safe and brand/code-based rather than strictly prototype-bound. `GoodVibesSdkError` stamps a non-enumerable brand symbol and overrides `[Symbol.hasInstance]`, and `ConfigurationError` / `ContractError` / `HttpStatusError` each override `[Symbol.hasInstance]` so an error carrying the matching `code` (or, for `HttpStatusError`, its own dedicated brand symbol) passes the check even across realms or after a serialize/deserialize round-trip. Callers that need strict prototype identity should compare against `<Class>.prototype` via `Object.getPrototypeOf(err)`.
