# Changelog

This file tracks breaking changes, additions, fixes, and migration steps for each release of `@pellux/goodvibes-sdk`. Every release **must** have a corresponding `## [X.Y.Z]` section here before publishing — the publish script and CI enforce this.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) conventions.

> **Versions prior to 0.19.0**: see `docs/releases/*.md` for long-form per-release notes.

---

## [0.19.6] - 2026-04-17

**Honest runtime posture + full documentation sweep + type-test relocation.** The biggest single release of the 0.19.x series. Breaking cleanup of previously-advertised Node support, comprehensive rewrite of consumer-facing documentation, monorepo version unification, and a new compile-time type-assertion gate.

### Breaking

- **`./node` exports entry removed** from `packages/sdk/package.json`. Consumers importing via `@pellux/goodvibes-sdk/node` must migrate to the root entry or an appropriate runtime-specific entry (`./react-native`, `./browser`, `./web`, `./expo`).
- **`./oauth` exports entry removed** from `packages/sdk/package.json`. The `./oauth` subpath was the Node-only OAuth fork (depends on `node:crypto` via `oauth-core.ts`). Consumers performing OAuth flows should use a server-side proxy and exchange tokens via the standard auth surface. The `OAuthClient` class is intentionally excluded from the companion barrel (`_internal/platform/auth/index.ts`) and was never usable on Hermes or browser.
- **`engines.node` removed**; replaced with `engines.bun: ">=1.0.0"`. The SDK does not support Node as a consumer runtime. Supported runtimes: Bun (dev + full agentic apps), Hermes (React Native / Expo for iOS + Android), browser.
- **`createNodeGoodVibesSdk` and `NodeGoodVibesSdkOptions` removed from the root `@pellux/goodvibes-sdk` entry.** These were helper factories that constructed an SDK instance with Node-specific defaults. The helpers are gone; consumers importing them from the root must migrate to `createGoodVibesSdk` (runtime-neutral) or the appropriate runtime-specific factory (`createReactNativeGoodVibesSdk`, `createBrowserGoodVibesSdk`).
- **`packages/sdk/src/node.ts` and `packages/sdk/src/oauth.ts` deleted** from the repo tree. The subpath exports were already removed; the source files are now gone so they cannot accidentally be re-exported.

### Added

- **Companion-bundle guard** (Wave S-ε.3): `test/rn-bundle-node-imports.test.ts` extended to cover all four companion entry points (`react-native.js`, `expo.js`, `browser.js`, `web.js`) plus `auth.js`. Asserts zero `Bun.*` API calls (agentic surface leak) AND zero `node:*` imports in each dist bundle. Run via the `rn-bundle` platform matrix dimension on CI.
- **`docs/surfaces.md`**: new authoritative document describing the two-tier surface split — **full surface** (Bun-only: TUI/daemon/CLI, includes agentic + `Bun.*` APIs) and **companion surface** (multi-runtime: Hermes, browser — auth + transport + events + contracts + errors + observer only). Includes supported-runtimes table, import-map per surface, and CI enforcement detail.
- **`docs/archive/README.md`** + **`docs/archive/releases/0.18.x/`**: 38 per-release notes (0.18.14 → 0.18.51) moved out of `docs/releases/` into a dated archive. Keeps the top-level docs tree focused on the 0.19.x series and forward. Archive README explains the policy and links back to the primary `CHANGELOG.md`.
- **Compile-time typed-client assertion suite** (relocated from `test-types/` → `test/types/`): `test/types/typed-client-usage.ts` exercises `GoodVibesSdk` generic inference against representative contract shapes. Run via `bun run types:check` (uses `tsconfig.type-tests.json`).
- **New `types-check` CI job** in `.github/workflows/ci.yml`: runs `bun run types:check` on every push/PR to `main`. Catches generic-inference regressions that the runtime test suite cannot.

### Changed — Documentation sweep (Wave D)

