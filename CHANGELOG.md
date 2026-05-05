# Changelog

This file tracks breaking changes, additions, fixes, and migration steps for each release of `@pellux/goodvibes-sdk`. Every release **must** have a corresponding `## [X.Y.Z]` section here before publishing — the publish script and CI enforce this.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) conventions.

## [Unreleased]

---

## [0.33.1] - 2026-05-05

### Fixed
- Hardened `PersistentStore` and `JsonFileStore` atomic writes against concurrent saves by giving each save a unique temporary file. This fixes a real automation-job persistence race observed in CI where one save could rename another save's shared `.tmp` file.
- Added regression coverage for concurrent `PersistentStore.persist()` and `JsonFileStore.save()` calls.
- Added Node 22 setup to the release validation job before Wrangler tests so the tag release path matches the main CI platform matrix environment.

---

## [0.33.0] - 2026-05-04

### Breaking
- Renamed platform error type aliases `ErrorCategory` → `PlatformErrorCategory` and `ErrorSource` → `PlatformErrorSource` in `@pellux/goodvibes-sdk/platform/types`. The platform-layer error hierarchy (`AppError`, `ProviderError`, etc.) is unchanged; only the type aliases were renamed to eliminate the public-surface name collision with the canonical `ErrorCategory` / `ErrorSource` from `@pellux/goodvibes-errors`. Consumers importing these aliases via `@pellux/goodvibes-sdk/platform/types` must update their imports.

### Added
- Removed the `validateEvent` alias from the public event contracts; `validateKnownEvent` is now the single runtime event validator.
- Tagged `daemon-sdk` `ExecutionIntent` alias (`type ExecutionIntent = unknown`) with `/** @public */` to align with the existing `AutomationSurfaceKind` widening pattern. Eliminates an api-extractor `ae-incompatible-release-tags` warning at the daemon-sdk ↔ platform-runtime circular-dep boundary.
- Documented `SessionManager.#observer` non-emission policy: the field is intentionally retained but observer notification lives in the `createGoodVibesAuthClient` facade (`auth.ts`), which has full priorToken awareness for `anonymous→token` vs `token→token` transitions. Emitting from `SessionManager` would produce duplicate transitions.
- Added `assertSameOriginAbsoluteUrl` helper in `@pellux/goodvibes-transport-http` and wired it into `requestJson` and `openServerSentEventStream` so absolute URLs that diverge from the transport's `baseUrl` origin are rejected with `ConfigurationError SDK_TRANSPORT_CROSS_ORIGIN` instead of silently receiving the bearer Authorization header.
- Added `requireAdmin` gates to all twelve state-changing handlers in `daemon-sdk/media-routes.ts` (voice TTS/STT/realtime, web search, artifact create, media analyze/transform/generate, multimodal analyze/packet/writeback).
- Extended `scripts/package-metadata-check.ts` to assert `engines.bun === "1.3.10"` and `engines.node === ">=22.0.0"` per workspace package, preventing future regressions where a package drops the engines pin.

### Fixed
- `docs/observability.md:9` no longer references a non-existent `sdk.observer` field; updated to instruct passing `observer` via `createGoodVibesSdk({ ..., observer })` or subscribing via `sdk.realtime.viaSse()` / `sdk.realtime.viaWebSocket()`.
- `examples/README.md` env-var table now documents `GOODVIBES_USERNAME` / `GOODVIBES_PASSWORD` required by `auth-login-and-token-store.ts`.
- `bundle-budgets.README.md` now documents the aggregate `./events` budget entry separately from the per-domain exclusions, with a pointer to the `domains` array for human reference.
- `docs/secrets.md:6` standardized on `**Public subpath:**` wording to match `docs/security.md`.
- Standardized cross-link footer headings on `## Next Reads` across `docs/getting-started.md`, `docs/observability.md`, `docs/wrfc-constraint-propagation.md`, `docs/performance.md` (previously a mix of `## Next reads` and `## Related`).
- `docs/observability.md` activity-logger snippet now uses `homedir()` + `path.join` instead of a hardcoded Linux path.
- `docs/companion-app-patterns.md` now cross-references `docs/companion-message-routing.md` for the `kind: 'followup'` taxonomy.
- `docs/getting-started.md:128` `authToken` type description now mentions the `undefined` member and points to `client.ts` JSDoc as canonical.
- `docs/error-kinds.md` clarified the two `err.code` namespaces (HTTP route-body codes vs. typed-error-subclass codes).
- `docs/realtime-and-telemetry.md` now declares its scope vs. `docs/observability.md` to clarify the intentional content overlap.
- `packages/sdk/src/platform/runtime/observability.ts` now carries a header comment documenting why this barrel uses named re-exports only (no `export *`), in contrast to sibling runtime barrels.

