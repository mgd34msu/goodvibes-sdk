# Changelog

## 0.18.42

- **δ1 — SharedSessionBroker: wire agent terminal events to input records**: Added `attachRuntimeBus(bus, sessionResolver)` to `SharedSessionBroker`. Subscribes to `AGENT_COMPLETED`, `AGENT_FAILED`, and `AGENT_CANCELLED` on the `RuntimeEventBus` and calls `completeAgent()` with the appropriate terminal status. Prior builds left `spawned` input records permanently stuck because `finalizeAgentInputs()` existed but was never triggered by bus events. Root cause of 8 stuck inputs observed at 192.168.0.61:3421
- **δ2 — AgentTaskAdapter: wire agent terminal events to task registry**: Added `attachRuntimeBus(bus)` to `AgentTaskAdapter`. Subscribes to the same three agent terminal events and calls `handleAgentStateChange()` with the mapped state (`completed`/`failed`/`cancelled`). Prior builds left task records permanently in `running` because `handleAgentStateChange()` existed but was never wired to bus events. Root cause of 8 agent tasks stuck in `running` at 192.168.0.61:3421
- **δ3 — SharedSessionBroker: lastActivityAt field + idle-session GC sweep**: Added `lastActivityAt: number` to `SharedSessionRecord`, updated on `createSession`, `bindAgent`, and `appendMessage`. Added `_gcSweep()` (runs every 60s via `setInterval` started on first `start()` call) that closes idle sessions with no active agent: empty-ghost policy (messageCount=0, idle >= `idleEmptyMs` default 10min) marks session `closed` with reason `idle-empty`; long-idle policy (has messages, idle >= `idleLongMs` default 24h) marks with reason `idle-long`. Fixes 9 ghost sessions (messageCount=0) and 10 perpetually-active sessions observed at 192.168.0.61:3421

## 0.18.41

- **γ1 — exec retry: full jitter + retryable classification**: `computeRetryDelay` now uses full jitter (`Math.random() * min(base * 2^attempt, maxDelay)`) to avoid thundering-herd on flaky dependencies. `runWithRetry` classifies errors before retrying — terminal errors (ENOENT, EACCES, `command not found`, `Permission denied`, syntax errors, `No such file or directory`) stop the retry loop immediately. Network-class errors (ECONNRESET, ENOTFOUND, ETIMEDOUT), lock/busy (EBUSY, ECONNREFUSED), and OOM (ENOMEM) retry per the `retry.on` allowlist. Added `max_delay_ms` and `on` fields to `ExecRetry` schema and interface. Exported `isRetryableExecResult` for testability
- **γ2 — ProcessManager.spawn: timeout + SIGKILL deadline + error surfacing**: `spawn()` is now `async` and accepts a `SpawnOptions` argument with `timeout_ms` (default 60000) and `sigterm_grace_ms` (default 5000). A timeout watchdog sends SIGTERM, waits the grace window, then SIGKILL. `killDeadline` is set on the process entry when SIGKILL is scheduled, distinguishing timeout-kill from user-abort in logs. ENOENT/EACCES from `Bun.spawn` are now surfaced as promise rejections instead of being silently swallowed
- **γ3 — Orchestrator.abort() clears animInterval**: `abort()` now immediately calls `clearInterval(this.animInterval)` and sets `animInterval = null`, preventing the thinking-animation timer from keeping the Node event loop alive after a mid-turn abort. Adds `isThinking = false` to the abort path so the UI state is consistent regardless of whether `stopThinking()` is reached in the `finally` block

## 0.18.40

- **CI recovery**: 0.18.39 published with a corrupted `version.ts` baked fallback (`let version = "0.18.39";;` — double-quoted + duplicate semicolon). The test/version-sync.test.ts regex requires single-quote form, so validate failed and no npm publish fired. This release restores the canonical single-quote format and hardens `scripts/sync-version-fallback.ts` to tolerate either quote style plus stray semicolons so the next mis-formatted edit is self-healing on the next sync

## 0.18.39

