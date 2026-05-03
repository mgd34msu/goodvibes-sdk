# Transports

The transport packages are source-of-truth packages re-exported through the SDK
facade.

- `transport-core`: shared direct transport primitives, event/error helpers,
  UUID fallback, and common transport utilities.
- `transport-direct`: SDK facade name for in-process direct transport backed by
  `transport-core`. It is a package export subpath only; there is no separate
  `packages/transport-direct` workspace package.
- `transport-http`: HTTP JSON transport, retry policy, auth header resolution,
  idempotency keys, and JSON Schema response validation helpers.
- `transport-realtime`: WebSocket and realtime runtime event transport.

Transport errors should preserve useful event fields and use typed SDK error
classes. Retryable HTTP status codes come from `@pellux/goodvibes-errors`.