Every consumer-facing document reviewed for honest-runtime-posture compliance, hallucinations, and broken examples. All affected docs updated in a single wave so the published 0.19.6 artifact is internally consistent.

- **Front-door rewrites (Cluster 1)**: `README.md`, `docs/README.md`, `docs/getting-started.md`, `docs/public-surface.md` — removed all `/node` and `/oauth` references, rewrote quickstart examples against the real import surface, replaced `case 'AUTH_FAILED':` / `case 'TRANSPORT_ERROR':` patterns with the real `SDKErrorKind` union values (`'auth'`, `'network'`, `'server'`, `'validation'`, `'rate-limit'`, `'contract'`, `'config'`, `'not-found'`, `'unknown'`). Corrected `createOperatorClient` → `createOperatorSdk` and `createPeerClient` → `createPeerSdk`.
- **Integration guides (Cluster 2)**: `docs/react-native-integration.md`, `docs/expo-integration.md`, `docs/browser-integration.md`, `docs/web-ui-integration.md`, `docs/daemon-embedding.md`, `docs/pairing.md`, `docs/packages.md`, `docs/authentication.md`, `docs/observability.md` — corrected import paths (e.g. `@pellux/goodvibes-sdk/platform/pairing` → `@pellux/goodvibes-sdk/platform/pairing/index` because wildcard `./platform/*` exports do not resolve directory-index fallbacks), removed fabricated factory names (`createDaemonSdk`, `createDaemonRouteHandler`, `createReactNativeTokenStore`) and replaced with real exports (`createGoodVibesSdk`, `dispatchDaemonApiRoutes`, `createMemoryTokenStore`), fixed `createConsoleObserver` import to come from the root entry rather than `/errors`.
- **Architecture docs (Cluster 3)**: `docs/architecture.md`, `docs/architecture-platform.md`, `docs/compatibility.md`, `docs/performance.md`, `docs/security.md`, `docs/tool-safety.md`, `docs/retries-and-reconnect.md` — updated runtime matrix to match `docs/surfaces.md`, corrected references to removed subpaths, validated example snippets against real symbols.
- **Migration & operations (Cluster 4)**: `docs/migration.md`, `docs/troubleshooting.md`, `docs/release-and-publishing.md` — added explicit 0.18.x → 0.19.x migration notes (Node removal, error-kind rename, factory rename), aligned troubleshooting recipes with the real error taxonomy, updated publish workflow to reference the new `version:check` / `types:check` / `changelog:check` gates.
- **Roadmap & tracking (Cluster 6)**: `docs/roadmap-to-1.0.md`, `docs/tracking/roadmap-status.md`, `CONTRIBUTING.md` — marked S-α through S-θ.1 complete, recorded current score (9.0/10), added score-effect reading notes, scrubbed banned phrase "pre-existing" (consistent with project style rule).
- **Archive (Cluster 8)**: all 38 pre-0.19 release notes moved to `docs/archive/releases/0.18.x/` via git rename (history preserved). `SDK-TUI-MIGRATION-CHANGELOG.md` at repo root deleted — superseded by `CHANGELOG.md` + `docs/migration.md`.
- **Hallucination audit**: every code example across the docs tree verified by a verify-then-patch protocol — the fix agent was required to CONFIRM each flagged hallucination was actually wrong before editing; false positives left the docs unchanged. 17 confirmed hallucinations fixed; 1 falsely flagged (the `platform/pairing/index` path, which was actually the correct fix after live module resolution).
- **Examples**: `examples/operator-http-quickstart.mjs`, `examples/realtime-events-quickstart.mjs`, `examples/retry-and-reconnect.mjs`, `examples/submit-turn-quickstart.mjs` — updated to import from the current public surface and use real error-kind values.

### Removed