- Fixed `setModelContextCap` customModels branch missing `_invalidateModelRegistry()` call — mutating a custom model's context window was not reflected in subsequent `listModels()` calls until the next cold rebuild (I1)
- Added unit tests for 5 cache invariants: `setModelContextCap` invalidation for both `customModels` and `discoveredModels` paths, `registerRuntimeProvider` unregister callback invalidation, ring buffer newest-first ordering for `count < cap` and `count >= cap`, `_syncScheduled` coalescing of burst `rememberEvent` calls into 1 `syncControlPlaneState` dispatch per microtask, and `getMessagesForLLM` reference identity across all 15 mutating methods (I2)
- Replaced `recentEvents: this.recentEvents.length` in `getSnapshot()` with `recentEvents: this._recentEventsCount` — eliminates the full O(n) ring array allocation just to read `.length` (I3)
- Fixed `lastEventAt` in `_scheduleControlPlaneSync` — was closure-captured from the first event in a synchronous burst; now stored as `this._lastEventAt` field, updated on every `rememberEvent`, read inside `setImmediate` callback to always reflect the most recent event's timestamp (I4)
- Moved `_invalidateModelRegistry()` in `registerDiscoveredProviders` to after the provider registration loop — pre-loop invalidation was fragile (safe by accident); post-loop invalidation ensures the rebuilt registry includes all newly discovered models (I5)
- Added JSDoc `@returns readonly reference` warning to `getMessagesForLLM` documenting the shared cache contract (I6)
- Added dev-only `console.error` assertion in the `recentEvents` ring accessor when an `undefined` slot is encountered despite valid `_recentEventsCount` — surfaces ring buffer accounting bugs early in development while keeping the production skip path for resilience (I7)

## 0.18.38

- Added `_cachedModelRegistry` + `_invalidateModelRegistry()` to `ProviderRegistry.getModelRegistry()` — cache is invalidated on every mutation (`register`, `registerRuntimeProvider`, `registerDiscoveredProviders`, `loadCustomProviders`, `updateCatalogState`, `setModelContextCap`) and returned on cache hit, eliminating repeated `buildModelRegistry` calls across 10+ call sites per turn
- Replaced `recentEvents` O(n) `unshift` in `ControlPlaneGateway` with a 500-slot pre-allocated circular ring buffer using `_recentEventsHead`/`_recentEventsCount` indices — insert is now O(1)
- Fixed `rememberEvent` bypassing direct ring-write via Zustand reducer for `clientRecord.ring` — events are now written directly to the ring buffer without a reducer dispatch per append
- Added `_scheduleControlPlaneSync()` debounce in `ControlPlaneGateway.rememberEvent` — coalesces N per-event `syncControlPlaneState` dispatches into 1 per `setImmediate` tick, eliminating redundant full-state Zustand reducer runs during high-throughput streaming
- Added `_messagesRevision` + `_cachedLLMMessages` memoization to `ConversationManager.getMessagesForLLM()` — cache is invalidated on every message-mutating method (`addUserMessage`, `addAssistantMessage`, `addToolResults`, `addSystemMessage`, `undo`, `redo`, `removeMessagesAfter`, `markLastUserMessageCancelled`, `startStreamingBlock`, `updateStreamingBlock`, `finalizeStreamingBlock`, `replaceMessagesForLLM`, `resetAll`, `switchBranch`, `mergeBranch`, `fromJSON`) and returned on cache hit

## 0.18.37

- Added `sharedDaemonToken` and `sharedHttpListenerToken` options to `startHostServices` factories. Surfaces that issue companion-pairing bearer tokens (e.g. TUI QR pairing) now thread the token through to `daemon.enable(...)` so scanned QR credentials actually authenticate. Previously the embedded daemon was started with no shared token and rejected every request carrying the token it advertised
- Added bootstrap credential drift detection to `UserAuthManager` constructor. When `auth-bootstrap.txt` has been manually edited so its plaintext password no longer verifies against the hash in `auth-users.json`, a warning is now logged instead of silently rejecting /login forever. The bootstrap file is output-only — rotate passwords via `UserAuthManager.rotatePassword()` to keep both files in sync

## 0.18.36

- Fixed `resolveDaemonFacadeRuntime` ignoring constructor-injected `config.port` and `config.host` — the returned runtime was built solely from `configManager` values resolved through `resolveHostBinding`, so tests and embedders passing explicit port/host to `new DaemonServer({ port, host })` silently got the config defaults instead. `port` and `host` now prefer the directly-injected values and fall back to the resolved binding, matching the pattern `HttpListener` already uses

## 0.18.35

