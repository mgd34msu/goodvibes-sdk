# Roadmap to 1.0

**Status**: Active. Last updated 2026-04-17.
**Current version**: 0.19.8.
**Current score**: 9.0 / 10.
**Target for 1.0.0 cut**: 10.0 / 10, plus explicit approval from the project owner.

---

## Non-negotiables

- **10/10 is a code-level bar, not a calendar bar.** Every step to 10 is enforced in CI, not earned by time-at-stability.
- **No major-version bump until 10/10 is reached AND the project owner has explicitly approved the 1.0.0 cut.** Hitting the gates is necessary but not sufficient. The cut itself requires a direct human decision.
- Until 1.0.0, breaking changes continue to ship as minor/patch per existing pre-1.0 policy.
- Post-1.0.0, major bumps become more liberal by explicit owner preference — but they still require a major bump and a migration note.

---

## Gap analysis (7.0 → 10.0)

What a 10/10 SDK means: consumers never reach into internals, every thrown error has a typed kind, every release ships with migration notes, every platform is tested in CI, breaking changes are visible in API snapshot diffs, mutation tests prove the test suite actually exercises logic, and the public surface carries machine-checkable documentation contracts.

The SDK has the bones today. It does not have the enforcement.

---

## Wave plan

### Wave S-α — Stabilize the public surface ✓ shipped 0.19.0
**Target release**: 0.19.0 · **Effort**: ~3 days · **Score effect**: 7.0 → 7.5

Prerequisite for TUI's F-arch-04 adapter layer and for every downstream wave. The hardest one to get right.

