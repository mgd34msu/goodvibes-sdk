# Decision: Extract the presentation contract (tones, glyphs, thinking phrases, waiting wording) into the SDK (One-Platform Wave 4, S1)

Status: accepted — 2026-07-05
Scope: goodvibes-sdk (`packages/sdk`) — new public subpath `@pellux/goodvibes-sdk/platform/presentation`
Wave: One-Platform Wave 4 — THE PRESENTATION CONTRACT (S1)

## Decision

ONE pure SDK presentation module — `platform/presentation` — holds the four genuinely
cross-repo-duplicated presentation tables the W4-R1 renderer/input parity audit named,
plus a typed waiting-wording function extracted from the TUI's honest waiting-state
split. It is data and pure functions only: no fs, no terminal I/O, no process globals.
Painting (color composition, spinner frames, gradient interpolation, layout) stays
renderer-owned in both `goodvibes-tui` and `goodvibes-agent`.

Hoisted, with the TUI's CURRENT source as the reference for every value:

1. **`THINKING_PHRASES`** (`thinking-phrases.ts`) — the 20-phrase rotation pool.
   Verbatim-identical in both repos today (TUI `ui-factory.ts:489-510` vs agent
   `ui-factory.ts:281-302`) — a pure move, no reconciliation.
2. **`GLYPHS` / `STATE_GLYPHS`** (`glyphs.ts`) — the glyph registry (frame/surface/
   navigation/status/meter groups) plus the 4-state semantic alias map. The status
   group DIVERGED between repos (TUI `ui-primitives.ts:1-58` vs agent `:1-57`): the
   TUI has `idle='◌'(U+25CC)`, `info='○'(U+25CB)`, `warn='⚠'`; the agent has
   `idle='○'(U+25CB)`, `info='•'(U+2022)`, and no `warn` key at all. **The contract
   picks the TUI's values.** `STATE_GLYPHS` is aliased to `GLYPHS.status` (the TUI's
   mechanism); the agent's twin hardcoded its own literals instead of aliasing a
   shared registry — hoisting the alias pattern here makes drift structurally
   impossible going forward.
3. **`TONE_TOKENS` / `resolveTones` / `DIFF_TONES` / `SPINNER_FRAMES`** (`tones.ts`) —
   mirrors the TUI's `UI_TONES` shape byte-for-byte (`ui-primitives.ts:65-138` +
   chrome group `:124-137`, plus `DIFF_TONES:149-157` and `SPINNER_FRAMES:160`),
   including the chrome group the agent's copy was missing entirely (agent
   `ui-primitives.ts:59-94` — a stale subset with no chrome group, no reasoning/
   empty/footer/border/brand/gradient roles, no `DIFF_TONES`, no `SPINNER_FRAMES`).
   `resolveTones(mode)` composes the `ThemeMode` dimension (TUI `theme.ts:157/203/
   233-241` — `resolveUiTones`/`activeUiTones`/`UI_TONES_LIGHT`): `resolveTones('dark')`
   returns `TONE_TOKENS` itself (same object reference — byte-identical, zero-cost),
   `resolveTones('light')` returns the inverted chrome/accent variant tuned for a
   light terminal background.
4. **`waitingPhrase` / `WaitingState`** (`waiting-wording.ts`) — a typed, pure
   state→wording function extracted from TUI `ui-factory.ts:554-584` (the
   phrase-selection branch inside `createThinkingFragment`). `WaitingState` is
   `'approval' | 'reconnecting' | 'pre-first-token' | 'stalled' | 'thinking'`, in the
   TUI's precedence order. This makes the split a DATA/pure-function contract both
   renderers call, not two divergent copies — the agent's twin (`ui-factory.ts:308-313`)
   was rotating-only, with no honest stall/reconnect/approval split at all.