- Fixed `resolveHostBinding` ignoring the configured port under `hostMode: 'local'` and `'network'` — the 0.18.34 implementation always returned the default port for the server type, which broke every test and deployment that specified a custom port while keeping the default bind mode. Port is now caller-controlled in all three modes; hostMode decides only the bind address (127.0.0.1, 0.0.0.0, or a custom host)

## 0.18.34

- Fixed asymmetric `DaemonServer` lifecycle: `stop()` now properly tears down all services started during `start()` in reverse order (C1)
- Fixed `RuntimeEventBus.emit` iterating a mutable Set — listeners are snapshotted before dispatch to prevent skipped handlers during concurrent subscribe/unsubscribe (C3)
- Fixed `SessionManager.writeFileSync` non-atomic write — session state is now written via tmp-file + fsync + rename, preventing corruption on crash (C4)
- Fixed `HttpListener` `RateLimiter` Map growing unbounded — added TTL eviction, LRU cap of 10,000 entries, periodic 60-second sweep, and a `stop()` method to clear the sweep interval (C5)
- Added `fetchWithTimeout` utility with 30-second default timeout and `AbortSignal.any()` caller-signal merging; applied to all non-streaming outbound `fetch` calls in `github.ts`, `ntfy.ts`, `slack.ts`, the Slack adapter, and `gemini.ts` (C6)

## 0.18.33

- Added comprehensive SDK documentation: architecture overview, security best practices, performance tuning, observability guide, migration guide, and companion app pairing guide
- Added release notes for 0.18.29 through 0.18.32
- Updated root README with pairing module, port checking, and config entries
- Added password field to CompanionConnectionInfo for companion app auth

## 0.18.32

- Added port-in-use checking to DaemonServer and HttpListener — both now verify the port is free before binding, with a clear error message instead of crashing with EADDRINUSE
- Changed default daemon port from 3000 to 3141 to avoid conflicts with common dev servers

## 0.18.31

- Replaced broken inline QR encoder with vendored Nayuki QR Code generator (pure TypeScript, MIT license)
- No npm dependencies for QR generation 2014 the vendored library handles all QR versions and error correction levels correctly

## 0.18.30

- Added `platform/pairing/` module with QR code generation, companion token management, and connection info formatting for mobile companion app pairing
- QR generator shells out to `qrencode` CLI when available, falls back to built-in encoder for versions 1-10
- Companion tokens persist to `.goodvibes/<surface>/companion-token.json` with create/regenerate/invalidate lifecycle
- Connection info formatter produces human-readable daemon startup blocks with embedded QR codes
- Added `tools.llmEnabled` config key (default: `false`) so tool LLM is explicitly opt-in, matching `helper.enabled` behavior
- `resolveToolLLM()` now checks `tools.llmEnabled` before any provider resolution — when disabled, tool LLM calls return empty string instead of silently using the main conversation model

## 0.18.29

