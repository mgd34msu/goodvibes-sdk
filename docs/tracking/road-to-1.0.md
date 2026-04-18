# Road to 1.0.0

Published plan for shipping `@pellux/goodvibes-sdk@1.0.0`. Every item below is a gate — the 1.0.0 publish does not happen until all boxes are checked **and** the repo owner has explicitly signed off.

## Status

- **Current released version**: `0.19.8` (Waves 5–9 consolidated; published to npm, `latest` tag)
- **Current score**: 9.0 / 10
- **Eligibility**: NOT eligible for 1.0.0 — Waves 1–9 landed, soak period + owner sign-off still pending

## Version plan

```
0.19.8          current (Waves 1–9 landed)
  → 0.19.x            hotfixes / follow-ups (e.g. Wrangler parity rerun)
  → 0.21.0            soak period (skip 0.20.x to avoid "just another release" ambiguity)
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
- [x] New CI matrix dimension `browser` in `platform-matrix` job
- [x] `examples-smoke` CI gate added (prevents example rot)

## Wave 3 — Hermes real-runtime (target: 0.19.8, shipped in `488b615`+`8262775`)

- [x] `test/hermes/` harness using `hermes-engine` binary
- [x] Imports built `dist/react-native.js` via `./react-native` subpath
- [x] New CI matrix dimension `hermes`
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
- [x] Per-runtime-entry bundle-size budgets enforced in CI (post-Zod measurement)

## Wave 8 — S-ι hardening (target: 0.19.14+)

- [x] Coverage backfill — target 100% no-skip across all packages and `_internal/platform/*` subsystems (daemon-sdk/operator-sdk/peer-sdk/errors src coverage complete; companion/state scope remains with source-cleanup agent)
- [x] Flake detection CI gate (N-run stability check) — `scripts/flake-detect.ts` + `flake:check` (shipped in `487a84d`)
- [x] Public API surface snapshot via `@microsoft/api-extractor` or equivalent — `etc/goodvibes-sdk.api.md` baseline (shipped in `487a84d`)
- [x] Snapshot gate fails on unintended public surface changes — `api:check` CI gate (shipped in `487a84d`)
- [x] Internal TODO cleanup (companion): session persistence, rate-limiting, ToolRegistry DI for tool-call execution (3 TODOs in `packages/sdk/src/_internal/platform/companion/companion-chat-manager.ts` + 1 in `companion-chat-types.ts`)
- [x] Replace `@ts-ignore` suppressions with real `sql.js` type declarations (`packages/sdk/src/_internal/platform/state/sqlite-store.ts:82`, `state/db.ts:76`) — add minimal `.d.ts` shim for the API surface actually used
- [x] **New CI gate `no-todo-markers`**: fail the build if `\b(TODO|FIXME|XXX|HACK|STUB)\b` appears in any source file outside `_internal/**`, `**/vendor/**`, `**/generated/**`, and `**/*.test.ts`. Prevents TODO drift in public-surface code post-1.0.0. (shipped in `487a84d`)

## Wave 9 — Soak period (target: 0.21.0)

- [ ] Bump from `0.19.14` to `0.21.0` (skip `0.20.x`)
- [ ] No new features during soak — hotfixes only (→ 0.21.1, 0.21.2, …)
- [ ] Owner-defined soak duration

## Wave 10 — 1.0.0

- [ ] **Owner explicit sign-off** (required regardless of gate state)
- [ ] All gates above green on main
- [ ] All CI dimensions passing: `bun`, `rn-bundle`, `browser`, `hermes`, `workers`
- [ ] All new CI jobs passing: `are-the-types-wrong`, `publint`, `sbom-check`, `bundle-budget`, `api-surface-snapshot`, `flake-watch`, `examples-smoke`, `no-todo-markers`
- [ ] npm publish as `1.0.0` with `--provenance` and signed tag

---

## Cross-cutting rules

- Each wave ships as its own CHANGELOG section + version bump (enforced by `changelog:check`)
- Mirror syncs always scoped: `bun run sync --scope=<subsystem>` — **never** unscoped
- Bundle guard extended per new runtime entry
- TUI downstream typecheck before pushing any SDK release
- CHANGELOG.md and package.json versions are orchestrator-managed — agents do not touch them
- All tools default to precision_engine (native Read/Write/Edit/Grep/Glob/WebFetch are deprecated)

## Owner sign-off

**1.0.0 publish will not occur without explicit owner approval.** Green gates are necessary but not sufficient. This file is the shared reference for what "ready" means.

