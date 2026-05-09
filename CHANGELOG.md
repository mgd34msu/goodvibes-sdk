# Changelog

This file tracks breaking changes, additions, fixes, and migration steps for each release of `@pellux/goodvibes-sdk`. Every release **must** have a corresponding `## [X.Y.Z]` section here before publishing — the publish script and CI enforce this.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) conventions.

## [Unreleased]

---

## [0.33.20] - 2026-05-09

### Fixed
- Enforced WRFC topology at the SDK agent tool/runtime boundary by collapsing
  batch-spawn role decomposition such as engineer plus tester/reviewer/verifier
  into one WRFC owner chain instead of allowing sibling root role agents.
- Rejected direct disabled reviewer/tester/verifier root spawns so review,
  test, verification, and fix roles remain WRFC lifecycle children owned by
  the controller.
- Clarified the agent tool contract so `batch-spawn` is reserved for genuinely
  independent sidecar work, while same-deliverable role decomposition is routed
  through WRFC.

---

## [0.33.19] - 2026-05-08

### Fixed
- Made WRFC review prompts include the engineer's full reviewable output so
  no-write and non-file deliverable tasks can be reviewed directly instead of
  failing because no files exist.
- Tightened reviewer constraint-finding instructions with the exact JSON shape
  and normalized common evidence object/array shapes in the parser so usable
  findings are not silently dropped into repeated malformed-finding loops.

---

## [0.33.18] - 2026-05-08

### Added
- Added durable WRFC owner decisions for chain lifecycle, child spawning,
  review/fix transitions, gate outcomes, cancellation, failure, pass, and
  resume handling.
- Added optional WRFC child route selection so owners can choose provider,
  model, and reasoning effort per phase while defaulting to owner routing.
- Added basic WRFC chain resume hooks and a generic external WRFC adapter seam
  for companion or partner surfaces that need a translation layer.

### Changed
- Made WRFC review and fix prompts preserve the original request as the
  authoritative full-scope review target for every loop, including later fix
  rounds.
- Added lightweight worker self-check guidance instead of heavier phase
  contract retry machinery.

---

## [0.33.17] - 2026-05-08

### Fixed
- Split regular Knowledge/Wiki and Home Assistant Home Graph into separate
  runtime knowledge stores so `/api/knowledge/*` cannot expose Home Graph
  records through default views, `includeAllSpaces`, projections, packets, or
  repair-derived nodes.
- Routed Home Graph semantic repair through the Home Graph service and store,
  including the target Home Graph knowledge space on repair-source ingestion.

---

## [0.33.16] - 2026-05-07

### Fixed
- Hid orphan catalog-derived topic/domain/folder nodes from default
  Knowledge/Wiki views unless they are connected to visible base knowledge,
  preventing stale DisplaySpecifications-style repair tags from appearing in
  regular wiki nodes after reindex.
- Hid answer-gap issues whose only grounding is a refinement-only answer-gap
  node from default issues and projection targets, while still exposing them
  through `includeAllSpaces` diagnostics.

---

## [0.33.15] - 2026-05-07

### Fixed
- Made regular Knowledge/Wiki scoping edge-aware for derived nodes and issues,
  so stale topic/domain records connected to Home Assistant sources only by
  graph edges no longer appear in default nodes, issues, projections, packets,
  or maps.
- Hid ungrounded semantic answer-gap records from scoped default Knowledge/Wiki
  surfaces while preserving them for `includeAllSpaces` diagnostics and
  refinement state inspection.

---

## [0.33.14] - 2026-05-07

### Fixed
- Restored implicit `default` knowledge-space matching for base records without
  explicit space metadata, while keeping relationship-aware filtering for
  extension-linked records. This keeps reviewed project memory visible in the
  regular Knowledge/Wiki surface without reintroducing Home Assistant leaks.
- Wrote memory-derived graph nodes and topic tags with explicit `default`
  knowledge-space metadata during memory sync so future reindex runs produce
  unambiguous base knowledge records.

---

## [0.33.13] - 2026-05-07

### Fixed
- Tightened Knowledge/Wiki scoped issue, projection, packet, map, and item reads
  so stale answer-gap records marked `default` are hidden when their linked
  source or subject object belongs to an extension knowledge space.
- Inferred concrete non-default knowledge spaces for new answer gaps and
  source-linked records when their related source, subject, or linked object is
  already scoped, preventing future Home Assistant answer gaps from being
  written into base Knowledge/Wiki by mistake.

---

## [0.33.12] - 2026-05-07

### Fixed
- Tightened regular Knowledge/Wiki default scoping so unscoped derivative
  records are not treated as `default` knowledge. This prevents older
  Home Assistant/Home Graph semantic nodes, issues, projection targets, map
  entries, and packets from leaking through base knowledge routes.
- Namespaced source-derived compiled nodes and edges with the source knowledge
  space, so future domain, tag, folder, section, and structured entity records
  stay in the same space as the source that generated them.

---

## [0.33.11] - 2026-05-07

### Fixed
- Scoped regular Knowledge/Wiki reads to the base `default` knowledge space by
  default, so Home Assistant Home Graph records no longer appear through base
  knowledge sources, nodes, issues, search, map, packets, projections, status,
  item, extraction, or GraphQL routes unless callers explicitly request
  `knowledgeSpaceId` or `includeAllSpaces`.
