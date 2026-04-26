# Roadmap-to-1.0 Status

**Plan**: [`docs/roadmap-to-1.0.md`](../roadmap-to-1.0.md)
**Current version**: 0.25.12
**Current score**: pending recalibration after 0.23.x-0.25.x feature and hardening releases (last recorded: 9.0 / 10 at 0.21.36)
**Last updated**: 2026-04-24 (0.25.x dependency-audit and ntfy hardening; 1.0 soak criteria need reset)

---

## Live status

| Wave | Name | Target | Status | Score effect | Shipped in | Notes |
|------|------|--------|--------|--------------|------------|-------|
| S-α | Stabilize the public surface | 0.19.0 | **shipped** | 7.0 → 7.5 | 0.19.0 `d5e2f04` | TUI F-arch-04 now unblocked |
| S-β | Error taxonomy enforcement | 0.19.3 | **shipped** | 8.5 → 9.0 | 0.19.3 `62a9756` | 7 throws converted; `throw-guard` CI gate catches all raw-throw variants. |
| S-γ | Mirror-drift guard | 0.19.0 | **shipped** | 8.0 → 8.3 | 0.19.0 `d5e2f04` (S-γ scripts from `2ed2853`) | Follow-up WRFC needed to run `bun run sync` for 8 tracked drifts before CI goes green on main. |
| S-δ | Per-release migration notes | 0.19.1 | **shipped** | 8.3 → 8.5 | 0.19.1 `d5b99e0` | Changelog gate live, CI job `changelog-check` armed. |
| S-ε | Multi-platform test matrix | 0.19.1 | **shipped (partial)** | 8.5 → 8.5 | 0.19.1 `d5b99e0` | 4 dimensions wired (Bun + bun-on-nodeN + RN). Real Node/Browser/Workers deferred to S-ε.2. Partial — score effect withheld until full delivery. |
| S-ε.2 | Platform matrix — real runtime checks | 0.19.8 | **needs-current-CI-review** | 8.5 → 8.8 | 0.19.8 `f86123b` (browser) / `8262775` (hermes) / `47d870a` (workers) / `001455d` + `f428e84` (wrangler harness) | Historical browser/Hermes/Workers harnesses landed, but current `.github/workflows/ci.yml` only runs `bun`, `rn-bundle`, `workers`, and `workers-wrangler` as platform-matrix dimensions. Browser compatibility is currently a static `validate` check; Hermes is not an explicit CI lane. |
| S-θ.2 | Observer seams — onEvent + onError + onTransportActivity | 0.19.8 | **shipped** | 9.0 → 9.2 | 0.19.8 `60a2a06` | All three callbacks wired at transport + SDKError sites; OTel adapter covered. |
| Wave 5 | Package hygiene + SBOM + provenance | 0.19.8 | **shipped** | no score effect (hygiene) | 0.19.8 `83009b5` | attw + publint + provenance + release-tag helper + SBOM (CycloneDX). Current release workflow validates tag/version sync but does not enforce tag signatures cryptographically. |
| Wave 6 | Policy & UX — error audit, timeout bounds, producer queue | 0.19.8 | **shipped** | no score effect (hygiene) | 0.19.8 `23c4292` | `docs/semver-policy.md` + `docs/defaults.md`; bounded realtime queue replaces unbounded. |
| Wave 7 | Verification — Zod validation + bundle budgets + Verdaccio | 0.19.8 | **partially-current** | no score effect (hygiene) | 0.19.8 `3fb64e2` + `9cd9558` | Zod v4 modular adopted at transport boundary; Verdaccio dry-run remains available. `bun run bundle:check` exists, but current CI does not run it as a standalone gate. |
| Wave 8 | Hardening — coverage backfill, flake, API extractor, no-todo | 0.19.8 | **shipped** | 9.2 → 9.5 | 0.19.8 `552f8d4` + `487a84d` + `25fe936` | 195-test coverage backfill; flake-detect, api-extractor baseline (`etc/goodvibes-sdk.api.md`), no-todo-markers CI; companion TODOs + sql.js shim cleaned. |
| Wave 9 (features) | SDK enhancements — auto-refresh + middleware + idempotency + traceparent + platform stores | 0.19.8 | **shipped** | no score effect (features) | 0.19.8 `4965939` (+ `b3e2984` test fix) | Auth auto-refresh middleware, idempotency keys, W3C traceparent, iOS Keychain / Android Keystore / Expo SecureStore token stores. Distinct from the "Wave 9 soak period" tracked in `road-to-1.0.md`. |
| S-γ-cleanup | Transport-http drift cleanup (narrow) | 0.19.2 | **shipped** | no score effect (infra) | 0.19.2 `c7c561e` | `--scope=<subsystem>` flag added; 8 transport-http drifts resolved; `mirror-drift` CI can now pass on main. |
| S-ζ | Integration + property tests | 0.19.4 | **shipped** | 8.8 → 9.2 | 0.19.4 | End-to-end auth, SSE/WS chaos, property-based discriminant tests |
| S-θ | Observability hooks | 0.19.5 | **shipped (partial)** | 9.2 → 9.5 | 0.19.5 | SDKObserver interface + onEvent/onError adapters; OTel adapter deferred |
| honest-runtime-posture | Honest runtime posture | 0.19.6 | **shipped** | no score effect (hygiene) | 0.19.6 | Stripped theater CI labels; runtime reporting now accurately reflects actual execution |
| Wave M | Metadata / polish | 0.19.6 | **shipped** | no score effect (docs) | 0.19.6 | CONTRIBUTING.md CI gates, roadmap-status refresh, stale docs cleanup |
| Wave D | Dependency audit + hardening | 0.25.1 | **shipped** | — | 0.25.1 | Root/package overrides now force fixed `ajv`, `fast-xml-parser`, `google-auth-library`, `lodash`, and `minimatch`; Bash LSP remains bundled through `vendor/bash-language-server`, patched to use `editorconfig@3.0.2`; the Vertex SDK transitive path was replaced; Verdaccio's `uuid@8` dry-run path is redirected to `vendor/uuid-cjs`. |
| Wave 9 (soak) | Soak period | 0.21.0–0.25.12+ | **reset-needed** | — | 0.25.12 | Started 2026-04-18, but feature-bearing 0.23.x, 0.24.0, and 0.25.x releases landed after that. Owner sign-off pending and soak criteria need a fresh definition before 1.0.0. |
| S-ι | Hardening gates | 0.19.8 / 0.20.x | **shipped (partial)** | 9.5 → 10.0 | 0.19.8 (Waves 5–8) | Waves 5–8 landed (hygiene, policy, verification, API-extractor/flake/no-todo). Remaining S-ι scope from `docs/roadmap-to-1.0.md`: mutation testing ≥85% kill rate, branch-coverage ≥95% on error paths, JSDoc `@throws` contract lint, public-surface file-size cap, `no-any-leak` lint. Score-effect withheld until full S-ι lands. |
| 1.0.0 cut | Owner approval gate | 1.0.0 | **blocked on owner approval** | — | — | **Requires explicit owner approval. Not automatic.** |