- Removed terminal rendering primitives from the reusable SDK platform surface: deleted `types/grid.ts` (`Cell`, `Line`, `createEmptyLine`, `createStyledCell`) and `core/history.ts` (`InfiniteBuffer`) which were orphaned TUI-specific modules that no SDK consumer should depend on
- Cleaned the `BlockMeta` interface in `core/conversation.ts` by removing the TUI rendering fields (`blockIndex`, `startLine`, `lineCount`, `collapseKey`) and keeping only platform-level fields (`type`, `rawContent`, `filePath`, `diffOriginal`, `diffUpdated`); surfaces extend `BlockMeta` with their own rendering coordinates
- Removed unused `_getWidth` and `_configManager` constructor parameters from `ConversationManager` and updated the agent orchestrator runner call site to match
- Decoupled `core/conversation-diff.ts` from the `BlockMeta` type by introducing a standalone `DiffParseResult` interface for `parseDiffForApply`, removing the unnecessary type coupling
- Added `undo()` and `redo()` methods to the SDK's `ConversationManager` — these were previously only available in the TUI but are pure message-list operations with no rendering dependency
- Created `config/api-keys.ts` with `getConfiguredApiKeys()` and `resolveApiKeys()` containing the canonical 30+ provider-to-environment-variable mapping and three-tier key resolution (env vars, SecretsManager, skip); extracted from the inline implementation in `config/index.ts`
- Extended the plugin loader with `additionalDirectories` and `entryDefault` options in `PluginPathOptions`, allowing surfaces to inject surface-specific plugin search paths and entry point defaults without forking the loader
- Generalized the health monitoring infrastructure from Panel-specific to Component-generic: renamed `PanelHealthMonitor` to `ComponentHealthMonitor`, `PanelResourceContract` to `ComponentResourceContract`, `PanelHealthState` to `ComponentHealthState`, and related types; old `Panel*` names are preserved as deprecated backward-compatible aliases
- Updated `RuntimeServices.panelHealthMonitor` to `componentHealthMonitor: ComponentHealthMonitor` throughout the services layer, shell command services, and workspace services
- Renamed diagnostic types from `PanelResourceEntry`/`PanelResourceSnapshot`/`PanelConfig` to `ComponentResourceEntry`/`ComponentResourceSnapshot`/`ComponentConfig` with deprecated aliases for backward compatibility
- Removed TUI-specific store domains from the SDK's `RuntimeState`: replaced `panels: PanelDomainState` with `panels: Record<string, unknown>` so surfaces define their own panel state shape, and replaced `uiPerf: UiPerfDomainState` with `surfacePerf: SurfacePerfDomainState` using the already-existing generic replacement
- Removed TUI-specific selectors (`selectPanels`, `selectActivePanels`, `selectFocusedPanel`) from the SDK store selectors and added `selectSurfacePerf` plus 8 missing platform domain selectors (`selectOrchestration`, `selectCommunication`, `selectAutomation`, `selectRoutes`, `selectControlPlane`, `selectDeliveries`, `selectWatchers`, `selectSurfaces`)
- Created `runtime/service-queries.ts` as the canonical platform-named barrel for the existing `ui-service-queries.ts` query interfaces
- Made the TUI surface config-driven in `channels/surface-registry.ts` instead of hardcoded as always-enabled; TUI now defaults to enabled via config check like every other surface, and can be explicitly disabled
- Split `utils/clipboard.ts`: removed the terminal-specific OSC 52 `copyToClipboard()` from the SDK and added a `ClipboardWriteFunction` type so surfaces inject their own clipboard write implementation; kept platform-level `pasteFromClipboard()` and `pasteImageFromClipboard()` in the SDK
- Removed `utils/splash-lines.ts` (ASCII art terminal banner) from the SDK platform surface
- Replaced hardcoded TUI references in ops playbooks (`permission-deadlock.ts`: "Ink render tree" to "host render context") and session return context (`session-return-context.ts`: "terminal coding session" to "coding session")
- Updated bookmark manager docstring to use generic terminology instead of TUI-specific "collapse key"
- Documented platform vs surface classification in `utils/terminal-width.ts` and `utils/notify.ts` for future cleanup reference

## 0.18.28

- Fixed the SDK session-persistence helpers so `surfaceRoot` now flows through the last-session pointer and crash-recovery paths instead of silently falling back to the shared `.goodvibes/...` root
- This closes the remaining TUI session-storage boundary leak that still wrote pointer and recovery files to the wrong root even when the host explicitly owned persistence under `.goodvibes/tui/...`

## 0.18.27

- Added the reusable `@pellux/goodvibes-sdk/platform/templates/manager` surface so hosts can use the SDK-owned template manager instead of carrying a local template implementation
- Moved template storage policy out of the reusable implementation by making the manager accept host-owned template roots while still supporting project and global template directories
- This release unblocks the TUI cutover of session template commands onto the published SDK package instead of a local copied `templates/manager.ts`

## 0.18.26

- Fixed the SDK’s baked runtime version fallback so it now syncs from the workspace package version during every build instead of drifting as a stale hardcoded literal
- Added a regression test that locks the source fallback to the root package version so this exact mismatch cannot silently ship again
- Removed stale static “current SDK version” lines from the docs that had already drifted out of date and were reinforcing the same bad state
- This patch closes the remaining version-leak path that still embedded `0.18.14` inside downstream TUI binaries even after the TUI app version had moved forward

## 0.18.25

- Fixed the SDK tool surface so `@ast-grep/napi` is no longer imported at module load time from the reusable `find` and `edit` support paths
- Moved AST native binding loading behind true runtime lazy imports for structural search and `ast_pattern` edit mode, so hosts do not need the native parser just to boot the SDK or register tools
- Updated the edit runtime to await the lazy `ast_pattern` path and keep the existing exact-edit fallback behavior when the AST runtime is unavailable
- Added a regression test that locks the startup boundary in place by preventing top-level `@ast-grep/napi` imports from returning in the SDK’s startup-sensitive tool modules