- Returned scoped map facets and projection counts instead of deriving sidebar
  facets, backlink IDs, and wiki counts from the full cross-extension graph.

---

## [0.33.10] - 2026-05-07

### Added
- Added typed companion-chat message attachments. Browser clients can create
  artifacts through `sdk.artifacts.create(...)` from
  `@pellux/goodvibes-sdk/browser/knowledge`, then send them with
  `sdk.chat.messages.create(sessionId, { body, attachments: [...] })`.
- Persisted companion-chat attachments in message history and included them in
  per-session turn events so WebUI clients can render attachment state without
  local-only metadata.

### Fixed
- Resolved companion-chat attachments through the daemon artifact store before
  model turns. Small text artifacts are inlined into the provider prompt, image
  artifacts are forwarded as multimodal content parts, and unsupported files
  remain visible as durable artifact references instead of fake message
  metadata.

---

## [0.33.9] - 2026-05-07

### Added
- Added first-class companion-chat session listing and session route updates to
  `@pellux/goodvibes-sdk/browser/knowledge` via `sdk.chat.sessions.list()` and
  `sdk.chat.sessions.update(...)`.
- Added the typed `companion.chat.sessions.list` operator method and
  `GET /api/companion/chat/sessions` daemon route.

### Fixed
- Normalized OpenAI subscription-backed companion-chat model routing so both
  the catalog provider (`openai`) and runtime provider implementation
  (`openai-subscriber`) resolve `openai:*` registry keys safely.
- Returned the full stored companion-chat session from
  `companion.chat.sessions.create`, allowing browser clients to verify the
  persisted provider/model route immediately after create.

---

## [0.33.8] - 2026-05-07

### Added
- Added typed companion-chat browser helpers to
  `@pellux/goodvibes-sdk/browser/knowledge`, including scoped JSON methods for
  chat sessions/messages and an explicit SSE helper for per-session turn events.

### Fixed
- Aligned companion-chat operator contract outputs with the daemon route shapes
  so `sessions.get`, `sessions.update`, and `messages.list` no longer expose
  shared-session schemas.
- Preserved full provider/model routing metadata for `sessions.messages.create`
  `kind: "message"` conversation turns.

---

## [0.33.7] - 2026-05-07

### Fixed
- Reissued the scoped browser entrypoint release after npm published the
  `0.33.6` metadata for `@pellux/goodvibes-transport-realtime` without a
  retrievable tarball. No source changes from `0.33.6`.

---

## [0.33.6] - 2026-05-07

### Added
- Added scoped browser SDK entrypoints for extension-specific browser apps:
  `@pellux/goodvibes-sdk/browser/knowledge` exposes the base knowledge/wiki
  browser surface without Home Assistant Home Graph route metadata, and
  `@pellux/goodvibes-sdk/browser/homeassistant` exposes the Home Assistant Home
  Graph browser surface without the base knowledge/wiki route table.
- Added regression coverage that scoped browser bundles reject out-of-scope
  operator methods and do not include unrelated route metadata.

### Fixed
- Fixed scoped browser SSE cleanup so a subscription removed before the stream
  connection resolves cannot leave an orphaned stream open.

---

## [0.33.5] - 2026-05-07

### Fixed
- Aligned the public typed operator method id union with the generated operator method id artifact so `OperatorTypedMethodId` accepts every public method, including `knowledge.ask` and `knowledge.refinement.tasks.list`.
- Added type-level coverage for browser/WebUI knowledge invokes so contract drift between `OPERATOR_METHOD_IDS` and `OperatorMethodInput/Output` fails before publish.

---

## [0.33.4] - 2026-05-05

### Fixed
- Aligned `remote.snapshot` with the strict operator contract by serializing distributed pair requests, peers, work, and audit records as arrays instead of leaking the internal summary-object shape.
- Normalized persisted shared-session records when loading the session broker store so existing project stores receive required current fields such as `kind`, `lastActivityAt`, and `pendingInputCount` instead of blocking daemon startup.

---

## [0.33.3] - 2026-05-05

### Fixed
- Aligned `GET /api/accounts` with the strict `accounts.snapshot` contract by returning the canonical provider account snapshot without channel account fields.
- Fixed `IntegrationHelperService.getAccountsSnapshot()` so provider records keep required `notes` and `routeRecords` fields instead of returning a lossy projection.
- Added daemon-route and integration-helper regressions for account snapshots matching the published contract shape.
- Aligned SSE/WebSocket runtime event envelope serialization with the public realtime transport schema by emitting `ts` instead of the stale `timestamp` field.
- Enforced the current shared-session response shape on daemon session routes so `sessions.messages.list` includes required fields such as `session.kind` and `session.lastActivityAt`.

---

## [0.33.2] - 2026-05-05

### Fixed
- Aligned the shared-session operator contract with the daemon route/runtime session record by adding required `kind` and `lastActivityAt` fields to generated `sessions.*` response schemas and client types.
- Added regression coverage for the `sessions.create` contract so the published operator schema accepts the same session payload returned by `POST /api/sessions`.

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