### Migration
- **Platform error type rename**: if you import `ErrorCategory` or `ErrorSource` from `@pellux/goodvibes-sdk/platform/types` (or the deeper `platform/types/errors` path), rename to `PlatformErrorCategory` / `PlatformErrorSource`. The canonical `ErrorCategory` / `ErrorSource` from `@pellux/goodvibes-errors` are the consumer-facing names and are unchanged.

---

## [0.30.5] - 2026-05-04

### Breaking
- none

### Added
- Closed docs and examples audit findings across `docs/`, `examples/`, `packages/sdk/src/client.ts`, and all package `package.json` files.
- Bumped all package versions to `0.30.5` to align CHANGELOG with source-of-truth.
- Fixed `docs/media-and-search.md`: removed non-existent `platform/media` subpath; corrected to `platform.media.*` namespace and `platform/multimodal` subpath.
- Fixed `packages/sdk/src/client.ts:48`: JSDoc example replaced broken `.then(events => ...)` form with correct synchronous `viaSse()` usage.
- Fixed `docs/security.md:226`: changed "Internal module" to "**Public subpath:**" for `platform/config`.
- Fixed five example quickstarts (`submit-turn`, `retry-and-reconnect`, `realtime-events`, `peer-http`, `operator-http`): replaced silent `?? null` authToken with explicit guard that throws when `GOODVIBES_TOKEN` is unset.
- Removed duplicate `> **Note:**` block from `docs/observability.md` after daemon-embedder gate was already present at section top.
- Updated `examples/peer-http-quickstart.mjs` clarification comment to reference `docs/public-surface.md` capability namespaces.
- Strengthened `examples/README.md` daemon-fetch-handler entry to describe the host callback boundaries explicitly.
- Added Route-Level Error Codes section to `docs/error-kinds.md` cataloguing `INVALID_KIND`, `PROVIDER_NOT_CONFIGURED`, `INVALID_REQUEST`, and other HTTP-route error codes.
- Removed lone JSDoc `@param` annotation from `examples/submit-turn-quickstart.mjs` for consistency with other `.mjs` examples.
- Added `(internal helper)` marker to `extractAuthToken` prose in `docs/auth.md`.
- Converted long companion-chat route list paragraph to a table in `docs/companion-message-routing.md`.

### Fixed
- none

### Migration
- none

---

## [0.30.4] - 2026-05-04

### Breaking
- none