## 0.18.24

- Fixed the SDK ecosystem catalog/runtime layer so hosts can override catalog and receipt roots instead of being forced onto the SDK’s hardcoded `.goodvibes/ecosystem/...` layout
- Kept installed plugin, skill, hook-pack, and policy-pack destinations on the shared `.goodvibes/plugins|skills|hooks|policies` roots while letting hosts independently place curated catalog JSON and install receipts under their own surface-specific configuration trees
- Added an SDK regression test that locks the TUI host model in place: curated catalogs and receipts can live under `.goodvibes/tui/ecosystem/...` while installs still land under the shared `.goodvibes/...` runtime roots
- This closes the ecosystem/storage boundary leak that still broke the TUI’s SDK-backed plugin, skills, and marketplace commands after the `0.18.23` cutover

## 0.18.23

- Removed the SDK runtime network layer's remaining concrete `ConfigManager` class dependency and replaced it with host-neutral config-reader interfaces for shared path resolution, inbound TLS inspection, outbound TLS inspection, fetch wrapping, and the global network transport installer
- This closes the next host-boundary leak that still prevented `goodvibes-tui` from importing the reusable SDK network surface directly without sharing the SDK's concrete config manager class identity

## 0.18.22

- Removed the SDK’s remaining TUI-owned concrete runtime classes from the reusable platform boundary by deleting the copied command-registry, keybindings, panel-manager, and panel type implementations from the internal platform tree
- Replaced those concrete classes with host-facing runtime interfaces and no-op defaults so plugin loading, integration helpers, and runtime service composition accept caller-supplied host UI implementations instead of constructing TUI behavior inside the SDK
- Removed the automation runtime’s last hardcoded `tui` fallback for `main` and `current` session targets; hosts must now supply the default surface kind at the boundary, and the canonical runtime services layer injects that host policy explicitly
- This closes the remaining SDK host-boundary leak that still let reusable runtime code silently assume the TUI product surface instead of taking that configuration from the consuming host

## 0.18.21

- Removed the replay engine's remaining hardcoded `/tmp` export assumption by allowing report exports under the host's active temp root instead of a Unix-only fixed path
- Updated replay command guidance to use host-neutral project-local export examples instead of baking `/tmp` into the public SDK command surface
- This closes the downstream TUI replay regression that appeared once the test runner moved onto repo-local temp roots during the SDK cutover validation pass

## 0.18.20

- Fixed the SDK REPL Python runtime so it no longer tries to build an ephemeral virtualenv before every evaluation
- Switched the Python REPL execution path back to the host-provided `python3` interpreter inside the selected sandbox session, which removes the hidden `ensurepip` / `venv` dependency from the published package surface
- This closes the package-level REPL regression that still broke `goodvibes-tui` after the sandbox runtime cutover, even when the host already had a working `python3`

## 0.18.19

- Fixed the public sandbox provisioning surface so hosts are no longer forced to satisfy the SDK’s private `ConfigManager` class identity just to use doctor, guest-bundle, and QEMU setup helpers
- Replaced the concrete provisioning manager type with host-facing `ConfigManagerLike` / `WritableConfigManagerLike` interfaces, keeping the SDK reusable from package consumers that supply their own compatible config manager implementations
- This closes the package-level typing break that blocked `goodvibes-tui` from consuming the canonical sandbox provisioning exports directly after the sandbox runtime cutover

## 0.18.18

- Finished the next host-boundary cleanup pass by removing the remaining reusable SDK modules that were still deriving `.goodvibes/goodvibes/...` paths internally
- Made the service-manager configurable from the host layer and kept the canonical `goodvibes` binary/service description only in concrete daemon composition instead of reusable SDK internals
- Moved session/worktree/WRFC runtime state, team/worklist/packet/query tool persistence, ecosystem catalogs, registry discovery, intelligence config, and scheduler helper state onto host-configurable or shared `.goodvibes` paths, then revalidated the standalone package

## 0.18.17

- Continued the SDK host-boundary cleanup by removing more baked-in `.goodvibes/goodvibes/...` storage paths from reusable platform modules
- `ConfigManager`, `SecretsManager`, background provider/MCP discovery, the cross-session task registry, the distributed-runtime store, keybindings, guidance persistence, plugin state, and sandbox provisioning now require explicit host-owned `surfaceRoot` or storage-path input instead of silently defaulting to the canonical product root
- Kept the canonical `goodvibes` root choice only in concrete daemon host wiring while the reusable SDK surfaces now compile and validate with the storage root pushed back to the host boundary

