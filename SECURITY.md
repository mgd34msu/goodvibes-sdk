# Security

Security-sensitive areas in this SDK include:
- bearer-token handling
- session login flows
- token persistence adapters
- realtime event streams
- daemon route embedding
- structured error propagation

## Reporting

If you find a security issue in:
- the GoodVibes protocol
- the daemon route helpers
- auth/session behavior
- token persistence guidance
- retry/reconnect behavior that could leak data

report it privately through the main GoodVibes security/reporting channel rather than filing a public issue with exploit details.

## Scope Notes

This repo publishes TypeScript packages. Some integration guides also cover the platform protocol for companion apps, but the platform behavior itself still originates in `goodvibes-tui`.

If the issue is in:
- contracts
- daemon route behavior
- auth/session semantics
- transport/realtime protocol behavior

the fix will generally need to land in `goodvibes-tui` first, then be synced here.

## Consumer Guidance

When building with this SDK:
- prefer bearer tokens for service-to-service and mobile companion clients
- use secure storage for persisted tokens
- avoid logging raw credentials or bearer tokens
- treat structured error fields as telemetry/debug metadata, not something to expose directly to end users without review
- validate CORS and cookie/session assumptions explicitly when using browser session auth