- Enumerate every import of `@pellux/goodvibes-sdk/_internal/**` or `@pellux/goodvibes-sdk/platform/**` from consumer packages (TUI's 36 files is the canonical consumer list).
- For each, promote to a stable top-level entry point. One barrel per subsystem: `/runtime-events`, `/config`, `/auth`, `/permissions`, `/providers`, `/tools`, `/sessions`, `/memory`, `/plugins`, `/control-plane`.
- Add `exports` map in `package.json` that **only** exports stable subpaths. `_internal` becomes unreachable via the package name — consumer builds break loudly if they reach in.
- Add a CI gate that fails the build if any consumer imports a non-exported path (runs against the TUI's source as a downstream smoke test).
- Write `docs/public-surface.md`: one entry per exported subpath with its stability contract (stable / beta / preview).

### Wave S-β — Error taxonomy enforcement ✓ shipped 0.19.3
**Target release**: 0.19.1 · **Effort**: ~2 days · **Score effect**: 7.5 → 8.0 · **Depends on**: S-α

- Grep every `throw new Error(` in `packages/*/src/**` (excluding tests and internal helpers that throw+catch locally).
- Classify each site: wrap in the right `SDKErrorKind` (e.g. `'transport.network'`, `'auth.invalid_session'`, `'config.missing_required'`, `'runtime.invariant'`) or annotate with `// internal: throw-catch pair at <location>`.
- Add an AST-grep CI rule: `throw new Error(...)` in any file under a `public/` directory (or matching the exports map) fails the build.
- Document every `SDKErrorKind` value in `docs/error-kinds.md`: when it fires, what remediation consumers should attempt, whether it's retryable.

### Wave S-γ — Mirror-drift guard ✓ shipped 0.19.0 (+ S-γ-cleanup 0.19.2)
**Target release**: 0.19.1 · **Effort**: ~1 day · **Score effect**: 8.0 → 8.3 · **Parallel with S-β**

Closes the bug class where canonical transport-http diverged from the sdk/_internal mirror on one SSE call.

- CI job: compare `packages/transport-http/src/**` byte-for-byte against `packages/sdk/src/_internal/transport-http/**`, with a known-allowed diff list (header comment + import path rewrites). Any other divergence fails the build.
- Migrate the existing sync script to be idempotent and verifiable — a `sync:check` command that exits non-zero if a mirror is stale.
- Add a pre-commit hook (opt-in) that runs `sync:check` on staged transport-http files.

### Wave S-δ — Per-release migration notes ✓ shipped 0.19.1
**Target release**: 0.19.2 · **Effort**: ~1 day · **Score effect**: 8.3 → 8.5 · **Parallel with S-γ**

Ends the "SDK bump → surprise TUI test burn" pattern.

- `CHANGELOG.md` section per release, required by the publish script. Format: `### Breaking`, `### Added`, `### Fixed`, `### Migration`.
- Publish script refuses to release if the version bump doesn't have a matching changelog section.
- Auto-generate the skeleton from conventional commits between tags where feasible. Manual edits still allowed.
- Each breaking change gets a copy-pasteable before/after snippet.

### Wave S-ε — Multi-platform test matrix ✓ shipped partial 0.19.1, expanded 0.19.8 (S-ε.2 Browser + Hermes + Workers landed; real Node + Wrangler still pending)
**Target release**: 0.19.3 · **Effort**: ~2 days · **Score effect**: 8.5 → 8.8 · **Parallel after S-α**

The existing RN CI gate is a one-off. Extend to full platform parity.

- CI jobs per platform against the same test suite: Node 20, Node 22, Bun, React Native (metro bundle + runtime harness), browser (Vitest browser mode), Cloudflare Workers edge runtime.
- Transport-http + auth + runtime-events get explicit per-platform expectations tests.
- RN bundle check extends to also verify that typed events serialize/deserialize identically across platforms.

### Wave S-ζ — Integration + property tests ✓ shipped 0.19.4
**Target release**: 0.19.4 · **Effort**: ~3 days · **Score effect**: 8.8 → 9.2 · **Depends on**: S-α + S-β

The tests that would have caught tonight's TUI regressions at the SDK level.

- End-to-end auth flow fixture: boot a fake HTTP server, walk login → cookie → authenticated call → revoke → 401 fallback. Run it against every auth mode.
- SSE / WebSocket chaos tests: inject network failures at realistic boundaries, verify backoff + reconnect respect policy. Shared harness so both transports get the same chaos.
- Property-based tests (fast-check or similar) on `AnyRuntimeEvent` discriminants: every event kind round-trips through JSON serialization without type loss.
- Integration test for `createGoodVibesAuthClient` decomposition: `TokenStore` + `SessionManager` + `PermissionResolver` compose to exactly the same observable behavior as the monolithic legacy facade.

### Wave S-θ — Observability hooks ✓ shipped partial 0.19.5, completed 0.19.8 (S-θ.2 `60a2a06` — onEvent + onError + onTransportActivity + OTel end-to-end)
**Target release**: 0.19.5 · **Effort**: ~2 days · **Score effect**: 9.2 → 9.5 · **Parallel after S-α**

Without this, consumers have to monkey-patch to get telemetry. With it, they plug in.

- `SDKObserver` interface with `onEvent`, `onError`, `onTransportActivity`, `onAuthTransition`. Optional; default is no-op.
- Accepted as a constructor option on every top-level client.
- Built-in observer adapters for OpenTelemetry and Console (for dev).
- Documented as the canonical way to wire SDK internals to external telemetry — no more reaching into `_internal` to hook things.

### Wave S-ι — Hardening gates (the last mile) ✓ shipped partial 0.19.8 (Waves 5–8 landed: hygiene, policy, Zod validation, API-extractor/flake/no-todo gates)
**Target release**: 0.20.x · **Effort**: weeks of grind across the public surface · **Score effect**: 9.5 → 10.0 · **Depends on**: S-α through S-θ

**Landed in 0.19.8**: API surface snapshot via `@microsoft/api-extractor` (`etc/goodvibes-sdk.api.md` baseline + `api:check` CI gate); `no-todo-markers` CI gate; flake-detection CI gate; public-surface file-size discipline via coverage backfill. Still pending:

Each gate is enforced in CI; failing any blocks the release.

- **API surface snapshot diff**. Dump every exported type, function signature, and enum value into a committed `.api.md` file per package. CI regenerates on every build and diffs against the committed copy. Any drift requires an explicit commit that bumps the snapshot — author must consciously acknowledge the public-API change.
- **Mutation testing threshold**. Stryker or similar, scoped to `packages/*/src/**` excluding internals-only files. Gate at ≥85% mutant kill rate.
- **Branch coverage on error paths**. Separate gate from line coverage: ≥95% branch coverage, specifically including every `throw` / reject / early-return.
- **JSDoc contract on every public export**. Lint rule requiring `@throws` with the specific `SDKErrorKind` for every throwable public function, `@param` with preconditions, `@returns` with the exact shape. API reference docs build from this.
- **Zero `TODO` / `FIXME` / `HACK` / `XXX` in published source.** Allowed in tests and internals-only files; banned in anything reachable via the exports map.
- **File size cap on public surface files**. Soft cap 400 lines, hard cap 600, with a documented exception list committed to the repo.
- **No `any` / `unknown` leaking to public signatures**. Lint rule: public exports cannot have `any` in their type position; `unknown` requires a `@param` note explaining why narrowing is the caller's responsibility.

### Gate to 1.0.0 — requires explicit owner approval
**Target release**: 1.0.0 · **Prereq**: S-ι complete, all hardening gates green, **plus explicit human approval from the project owner**.

This is not an automatic promotion. When S-ι lands green, the release is tagged `0.20.x-rc` (or similar) and held. The 1.0.0 cut happens only after the owner reviews and says yes.

The cut itself announces:

- Public surface is frozen under semver from this moment.
- Breaking changes require major bump. Post-1.0 policy per owner preference: majors can be more liberal than strict-semver would suggest, but every major still requires a migration note.
- `.api.md` snapshots become load-bearing: under semver, they determine whether a change is major / minor / patch automatically.

---

## Dependency graph

```
S-α (public surface) ──▶ S-β (error enforcement) ─┐
                  │                                │
                  ├──▶ S-γ (mirror guard)          │
                  │                                │
                  ├──▶ S-δ (migration notes)       ├──▶ S-ι (hardening) ──▶ [HOLD] ──▶ 1.0.0
                  │                                │                                  ▲
                  └──▶ S-ζ (integration tests) ────┤                                  │
                                                   │                         owner approval required
S-ε (platform matrix) ─────────────────────────┤
S-θ (observability) ─────────────────────────┘
```

**Parallel-safe groupings for max throughput:**

- First sprint: {S-α} solo.
- Second sprint: {S-β, S-γ, S-δ, S-ε, S-θ} in parallel after S-α.
- Third sprint: {S-ζ} after S-α and S-β.
- Fourth: S-ι grind, can overlap with other product work.

---

## Coordination with the TUI

- **S-α blocks TUI F-arch-04.** Don't start the TUI adapter until S-α's stable entry points are frozen — otherwise the adapter re-exports `_internal` paths and undoes the work.
- **S-β unblocks TUI F-errors-01.** TUI can start adopting typed error kinds the same week S-β ships.
- **S-γ eliminates a class of hot-patch that has already cost real wall-clock time.** Highest leverage for orchestrator productivity.
- **S-δ ends the "SDK bump → surprise TUI test burn" pattern.** Quality of life for every TUI release after it.
- **TUI's own 10/10 ceiling is bounded by the SDK's.** Consumers cannot truthfully claim 10/10 on a pre-1.0 dependency. When the SDK cuts 1.0.0 (after owner approval), the TUI's ceiling unlocks.

---

## What ships first

Smallest ship that moves the needle: **S-α + S-γ in parallel**. S-α unblocks TUI decoupling. S-γ is pure infrastructure with zero consumer impact but eliminates a bug class. Those two land the SDK at 8.3 inside one release cycle.

---

## Ongoing commitments during this roadmap

- Pre-1.0 breaking changes continue to ship as minor/patch. The S-δ CHANGELOG gate retrofits migration notes for every such change from 0.19.0 onward.
- Mirror byte-parity rules stay enforced manually until S-γ automates them.
- No hot-patches skip the CHANGELOG gate once S-δ is live.
- This document is the single source of truth for the 1.0 roadmap. Status lives in `docs/tracking/roadmap-status.md`.