## 0.18.16

- Removed the hardcoded `goodvibes` product-root assumption from the reusable SDK runtime/tool surfaces that the TUI is expected to consume directly
- `createRuntimeServices`, `registerAllTools`, and `createReplTool` now require host-injected `surfaceRoot` ownership instead of baking a product root into the reusable SDK layer
- Moved the canonical `goodvibes` root choice up into the SDK’s concrete daemon host wiring so the package keeps product defaults at the host boundary rather than inside reusable platform modules

## 0.18.15

- Published the completed platform extraction pass into the SDK-owned internal tree, bringing the pending ACP, adapters, agents and WRFC runtime, automation, channels, config, control-plane, daemon host, hooks, knowledge, MCP, media, runtime, state, tools, watchers, and web-search implementation modules into the canonical SDK release
- Converted the newly extracted runtime support layer into SDK-native code by making the public `platform/runtime/ui/provider-health/*` path source-owned, pushing the older `platform/runtime/provider-health/*` path behind compatibility re-exports, and replacing remaining self-package imports in runtime barrels, diagnostics, bootstrap helpers and services, model-picker, and orchestrator/runtime support files with direct local imports
- Hardened the SDK release path so GitHub releases prefer dedicated `docs/releases/<version>.md` documents and pack/install/release helpers stage their temporary files under the repo-local `.tmp/` root instead of leaking OS temp artifacts into the worktree

## 0.18.14

### First Full SDK Release

- Published the first full canonical `@pellux/goodvibes-sdk` release as one umbrella package with stable subpath exports instead of a public multi-package install model
- Shipped the extracted GoodVibes platform surface in a standalone SDK-owned package tree, including contracts, auth, errors, transports, operator and peer clients, daemon route builders, and reusable platform/runtime modules
- Finalized the flattened package shape so installs resolve to one real package with local subpath exports and no leaked nested internal workspace packages

### Public Package Surface

- `@pellux/goodvibes-sdk`
  umbrella SDK plus runtime-specific entrypoints for Node, browser, web UI, React Native, and Expo
- `@pellux/goodvibes-sdk/contracts`
  runtime-neutral operator and peer contract artifacts, ids, generated types, and event-domain metadata
- `@pellux/goodvibes-sdk/contracts/node`
  Node-only helpers for raw artifact path access
- `@pellux/goodvibes-sdk/auth`
  token-store helpers plus login/current-auth flows
- `@pellux/goodvibes-sdk/errors`
  structured SDK, transport, and daemon errors
- `@pellux/goodvibes-sdk/operator`
  contract-driven operator/control-plane client
- `@pellux/goodvibes-sdk/peer`
  contract-driven peer/distributed-runtime client
- `@pellux/goodvibes-sdk/daemon`
  embeddable daemon route contracts, route builders, dispatchers, auth helpers, and error-response helpers
- `@pellux/goodvibes-sdk/transport-core`
  shared client-transport and event-feed primitives
- `@pellux/goodvibes-sdk/transport-direct`
  in-process direct transport shell
- `@pellux/goodvibes-sdk/transport-http`
  HTTP path, auth, retry, JSON, SSE, and contract-client layers
- `@pellux/goodvibes-sdk/transport-realtime`
  runtime-event connectors over SSE and WebSocket

### Daemon And Route Layer

- Included the reusable daemon/server integration layer for control, runtime, telemetry, channel, integration, knowledge, media, system, and remote route surfaces
- Included API dispatchers for operator, automation, sessions, tasks, and remote routes
- Included shared daemon policy/error/route-helper surfaces so hosts can embed the route layer without reimplementing the daemon adapter contract

### Platform Runtime Modules

- Included reusable platform/runtime modules for control-plane, knowledge, automation, tools, runtime events, permissions, transport helpers, voice, watchers, and related non-UI platform systems
- Extracted platform domains now cover:
  `acp`, `adapters`, `agents`, `artifacts`, `automation`, `bookmarks`, `channels`, `config`, `control-plane`, `core`, `daemon`, `discovery`, `hooks`, `integrations`, `intelligence`, `knowledge`, `mcp`, `media`, `multimodal`, `permissions`, `profiles`, `providers`, `runtime`, `scheduler`, `security`, `sessions`, `state`, `tools`, `types`, `utils`, `voice`, `watchers`, `web-search`, and `workflow`
