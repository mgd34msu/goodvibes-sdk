# Changelog

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
- Added `scripts/prepare-sdk-package.mjs` and updated release staging so the umbrella package is flattened and rewritten from local built outputs before pack/publish
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

- Extracted the reusable transport/event seams from `goodvibes-tui` source first, then synced them into SDK packages
- Synced operator and peer foundation contracts plus the canonical runtime event domain vocabulary
- Added `@pellux/goodvibes-transport-core`, `@pellux/goodvibes-transport-direct`, and `@pellux/goodvibes-transport-realtime`
- Moved `@pellux/goodvibes-transport-http` onto source-owned TUI HTTP path, JSON, and SSE seams instead of downstream-only implementations
- Synced the daemon JSON error response contract from `goodvibes-tui` into `@pellux/goodvibes-errors`
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
