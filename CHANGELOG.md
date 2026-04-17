# Changelog

This file tracks breaking changes, additions, fixes, and migration steps for each release of `@pellux/goodvibes-sdk`. Every release **must** have a corresponding `## [X.Y.Z]` section here before publishing — the publish script and CI enforce this.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) conventions.

> **Versions prior to 0.19.0**: see `docs/releases/*.md` for long-form per-release notes.

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