- `tests/node-smoke/` suite — removed entirely. It tested a runtime with no consumers.
- `node-20` / `node-22` CI matrix dimensions — removed from `.github/workflows/ci.yml`.
- Root `test:node-smoke` and `test:ci` scripts — removed from `package.json`.
- `packages/sdk/src/node.ts` (Node factory module — no longer exported).
- `packages/sdk/src/oauth.ts` (Node-only OAuth — no longer exported).
- `SDK-TUI-MIGRATION-CHANGELOG.md` at repo root (content superseded by this file + `docs/migration.md`).
- `test-types/` directory at repo root (renamed to `test/types/` to consolidate all tests under `test/`).

### Migration

- Consumers importing from `@pellux/goodvibes-sdk/node`: import from the root (`@pellux/goodvibes-sdk`) for Bun apps, or from a runtime-specific entry point for companion apps. Node.js consumption was never tested or supported despite the entry point existing.
- Consumers importing from `@pellux/goodvibes-sdk/oauth`: if you need daemon-to-daemon OAuth on Bun, access `OAuthClient` directly from the internal path (unsupported, may change) or open an issue for a supported API. RN/browser consumers should use the server-side proxy pattern.
- Consumers matching on error strings (`'AUTH_FAILED'`, `'TRANSPORT_ERROR'`, etc.): update to the real `SDKErrorKind` union — `'auth' | 'config' | 'contract' | 'network' | 'not-found' | 'rate-limit' | 'server' | 'validation' | 'unknown'`. The real union has been stable since 0.19.2; the old string-tag form was never the runtime shape, only a docs hallucination.
- Consumers importing `createOperatorClient` / `createPeerClient`: rename to `createOperatorSdk` / `createPeerSdk`.
- No changes required if you import only from the root, `./auth`, `./errors`, `./contracts`, `./transport-*`, `./browser`, `./web`, `./react-native`, `./expo`, or `./platform/*` and were already using the real `SDKErrorKind` values.

### Infrastructure

- **All workspace packages unified at 0.19.6**: prior to this wave, `packages/sdk/package.json` had been bumped incrementally to 0.19.3–0.19.6 across per-wave releases while the root `package.json` and all other `packages/*/package.json` files remained at 0.18.53. All 11 `package.json` files (root + 10 workspace packages) are now at 0.19.6.
- **New `version-consistency` CI gate**: `scripts/version-consistency-check.ts` reads the root `package.json` version and asserts all `packages/*/package.json` files match. Wired as `bun run version:check` and runs on every push/PR to `main` via the `version-consistency` job in `.github/workflows/ci.yml`. Supports `WORKSPACE_ROOT` and `WORKSPACE_PACKAGES_JSON` env overrides to enable its own unit tests. Prevents future divergence from per-wave partial bumps.
- **New `types-check` CI job**: enforces `bun run types:check` on every push/PR. Uses `tsconfig.type-tests.json` (updated to include `test/types/**/*.ts` after the relocation).
- **Auto-synced version fallback**: `scripts/sync-version-fallback.ts` now writes `packages/sdk/src/_internal/platform/version.ts` with the root version on every version bump. No more manual drift between the package manifest and the runtime `SDK_VERSION` constant.
- **Root cause documentation**: `publish-packages.ts` reads `packages/sdk/package.json` for the changelog gate but does not propagate the version to sibling packages. Each package publishes its own stored `manifest.version`. Without a consistency gate, partial bumps were invisible to CI — fixed by the new `version-consistency` job.

### Internals

- **`SDKObserver.onAuthTransition` wired** in `packages/sdk/src/auth.ts`: captures the prior token via `ts?.getToken()` BEFORE calling `sm.login(...)`, then invokes the observer with `{ from: priorToken ? 'token' : 'anonymous', to: 'token', reason: 'login' }` after a successful login. Wrapped in `invokeObserver(...)` so observer exceptions never surface to callers. `onEvent` / `onError` / `onTransportActivity` remain on the roadmap as S-θ.2.
- **`test/integration/`** suite added: `auth-flow-e2e.test.ts` + `any-runtime-event-property.test.ts` + shared arbitraries — exercises the auth → transport → events happy path without touching external services.
- **`test/sdk-observer.test.ts`** + **`test/version-consistency.test.ts`** added: unit coverage for the observer helpers and the version-consistency check script (using `WORKSPACE_ROOT` override).