### Added
- Closed docs and examples audit findings across `docs/`, `examples/`, `README.md`, `CHANGELOG.md`, `SECURITY.md`, and package READMEs.
- Corrected default daemon control-plane port from `3210` to `3421` across all quickstarts, docs, examples, and package READMEs.
- Fixed sealed-path imports: `docs/automation.md` (`platform/automation` → `platform`), `docs/security.md` (`platform/permissions` → `platform` namespace), `docs/media-and-search.md` (removed non-existent `platform/media` subpath), `packages/contracts/src/zod-schemas/README.md` (`zod-schemas` → `zod-schemas/index`).
- Corrected `docs/wrfc-constraint-propagation.md`: `ConstraintFinding` is not exported from the SDK root; corrected to reflect `platform` namespace access.
- Fixed broken doc anchor in `examples/expo-quickstart.tsx`: `#websocket-not-available` → `#websocket-implementation-is-required`.
- Updated `SECURITY.md` lodash override version from `4.17.21` to `4.18.1` to match the pinned override in `package.json`.
- Corrected `docs/architecture.md`: `platform/pairing` is a public subpath, not an internal module.
- Refactored `examples/auth-login-and-token-store.ts`: replaced unidiomatic IIFE-throw pattern with explicit guard block.
- Added session TTL and rate-limit defaults to `docs/defaults.md`.
- Clarified `docs/observability.md`: `LOG_FLUSH_INTERVAL_MS` and `LOG_BUFFER_MAX` are internal constants, not exported configurables; added daemon-embedder note before `configureActivityLogger` example; added `STREAM_DELTA` to turn events table; added wire-up status table caption.
- Disambiguated `docs/companion-app-patterns.md` `POST`/`PATCH` guidance for companion chat sessions.
- Added public-surface cross-reference note to `docs/runtime-orchestration.md`.
- Clarified `docs/troubleshooting.md`: SSE mobile reconnection issues described precisely; added Next Reads section.
- Clarified `docs/feature-flags.md` `killed` state description.
- Marked internal functions in `docs/auth.md` scope flow list; aligned `client-auth` phrasing.
- Added clarifying note to `docs/error-kinds.md` WRFC synthetic critical issues section.
- Added Next Reads sections to `docs/automation.md`, `docs/voice.md`, `docs/troubleshooting.md`.
- Clarified `examples/README.md` guidance for `daemon-fetch-handler-quickstart.ts` host callbacks.
- Added usage hint comment to `docs/getting-started.md` daemon embed snippet.
- Added `peer-http-quickstart.mjs` operator.snapshot clarification comment.
- Closed docs and examples audit findings across `docs/`, `examples/`, `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, and `SECURITY.md`.
- Reconciled `docs/public-surface.md` platform table with actual `packages/sdk/package.json` exports map; added `./client-auth` and `./observer` entries.
- Corrected `docs/authentication.md`: `autoRefresh: false` → `autoRefresh: { autoRefresh: false }`, `AutoRefreshCoordinator` import path corrected to `./client-auth`.
- Corrected `docs/retries-and-reconnect.md`: removed non-existent `generateIdempotencyKey` import from `transport-http`.
- Corrected `docs/error-handling.md`: `OperatorSdk`/`ControlSnapshot` replaced with `GoodVibesSdk`/`OperatorMethodOutput<'control.snapshot'>`.
- Fixed `docs/daemon-embedding.md` route-group list to reflect actual exported dispatchers.
- Replaced internal source file paths in `docs/secrets.md`, `docs/auth.md`, `docs/runtime-orchestration.md`, `docs/channel-surfaces.md` with public API references.
- Updated `examples/daemon-fetch-handler-quickstart.ts` to use the generated operator contract.

### Fixed
- none

### Migration
- none

---

## [0.30.3] - 2026-05-03

### Breaking
- none

### Added
- Expanded public seams used by TUI tests and examples without restoring
  private/deep import paths: ACP connections, adapter helpers, automation
  scheduler snapshot import, hook runner helpers, runtime lifecycle helpers,
  transport helpers, provider classes, runtime snapshots, media understanding
  providers, and built-in tool factories are now exported from their platform
  seams.
- Added automation store snapshot import coverage through the automation API.
- Added a runtime lifecycle facade that routes plugin, MCP, task, and
  compaction transition helpers through the explicit `platform/runtime` seam
  while keeping the subsystem-specific modules typed for direct consumers.

### Fixed
- Restored package-export-valid access for TUI test and example imports that
  still depended on SDK-owned symbols after the v0.30 public seam cleanup.
- `buildOperatorContract()` now includes the current-auth alias path metadata
  advertised by the daemon, and the shared contract type/schema accepts it.
- Transport diagnostics expose structured negotiation failure fields for current
  diagnostics consumers.

### Migration
- Continue using explicit `@pellux/goodvibes-sdk/platform/...` public seams
  listed in the package export map. Private source paths remain unavailable.

---

## [0.30.2] - 2026-05-03

### Breaking
- none

### Added
- Expanded the public `platform/runtime` seam for host-owned TUI and daemon
  composition: shell path helpers, provider account snapshots, system-message
  policy, command shell service contracts, diagnostics panels, eval helpers,
  forensics, sandbox, worktree, remote runtime, session persistence, return
  context, settings sync, ecosystem catalog, provider health UI data, and
  runtime read models are now available through the aggregate runtime entry.
- Expanded exported platform seams with SDK-owned symbols needed by host
  runtimes. Consumers should import only exact subpaths listed in the package
  export map.

### Fixed
- Restored package-export-valid public access for the TUI's production SDK
  imports without adding private source-path aliases.
- Background provider discovery now accepts both current host hook names used
  by SDK-owned bootstrap code.
- Ecosystem catalog reviews and install receipts expose `compatibility`
  alongside `runtimeFit`, matching the marketplace UI contract.
- Companion pairing token helpers now support scoped host calls and expose
  stale operator-token pruning through the public pairing seam.

### Migration
- Keep using exact `@pellux/goodvibes-sdk/platform/...` seams from the package
  export map. Do not import private SDK source paths.

---

## [0.30.1] - 2026-05-03

### Breaking
- none

### Added
- Added deliberate public SDK seams for daemon host runtimes that need to
  compose GoodVibes platform services without importing private source paths.
- Added public runtime subpaths for event bus, feature flags, network helpers,
  runtime store, store domains, and store reducer helpers.
- Added public config subpaths and aggregate exports for secrets, secret
  references, service registry, provider subscriptions, helper model,
  OpenAI Codex auth, and tool LLM support.

### Fixed
- `platform/tools` now exports the SDK-owned `ToolRegistry`, `ProcessManager`,
  and `AgentManager` classes required by daemon/TUI runtime composition.
- `platform/providers` now exports `ProviderRegistry`, so host runtimes can
  wire provider catalog, routing, and model state through the public provider
  seam.
- Host-runtime composition moved to explicit platform subpaths instead of
  private source imports.

### Migration
- Replace private deep imports such as `config/manager`,
  `runtime/feature-flags`, `runtime/network`, `utils/logger`, and
  `daemon/server/http-listener` with corresponding explicit platform public
  seams.

---

## [0.30.0] - 2026-05-02

### Breaking
- The SDK source mirror system has been removed. Sibling packages such as
  `@pellux/goodvibes-contracts`, `@pellux/goodvibes-transport-http`,
  `@pellux/goodvibes-peer-sdk`, and `@pellux/goodvibes-operator-sdk` are now
  the source of truth and `@pellux/goodvibes-sdk` re-exports them through
  deliberate facade entrypoints.
- Arbitrary `@pellux/goodvibes-sdk/platform/*` wildcard imports are no longer
  public API. Use the explicit package exports documented for v0.30.0.

### Added
- `bun run contracts:check` replaces the old mirror-oriented `sync:check`
  command and checks generated contract artifacts only. It does not check or
  regenerate SDK mirror source because mirror source no longer exists.
- v0.30.0 documentation now describes the facade package, source-of-truth
  sub-packages, explicit exports, runtime surfaces, base knowledge refinement,
  generated pages, and Home Graph as an extension.
- CI now rejects ordinary skipped/todo tests and folds lint-style gates into
  the validation path.

### Fixed
- Deleted the stale `packages/transport-direct` workspace artifacts; the public
  SDK subpath now remains only as a facade over `transport-core`.
- Home Graph generated-page refresh now batches graph writes, skips missing
  extraction text explicitly, and indexes page source relationships before
  rendering device passports.
- WebSocket realtime errors now preserve close/error event fields and outbound
  queue overflow uses a typed transport error.
- Peer/operator clients share contract input merging, reject excess helper
  arguments, expose disposal hooks, and derive available Zod response schemas
  from contract schema exports.
- The HTTP contract response validator now checks common JSON Schema `format`
  constraints.
- Retryable HTTP status codes now use the canonical
  `@pellux/goodvibes-errors` list everywhere, so SDK platform helpers,
  transport retry policy, and structured HTTP errors agree on 408, 429, 500,
  502, 503, and 504.
- CI no longer runs dead mirror deletion guards. The mirror-drift job is
  replaced with a contract-artifact check that matches the current
  source-of-truth architecture.
- Large semantic and Home Graph route tests were split into focused files with
  shared fixtures.

### Migration
- Remove any workflow or local command that calls `bun run sync:check`,
  `scripts/sync-check.ts`, `scripts/sync-sdk-internals.ts`, or
  `bun run sync --scope=...`; those tools were deleted or renamed with the
  mirror system.
- Replace old deep imports into SDK mirror or platform wildcard paths with
  explicit v0.30.0 exports.
