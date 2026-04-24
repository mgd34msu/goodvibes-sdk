# Road to 1.0.0

Published plan for shipping `@pellux/goodvibes-sdk@1.0.0`. Every item below is a gate — the 1.0.0 publish does not happen until all boxes are checked **and** the repo owner has explicitly signed off.

## Status

- **Current version target**: `0.25.1` (current pre-1.0 hardening line; 0.25.0 is already published and 0.25.1 carries dependency-audit remediation)
- **Current score**: pending recalibration after the 0.23.x–0.25.x feature and hardening releases (last recorded roadmap score: 9.0 / 10 at 0.21.36)
- **Eligibility**: NOT eligible for 1.0.0 — owner sign-off pending and the soak criteria must be redefined after feature-bearing 0.23.x, 0.24.x, and 0.25.x releases landed after the original 0.21.0 soak start

## Version plan

```
0.19.9          previous (Waves 1–9 consolidated + pipeline hardening + zero-any gate)
  → 0.21.0            original soak signal (started 2026-04-18)
  → 0.25.1            current hardening line [CURRENT]
  → 1.0.0            owner-approved release
```

We deliberately skip `1.0.0-rc.X` prerelease syntax to avoid `package.json` pinning confusion. The 2-minor jump to `0.21.0` is the soak signal.

---

## Wave 1 — S-θ.2 observer seams (target: 0.19.8, shipped in `60a2a06`)

Wire the three remaining `SDKObserver` callbacks.

- [x] `TransportObserver` interface defined in `packages/transport-core/src/`
- [x] `SDKObserver` in `packages/sdk/src/observer/` extends `TransportObserver`
- [x] `onEvent` wired in `transport-realtime` receive paths + event facade
- [x] `onError` wired at every `SDKError` throw site in transport/auth layers
- [x] `onTransportActivity` wired in `transport-http` + `transport-realtime`
- [x] All observer calls wrapped in `invokeObserver(…)` so exceptions don't surface
- [x] OpenTelemetry observer tested end-to-end (in-memory collector mock)
- [x] `test/sdk-observer.test.ts` extended with the three new callbacks

## Wave 2 — Browser real-runtime (target: 0.19.8, shipped in `f86123b`)

- [x] `test/browser/` harness using `@vitest/browser` + Playwright
- [x] Imports built `dist/browser.js` via `./browser` subpath
- [x] Exercises auth + transport-http + transport-realtime against MSW mock
- [ ] Restore explicit `browser` CI dimension if browser real-runtime execution is still required for 1.0; current CI keeps only the static browser compatibility check inside `bun run validate`
- [ ] Restore examples smoke as an explicit CI gate if example execution remains a 1.0 requirement; current `docs-completeness-check` only verifies required example files exist and are non-empty

## Wave 3 — Hermes real-runtime (target: 0.19.8, shipped in `488b615`+`8262775`)

- [x] `test/hermes/` harness using `hermes-engine` binary
- [x] Imports built `dist/react-native.js` via `./react-native` subpath
- [ ] Restore explicit `hermes` CI dimension if Hermes real-runtime execution is still required for 1.0; current CI relies on the `rn-bundle` static companion-surface check
- [x] Any Hermes shims land in `sdk/src/_internal/platform/*` following existing runtime-conditional pattern

## Wave 4 — Workers real-runtime (target: 0.19.7, landed)

- [x] `test/workers/` harness using Miniflare
- [x] First attempt: `/web` entry under Miniflare. If clean, reuse.
- [x] Decision: `./web` is sufficient — no `./workers` subpath needed. `dist/web.js` has zero `node:` and zero `Bun.*`.
- [x] New CI matrix dimension `workers`
- [x] Follow-up: `wrangler dev --local` harness landed in `test/workers-wrangler/` (9 tests, CI matrix dimension). Discovered that `wrangler dev --local` uses Miniflare 4 internally, so the runtime layer is the same as the Miniflare harness — value is exercising wrangler's esbuild bundling pipeline and wrangler.toml. Production-workerd verification (e.g. `EventSource === false`) remains unverifiable locally; requires a real Cloudflare deploy (out of scope for 1.0). See `test/workers/FINDINGS.md`.

## Wave 5 — Package hygiene + supply chain (target: 0.19.11)

- [x] `@arethetypeswrong/cli` CI gate (validates `exports` map type resolution across `node16` + `bundler`)
- [x] `publint` CI gate
- [x] `npm publish --provenance` wired via GitHub Actions OIDC
- [x] Signed git tags (`git tag -s`) on every release tag
- [x] `SECURITY.md` at repo root with reporting policy and response SLA
- [x] **SBOM generation** (CycloneDX JSON via `@cyclonedx/cyclonedx-npm`) attached to every GitHub release and the npm tarball; new CI job `sbom-check`