### Not shipped yet

- `SDKObserver.onEvent`, `SDKObserver.onError`, `SDKObserver.onTransportActivity` — design complete, wiring deferred to S-θ.2.
- Platform-matrix expansion (S-ε.2): RN/Hermes + browser runtime dimensions beyond bundle-shape checks.
- Hardening gates (S-ι): long-horizon stability work, ~2–3 weeks, required before 1.0.0 is eligible.
- **1.0.0 itself**: explicitly deferred. Per repo policy, 1.0.0 requires direct owner approval and is not implied by any code-quality threshold.

---

## [0.19.5] - 2026-04-17

SDK observer interface (partial delivery).

### Added

- **`SDKObserver` interface** (Wave S-θ.1): optional observability hook surface. Methods: `onAuthTransition` (wired), `onEvent` / `onError` / `onTransportActivity` (declared but not yet invoked — wire-up in S-θ.2). Export from `@pellux/goodvibes-sdk` root.
- **`createConsoleObserver(opts?)`** (Wave S-θ.1): dev adapter that logs observer events to the console. Optional `level` (`'debug' | 'info'`, default `'info'`).
- **`createOpenTelemetryObserver(tracer, meter)`** (Wave S-θ.1): production adapter that emits OpenTelemetry spans and counters. Accepts external `tracer` and `meter` args — no hard `@opentelemetry/*` dependency; consumers bring their own.
- **Auth transition observability** (Wave S-θ.1): `createGoodVibesAuthClient` accepts an optional 4th `observer?: SDKObserver` argument and fires `onAuthTransition` on login and logout.
- **`docs/observability.md`** (Wave S-θ.1): new section documenting the interface, adapters, silent-on-error guarantee, and wire-up status.

### Deferred

- **`onEvent`, `onError`, `onTransportActivity` wire-up** (Wave S-θ.2): declared on the interface but no SDK code fires them yet. Consumers may register implementations safely — they will begin firing when the wire-up lands.

### Migration

- Existing consumers of `createGoodVibesAuthClient` are unaffected. The new `observer` argument is optional (4th positional) and defaults to undefined.
- To observe auth transitions, pass `createConsoleObserver()` or your own `SDKObserver` implementation as the 4th argument.

---

## [0.19.4] - 2026-04-17

Integration + property test infrastructure. No consumer-facing API changes.

### Added

- **End-to-end auth flow integration test** (Wave S-ζ): `test/integration/auth-flow-e2e.test.ts` drives `createGoodVibesAuthClient` + `createOperatorSdk` through login → authenticated call → session expiry → revoke → 401 fallback against a real `Bun.serve` fake operator server. 4 scenarios covering session-cookie, shared-token, and fallthrough auth modes.
- **Property tests for `AnyRuntimeEvent` round-trips** (Wave S-ζ): `test/integration/any-runtime-event-property.test.ts` uses `fast-check` with 100-200 iterations per property to verify every event kind round-trips through JSON serialization without type loss, malformed events produce typed errors, and discriminant coverage is exhaustive.
- **`fast-check` dev dependency** pinned to `3.23.2`.

### Deferred

- **SSE/WebSocket chaos tests** (Wave S-ζ.2): network-failure injection harness for backoff + reconnect policy assertions. Scheduled for a follow-up.
- **`createGoodVibesAuthClient` decomposition regression test** (Wave S-ζ.2): explicit TokenStore + SessionManager + PermissionResolver compose-equivalence test. Partially covered by the existing auth-* test suite + the new e2e test.

---

## [0.19.0] - 2026-04-17

### Breaking

