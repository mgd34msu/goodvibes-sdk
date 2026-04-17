# Roadmap-to-1.0 Status

**Plan**: [`docs/roadmap-to-1.0.md`](../roadmap-to-1.0.md)
**Current version**: 0.18.51
**Current score**: 7.0 / 10
**Last updated**: 2026-04-17

---

## Live status

| Wave | Name | Target | Status | Score effect | Shipped in | Notes |
|------|------|--------|--------|--------------|------------|-------|
| S-α | Stabilize the public surface | 0.19.0 | **in-progress** | 7.0 → 7.5 | — | TUI F-arch-04 blocker |
| S-β | Error taxonomy enforcement | 0.19.1 | not-started | 7.5 → 8.0 | — | Depends on S-α |
| S-γ | Mirror-drift guard | 0.19.0 | **shipped (unreleased)** | 8.0 → 8.3 | commit `2ed2853` | Held for 0.19.0 cut alongside S-α. Follow-up WRFC needed to run `bun run sync` for the 8 tracked drifts. |
| S-δ | Per-release migration notes | 0.19.2 | not-started | 8.3 → 8.5 | — | Parallel with S-γ |
| S-ε | Multi-platform test matrix | 0.19.3 | not-started | 8.5 → 8.8 | — | Parallel after S-α |
| S-ζ | Integration + property tests | 0.19.4 | not-started | 8.8 → 9.2 | — | Depends on S-α + S-β |
| S-θ | Observability hooks | 0.19.5 | not-started | 9.2 → 9.5 | — | Parallel after S-α |
| S-ι | Hardening gates | 0.20.x | not-started | 9.5 → 10.0 | — | Depends on S-α..S-θ |
| 1.0.0 cut | Owner approval gate | 1.0.0 | **blocked on owner approval** | — | — | **Requires explicit owner approval. Not automatic.** |

Status values: `not-started` · `in-progress` · `in-review` · `shipped` · `blocked` · `deferred`.

---

## Decision log

### 2026-04-17 — Roadmap accepted

Owner reviewed the 8-wave plan and accepted it with one modification: **1.0.0 requires explicit owner approval in addition to the hardening gates being green**. S-ι green is necessary but not sufficient; the cut itself is a human decision, not an automatic promotion.

Owner stated that post-1.0 major bumps will be "a little more loose" than strict semver would suggest. Breaking changes still require a major bump and a migration note.

### 2026-04-17 — S-α + S-γ selected as first parallel sprint

Smallest combination that moves the score needle (7.0 → 8.3 when both land) and unblocks the TUI's F-arch-04. Launched same-day.

### 2026-04-17 — S-γ landed (unreleased), 10.0/10

Initial review 8.8/10 (three Minors + a "pre-existing" phrasing violation), fix pass 10.0/10. Landed under commit `2ed2853` without a version bump. Key decision: held release until S-α also lands, both ship together as 0.19.0.

Reviewer recommendation: spawn a follow-up WRFC **after** 0.19.0 cut to run `bun run sync` and commit the 8 regenerated mirror files (7 legacy-banner + `sse-stream.ts` content drift). Until that follow-up lands, the `mirror-drift` CI job will red-X every PR — the drift-cleanup is the gating task before CI goes green on main.

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