- Removed the remaining source-repo coupling and old source-sync workflow so the SDK validates and installs without requiring a `goodvibes-tui` checkout
- Removed the last matching byte-for-byte extracted platform carryover at the legacy path boundary and moved the extracted runtime under the SDK-owned internal tree

### Runtime Integrations And Consumers

- Exposed cross-runtime entrypoints for Node, browser, web UI, React Native, and Expo, along with runtime-neutral contract exports and Node-only contract artifact helpers
- Included companion-app guidance and examples for browser/web UI, React Native, Expo, Android, iOS, daemon embedding, auth flows, retry/reconnect, and approvals/status feeds
- Shipped reusable runtime inspection/state-inspector exports so hosts do not need to carry local copies of those inspection utilities

### Docs, Validation, And Release

- Shipped full SDK docs, generated contract references, environment guides, examples, package metadata, and release/publishing documentation for the umbrella package model
- Added validation for type-level usage, browser/runtime-neutral safety, package metadata, pack/install smoke, registry verification, and release dry-run behavior
- Added registry-aware release automation for npm and the GitHub Packages mirror, with tag-driven GitHub release creation
- Added a public umbrella export for `@pellux/goodvibes-sdk/platform/runtime/inspection/state-inspector` and locked that subpath into install-smoke validation so hosts can depend on the SDK-owned state-inspector implementation without carrying local copies

## 0.18.13

- Removed the leftover `projectSdkRoot` / `userSdkRoot` and `resolveProjectSdkPath` / `resolveUserSdkPath` naming from the public shell-path service so the SDK no longer exposes the old extracted-app compatibility surface
- Corrected the extracted platform runtime storage roots to use the TUI product namespace under `.goodvibes/tui` instead of the invalid `.goodvibes/sdk` path
- Revalidated the standalone SDK after the storage-root correction with clean build, tests, pack checks, install smoke, and release dry-run

## 0.18.12

- Moved the extracted platform runtime behind the umbrella package’s SDK-owned internal source boundary under `packages/sdk/src/_internal/platform` while keeping the public `platform/*` subpath exports intact
- Added explicit SDK-internal root modules for contracts, daemon, errors, operator, peer, and transport surfaces so the relocated platform runtime no longer depends on the old source-tree depth assumptions
- Removed the remaining TUI-specific wording from the extracted runtime, security, ACP, session, overlay, profile, and voice modules
- Eliminated the remaining byte-for-byte TUI carryover in the extracted platform tree and revalidated the standalone SDK with clean build, tests, pack checks, tarball install smoke, and release dry-run

## 0.18.11

- Removed the remaining source-repo coupling from the SDK workspace, including the old source-sync workflow and the Bun-run `.mjs` maintenance scripts
- Finished moving the extracted platform runtime into the umbrella package’s local internal tree so the published SDK validates and installs as a standalone product
- Replaced the old extracted-app storage root with the SDK-owned `.goodvibes/sdk` runtime path
- Re-homed the leftover `runtime/ui` slices into platform-neutral runtime namespaces and renamed the old `ui-perf` domain to `surface-perf`
- Removed the unused `panels` store domain from the extracted platform tree and revalidated the umbrella package with clean build, tests, pack checks, and tarball install smoke

## 0.18.10

- Fixed the public `@pellux/goodvibes-sdk/transport-http` entrypoint so the low-level `requestJson` helper and `TransportJsonError` type are actually exported from the published package
- This closes the last public export gap that blocked the TUI from replacing its local JSON transport wrapper with the SDK surface

## 0.18.9

- Exposed the low-level operator and peer remote-client constructors as public SDK entrypoints so host code can compose typed clients from a preconfigured transport without copying the TUI source
- Exposed the low-level JSON request helper and transport error type from `@pellux/goodvibes-sdk/transport-http` so host code can reuse the SDK transport surface instead of carrying local fetch wrappers
- Expanded package READMEs for the operator, peer, and transport HTTP surfaces to document the newly public low-level composition APIs

## 0.18.8

- Restored daemon error compatibility for foreign provider-style errors so `@pellux/goodvibes-sdk/daemon` preserves structured metadata when hosts pass non-SDK error classes with the same provider fields
- Added SDK coverage that locks the TUI-facing provider error compatibility path into the published daemon surface