- **`_internal` path no longer reachable through package exports** (Wave S-α): `packages/sdk/package.json` exports map updated so `./platform/*` resolves to `./dist/platform/*.js` instead of `./dist/_internal/platform/*.js`. Any consumer importing via `@pellux/goodvibes-sdk/dist/_internal/...` or using `./platform/*` subpaths that relied on the old resolution must update to the public barrel entry-points.
- **633 transparent barrel files added** (Wave S-α): public platform surface is now exported through explicit barrels. Consumers importing from private paths that were accidentally resolvable before will receive module-not-found errors at build time.

### Added

- **Mirror drift guard** (Wave S-γ): `bun run sync:check` (`scripts/sync-check.ts`) verifies byte-parity between `packages/transport-http/src/**` (canonical) and `packages/sdk/src/_internal/transport-http/**` (mirror). Enforced in CI via the `mirror-drift` job on every push/PR to `main`.
- **Shared normalization module** (Wave S-γ): `scripts/_internal/normalize.ts` extracted as a shared helper used by the sync + drift-guard scripts so normalization logic cannot diverge between them.

### Fixed

- Mirror drift in `packages/sdk/src/_internal/transport-http/**` that caused consumer regressions is now caught before it reaches main.

### Migration

- Replace any imports of the form `@pellux/goodvibes-sdk/dist/_internal/platform/...` with the corresponding public barrel: `@pellux/goodvibes-sdk/platform/...` or a named export from the top-level `@pellux/goodvibes-sdk` entry.
- If you used `./platform/*` subpath exports, verify your import still resolves after upgrading — the target changed from `_internal/platform` to `platform`.
- Run `bun run sync:check` locally before pushing to verify no transport-http mirror drift.

---

## [0.19.3] - 2026-04-17

Error taxonomy enforcement on the public surface.

### Breaking

- **Public SDK functions now throw typed `GoodVibesSdkError` instead of raw `Error`** (Wave S-β): consumers can now discriminate errors by `err.kind` / `err.category` / `err.source` fields rather than string-matching `err.message`. The error types are unchanged — only the concrete throw sites are now typed. Code that catches and inspects SDK errors may gain new structured fields; code that catches without inspection continues to work unchanged.
- Converted 7 raw throw sites on the canonical public surface:
  - `packages/daemon-sdk/src/knowledge-routes.ts` (4 schedule validation throws → `GoodVibesSdkError` with `category: 'bad_request'`, `source: 'contract'`, which maps to kind `validation`).
  - `packages/transport-http/src/contract-client.ts` (1 unknown-route throw → `category: 'contract'`, kind `contract`).
  - `packages/transport-http/src/paths.ts` (1 missing-baseUrl throw → `ConfigurationError` with code `SDK_TRANSPORT_BASE_URL_REQUIRED`, kind `config`).
  - `packages/operator-sdk/src/client-core.ts` (1 no-HTTP-binding throw → `category: 'contract'`, kind `contract`).

### Added

- **`throw-guard` CI job** (Wave S-β): `.github/workflows/ci.yml` gains a ripgrep-based gate that fails the build if any of the following patterns appear in public source (`packages/**/src/**` excluding `_internal/`, `errors/`, tests): `throw new Error(`, `throw Error(`, `throw {`, `throw '`, `throw "`. Enforced on push/PR to `main`. Prevents regression of the typed-error contract.
- **`docs/error-kinds.md`** (Wave S-β): one section per `SDKErrorKind` value documenting when it fires, what remediation consumers should attempt, and whether it's retryable.
- **`docs/error-handling.md` extended** (Wave S-β): typed-discrimination consumer pattern with a TUI-style `switch (err.kind)` example.

### Migration

- Consumers catching SDK errors can now use `if (err instanceof GoodVibesSdkError) switch (err.kind) { ... }` to handle specific error categories. See `docs/error-handling.md` for the canonical pattern.
- If your code was catching specific error messages via string match, verify the corresponding `err.kind` / `err.category` gives you the same discriminator. Message strings may change; kinds will not (post-1.0).