## Wave 6 — Policy & UX (target: 0.19.12)

- [x] `docs/semver-policy.md` — explicit definition of what counts as a breaking change
- [x] Error-message quality audit — every `SDKError` throw site graded and rewritten where lacking
- [x] Timeout / retry / backoff defaults audit across transport-http, transport-realtime, auth refresh
- [x] Public-surface TODO cleanup: fold `packages/sdk/src/platform/runtime/transports/http.ts` into `daemon-http-client` once consumers stop importing `transports/http` directly
- [x] Public-surface TODO cleanup: wire producer API + bound queue size in `packages/transport-realtime/src/runtime-events.ts:143` (unbounded queue is a prod-hang risk; resync mirror scoped after fix)
- [x] Any finding documented in CHANGELOG as a fix

## Wave 7 — Verification + Zod runtime validation (target: 0.19.13)

- [x] Zod (v4, modular tree-shakeable build) adopted at transport boundary
- [x] Schemas auto-generated from contract definitions in `packages/contracts/`
- [x] Validation failures throw `SDKError{kind:'contract'}` with field-level detail
- [x] Verdaccio dry-run publish + install into scratch project
- [ ] Per-runtime-entry bundle-size budgets exist as `bun run bundle:check`, but the current CI workflow does not run them as a standalone required gate

## Wave 8 — S-ι hardening (target: 0.19.14+)

- [x] Coverage backfill — target 100% no-skip across all packages and `_internal/platform/*` subsystems (daemon-sdk/operator-sdk/peer-sdk/errors src coverage complete; companion/state scope remains with source-cleanup agent)
- [x] Flake detection CI gate (N-run stability check) — `scripts/flake-detect.ts` + `flake:check` (shipped in `487a84d`)
- [x] Public API surface snapshot via `@microsoft/api-extractor` or equivalent — `etc/goodvibes-sdk.api.md` baseline (shipped in `487a84d`)
- [x] Snapshot gate fails on unintended public surface changes — `api:check` CI gate (shipped in `487a84d`)
- [x] Internal TODO cleanup (companion): session persistence, rate-limiting, ToolRegistry DI for tool-call execution (3 TODOs in `packages/sdk/src/_internal/platform/companion/companion-chat-manager.ts` + 1 in `companion-chat-types.ts`)
- [x] Replace `@ts-ignore` suppressions with real `sql.js` type declarations (`packages/sdk/src/_internal/platform/state/sqlite-store.ts:82`, `state/db.ts:76`) — add minimal `.d.ts` shim for the API surface actually used
- [x] **New CI gate `no-todo-markers`**: fail the build if `\b(TODO|FIXME|XXX|HACK|STUB)\b` appears in any source file outside `_internal/**`, `**/vendor/**`, `**/generated/**`, and `**/*.test.ts`. Prevents TODO drift in public-surface code post-1.0.0. (shipped in `487a84d`)

## Wave 9 — Soak period (target: 0.21.0) — IN PROGRESS (started 2026-04-18)

- [x] Bump from `0.19.9` to `0.21.0` (skip `0.20.x`)
- [ ] Redefine/restart soak after 0.23.x WRFC constraint propagation, 0.24.0 SecretRef URI migration, and 0.25.x feature-flag/dependency-hardening releases
- [ ] Owner-defined soak duration

## Wave 10 — 1.0.0

- [ ] **Owner explicit sign-off** (required regardless of gate state)
- [ ] All gates above green on main
- [ ] Current CI dimensions passing: `bun`, `rn-bundle`, `workers`, `workers-wrangler`; decide whether to restore explicit `browser` and `hermes` real-runtime dimensions before 1.0
- [ ] Current CI jobs passing: `validate`, `build`, `mirror-drift`, `platform-matrix`, `lint-gates`, `types-check`, `types-resolution-check`, `publint-check`, `sbom-check`, and PR-only `sync-safety-check`
- [ ] Decide whether `bundle:check`, `api:check`, `flake:check`, `todo:check`, and examples smoke should be restored as required CI gates before 1.0
- [ ] npm publish as `1.0.0` with provenance and a release tag; signed tags are preferred via `bun run release:tag`

---

## Cross-cutting rules

- Each wave ships as its own CHANGELOG section + version bump (enforced by `changelog:check`)
- Mirror syncs always scoped: `bun run sync --scope=<subsystem>` — **never** unscoped
- Bundle guard extended per new runtime entry
- TUI downstream typecheck before pushing any SDK release
- CHANGELOG.md and package.json versions must be updated together and verified with `bun run changelog:check` and `bun run version:check`
- All tools default to precision_engine (native Read/Write/Edit/Grep/Glob/WebFetch are deprecated)

## Owner sign-off

**1.0.0 publish will not occur without explicit owner approval.** Green gates are necessary but not sufficient. This file is the shared reference for what "ready" means.
