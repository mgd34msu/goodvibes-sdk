# Error Architecture

> Internal source map. For consumer guidance see [Error Handling](./error-handling.md) and [SDK Error Kinds](./error-kinds.md).

GoodVibes errors use shared categories and kinds from
`@pellux/goodvibes-errors`. Everything below lives in that package; line
references point at `packages/errors/src`.

## Source map

| Concern | Symbol | Location |
|---------|--------|----------|
| Wire category union | `DaemonErrorCategory` (type + const) | `daemon-error-contract.ts:1`, `:18` |
| Wire source union | `DaemonErrorSource` | `daemon-error-contract.ts:36` |
| Daemon error body shape | `StructuredDaemonErrorBody` | `daemon-error-contract.ts:47` |
| SDK category (adds `'contract'`) | `ErrorCategory` | `index.ts:20` |
| SDK source (adds `'contract'`) | `ErrorSource` | `index.ts:22` |
| Kind discriminant union | `SDKErrorKind` | `index.ts:37` |
| Canonical code union | `SDKErrorCode` | `index.ts:79` |
| Runtime code const | `SDKErrorCodes` | `index.ts:124` |
| Code guards | `isErrorCode` / `isKnownErrorCode` | `index.ts:172`, `:185` |
| Category to kind | `inferKind` | `index.ts:189` |
| Base error class | `GoodVibesSdkError` | `index.ts:405` |
| Config error | `ConfigurationError` | `index.ts:555` |
| Contract error | `ContractError` | `index.ts:605` |
| HTTP error | `HttpStatusError` | `index.ts:681` |

## Important rules

- Retryable status codes are defined once, in `RETRYABLE_STATUS_CODES` (`index.ts:276` — `[408, 429, 500, 502, 503, 504]`); `GoodVibesSdkError` derives `recoverable` from this set when the caller does not pass `recoverable` explicitly (`index.ts:466`).
- Transport failures preserve `url`, `method`, `status`, `retryAfterMs`, and the provider context fields `provider` / `operation` / `phase` / `requestId` / `providerCode` / `providerType` (`index.ts:427-432`). There is no `event` field.
- Contract violations are `ContractError` (code `SDK_CONTRACT_ERROR`, kind/category `contract`).
- Configuration failures are `ConfigurationError` (code `SDK_CONFIGURATION_ERROR`, kind/category `config`).
- HTTP failures are `HttpStatusError` (code defaults to `SDK_HTTP_STATUS_ERROR`, source `transport`).
- Unknown values are normalized without losing the original `cause` (`index.ts:434`, `:479`).

Do not introduce parallel error taxonomies in extension packages.

## Constructing & serializing errors

- `GoodVibesSdkErrorOptions` (`index.ts:251`) is the construction surface for every error class — all fields are optional, and `code` / `category` / `recoverable` are inferred when omitted (`index.ts:447-479`).
- `createHttpStatusError(status, url, method, body, fallbackHint?)` (`index.ts:746`) builds an `HttpStatusError` from a response. When `body` satisfies `isStructuredDaemonErrorBody` (`index.ts:725`) the daemon-supplied fields (including an explicit `code`) win; otherwise the `code` is inferred from `status`.
- `toJSON()` (`index.ts:482`) serializes the structured fields via `omitUndefined`, dropping `undefined` entries; `cause` is preserved through the native `Error` `cause` option (`index.ts:451`).
- `instanceof` is realm-safe and brand/code-based rather than strictly prototype-bound: `GoodVibesSdkError` stamps a non-enumerable brand and overrides `[Symbol.hasInstance]` (`index.ts:436`), and `ConfigurationError` / `ContractError` / `HttpStatusError` each override `[Symbol.hasInstance]` (`index.ts:563`, `:613`, `:693`) so an error carrying the matching `code` (or the dedicated `HttpStatusError` brand) passes the check even across realms or after a serialize/deserialize round-trip. Callers that need strict prototype identity should compare against `<Class>.prototype` via `Object.getPrototypeOf(err)`.