---

## [0.19.2] - 2026-04-17

Mirror drift cleanup. No consumer-facing API changes.

### Added

- **`--scope=<subsystem>` flag on `scripts/sync-sdk-internals.ts`** (Wave S-γ-cleanup): allows narrow regeneration of a single mirror subsystem without touching others. `removeStaleFiles` is narrowed to the scoped `targetDir` when `--scope` is active, fixing a prior bug where the stale walker would traverse all of `_internal/` regardless of the sync target. Default (no `--scope`) behavior preserved — full-tree sync still works.

### Fixed

- **8 transport-http mirror drifts resolved** (Wave S-γ-cleanup): ran `bun scripts/sync-sdk-internals.ts --scope=transport-http` to regenerate `auth.ts`, `backoff.ts`, `contract-client.ts`, `http-core.ts`, `paths.ts`, `reconnect.ts`, `retry.ts`, `sse-stream.ts`. Legacy `// Extracted from …` banners replaced with correct `// Synced from …` banners; `sse-stream.ts` import-order content drift resolved. The `mirror-drift` CI job (introduced in 0.19.0) can now pass on `main`.

### Migration

- For future narrow drift cleanups, use `bun scripts/sync-sdk-internals.ts --scope=<subsystem>` where `<subsystem>` is one of: `contracts`, `errors`, `daemon`, `transport-core`, `transport-direct`, `transport-http`, `transport-realtime`, `operator`, `peer`.

---

## [0.19.1] - 2026-04-17

Two release-infrastructure waves. No consumer-facing API changes.

### Added

- **Changelog gate** (Wave S-δ): `bun run changelog:check` (`scripts/check-changelog.ts`) verifies that a `CHANGELOG.md` section exists for the current `packages/sdk` version. Enforced in CI via the new `changelog-check` job and inline in `scripts/publish-packages.ts` as a pre-stage gate. Future releases are blocked until their `## [X.Y.Z]` section is added.
- **Platform test matrix** (Wave S-ε, partial): `.github/workflows/ci.yml` gains a `platform-matrix` job running the test suite under four dimensions — `bun`, `bun-on-node20`, `bun-on-node22`, `rn-bundle`. `rn-bundle` folds the prior standalone RN `node:` import check into the matrix. The `bun-on-node20` / `bun-on-node22` dimensions are honestly labeled — Bun is the test runner in all four, with the Node binary present in the environment to catch install-time regressions; they do not run tests under `node --test`.
- **`test:ci`, `test:rn` scripts** (Wave S-ε): single-source build-and-test commands invoked by the matrix job.
- **Changelog Gate + Platform Matrix docs** (Waves S-δ, S-ε): new sections in `docs/release-and-publishing.md`.

### Deferred

- **Real Node-as-runtime dimensions** (Wave S-ε follow-up): converting `bun-on-nodeN` dimensions to genuine `node --test` execution against `dist/` requires a Node-compatible test harness; tracked separately.
- **Browser + Cloudflare Workers dimensions** (Wave S-ε follow-up): need `@vitest/browser` + Playwright and Miniflare harnesses respectively; both deferred.
- **Broader mirror drift cleanup**: a drift-cleanup attempt via `bun run sync` was reverted during this release because `sync` targets all `_internal/**` subsystems (daemon, transport-core, transport-direct, transport-realtime, operator, peer) beyond the transport-http scope of the guard, and regenerating those mirrors surfaced latent type mismatches between canonical packages and their barrel consumers. Only transport-http drift was intended; a future WRFC will narrow the sync invocation.

### Migration

- Before releasing, run `bun run changelog:check` to confirm the CHANGELOG entry is present for the version being published. The publish script will fail fast if it is missing.
- CI now runs four platform-matrix dimensions. If you have a fork, confirm your CI setup pulls the updated `.github/workflows/ci.yml`.