Status values: `not-started` · `in-progress` · `in-review` · `shipped` · `blocked` · `deferred`.

> **Score-effect reading**: each `Score effect` column shows the delta **attributed to that wave at the time of its review**, measured against the score baseline that wave's scope targets. Rows do not chain monotonically — multiple waves can share a starting baseline, partial deliveries can withhold effect (e.g. S-ε partial shows `8.5 → 8.5`), and independent waves may overlap. The `Current score` header is the current cumulative rating, which the deltas feed into but do not arithmetically sum to.

---

## Decision log

### 2026-04-17 — Roadmap accepted

Owner reviewed the 8-wave plan and accepted it with one modification: **1.0.0 requires explicit owner approval in addition to the hardening gates being green**. S-ι green is necessary but not sufficient; the cut itself is a human decision, not an automatic promotion.

Owner stated that post-1.0 major bumps will be "a little more loose" than strict semver would suggest. Breaking changes still require a major bump and a migration note.

### 2026-04-17 — S-α + S-γ selected as first parallel sprint

Smallest combination that moves the score needle (7.0 → 8.3 when both land) and unblocks the TUI's F-arch-04. Launched same-day.

### 2026-04-17 — S-γ landed (unreleased), 10.0/10

Initial review 8.8/10 (three Minors + a banned-phrasing violation introduced by the S-γ engineer), fix pass 10.0/10. Landed under commit `2ed2853` without a version bump. Key decision: held release until S-α also lands, both ship together as 0.19.0.

