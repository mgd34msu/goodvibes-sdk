# Changelog

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