## 0.18.7

- Restored transport compatibility on normalized HTTP errors by preserving `error.transport` metadata on SDK `HttpStatusError` instances
- Restored rich daemon JSON error bodies in `@pellux/goodvibes-sdk/daemon`, including structured provider metadata, summary tags, and category-based hints
- Added SDK tests that lock transport metadata and structured daemon error compatibility so the TUI migration stays aligned with the published SDK surface

## 0.18.6

- Added a dedicated `@pellux/goodvibes-sdk/auth` subpath so token-store and login helpers are discoverable without reaching through the umbrella entrypoint
- Added explicit umbrella subpath shim modules for `contracts`, `contracts/node`, `daemon`, `errors`, `operator`, `peer`, and the `transport-*` surfaces so those entrypoints are part of the published package shape instead of relying on indirect re-export behavior
- Tightened pack and install smoke checks to fail if the published SDK ever regresses into nested internal `node_modules` packages again
- Tightened pack checks to fail if any published build output still references internal workspace package specifiers
- Added `scripts/prepare-sdk-package.ts` and updated release staging so the umbrella package is flattened and rewritten from local built outputs before pack/publish
- Updated the public docs, package README, examples, and release docs so they describe one npm package with entrypoints instead of implying a multi-package public install model
- Added registry-aware release plumbing so npmjs remains primary while GitHub Packages can mirror the same umbrella package shape, including registry-specific token/config handling in the release scripts and workflow

## 0.18.5

- Flattened the umbrella SDK package so the published install artifact is a single self-contained package instead of a bundle of nested internal workspace packages
- Rewrote umbrella subpath exports to resolve to local flattened implementation files inside `@pellux/goodvibes-sdk`
- Added raw contract JSON exports on the umbrella package for `contracts/operator-contract.json` and `contracts/peer-contract.json`
- Removed bundled dependency usage from the public package and added metadata guards to prevent that packaging model from returning
- Updated the build pipeline to prepare the flattened SDK package automatically after TypeScript compilation

## 0.18.4

- Converted the SDK release model to one public npm package: `@pellux/goodvibes-sdk`
- Moved consumer-facing imports to subpath exports under the umbrella package instead of separate published packages
- Marked internal workspace packages private and updated package validation to enforce that boundary
- Fixed staged release bundling so the published umbrella tarball no longer leaks workspace symlinks or invalid `..` tar paths during packaging
- Updated release validation, pack checks, install smoke checks, and published-version verification for the umbrella-only publish flow
- Corrected README, getting-started, package docs, and release docs so they describe one package with subpath exports instead of multiple public npm packages

## 0.18.3

- Extracted the reusable transport/event seams from the legacy platform source into SDK packages
- Synced operator and peer foundation contracts plus the canonical runtime event domain vocabulary
- Added `@pellux/goodvibes-transport-core`, `@pellux/goodvibes-transport-direct`, and `@pellux/goodvibes-transport-realtime`
- Moved `@pellux/goodvibes-transport-http` onto source-owned TUI HTTP path, JSON, and SSE seams instead of downstream-only implementations
- Moved the daemon JSON error response contract into `@pellux/goodvibes-errors`
- Added source-sync validation for transport and error seams alongside contract sync validation
- Added realtime transport tests and umbrella exports for the extracted transport layer
- Made `@pellux/goodvibes-contracts` runtime-neutral for browser and mobile consumers while keeping Node-only artifact path helpers on `@pellux/goodvibes-contracts/node`
- Added composed SDK entrypoints for Node, browser, web UI, React Native, and Expo in `@pellux/goodvibes-sdk`
- Added generated operator, peer, and runtime-event API reference docs from the synced contracts
- Added full SDK docs, per-package READMEs, and environment-specific examples for web UI, Expo, React Native, native Android, native iOS, and daemon embedding
- Added browser/runtime-neutral compatibility checks, documentation completeness checks, and package metadata/readme validation to the SDK validation pipeline
- Added portable release automation for npm publishing, staged pack validation, local tarball install smoke checks, and published-registry verification
- Added a tag-driven GitHub release workflow and release/publishing documentation for the SDK release process
- Renamed the published npm packages from the incorrect `@goodvibes/*` scope to the correct `@pellux/goodvibes-*` scope