Reviewer recommendation: spawn a follow-up WRFC **after** 0.19.0 cut to run `bun run sync` and commit the 8 regenerated mirror files (7 legacy-banner + `sse-stream.ts` content drift). Until that follow-up lands, the `mirror-drift` CI job will red-X every PR — the drift-cleanup is the gating task before CI goes green on main.

### 2026-04-17 — S-α landed, 0.19.0 released, score 7.0 → 8.3

Initial review 9.4/10 (circular `_internal` self-imports through the public `platform/*` barrier, planning-ID in a TODO, and a banned-phrasing violation introduced by the S-α engineer). Fix pass 10.0/10 after rewriting 1,496 self-imports across 358 `_internal/**` files to relative `.js`-suffixed paths and cleaning the TODO.

**Important recovery**: the fix engineer's `git checkout` revert of a first-pass bad import rewrite accidentally wiped the `packages/sdk/package.json` exports-map change. The orchestrator caught this pre-commit and re-applied the change manually before cutting 0.19.0; otherwise the whole S-α intent (close the `_internal` leak) would have shipped as a no-op. Lesson for future waves: engineers who revert working trees must re-verify the full S-α invariant in their completion report, not just their specific section.

Bundled S-γ into the same 0.19.0 cut (S-γ's 3 scripts were already committed at `2ed2853`; the release is `d5e2f04`). TUI's F-arch-04 is now unblocked; the mirror-drift CI job is armed and will fail on main until the drift-cleanup follow-up WRFC runs `bun run sync`.

### 2026-04-17 — S-δ + S-ε shipped (partial), 0.19.1 released, score 8.3 → 8.5

Bundled two infra waves into `d5b99e0`.

**S-δ** — shipped clean at 10.0 on first review. Changelog gate live: `bun run changelog:check` + inline check in `publish-packages.ts` + CI `changelog-check` job. Future releases cannot publish without a matching `## [X.Y.Z]` section in `CHANGELOG.md`. This ends the "SDK bump → surprise consumer test burn" pattern that ate ~17 TUI tests after 0.18.50.

**S-ε** — reviewed at 9.0 with a Major on "Node dimensions are theater" (engineer used `bun test` in all 4 dimensions; `node-20` / `node-22` names implied Node-as-runtime but tests ran under Bun with Node merely installed on PATH). Orchestrator applied the reviewer's recommended "relabel path" pre-commit: renamed dimensions to `bun-on-node20` / `bun-on-node22`, consolidated redundant scripts. Shipped at 10.0 on the relabeled (honest) scope — which is a PARTIAL delivery of the original S-ε goal. Real Node/Browser/Workers deferred to S-ε.2. **Score effect withheld** until full multi-platform delivery lands.

**Drift cleanup (planned for 0.19.1)** — deferred. The initial attempt ran `bun run sync` which regenerates all `_internal` subsystem mirrors (daemon, transport-core, transport-direct, transport-realtime, operator, peer), not just transport-http. The broader sync surfaced latent type mismatches in non-transport-http canonicals vs their barrel consumers, breaking `bun run build`. Orchestrator reverted all drift-cleanup changes pre-commit. A narrower follow-up WRFC must scope `sync` to transport-http only before the `mirror-drift` CI job can pass on main.

**Cross-chain mishap**: an engineer ran `git checkout -- packages/sdk/src/` during verification cleanup, which wiped another in-flight chain's uncommitted work. This kept happening tonight. Standing rule reinforced in WRFC prompts: **engineers must never `git checkout` or `git stash` to clean up during verification**; if the tree is polluted, stop and escalate.

**Persistent banned-phrasing violations**: four separate engineers attributed bugs to inherited state rather than their own code tonight across different waves. The standing rule is in memory, but enforcement has to continue at the reviewer layer.

### 2026-04-17 — S-β shipped, 0.19.3 released, score 8.5 → 9.0

7 raw throws on the canonical public surface converted to typed `GoodVibesSdkError`. Added `throw-guard` CI job + `docs/error-kinds.md` + `docs/error-handling.md` consumer pattern.

**Initial review 7.5/10 — major defect caught**: the `throw-guard` job's ripgrep glob pattern `*/src/**` matched zero files under `packages/` (ripgrep treats single-star prefix literally). The guard was a silent no-op that would never fail CI — any raw throw could have been reintroduced unnoticed. Fix pass (10.0/10): corrected to `**/src/**` across 6 glob occurrences, extended patterns to cover all 5 raw-throw variants (`throw new Error(`, `throw Error(`, `throw {`, `throw '`, `throw "`). Reviewer independently smoke-tested: planted throws in public source caught, planted throws in `_internal/` correctly excluded.

This is the only wave tonight where the reviewer caught a defect that would have shipped as a zero-coverage regression gate. Good illustration of why the 10.0 bar matters more than the engineer's self-reported pass.

### 2026-04-17 — S-β shipped, S-β decision

Shipped at 0.19.3. Enforced typed `GoodVibesSdkError` on all canonical public surface throws. The `throw-guard` CI job's initial ripgrep glob was a silent no-op (single-star prefix matched zero files under `packages/`); reviewer caught this and the fix pass corrected all 6 glob occurrences to `**/src/**` and extended coverage to all 5 raw-throw variants.

### 2026-04-17 — S-γ-cleanup shipped, 0.19.2 released

Narrow-scope sync landed clean at 10.0 on first review. `--scope=<subsystem>` flag on `scripts/sync-sdk-internals.ts` fixes the prior global-stale-walk bug and makes future per-subsystem drift cleanups trivial. The 8 tracked transport-http drifts are resolved; `mirror-drift` CI job can now pass on main.

No score effect (infra/hygiene), but this unblocks forward development — previously every PR would red-X the mirror-drift gate.

### 2026-04-17 — S-ζ shipped, 0.19.4 released

Integration + property tests landed. End-to-end auth fixture, SSE/WS chaos harness, and fast-check property tests on `AnyRuntimeEvent` discriminants all green. `createGoodVibesAuthClient` decomposition integration test confirmed composability matches monolithic facade behavior.

### 2026-04-17 — S-θ shipped (partial), 0.19.5 released

`SDKObserver` interface shipped with `onEvent`, `onError`, and `onTransportActivity` hooks accepted as constructor options on all top-level clients. Console dev adapter included. OpenTelemetry adapter deferred to S-θ.2 — score effect withheld until full OTel delivery lands.

### 2026-04-17 — Waves 1–9 shipped, 0.19.8 released

Consolidated Waves 5–9 into the 0.19.8 cut. Ten engineer-stream commits landed between `60a2a06` (Wave 1 S-θ.2) and `4965939` (Wave 9 features), plus `b3e2984` (traceparent test-isolation fix) and `ff68ad5` (release.yml dynamic-needs fix).

- **Wave 1 (S-θ.2)** `60a2a06` — `onEvent` / `onError` / `onTransportActivity` wired through `transport-realtime`, `transport-http`, auth; observer calls wrapped in `invokeObserver` so consumer-thrown exceptions don't poison SDK state.
- **Wave 2 (browser)** `f86123b` — `@vitest/browser` + Playwright harness against MSW mock; `dist/browser.js` exercised via `./browser` subpath; CI matrix dimension added.
- **Wave 3 (hermes)** `488b615` + `8262775` — `hermes-engine` harness + CI matrix dimension.
- **Wave 4 (workers, perfection fix)** `47d870a` — M-1 + m-1..m-6 + n-1..n-3 defects closed on the Miniflare harness. Wrangler-CLI harness subsequently landed in `001455d` + `f428e84` (9 tests, dedicated CI lane) to exercise wrangler's esbuild/`wrangler.toml` pipeline. Production-workerd parity remains an open MIN (would require live Cloudflare deploy) because `wrangler dev --local` shares Miniflare 4's runtime layer.
- **Wave 5 (hygiene + SBOM + provenance)** `83009b5` — attw + publint CI gates, OIDC `npm publish --provenance`, release-tag helper, SECURITY.md, CycloneDX SBOM generation.
- **Wave 6 (policy & UX)** `23c4292` — `docs/semver-policy.md`, `docs/defaults.md`, error-message audit across `SDKError` throw sites, timeout/retry/backoff defaults audit, bounded producer queue in `transport-realtime/runtime-events.ts` (replaces unbounded prod-hang risk).
- **Wave 7 (verification)** `3fb64e2` (bundle budgets + Verdaccio dry-run) + `9cd9558` (Zod v4 modular runtime validation at transport boundary; validation failures throw `SDKError{kind:'contract'}` with field-level detail).
- **Wave 8 (S-ι hardening)** `552f8d4` (195-test coverage backfill) + `487a84d` (flake-detect + api-extractor + no-todo-markers CI gates; `etc/goodvibes-sdk.api.md` 14805-line public-API baseline) + `25fe936` (companion TODOs cleaned: session persistence, rate-limiting, ToolRegistry DI; sql.js shim replaces `@ts-ignore`).
- **Wave 9 (SDK enhancements)** `4965939` — auto-refresh middleware, idempotency keys, W3C traceparent propagation, iOS Keychain / Android Keystore / Expo SecureStore token stores. Feature scope (not in the `road-to-1.0.md` wave plan, which uses "Wave 9" for the soak period).

**Open follow-ups**:
- Real Wrangler rerun of the workers harness (Miniflare is a simulation, not real Workers runtime).
- Full S-ι scope from `docs/roadmap-to-1.0.md` beyond what Wave 8 delivered: mutation testing ≥85% kill rate, ≥95% branch coverage on error paths, JSDoc `@throws` contract lint, public-surface file-size cap, `no-any-leak` lint rule.
- Wave 9 (soak period) and Wave 10 (1.0.0 owner sign-off) per `road-to-1.0.md`.

### 2026-04-17 — honest-runtime-posture + Wave M shipped, 0.19.6 released

honest-runtime-posture: stripped theater CI dimension labels introduced in S-ε partial delivery; runtime reporting now accurately reflects actual execution context rather than implying Node-as-runtime when Bun is the runner. Wave M: `CONTRIBUTING.md` updated with Bun requirement and 0.19.x CI gate inventory; stale `SDK-TUI-MIGRATION-CHANGELOG.md` scratchpad removed; roadmap header fields refreshed to current version (0.19.6) and score (9.0).

---

## Per-wave notes

### S-α — Stabilize the public surface

- Scope: enumerate TUI's 36 `_internal/**` and `platform/**` imports, design the stable top-level barrel structure, restructure `exports` map, write `docs/public-surface.md`, add downstream smoke-test CI gate.
- Open questions: do we keep `/platform/*` as a documented advanced surface or collapse into dedicated subsystem barrels? Lean toward dedicated barrels per subsystem — `/platform/*` as a catch-all is part of what caused the leak.

### S-γ — Mirror-drift guard

- Scope: byte-parity comparison script for `packages/transport-http/src/**` vs `packages/sdk/src/_internal/transport-http/**`. Known-allowed diff: header comment + import path rewrites. CI gate + opt-in pre-commit hook.
- Open questions: should the sync script auto-regenerate the mirror on every `transport-http` commit via a hook, or stay manual with CI as the guard? Lean toward manual with CI guard — automatic regeneration hides the intent of the mirror.

---

## How to update this file

On every SDK release:

1. Update the status table row for any wave whose state changed.
2. Add a line to the decision log for any material judgement call (wave scope change, dependency discovery, approach change).
3. Update per-wave notes with learnings that would help the next wave.
4. Update the `Current version` and `Current score` header fields.

On 1.0.0 cut:

1. Update S-ι and 1.0.0 cut rows to `shipped` with the version number.
2. Add a decision log entry capturing the owner's approval (who, when, any conditions).
3. Link to the 1.0.0 release notes.
4. Freeze this document — post-1.0 tracking moves to a separate roadmap.
