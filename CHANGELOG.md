# Changelog

## 0.18.2

- Extracted the reusable transport/event seams from `goodvibes-tui` source first, then synced them into SDK packages
- Synced operator and peer foundation contracts plus the canonical runtime event domain vocabulary
- Added `@goodvibes/transport-core`, `@goodvibes/transport-direct`, and `@goodvibes/transport-realtime`
- Moved `@goodvibes/transport-http` onto source-owned TUI HTTP path, JSON, and SSE seams instead of downstream-only implementations
- Synced the daemon JSON error response contract from `goodvibes-tui` into `@goodvibes/errors`
- Added source-sync validation for transport and error seams alongside contract sync validation
- Added realtime transport tests and umbrella exports for the extracted transport layer
- Made `@goodvibes/contracts` runtime-neutral for browser and mobile consumers while keeping Node-only artifact path helpers on `@goodvibes/contracts/node`
- Added composed SDK entrypoints for Node, browser, web UI, React Native, and Expo in `@goodvibes/sdk`
- Added generated operator, peer, and runtime-event API reference docs from the synced contracts
- Added full SDK docs, per-package READMEs, and environment-specific examples for web UI, Expo, React Native, native Android, native iOS, and daemon embedding
- Added browser/runtime-neutral compatibility checks, documentation completeness checks, and package metadata/readme validation to the SDK validation pipeline