Chosen per Mike's SDK-boundary ruling (plan 2026-07-04:345-352, Wave 4 = the
presentation contract) and the move-to-SDK authority: machinery needed by 2+ surfaces
belongs in the SDK. The drift was already visible before this hoist (GLYPHS idle/info
diverged; the agent's UI_TONES was a stale subset missing the whole chrome group) —
exactly the failure mode the SDK boundary exists to prevent.

## What shipped (SDK side; consumer cutovers are later waves)

- **New subpath `@pellux/goodvibes-sdk/platform/presentation`** (added to
  `packages/sdk/package.json` exports, alphabetically between `platform/plugins` and
  `platform/profiles`). Source under `packages/sdk/src/platform/presentation/`:
  `glyphs.ts`, `tones.ts`, `thinking-phrases.ts`, `waiting-wording.ts`, `index.ts`
  (public re-exports). No entry was added to `platform/node/capabilities.ts` — that
  file only lists a curated subset of subpaths (the session-spine subpath, the most
  recent comparable extraction, isn't listed there either); `check:metadata`'s
  capabilities-coverage check only requires that entries WHICH EXIST there have a
  matching export, not that every subpath appears.
- **`resolveTones(mode)`** — `'dark'` returns the exact `TONE_TOKENS` object
  (reference-identical); `'light'` returns a derived variant that only overrides the
  roles with a light-appropriate value today (`state.info`/`state.reasoning`,
  `accent.brand`/`gradientStart`/`gradientEnd`, and the full `chrome` group) — every
  other role carries the dark value forward unchanged, matching the TUI's
  `UI_TONES_LIGHT` exactly, including which roles it deliberately leaves untouched.
- **`waitingPhrase(state, ctx)`** — pure, five-branch, returns the TUI's exact
  strings: `'Waiting for your approval'`, `` `Reconnecting (attempt ${n}/${m})...` ``,
  `` `Waiting for model ${n}s...` ``, `` `Stalled ${n}s...` ``, and a
  `THINKING_PHRASES`-rotation string for `'thinking'` (same `PHRASE_ROTATION_FRAMES=375`
  cadence as the TUI, so frame-for-frame rotation output matches).

## Divergence ruling: the GLYPHS status group

This is the one real content choice in this hoist. The TUI's `idle='◌'`/`info='○'`/
`warn='⚠'` wins over the agent's `idle='○'`/`info='•'`/no-`warn`. Rationale: the TUI is
the more-recently-fixed, more-complete copy (its `status-glyphs.ts` comment records that
it already resolved an internal `info`/`pending` collision the agent's copy still
carries), and Mike's ruling designates the TUI as the reference substrate for this wave.
**Effect when the agent adopts this (R4, a later wave, not this one):** the agent's
`idle` and `info` status glyphs will VISIBLY change on render — this is an intentional
convergence to the reference, not a regression, and should be called out in that wave's
notes so it isn't mistaken for a defect.

## Rejected alternatives

- **Leaving the four tables duplicated with a "keep in sync" convention/lint.** The
  drift had already started (GLYPHS status group diverged; the agent's UI_TONES was
  missing the entire chrome group) — Mike's ruling is machinery-needed-by-2+-surfaces
  => SDK, and a lint cannot un-diverge already-shipped literal tables.
- **Hoisting `status-token.ts` / `tool-labels.ts`.** Agent-only (the TUI has neither) —
  not cross-repo duplication, and pulling them in would pollute the SDK with
  agent-specific presentation the TUI has no use for. Explicitly excluded per the
  W4-R1 audit's candidate list.
- **Swapping the TUI onto this contract in the same wave.** The TUI is the reference
  and is already correct; rewriting its renderer to import from the SDK here would be
  blast-radius for zero honesty gain. Deferred to a Wave-6 coherence pass (see Flag,
  below).
- **A runtime theme SERVICE (subscribe/notify, mode-change events, etc).** The contract
  is data plus pure functions; painting and mode-change propagation stay
  renderer-owned. `resolveTones`/`waitingPhrase` are called per-render by whichever
  renderer holds the active mode/state, exactly like the TUI's own
  `resolveUiTones`/`createThinkingFragment` do today.
- **Hoisting `computeStallInfo`/`computeRenderStallInfo` (ui-factory.ts:522-552)
  alongside `waitingPhrase`.** These derive a `WaitingState` from a renderer's own
  live stream metrics (`lastDeltaAtMs`, `activeToolName`, reconnect counters) — a
  shape that is renderer-local by nature (the agent's stream-metrics surface differs
  from the TUI's). The contract stops at state→wording; deriving the state from raw
  signals is each renderer's own job, same as it is in the TUI today.

## Flag

"Both renderers consume this" is ARCHITECTURAL until a second real consumer imports it.
Today the module has zero consumers landed — the agent adopts it in W4-R4 (a later,
separately-scoped wave). The TUI, despite being the reference this module mirrors, does
NOT adopt it in this wave either: the TUI's own `ui-primitives.ts`/`theme.ts`/
`ui-factory.ts`/`status-glyphs.ts` are untouched and remain read-only reference sources.
A TUI-consumes-SDK swap is intentionally deferred to a Wave-6 coherence pass (per the
brief: "the TUI is the reference and already correct; a TUI swap is blast-radius for no
honesty gain"). webui/PWA are consumers-in-waiting beyond that.

## Consumability proof

`test/platform-presentation.test.ts` proves: (1) `resolveTones('dark')` is
reference-identical to `TONE_TOKENS` (the TUI no-op-swap guarantee) and
`resolveTones('light')` inverts exactly the chrome/accent/state roles documented above
while leaving every other role unchanged; (2) `waitingPhrase` returns the four honest
strings for `approval`/`reconnecting`/`pre-first-token`/`stalled` and a
`THINKING_PHRASES`-rotated string for `thinking`, golden-matched against the TUI
`ui-factory.ts:554-584` formulas for identical inputs; (3) `GLYPHS.status` carries the
TUI's reconciled idle/info/warn values and `STATE_GLYPHS` aliases into it (no
independent literals); (4) a purity assertion that no file under
`packages/sdk/src/platform/presentation/` imports `node:fs`, `node:tty`, `node:process`,
or references `process.stdout`/`process.stderr`.
